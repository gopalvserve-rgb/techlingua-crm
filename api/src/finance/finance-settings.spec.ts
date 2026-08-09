import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException } from '@nestjs/common';
import { FinanceSettingsService, EffectiveCaps } from './finance-settings.service';
import { FinanceSettingsController } from './finance-settings.controller';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * FINANCE SETTINGS — the discount/scholarship/capping-limit config (% AND ₹), the cap
 * enforcement semantics, per-vertical resolution, override, and the RBAC census.
 */

const caps = (o: Partial<EffectiveCaps> = {}): EffectiveCaps => ({
  discount: { pct: null, minor: null },
  scholarship: { pct: null, minor: null },
  cap: { pct: null, minor: null },
  ...o,
});

// a bare service instance is enough for the PURE checker (no db/rbac calls).
const svc = new FinanceSettingsService({} as any, {} as any);

describe('finance — the cap check (percent AND amount, blank = off, stricter binds)', () => {
  it('blank caps enforce nothing', () => {
    expect(svc.check(caps(), 'discount', 100_000, 100_000).ok).toBe(true);
  });

  it('within the percent cap is allowed; over it is rejected', () => {
    const c = caps({ discount: { pct: 20, minor: null } });
    // base ₹1000 -> 20% = ₹200. ₹200 ok, ₹201 rejected.
    expect(svc.check(c, 'discount', 100_000, 20_000).ok).toBe(true);
    const r = svc.check(c, 'discount', 100_000, 20_100);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/20%/);
  });

  it('within the amount cap is allowed; over it is rejected', () => {
    const c = caps({ discount: { pct: null, minor: 500_000 } });   // ₹5000
    expect(svc.check(c, 'discount', 10_000_000, 500_000).ok).toBe(true);
    const r = svc.check(c, 'discount', 10_000_000, 500_100);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/5000\.00/);
  });

  it('BOTH must hold — a discount within % but over ₹ is rejected (the stricter binds)', () => {
    const c = caps({ discount: { pct: 50, minor: 500_000 } });    // 50% OR ₹5000
    // base ₹20000, 40% = ₹8000: within 50% but over ₹5000 -> rejected on amount.
    const r = svc.check(c, 'discount', 2_000_000, 800_000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/5000\.00/);
  });

  it('the hard cap tightens the kind cap (min of the two)', () => {
    // discount says 40% but the hard cap says 20% -> effective 20%.
    const c = caps({ discount: { pct: 40, minor: null }, cap: { pct: 20, minor: null } });
    expect(svc.check(c, 'discount', 100_000, 20_000).ok).toBe(true);
    expect(svc.check(c, 'discount', 100_000, 25_000).ok).toBe(false);
  });

  it('scholarship is capped independently of discount', () => {
    const c = caps({ scholarship: { pct: 10, minor: null }, discount: { pct: 90, minor: null } });
    expect(svc.check(c, 'scholarship', 100_000, 9_000).ok).toBe(true);
    expect(svc.check(c, 'scholarship', 100_000, 15_000).ok).toBe(false);
    // ...while a discount up to 90% is still fine.
    expect(svc.check(c, 'discount', 100_000, 80_000).ok).toBe(true);
  });

  it('a zero discount is always allowed', () => {
    expect(svc.check(caps({ cap: { pct: 0, minor: 0 } }), 'discount', 100_000, 0).ok).toBe(true);
  });
});

describe('finance — effective resolution (per-vertical over org-wide, per field)', () => {
  function makeSvc(rows: any[], userPerms: string[] = []) {
    const db = {
      one: async (sql: string) => (/organisation/.test(sql) ? { id: '1' } : null),
      query: async () => rows,
    };
    const rbac = { loadUserGrants: async () => ({ rolePermissions: userPerms.map((k) => ({ permissionKey: k })) }) };
    return new FinanceSettingsService(db as any, rbac as any);
  }

  it('vertical value wins where set, org-wide shows through where blank', async () => {
    const s = makeSvc([
      { vertical_id: null, discount_max_pct: 10, discount_max_minor: 500000, scholarship_max_pct: 5, scholarship_max_minor: null, cap_max_pct: 30, cap_max_minor: null },
      { vertical_id: 3, discount_max_pct: 20, discount_max_minor: null, scholarship_max_pct: null, scholarship_max_minor: null, cap_max_pct: null, cap_max_minor: null },
    ]);
    const eff = await s.effective(3);
    expect(eff.discount.pct).toBe(20);          // vertical override
    expect(eff.discount.minor).toBe(500000);    // fell through to org-wide
    expect(eff.scholarship.pct).toBe(5);        // org-wide
    expect(eff.cap.pct).toBe(30);               // org-wide
  });

  it('userCanOverride reflects the finance.override grant', async () => {
    expect(await makeSvc([], ['finance.override']).userCanOverride(1)).toBe(true);
    expect(await makeSvc([], ['finance.read']).userCanOverride(1)).toBe(false);
  });

  it('guardFor rejects a normal user over the cap and passes an override holder', async () => {
    const rows = [{ vertical_id: null, discount_max_pct: 10, discount_max_minor: null, scholarship_max_pct: null, scholarship_max_minor: null, cap_max_pct: null, cap_max_minor: null }];
    const normal = await makeSvc(rows, []).guardFor(null, 1);
    expect(() => normal.enforce('discount', 100_000, 20_000, 'Line 1')).toThrow(BadRequestException);
    const boss = await makeSvc(rows, ['finance.override']).guardFor(null, 1);
    expect(() => boss.enforce('discount', 100_000, 20_000, 'Line 1')).not.toThrow();
  });
});

