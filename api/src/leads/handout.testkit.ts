/**
 * In-memory Postgres double for the on-demand hand-out suite.
 *
 * Like ingestion/fake-db.testkit.ts this is NOT a mock of our code — it interprets
 * the service's REAL SQL. Crucially it models **row locking**: a transaction that
 * has claimed leads holds a lock on them until it commits/rolls back, and a
 * concurrent `FOR UPDATE ... SKIP LOCKED` claim SKIPS locked rows instead of
 * waiting. That is what makes the "two agents click Start Calling at the same
 * instant" test meaningful rather than decorative.
 *
 * Excluded from the production build (tsconfig.build.json: *.testkit.ts).
 */
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { HandoutService } from './handout.service';
import { FollowUpsService } from './followups.service';

export interface FakeLead {
  id: number; campaign_id: number; owner_id: number | null;
  full_name: string; phone: string; priority: 'low' | 'med' | 'high';
  created_at: string; stage_id: number | null; status_id: number | null;
  is_active?: boolean; deleted_at?: string | null;
  org_id?: number; branch_id?: number; pipeline_id?: number;
  temperature?: string | null; score?: number; email?: string | null;
  next_follow_up_at?: string | null; last_activity_at?: string | null;
}

export interface FakeHandoutState {
  leads: FakeLead[];
  handouts: any[];
  items: any[];
  activities: any[];
  audit: any[];
  followups: any[];
  users: number[];                       // active user ids
  campaign: any;                         // the single campaign under test
  guard: { enabled: boolean; min_actioned_pct: number } | null;
  stages: Array<{ id: number; name: string; stage_type: string; is_default: boolean; sort_order: number; pipeline_id: number }>;
  dispositions: number[];
  /** set to a promise to freeze the FIRST claim mid-transaction (concurrency test) */
  holdAfterClaim: Promise<void> | null;
}

const STAGES = [
  { id: 51, name: 'New', stage_type: 'open', is_default: true, sort_order: 1, pipeline_id: 4 },
  { id: 52, name: 'Contacted', stage_type: 'open', is_default: false, sort_order: 2, pipeline_id: 4 },
  { id: 58, name: 'Won', stage_type: 'won', is_default: false, sort_order: 8, pipeline_id: 4 },
  { id: 59, name: 'Lost', stage_type: 'lost', is_default: false, sort_order: 9, pipeline_id: 4 },
];

/** audit_log.action CHECK — keep in step with db/migrations (006 -> 015 -> 019 -> 021). */
export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'login', 'export', 'transfer',
  'permission_change', 'merge', 'restore', 'handout'];

export const CAMPAIGN_ID = 5;
export const ORG = 1; export const BRANCH = 2; export const VERTICAL = 3; export const PIPELINE = 4;

/** n unassigned leads in the pool, oldest first, all 'med' priority unless overridden. */
export function poolLeads(n: number, over: Partial<FakeLead>[] = []): FakeLead[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    campaign_id: CAMPAIGN_ID,
    owner_id: null,
    full_name: `Lead ${i + 1}`,
    phone: `+9190000000${String(i).padStart(2, '0')}`,
    priority: 'med' as const,
    created_at: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),   // ascending = oldest first
    stage_id: 51, status_id: 31,
    is_active: true, deleted_at: null,
    org_id: ORG, branch_id: BRANCH, pipeline_id: PIPELINE,
    ...(over[i] ?? {}),
  }));
}

