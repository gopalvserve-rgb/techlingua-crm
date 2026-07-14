import { DashboardService, WIDGETS, viewOf } from './dashboard.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * ROLE-BASED DASHBOARDS — the client's requirement, and the thing that must not leak:
 *
 *   "Counsellor -> own leads/tasks/targets. Branch Manager -> their branch + team.
 *    Vertical Head -> their vertical. Admin -> org-wide. Must use the existing RBAC
 *    ScopeResolver — never hand-roll scoping."
 *
 * So the tests assert TWO things:
 *   1. the VIEW is derived from the resolved scope (not from a role NAME — custom roles
 *      are a first-class feature and a name lookup would get them wrong);
 *   2. the SQL a counsellor's request produces is genuinely narrowed to their own rows.
 *      A counsellor must not be able to see branch numbers even if the view were
 *      mislabelled — so we capture the actual SQL + params and check the predicate.
 */

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'lead.read', allowed: true, all: false, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});

const OWN = scope({ filters: [{ kind: 'own', userId: 3 }] });
const TEAM = scope({ filters: [{ kind: 'team', teamIds: [2] }] });
const BRANCH = scope({ filters: [{ kind: 'branch', branchId: 9 }] });
const VERTICAL = scope({ filters: [{ kind: 'vertical', verticalId: 1 }] });
const ADMIN = scope({ all: true });

describe('viewOf — the dashboard follows the SCOPE, not the role name', () => {
  it.each([
    [OWN, 'counsellor'], [TEAM, 'team'], [BRANCH, 'branch'], [VERTICAL, 'vertical'], [ADMIN, 'admin'],
  ] as const)('%#', (s, expected) => {
    expect(viewOf(s)).toBe(expected);
  });

  it('a multi-unit user gets the WIDEST view their grants allow', () => {
    const both = scope({ filters: [{ kind: 'own', userId: 3 }, { kind: 'branch', branchId: 9 }] });
    expect(viewOf(both)).toBe('branch');
  });

  it('a user with NO grant degrades to the counsellor view (never to admin)', () => {
    expect(viewOf(scope({ allowed: false }))).toBe('counsellor');
  });

  it('a custom role scoped to a vertical gets the vertical dashboard — no role names involved', () => {
    expect(viewOf(scope({ filters: [{ kind: 'vertical', verticalId: 4 }] }))).toBe('vertical');
  });
});

describe('the widget MIX differs by view (same design language, different data)', () => {
  it('a counsellor gets personal widgets and NO team leaderboard or SLA manager view', () => {
    expect(WIDGETS.counsellor).toContain('my_tasks');
    expect(WIDGETS.counsellor).not.toContain('team_leaderboard');
    expect(WIDGETS.counsellor).not.toContain('sla');
  });
  it('a branch manager gets the team + SLA + walk-in widgets', () => {
    for (const w of ['team_leaderboard', 'sla', 'walkins', 'referrals']) expect(WIDGETS.branch).toContain(w);
  });
  it('only the admin view gets the org-wide source widget', () => {
    expect(WIDGETS.admin).toContain('sources');
    expect(WIDGETS.vertical).not.toContain('sources');
  });
  it('AI Insights is present in every view (an empty-state shell — never fake data)', () => {
    for (const v of Object.values(WIDGETS)) expect(v).toContain('ai_insights');
  });
});

/* -------- the real test: what SQL does a counsellor's dashboard actually run? -------- */

function spyDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  return { db, calls };
}

const svc = (db: DatabaseService) => new DashboardService(db, new ScopeResolverService());

