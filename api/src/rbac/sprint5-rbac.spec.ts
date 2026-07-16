import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from './rbac.decorators';
import { PERMISSION_CATALOG } from './permission-catalog';
import { QuotationController } from '../quotations/quotation.controller';
import { EnrolmentController } from '../enrolments/enrolment.controller';
import { FeeController } from '../fees/fee.controller';
import { PerformanceController } from '../performance/performance.controller';
import { NumberingController } from '../numbering/numbering.controller';

/**
 * RBAC ON EVERY SPRINT-5 ENDPOINT — enforced mechanically, exactly as Sprints 3 and 4 do.
 *
 * A route that forgets @RequirePermission has no `request.scope`, so any scoped query it
 * builds either throws or — far worse — falls open. Sprint 5 raises the stakes again:
 * these endpoints QUOTE PRICES, CLOSE SALES and TAKE MONEY. A missing decorator here is
 * a counsellor reading another branch's revenue, or collecting against someone else's
 * enrolment.
 *
 * This walks the real controller prototypes via reflect-metadata, so it cannot go stale.
 */

const CONTROLLERS = [
  ['QuotationController', QuotationController],
  ['EnrolmentController', EnrolmentController],
  ['FeeController', FeeController],
  ['PerformanceController', PerformanceController],
  ['NumberingController', NumberingController],
] as const;

interface Route { controller: string; handler: string; permission?: string; public: boolean }

function routesOf(name: string, ctrl: new (...a: any[]) => unknown): Route[] {
  const proto = ctrl.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((m) => m !== 'constructor' && typeof proto[m] === 'function')
    .filter((m) => Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined
      || Reflect.getMetadata(PATH_METADATA, proto[m]) !== undefined)
    .map((m) => ({
      controller: name,
      handler: m,
      permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
      public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
    }));
}

const ALL = CONTROLLERS.flatMap(([n, c]) => routesOf(n, c as new (...a: any[]) => unknown));
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));

describe('Sprint-5 RBAC coverage', () => {
  it('found every Sprint-5 route (the reflection actually works)', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(25);
    for (const [name] of CONTROLLERS) expect(ALL.some((r) => r.controller === name)).toBe(true);
  });

  it('EVERY route requires a permission — none is unguarded', () => {
    const naked = ALL.filter((r) => !r.permission && !r.public);
    expect(naked.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('NOTHING in Sprint 5 is public — every one of these routes touches money', () => {
    expect(ALL.filter((r) => r.public).map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('every permission a route names exists in the catalog (no typo grants access)', () => {
    const unknown = ALL.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission))
      .map((r) => `${r.controller}.${r.handler} -> ${r.permission}`);
    expect(unknown).toEqual([]);
  });

  it('migration 029 GRANTS every permission the catalog declares for Sprint 5', () => {
    // A permission that exists but is granted to nobody is a screen nobody can open —
    // which is exactly how Sprint 1's `settings.*` sat dead until Sprint 4 noticed.
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '029_sprint5.sql'), 'utf8');
    const sprint5Modules = ['quotation', 'enrolment', 'fee', 'target', 'performance'];
    const keys = PERMISSION_CATALOG
      .filter((m) => sprint5Modules.includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`));
    expect(keys.length).toBeGreaterThan(14);
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
  });

  /**
   * THE SEPARATION-OF-DUTIES ASSERTIONS. These are the ones that would actually cost the
   * client money, so they are named rather than merely implied by the grant table.
   */
  describe('separation of duties', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const sql: string = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '029_sprint5.sql'), 'utf8');
    const granted = (perm: string, role: string) =>
      new RegExp(`'${perm.replace('.', '\\.')}'\\s*,\\s*'${role}'`).test(sql);

    it('a Counsellor CANNOT approve an enrolment — his own or anyone\'s', () => {
      expect(granted('enrolment.approve', 'Counsellor')).toBe(false);
      expect(granted('enrolment.approve', 'Telecaller')).toBe(false);
      // …nor can a Team Leader: he closes sales himself, so approving is self-approval
      expect(granted('enrolment.approve', 'Team Leader')).toBe(false);
      expect(granted('enrolment.approve', 'Branch Manager')).toBe(true);
    });

    it('a Counsellor CANNOT set targets — only managers and admins', () => {
      expect(granted('target.manage', 'Counsellor')).toBe(false);
      expect(granted('target.manage', 'Team Leader')).toBe(false);
      expect(granted('target.manage', 'Branch Manager')).toBe(true);
      // …but he can READ his own. A target nobody can see is not a target.
      expect(granted('target.read', 'Counsellor')).toBe(true);
    });

    it('only an ADMIN can void a receipt or delete a quotation — they are records', () => {
      expect(granted('fee.delete', 'Counsellor')).toBe(false);
      expect(granted('fee.delete', 'Branch Manager')).toBe(false);
      expect(granted('fee.delete', 'Organization Admin')).toBe(true);
      expect(granted('quotation.delete', 'Counsellor')).toBe(false);
      expect(granted('quotation.delete', 'Organization Admin')).toBe(true);
    });

    it('the approval POLICY is admin-only, but the queue is a manager\'s', () => {
      const policy = ALL.find((r) => r.controller === 'EnrolmentController' && r.handler === 'setPolicy');
      expect(policy?.permission).toBe('settings.update');      // Super/Org Admin (migration 026)
      const queue = ALL.find((r) => r.controller === 'EnrolmentController' && r.handler === 'queue');
      expect(queue?.permission).toBe('enrolment.approve');
    });

    it('numbering is Settings — a Branch Manager cannot renumber the org\'s quotations', () => {
      for (const r of ALL.filter((x) => x.controller === 'NumberingController')) {
        expect(r.permission).toMatch(/^settings\.(read|update)$/);
      }
    });

    it('every counsellor-facing read is scoped, never "all"', () => {
      // 'own' for a Counsellor on every read permission Sprint 5 adds
      for (const p of ['quotation.read', 'enrolment.read', 'fee.read', 'target.read', 'performance.read']) {
        expect(new RegExp(`'${p.replace('.', '\\.')}'\\s*,\\s*'Counsellor',\\s*'own'`).test(sql)).toBe(true);
      }
    });
  });
});
