import { BadRequestException } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';

/**
 * DEF-2 regression (client UAT: "Edit branch is not editable — only readonly
 * columns are showing").
 *
 * Root cause was that Branch Type / City / State / Contact Number / Branch Email /
 * Branch Head had NO columns and NO PATCH whitelist entries, so the web Edit modal
 * dumped them into its read-only `lock` list. These tests pin the server contract:
 * every field the Add form shows must survive create AND update.
 */

type Call = { sql: string; params: unknown[] };

function mkDb() {
  const calls: Call[] = [];
  const exec = (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [{ id: 1 }];
  };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => (exec(sql, params) as any[])[0] ?? null,
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string, params: unknown[] = []) => ({ rows: exec(sql, params) }) }),
  };
}

const svc = (db: any) => new HierarchyService(db as any, { buildScopeWhere: () => 'TRUE' } as any, {} as any);

describe('DEF-2 — branch edit fields are persisted', () => {
  it('updateBranch whitelists every editable Add-Branch field (incl. address)', async () => {
    const db = mkDb();
    await svc(db).updateBranch(7, {
      name: 'Vikaspuri', code: 'VKP', address: 'A-11 2nd Floor, Vikaspuri',
      branch_type: 'Franchise Branch', contact_number: '+911140001234',
      email: 'vkp@techlingua.in', head_user_id: 3, state_id: 1, city_id: 2, is_active: true,
    });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE branch'))!;
    expect(upd).toBeDefined();
    for (const col of ['name', 'code', 'address', 'branch_type', 'contact_number', 'email', 'head_user_id', 'state_id', 'city_id', 'is_active']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
    // the address the client typed must actually reach the DB
    expect(upd.params).toContain('A-11 2nd Floor, Vikaspuri');
    // label -> enum
    expect(upd.params).toContain('franchise');
  });

  it('address-only PATCH works (the exact thing the client tried)', async () => {
    const db = mkDb();
    await svc(db).updateBranch(7, { address: 'New Address 42' } as any);
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE branch'))!;
    expect(upd.sql).toContain('address = $1');
    expect(upd.params[0]).toBe('New Address 42');
  });

  it('createBranch stores type / contact / email / head / city / state', async () => {
    const db = mkDb();
    await svc(db).createBranch({
      name: 'Janakpuri', code: 'jnp', address: 'Janakpuri', branch_type: 'Company Branch',
      contact_number: '+919000000009', email: 'jnp@techlingua.in', head_user_id: 4, state_id: 1, city_id: 2,
    }, 1);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO branch'))!;
    expect(ins.sql).toContain('branch_type, contact_number, email, head_user_id');
    expect(ins.params).toEqual(expect.arrayContaining([
      'Janakpuri', 'JNP', 'company', '+919000000009', 'jnp@techlingua.in', 4,
    ]));
  });

  it('branchType maps the prototype labels and rejects junk', () => {
    expect(HierarchyService.branchType('Company Branch')).toBe('company');
    expect(HierarchyService.branchType('Franchise Branch')).toBe('franchise');
    expect(HierarchyService.branchType('franchise')).toBe('franchise');
    expect(HierarchyService.branchType('')).toBeNull();
    expect(HierarchyService.branchType(null)).toBeNull();
    expect(() => HierarchyService.branchType('Nope')).toThrow(BadRequestException);
  });
});

describe('DEF-2 — the same gap in the other hierarchy modules', () => {
  it('updateVertical accepts head + description', async () => {
    const db = mkDb();
    await svc(db).updateVertical(2, { name: 'BCL', head_user_id: 5, description: 'Bootcamp Learning' });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE vertical'))!;
    expect(upd.sql).toContain('head_user_id = $');
    expect(upd.sql).toContain('description = $');
    expect(upd.params).toContain('Bootcamp Learning');
  });

  it('updatePipeline accepts owner', async () => {
    const db = mkDb();
    await svc(db).updatePipeline(3, { name: 'Admissions', owner_user_id: 6 });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE pipeline'))!;
    expect(upd.sql).toContain('owner_user_id = $');
    expect(upd.params).toContain(6);
  });

  it('updateSource accepts cost per lead', async () => {
    const db = mkDb();
    await svc(db).updateSource(4, { name: 'Meta Ads', cost_per_lead: 250 });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE source'))!;
    expect(upd.sql).toContain('cost_per_lead = $');
    expect(upd.params).toContain(250);
  });
});

/**
 * QA-10 (Sprint 2 acceptance) — the SAME class of defect, found in three more places.
 * These pin the server half of the contract; the web half is pinned by
 * `web/src/qa10matrix.test.tsx` (the form must SEND what it renders).
 */
describe('DEF-S2-04 — createVertical persists Vertical Head and Description', () => {
  it('the INSERT carries head_user_id + description (they were PATCH-only)', async () => {
    const db = mkDb();
    await svc(db).createVertical({
      branch_id: 1, name: 'Bootcamp', code: 'BCL', head_user_id: 51, description: 'Bootcamp Learning',
    }, 9);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO vertical'))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toContain('head_user_id');
    expect(ins.sql).toContain('description');
    expect(ins.params).toContain(51);
    expect(ins.params).toContain('Bootcamp Learning');
  });

  it('an Add with no head/description still inserts NULLs (no regression)', async () => {
    const db = mkDb();
    await svc(db).createVertical({ branch_id: 1, name: 'Bootcamp', code: 'BCL' }, 9);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO vertical'))!;
    expect(ins.params).toContain(null);
  });
});

describe('DEF-S2-02 — the campaign form fields are real columns', () => {
  const scope = { all: true } as any;

  it('createCampaign stores Campaign Type / Marketing Channel / Start Date / End Date', async () => {
    const db = mkDb();
    await svc(db).createCampaign({
      pipeline_id: 4, name: 'Meta July', campaign_type: 'Digital', marketing_channel: 'Meta',
      start_date: '2026-07-01', end_date: '2026-07-31',
    }, 9, scope);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO campaign'))!;
    for (const col of ['campaign_type', 'marketing_channel', 'start_date', 'end_date']) {
      expect(ins.sql).toContain(col);
    }
    expect(ins.params).toContain('Digital');
    expect(ins.params).toContain('Meta');
    expect(ins.params).toContain('2026-07-01');
    expect(ins.params).toContain('2026-07-31');
  });

  it('updateCampaign whitelists all four (Edit -> save -> reload keeps them)', async () => {
    const db = mkDb();
    await svc(db).updateCampaign(5, {
      name: 'Meta July', campaign_type: 'Event', marketing_channel: 'Hoarding',
      start_date: '2026-08-01', end_date: '2026-08-30',
    }, 9, scope);
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE campaign'))!;
    for (const col of ['campaign_type', 'marketing_channel', 'start_date', 'end_date']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
    expect(upd.params).toContain('2026-08-01');
  });

  it("an emptied date input ('') is stored as NULL, not a 22P02", async () => {
    const db = mkDb();
    await svc(db).updateCampaign(5, { start_date: '', end_date: '' } as any, 9, scope);
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE campaign'))!;
    expect(upd.params.slice(0, 2)).toEqual([null, null]);
  });

  it('a malformed date is a 400, never a crash', async () => {
    const db = mkDb();
    await expect(svc(db).updateCampaign(5, { start_date: '31/07/2026' } as any, 9, scope))
      .rejects.toThrow(BadRequestException);
  });
});

describe('QA-10 sweep — an Add form Status of "Inactive" must stick', () => {
  const scope = { all: true } as any;

  it('createBranch honours is_active', async () => {
    const db = mkDb();
    await svc(db).createBranch({ name: 'Pune', code: 'PUN', is_active: false } as any, 9);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO branch'))!;
    expect(ins.sql).toContain('is_active');
    expect(ins.params).toContain(false);
  });

  it('createPipeline / createSource / createCampaign honour is_active', async () => {
    const dbP = mkDb();
    await svc(dbP).createPipeline({ vertical_id: 2, name: 'Admissions', code: 'ADM', is_active: false }, 9);
    expect(dbP.calls.find((c) => c.sql.startsWith('INSERT INTO pipeline'))!.params).toContain(false);

    const dbS = mkDb();
    await svc(dbS).createSource({ campaign_id: 5, name: 'Meta Ads', is_active: false }, 9);
    expect(dbS.calls.find((c) => c.sql.startsWith('INSERT INTO source'))!.params).toContain(false);

    const dbC = mkDb();
    await svc(dbC).createCampaign({ pipeline_id: 4, name: 'X', is_active: false }, 9, scope);
    expect(dbC.calls.find((c) => c.sql.startsWith('INSERT INTO campaign'))!.params).toContain(false);
  });
});