describe('SCOPING — a counsellor cannot see branch numbers, by construction', () => {
  it("every lead query a counsellor runs is narrowed to `l.owner_id = <them>`", async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(OWN, 3);
    const leadQueries = calls.filter((c) => /FROM lead l/.test(c.sql));
    expect(leadQueries.length).toBeGreaterThan(0);
    for (const c of leadQueries) {
      expect(c.sql).toContain('l.owner_id = $1');
      expect(c.params[0]).toBe(3);
      // and it must NOT be an unrestricted scan
      expect(c.sql).not.toMatch(/WHERE \(1=1\)/);
    }
  });

  it('a counsellor does NOT get the team leaderboard or the SLA manager block at all', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).overview(OWN, 3);
    expect(out.view).toBe('counsellor');
    expect(out.leaderboard).toEqual([]);
    expect(out.sla).toBeNull();
    expect(calls.some((c) => /GROUP BY u.id, u.name/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /FROM lead_sla/.test(c.sql))).toBe(false);
  });

  it('a BRANCH manager IS narrowed to their branch — not to everything', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).overview(BRANCH, 5);
    expect(out.view).toBe('branch');
    const leadQueries = calls.filter((c) => /FROM lead l/.test(c.sql));
    for (const c of leadQueries) {
      expect(c.sql).toContain('l.branch_id = $1');
      expect(c.params[0]).toBe(9);
    }
    expect(calls.some((c) => /GROUP BY u.id, u.name/.test(c.sql))).toBe(true);   // leaderboard runs
  });

  it('a VERTICAL head is narrowed to their vertical', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).overview(VERTICAL, 6);
    expect(out.view).toBe('vertical');
    for (const c of calls.filter((c) => /FROM lead l/.test(c.sql))) {
      expect(c.sql).toContain('l.vertical_id = $1');
      expect(c.params[0]).toBe(1);
    }
  });

  it('only an ADMIN produces an unrestricted (1=1) predicate', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).overview(ADMIN, 1);
    expect(out.view).toBe('admin');
    expect(calls.filter((c) => /FROM lead l/.test(c.sql)).every((c) => /\(1=1\)/.test(c.sql))).toBe(true);
  });

  it('a REVOKED scope produces 1=0 — the dashboard returns nothing, it does not fall open', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(scope({ allowed: false }), 3);
    expect(calls.filter((c) => /FROM lead l/.test(c.sql)).every((c) => /1=0/.test(c.sql))).toBe(true);
  });

  it('follow-up counters are scoped through the follow-up columns, not the lead owner', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(OWN, 3);
    const fq = calls.find((c) => /FROM follow_up f JOIN lead l/.test(c.sql));
    expect(fq).toBeDefined();
    expect(fq!.sql).toContain('f.owner_id = $1');
  });

  it('walk-in and referral widgets are scoped through the lead they created', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(BRANCH, 5);
    const w = calls.find((c) => /FROM walk_in w/.test(c.sql));
    const r = calls.find((c) => /FROM referral r/.test(c.sql));
    expect(w!.sql).toContain('wl.branch_id = $1');
    expect(r!.sql).toContain('rl.branch_id = $1');
  });
});

describe('Quick Stats — CUSTOM DATE RANGE (the client asked for it explicitly)', () => {
  it('accepts an arbitrary from/to and uses it in the SQL', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).quickStats(ADMIN, { from: '2026-01-01', to: '2026-03-31' });
    expect(out.range).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(calls[0].params).toContain('2026-01-01');
    expect(calls[0].params).toContain('2026-03-31');
  });

  it('defaults to the current month when no range is given', async () => {
    const { db } = spyDb();
    const out = await svc(db).quickStats(ADMIN, {});
    const now = new Date();
    expect(out.range.from).toBe(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10));
  });

  it('rejects a malformed or inverted range (400, not a silent full-table scan)', async () => {
    const { db } = spyDb();
    await expect(svc(db).quickStats(ADMIN, { from: 'last-tuesday' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(svc(db).quickStats(ADMIN, { from: '2026-05-01', to: '2026-01-01' })).rejects.toThrow(/not be after/);
  });

  it('quick stats are scoped too — a counsellor gets their own numbers', async () => {
    const { db, calls } = spyDb();
    const out = await svc(db).quickStats(OWN, {});
    expect(out.view).toBe('counsellor');
    expect(calls[0].sql).toContain('l.owner_id = $1');
  });
});
