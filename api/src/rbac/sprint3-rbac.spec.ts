import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY, SCOPED_ENTITY_KEY } from './rbac.decorators';
import { PERMISSION_CATALOG } from './permission-catalog';
import { ScoringController } from '../scoring/scoring.controller';
import { SlaController } from '../sla/sla.controller';
import { CalendarController } from '../calendar/calendar.controller';
import { DashboardController } from '../dashboard/dashboard.controller';
import { NotificationController } from '../notifications/notification.controller';
import { ReferralController, WalkInController } from '../capture/capture.controller';

/**
 * RBAC ON EVERY NEW ENDPOINT — enforced mechanically, not by review.
 *
 * A route that forgets @RequirePermission is not merely un-scoped: PermissionsGuard has
 * nothing to resolve, so `request.scope` is undefined and any query built from it would
 * throw or (worse) fall open. Sprint 2 caught one of these in review; this test means the
 * next one fails the build instead.
 *
 * It walks the real controller prototypes via reflect-metadata, so it cannot go stale:
 * add a route to any Sprint-3 controller without a permission and this goes red.
 */

const CONTROLLERS = [
  ['ScoringController', ScoringController],
  ['SlaController', SlaController],
  ['CalendarController', CalendarController],
  ['DashboardController', DashboardController],
  ['NotificationController', NotificationController],
  ['WalkInController', WalkInController],
  ['ReferralController', ReferralController],
] as const;

interface Route { controller: string; handler: string; permission?: string; public: boolean; scopedEntity?: string }

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
      scopedEntity: (Reflect.getMetadata(SCOPED_ENTITY_KEY, proto[m]) as { kind?: string } | undefined)?.kind,
    }));
}

const ALL_ROUTES = CONTROLLERS.flatMap(([n, c]) => routesOf(n, c as new (...a: any[]) => unknown));
const CATALOG_KEYS = new Set(
  PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)),
);

describe('Sprint-3 RBAC coverage', () => {
  it('found every Sprint-3 route (the reflection actually works)', () => {
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(24);
    for (const [name] of CONTROLLERS) {
      expect(ALL_ROUTES.some((r) => r.controller === name)).toBe(true);
    }
  });

  it('EVERY route requires a permission — none is public, none is unguarded', () => {
    const naked = ALL_ROUTES.filter((r) => !r.permission && !r.public);
    expect(naked.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('no Sprint-3 route is marked @Public (only login may be)', () => {
    expect(ALL_ROUTES.filter((r) => r.public)).toEqual([]);
  });

  it('every required permission EXISTS in the catalog (a typo would deny everyone, silently)', () => {
    const unknown = ALL_ROUTES
      .map((r) => r.permission!)
      .filter((k) => k && !CATALOG_KEYS.has(k));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('MUTATIONS need a manage/create/update/delete permission — never a bare .read', () => {
    const mutators = ALL_ROUTES.filter((r) => /^(create|update|remove|save|markRead|markAll|recompute|syncNow)$/.test(r.handler));
    for (const r of mutators) {
      // notifications are the one exception: marking YOUR OWN bell read is not a
      // privileged mutation — it is hard-scoped to the caller's user_id in SQL.
      if (r.controller === 'NotificationController') {
        expect(r.permission).toBe('notification.read');
        continue;
      }
      expect(r.permission).toMatch(/\.(manage|create|update|delete)$/);
    }
  });

  it('the SCORING RULES are admin-only (score.manage), but the band is readable by all', () => {
    const byHandler = Object.fromEntries(
      ALL_ROUTES.filter((r) => r.controller === 'ScoringController').map((r) => [r.handler, r.permission]),
    );
    expect(byHandler.summary).toBe('score.read');
    expect(byHandler.rules).toBe('score.read');
    expect(byHandler.create).toBe('score.manage');
    expect(byHandler.update).toBe('score.manage');
    expect(byHandler.remove).toBe('score.manage');
    expect(byHandler.saveConfig).toBe('score.manage');
    expect(byHandler.recompute).toBe('score.manage');
  });

  it('SLA POLICIES are admin-only; the breach view is readable at the caller\'s scope', () => {
    const byHandler = Object.fromEntries(
      ALL_ROUTES.filter((r) => r.controller === 'SlaController').map((r) => [r.handler, r.permission]),
    );
    expect(byHandler.breaches).toBe('sla.read');
    expect(byHandler.summary).toBe('sla.read');
    expect(byHandler.create).toBe('sla.manage');
    expect(byHandler.update).toBe('sla.manage');
    expect(byHandler.remove).toBe('sla.manage');
  });

  it('a by-ID lead route carries @ScopedEntity so an out-of-scope id 404s (no existence oracle)', () => {
    const forLead = ALL_ROUTES.find((r) => r.controller === 'SlaController' && r.handler === 'forLead')!;
    expect(forLead.scopedEntity).toBe('lead');
  });

  it('THE DASHBOARD is governed by lead.read — the SAME permission as the lead list', () => {
    // deliberate: the dashboard IS lead data. A separate `dashboard.read` could drift from
    // lead.read and let a counsellor see branch numbers — exactly the leak the client asked
    // us to prevent.
    const dash = ALL_ROUTES.filter((r) => r.controller === 'DashboardController');
    // overview + quick-stats + team-status (dev/139) — all governed by lead.read.
    expect(dash).toHaveLength(3);
    for (const r of dash) expect(r.permission).toBe('lead.read');
  });

  it('walk-ins and referrals are separately permissioned (the front desk is not a lead admin)', () => {
    const w = Object.fromEntries(ALL_ROUTES.filter((r) => r.controller === 'WalkInController').map((r) => [r.handler, r.permission]));
    const rf = Object.fromEntries(ALL_ROUTES.filter((r) => r.controller === 'ReferralController').map((r) => [r.handler, r.permission]));
    expect(w).toMatchObject({ list: 'walkin.read', create: 'walkin.create', update: 'walkin.update', remove: 'walkin.delete' });
    expect(rf).toMatchObject({ list: 'referral.read', create: 'referral.create', update: 'referral.update', remove: 'referral.delete' });
  });
});

describe('the permission catalog covers the Sprint-3 modules', () => {
  it.each(['score', 'sla', 'calendar', 'notification', 'walkin', 'referral'])(
    'module "%s" is in the catalog', (mod) => {
      expect(PERMISSION_CATALOG.some((m) => m.module === mod)).toBe(true);
    },
  );
});
