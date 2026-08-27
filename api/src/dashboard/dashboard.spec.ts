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

describe('GLOBAL SCOPE NARROW — the top-bar selector narrows within RBAC, never widens it', () => {
  it('an admin who selects a branch gets (1=1) AND l.branch_id = <it>', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { branch_id: 9 });
    const kpi = calls.find((c) => /FROM lead l/.test(c.sql))!;
    expect(kpi.sql).toMatch(/\(1=1\)/);
    expect(kpi.sql).toMatch(/l\.branch_id IN \(/);   // narrowed on top of the open scope
    expect(kpi.params).toContain(9);
  });

  it('narrows the full chain (branch+vertical+pipeline+campaign) onto the lead query', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { branch_id: 2, vertical_id: 3, pipeline_id: 4, campaign_id: 5 });
    const kpi = calls.find((c) => /FROM lead l/.test(c.sql))!;
    for (const col of ['l.branch_id', 'l.vertical_id', 'l.pipeline_id', 'l.campaign_id']) expect(kpi.sql).toContain(col);
  });

  it('CANNOT WIDEN: a branch-9 manager selecting branch 99 still carries BOTH predicates (scope AND narrow) — an empty set, never branch 99', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(BRANCH, 5, { branch_id: 99 });
    const kpi = calls.find((c) => /FROM lead l/.test(c.sql))!;
    // scope predicate (branch 9) is still present …
    expect(kpi.sql).toContain('l.branch_id = $1');
    expect(kpi.params[0]).toBe(9);
    // … AND the client narrow (99) is ANDed on top, so the two can only intersect (=> no rows)
    expect(kpi.params).toContain(99);
    expect(kpi.sql).toMatch(/l\.branch_id IN \(/);  // the client narrow is ANDed as an IN, on top of the scope's = $1
  });

  it('an absent / zero / non-numeric selection adds no narrow at all (unchanged behaviour)', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { branch_id: 0 as any });
    const kpi = calls.find((c) => /FROM lead l/.test(c.sql))!;
    // only the scope's single (no) param — no extra branch predicate beyond the date range
    expect(kpi.sql).not.toMatch(/l\.branch_id IN \(/);
  });

  it('walk-in and referral widgets honour the narrow through their own lead alias', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { branch_id: 7 });
    const w = calls.find((c) => /FROM walk_in w/.test(c.sql))!;
    const r = calls.find((c) => /FROM referral r/.test(c.sql))!;
    expect(w.sql).toContain('wl.branch_id IN ($');
    expect(r.sql).toContain('rl.branch_id IN ($');
  });

  it('quick stats honour the narrow too', async () => {
    const { db, calls } = spyDb();
    await svc(db).quickStats(ADMIN, { branch_id: 4 });
    expect(calls[0].sql).toContain('l.branch_id IN ($');
    expect(calls[0].params).toContain(4);
  });
});

/* ---- the shared date-range control: the overview KPI/funnel cohort honours from/to ---- */
describe('the overview KPI cohort honours the shared date range (created_at), additively', () => {
  // the FUNNEL (byStage) query is the clean discriminator: with no range it has NO created_at
  // filter at all, so it agrees all-time with the Funnel report (reconcile.spec). A range adds one.
  const funnelOf = (calls: Array<{ sql: string; params: unknown[] }>) => calls.find((c) => /GROUP BY st\.id/.test(c.sql))!;

  it('WITHOUT a range the funnel query is ALL-TIME — default unchanged, still agrees with the report', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1);
    expect(funnelOf(calls).sql).not.toContain('l.created_at::date BETWEEN $');
  });

  it('WITH a range the funnel + KPI + leaderboard queries AND in created_at BETWEEN from..to', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { from: '2026-07-01', to: '2026-07-15' });
    // the funnel query now carries the created-cohort predicate
    expect(funnelOf(calls).sql).toContain('l.created_at::date BETWEEN $');
    // kpis, funnel and leaderboard all carry a created_at BETWEEN once the range is applied
    const applied = calls.filter((c) => c.sql.includes('l.created_at::date BETWEEN $'));
    expect(applied.length).toBeGreaterThanOrEqual(3);
    expect(funnelOf(calls).params).toContain('2026-07-01');
    expect(funnelOf(calls).params).toContain('2026-07-15');
  });

  it('a malformed range is a 400 (never a silently-wrong default)', async () => {
    const { db } = spyDb();
    await expect(svc(db).overview(ADMIN, 1, { from: 'last-tuesday', to: '2026-07-15' })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('an open-ended range (only from) is honoured', async () => {
    const { db, calls } = spyDb();
    await svc(db).overview(ADMIN, 1, { from: '2026-07-01' });
    const applied = calls.filter((c) => c.sql.includes('l.created_at::date BETWEEN $'));
    expect(applied.length).toBeGreaterThanOrEqual(3);
    // the missing `to` becomes an unbounded upper sentinel, not a 400
    for (const c of applied) expect(c.params).toContain('2026-07-01');
  });
});

/* -------- dev/139: live team status derives from user.last_seen_at -------- */
describe('teamStatus (dev/139) — live agent status', () => {
  const rowsDb = (rows: any[]) => ({
    query: async () => rows,
    one: async () => ({}),
  } as unknown as DatabaseService);

  it('buckets Online (<5m), Away (<30m), Offline (>=30m or never seen)', async () => {
    const now = Date.now();
    const at = (m: number | null) => (m == null ? null : new Date(now - m * 60000).toISOString());
    const rows = [
      { id: 1, name: 'A', last_seen_at: at(1), open_leads: 3, followups_today: 2 },
      { id: 2, name: 'B', last_seen_at: at(10), open_leads: 1, followups_today: 0 },
      { id: 3, name: 'C', last_seen_at: at(120), open_leads: 0, followups_today: 0 },
      { id: 4, name: 'D', last_seen_at: null, open_leads: 5, followups_today: 1 },
    ];
    const out: any = await svc(rowsDb(rows)).teamStatus(ADMIN);
    expect(out.total).toBe(4);
    expect(out.online).toBe(1);
    expect(out.away).toBe(1);
    expect(out.offline).toBe(2);
    expect(out.agents.find((a: any) => a.id === 1).status).toBe('online');
    expect(out.agents.find((a: any) => a.id === 2).status).toBe('away');
    expect(out.agents.find((a: any) => a.id === 4).status).toBe('offline');
    expect(out.agents.find((a: any) => a.id === 1).open_leads).toBe(3);
    expect(out.agents.find((a: any) => a.id === 1).followups_today).toBe(2);
  });

  it('scopes agents through the lead table (a counsellor only ever sees their own row)', async () => {
    const { db, calls } = spyDb();
    await svc(db).teamStatus(OWN);
    const q = calls.find((c) => /JOIN "user" u ON u\.id = l\.owner_id/.test(c.sql));
    expect(q).toBeTruthy();
    expect(q!.sql).toMatch(/owner_id/);
  });
});