export function makeHandoutDb(init: Partial<FakeHandoutState> = {}) {
  const st: FakeHandoutState = {
    leads: poolLeads(25),
    handouts: [], items: [], activities: [], audit: [], followups: [],
    users: [11, 12, 13],
    campaign: {
      id: CAMPAIGN_ID, org_id: ORG, branch_id: BRANCH, vertical_id: VERTICAL, pipeline_id: PIPELINE,
      name: 'Meta July', is_active: true, deleted_at: null,
      distribution_config: { mode: 'on_demand', batch_size: 10, agent_user_ids: [11, 12] },
    },
    guard: { enabled: false, min_actioned_pct: 100 },
    stages: STAGES,
    dispositions: [81, 82],
    holdAfterClaim: null,
    ...init,
  };
  let hSeq = 700, iSeq = 800;
  /** lead_id -> the tx that holds it (FOR UPDATE). Released on COMMIT/ROLLBACK. */
  const locks = new Map<number, number>();

  const stageOf = (id: unknown) => st.stages.find((s) => Number(s.id) === Number(id)) ?? null;
  const inPool = (l: FakeLead) =>
    l.owner_id == null && l.is_active !== false && !l.deleted_at
    && !['won', 'lost'].includes(String(stageOf(l.stage_id)?.stage_type ?? 'open'))
    && !st.items.some((i) => Number(i.lead_id) === Number(l.id));
  const rank = (p: string) => (p === 'high' ? 0 : p === 'med' ? 1 : 2);
  const ordered = (ls: FakeLead[]) => ls.slice().sort((a, b) =>
    rank(a.priority) - rank(b.priority)
    || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    || a.id - b.id);

  const exec = async (sqlRaw: string, params: unknown[] = [], txId = 0): Promise<any[]> => {
    const s = sqlRaw.replace(/\s+/g, ' ').trim();

    // ---- settings ---------------------------------------------------------
    if (s.startsWith("SELECT value FROM app_setting")) {
      return st.guard ? [{ value: st.guard }] : [];
    }
    // ---- eligibility ------------------------------------------------------
    if (s.startsWith('SELECT c.id, c.org_id, c.branch_id')) {
      const c = st.campaign;
      return c && Number(c.id) === Number(params[0]) && c.is_active && !c.deleted_at ? [c] : [];
    }
    if (s.startsWith('SELECT id FROM "user" WHERE id = $1 AND status')) {
      return st.users.includes(Number(params[0])) ? [{ id: Number(params[0]) }] : [];
    }
    // ---- pool size --------------------------------------------------------
    if (s.startsWith('SELECT COUNT(*)::int AS n FROM lead l')) {
      return [{ n: st.leads.filter((l) => Number(l.campaign_id) === Number(params[0]) && inPool(l)).length }];
    }
    // ---- open batches (guardrail) ------------------------------------------
    if (s.startsWith('SELECT id, campaign_id, size, actioned_count FROM lead_handout')) {
      return st.handouts.filter((h) => Number(h.user_id) === Number(params[0]) && h.status === 'open')
        .sort((a, b) => b.id - a.id);
    }
    // ---- THE CLAIM (FOR UPDATE ... SKIP LOCKED) -----------------------------
    if (s.startsWith('WITH pool AS')) {
      const [campaignId, size, userId] = [Number(params[0]), Number(params[1]), Number(params[2])];
      const eligible = ordered(st.leads.filter((l) => Number(l.campaign_id) === campaignId && inPool(l)))
        // SKIP LOCKED: rows held by ANOTHER live transaction are skipped, not waited for
        .filter((l) => !locks.has(l.id) || locks.get(l.id) === txId)
        .slice(0, size);
      for (const l of eligible) {
        locks.set(l.id, txId);           // FOR UPDATE — held until commit/rollback
        l.owner_id = userId;             // the UPDATE ... SET owner_id
        l.last_activity_at = new Date().toISOString();
      }
      if (st.holdAfterClaim) {           // freeze THIS tx mid-flight (concurrency test)
        const hold = st.holdAfterClaim;
        st.holdAfterClaim = null;
        await hold;
      }
      return eligible.map((l) => ({
        id: l.id, full_name: l.full_name, phone: l.phone, priority: l.priority, created_at: l.created_at,
      }));
    }
    // ---- batch bookkeeping --------------------------------------------------
    if (s.startsWith("UPDATE lead_handout SET status = 'closed'")) {
      for (const h of st.handouts) {
        if (Number(h.user_id) === Number(params[0]) && Number(h.campaign_id) === Number(params[1]) && h.status === 'open') {
          h.status = 'closed'; h.completed_at = new Date().toISOString();
        }
      }
      return [];
    }
    if (s.startsWith('INSERT INTO lead_handout (')) {
      const h = {
        id: ++hSeq, org_id: params[0], branch_id: params[1], vertical_id: params[2], pipeline_id: params[3],
        campaign_id: params[4], user_id: params[5], requested_size: params[6], size: params[7],
        actioned_count: 0, status: 'open', created_at: new Date().toISOString(), completed_at: null,
      };
      st.handouts.push(h);
      return [{ id: h.id, created_at: h.created_at }];
    }
    if (s.startsWith('INSERT INTO lead_handout_item')) {
      if (st.items.some((i) => Number(i.lead_id) === Number(params[1]))) {
        throw new Error('duplicate key value violates unique constraint "lead_handout_item_lead_id_key"');
      }
      st.items.push({ id: ++iSeq, handout_id: Number(params[0]), lead_id: Number(params[1]), position: Number(params[2]), actioned_at: null, disposition_id: null });
      return [];
    }
    if (s.startsWith('INSERT INTO lead_activity')) {
      // `type` is a SQL LITERAL in these statements ('assign' | 'stage_change' | 'disposition'),
      // the remaining columns are positional params — mirror that faithfully.
      const type = /VALUES \(\$1,\$2,\$3,\$4,'(\w+)'/.exec(s)?.[1] ?? 'unknown';
      const cols = /INSERT INTO lead_activity \(([^)]+)\)/.exec(s)![1].split(',').map((c) => c.trim());
      const row: Record<string, unknown> = { type };
      let pi = 0;
      for (const col of cols) {
        if (col === 'type') continue;               // literal, not a param
        row[col] = params[pi++];
      }
      st.activities.push(row);
      return [];
    }
    if (s.startsWith('INSERT INTO audit_log')) {
      // The REAL audit_log.action is an enumerated CHECK (006, widened by 015/019/021).
      // A value outside it rolls the whole claim transaction back — that actually
      // happened in the WS4 live smoke ('handout' was not yet allowed), so the fake DB
      // enforces the constraint now: a new audit verb without a migration fails here.
      const action = /VALUES \(\$1,\$2,'lead_handout',\$3,'(\w+)'/.exec(s)?.[1] ?? '';
      if (!AUDIT_ACTIONS.includes(action)) {
        throw new Error(`new row for relation "audit_log" violates check constraint "audit_log_action_check" (action='${action}')`);
      }
      st.audit.push({ org_id: params[0], actor_id: params[1], entity_type: 'lead_handout', entity_id: params[2], action: 'handout', after: JSON.parse(String(params[3])) });
      return [];
    }
    // ---- batch read ---------------------------------------------------------
    if (s.startsWith('SELECT h.*, c.name AS campaign_name')) {
      const h = st.handouts.find((x) => Number(x.id) === Number(params[0]));
      return h ? [{ ...h, campaign_name: st.campaign.name, branch_name: 'Delhi', vertical_name: 'TLA' }] : [];
    }
    if (s.startsWith('SELECT i.position, i.actioned_at')) {
      return st.items.filter((i) => Number(i.handout_id) === Number(params[0]))
        .sort((a, b) => a.position - b.position)
        .map((i) => {
          const l = st.leads.find((x) => Number(x.id) === Number(i.lead_id))!;
          return {
            position: i.position, actioned_at: i.actioned_at, disposition_id: i.disposition_id,
            disposition_name: null, ...l, stage_name: stageOf(l.stage_id)?.name ?? null,
          };
        });
    }
    if (s.startsWith('SELECT id, name, sort_order, stage_type, is_default FROM pipeline_stage')) {
      return st.stages.filter((x) => Number(x.pipeline_id) === Number(params[0]));
    }
    if (s.startsWith('SELECT id FROM lead_handout WHERE user_id')) {
      const open = st.handouts.filter((h) => Number(h.user_id) === Number(params[0]) && h.status === 'open')
        .sort((a, b) => b.id - a.id);
      return open.length ? [{ id: open[0].id }] : [];
    }
    // ---- campaigns I can pull from ------------------------------------------
    if (s.startsWith('SELECT c.id, c.name, c.distribution_config, b.name AS branch_name')
      && s.includes('AS waiting') && !s.includes('oldest_waiting_at')) {
      const c = st.campaign;
      if (!c.is_active || c.deleted_at || (c.distribution_config?.mode ?? 'on_demand') !== 'on_demand') return [];
      return [{
        ...c, branch_name: 'Delhi', vertical_name: 'TLA', pipeline_name: 'Admissions',
        waiting: st.leads.filter((l) => Number(l.campaign_id) === Number(c.id) && inPool(l)).length,
      }];
    }
    // ---- manager pool view ---------------------------------------------------
    if (s.includes('oldest_waiting_at')) {
      const c = st.campaign;
      const waiting = st.leads.filter((l) => Number(l.campaign_id) === Number(c.id) && inPool(l));
      return [{
        ...c, branch_name: 'Delhi', vertical_name: 'TLA', pipeline_name: 'Admissions',
        waiting: waiting.length,
        oldest_waiting_at: waiting.length ? ordered(waiting)[0].created_at : null,
        handouts_today: st.handouts.length,
        leads_handed_today: st.handouts.reduce((n, h) => n + Number(h.size), 0),
        open_batches: st.handouts.filter((h) => h.status === 'open').length,
      }];
    }
    if (s.startsWith('SELECT h.id, h.campaign_id, c.name AS campaign_name')) {
      return st.handouts.slice().sort((a, b) => b.id - a.id)
        .map((h) => ({ ...h, campaign_name: st.campaign.name, user_name: `Agent ${h.user_id}` }));
    }
    // ---- action (dispositions) ------------------------------------------------
    if (s.startsWith('SELECT i.id, i.actioned_at, i.position')) {
      const i = st.items.find((x) => Number(x.handout_id) === Number(params[0]) && Number(x.lead_id) === Number(params[1]));
      if (!i) return [];
      const h = st.handouts.find((x) => Number(x.id) === Number(i.handout_id))!;
      const l = st.leads.find((x) => Number(x.id) === Number(i.lead_id))!;
      if (l.deleted_at) return [];
      return [{
        id: i.id, actioned_at: i.actioned_at, position: i.position,
        handout_id: h.id, user_id: h.user_id, size: h.size, handout_status: h.status,
        lead_id: l.id, org_id: ORG, branch_id: BRANCH, pipeline_id: PIPELINE,
        owner_id: l.owner_id, stage_id: l.stage_id, status_id: l.status_id,
      }];
    }
    if (s.startsWith('SELECT pipeline_id FROM pipeline_stage WHERE id')) {
      const stg = stageOf(params[0]);
      return stg ? [{ pipeline_id: stg.pipeline_id }] : [];
    }
    if (s.startsWith('SELECT id FROM m_disposition')) {
      return st.dispositions.includes(Number(params[0])) ? [{ id: Number(params[0]) }] : [];
    }
    if (s.startsWith('UPDATE lead SET') && s.includes('WHERE id = $')) {
      const idParam = /WHERE id = \$(\d+)/.exec(s)!;
      const id = Number(params[Number(idParam[1]) - 1]);
      const l = st.leads.find((x) => Number(x.id) === id);
      if (l) {
        const setPart = /SET (.+?) WHERE id/.exec(s)![1];
        for (const frag of setPart.split(',')) {
          const m = /^\s*(\w+) = \$(\d+)$/.exec(frag);
          if (m) (l as any)[m[1]] = params[Number(m[2]) - 1];
        }
        l.last_activity_at = new Date().toISOString();
      }
      return [];
    }
    if (s.startsWith('UPDATE lead_handout_item SET actioned_at')) {
      const i = st.items.find((x) => Number(x.id) === Number(params[0]));
      if (i) { i.actioned_at = new Date().toISOString(); i.disposition_id = params[1] ?? null; }
      return [];
    }
    if (s.startsWith('UPDATE lead_handout_item SET disposition_id')) {
      const i = st.items.find((x) => Number(x.id) === Number(params[0]));
      if (i) i.disposition_id = params[1] ?? null;
      return [];
    }
    if (s.startsWith('UPDATE lead_handout SET actioned_count')) {
      const h = st.handouts.find((x) => Number(x.id) === Number(params[0]));
      if (h) h.actioned_count += 1;
      return [];
    }
    if (s.startsWith("UPDATE lead_handout SET status = 'completed'")) {
      const h = st.handouts.find((x) => Number(x.id) === Number(params[0]));
      if (h && h.status === 'open' && h.actioned_count >= h.size) {
        h.status = 'completed'; h.completed_at = new Date().toISOString();
      }
      return [];
    }

    throw new Error(`fake-handout-db: unhandled SQL: ${s.slice(0, 110)}`);
  };

  let txSeq = 0;
  const db = {
    query: (sql: string, params?: unknown[]) => exec(sql, params),
    one: async (sql: string, params?: unknown[]) => (await exec(sql, params))[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => {
      const txId = ++txSeq;
      const snap = JSON.parse(JSON.stringify({
        leads: st.leads, handouts: st.handouts, items: st.items,
        activities: st.activities, audit: st.audit,
      }));
      try {
        const out = await fn({
          query: async (sql: string, params?: unknown[]) => {
            const rows = await exec(sql, params, txId);
            return { rows, rowCount: rows.length };
          },
        });
        return out;                                     // COMMIT
      } catch (e) {
        Object.assign(st, snap);                        // ROLLBACK
        throw e;
      } finally {
        for (const [leadId, owner] of [...locks]) if (owner === txId) locks.delete(leadId);
      }
    },
  } as unknown as DatabaseService;

  return { db, st };
}

/** 'all' record scope (record-scope itself is covered by the RBAC suite). */
export const ALL_SCOPE: ResolvedScope = {
  permissionKey: 'lead.pull', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

export const allResolver = { buildScopeWhere: () => '1=1' } as unknown as ScopeResolverService;

/**
 * Enforcer stub.
 *  · `deny`       — the campaign is outside the caller's record scope (loose check fails).
 *  · `denyStrict` — the caller's scope does not MAP onto campaigns (an `own`-scoped
 *                   counsellor): the loose check passes, the strict one 404s. That is
 *                   the real behaviour of ScopeEnforcer and it is what stops an
 *                   empty-agent-pool campaign becoming a scope hole.
 */
export function makeEnforcer(deny = false, denyStrict = false): ScopeEnforcerService {
  const boom = async () => {
    const { NotFoundException } = await import('@nestjs/common');
    throw new NotFoundException('campaign not found');
  };
  return {
    assertRefInScope: async () => { if (deny) await boom(); },
    assertInScope: async () => { if (deny || denyStrict) await boom(); },
  } as unknown as ScopeEnforcerService;
}

export function makeHandout(
  db: DatabaseService,
  opts: {
    denyScope?: boolean; denyStrictScope?: boolean;
    followups?: FollowUpsService; resolver?: ScopeResolverService;
  } = {},
) {
  const followups = opts.followups
    ?? ({ create: async () => ({ id: 1 }) } as unknown as FollowUpsService);
  return new HandoutService(
    db, opts.resolver ?? allResolver, makeEnforcer(opts.denyScope, opts.denyStrictScope), followups,
  );
}

/** An `own`-scoped counsellor: allowed, but no filter maps onto a campaign. */
export const OWN_SCOPE: ResolvedScope = {
  permissionKey: 'lead.pull', allowed: true, all: false,
  filters: [{ kind: 'own', userId: 11 }], allowedFields: null, deniedFields: [],
};

/** buildScopeWhere over CAMPAIGN_SCOPE_COLS for an own-only scope -> '1=0' (no owner column). */
export const ownResolver = { buildScopeWhere: () => '1=0' } as unknown as ScopeResolverService;