describe('finance — save validation & persistence', () => {
  function makeSvc() {
    const issued: any[] = [];
    const db = {
      one: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/organisation/.test(sql)) return { id: '1' };
        if (/FROM vertical WHERE id/.test(sql)) return { '?column?': 1 };
        if (/INSERT INTO finance_setting/.test(sql)) {
          return { id: '7', vertical_id: params[1], discount_max_pct: params[2], discount_max_minor: params[3],
            scholarship_max_pct: params[4], scholarship_max_minor: params[5], cap_max_pct: params[6], cap_max_minor: params[7] };
        }
        return null;
      },
      query: async () => [],
    };
    return { svc: new FinanceSettingsService(db as any, {} as any), issued };
  }

  it('stores a rupee amount as paise (no float drift) and the percent as given', async () => {
    const { svc, issued } = makeSvc();
    const row = await svc.save({ vertical_id: null, discount_max_pct: '20', discount_max: '5000' }, 9);
    expect(row.discount_max_minor).toBe(500000);   // ₹5000 -> 500000 paise, integer
    expect(row.discount_max_pct).toBe(20);
    const ins = issued.find((i) => /INSERT INTO finance_setting/.test(i.sql));
    expect(ins.params[3]).toBe(500000);            // exact paise on the wire
  });

  it('rejects a percentage over 100', async () => {
    const { svc } = makeSvc();
    await expect(svc.save({ discount_max_pct: '150' }, 9)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a blank field clears the cap (null = off)', async () => {
    const { svc } = makeSvc();
    const row = await svc.save({ discount_max_pct: '', discount_max: '' }, 9);
    expect(row.discount_max_pct).toBeNull();
    expect(row.discount_max_minor).toBeNull();
  });
});

describe('finance — RBAC census', () => {
  it('every controller route is guarded by a permission', () => {
    const proto = FinanceSettingsController.prototype as any;
    for (const m of Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor')) {
      if (typeof proto[m] !== 'function') continue;
      if (Reflect.getMetadata(METHOD_METADATA, proto[m]) === undefined) continue;
      expect(Reflect.getMetadata(PERMISSION_KEY, proto[m])).toBeTruthy();
    }
  });

  it('every permission the routes name exists in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    const proto = FinanceSettingsController.prototype as any;
    for (const m of Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor')) {
      const k = Reflect.getMetadata(PERMISSION_KEY, proto[m]);
      if (k) expect(keys.has(k)).toBe(true);
    }
    expect(keys.has('finance.read')).toBe(true);
    expect(keys.has('finance.manage')).toBe(true);
    expect(keys.has('finance.override')).toBe(true);
  });

  it('reads are finance.read; the write (change the cap) is finance.manage', () => {
    const proto = FinanceSettingsController.prototype as any;
    const permOf = (m: string) => Reflect.getMetadata(PERMISSION_KEY, proto[m]);
    expect(permOf('all')).toBe('finance.read');
    expect(permOf('effective')).toBe('finance.read');
    expect(permOf('save')).toBe('finance.manage');
  });

  it('migration 045 grants finance.manage to the admin roles and NOT to the Counsellor', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '045_finance_settings.sql'), 'utf8');
    expect(sql).toMatch(/\('finance\.manage',\s*'Super Admin'/);
    expect(sql).toMatch(/\('finance\.manage',\s*'Organization Admin'/);
    // the Counsellor must not be able to change the cap
    expect(sql).not.toMatch(/\('finance\.manage',\s*'Counsellor'/);
    // ...nor exceed it
    expect(sql).not.toMatch(/\('finance\.override',\s*'Counsellor'/);
  });
});
