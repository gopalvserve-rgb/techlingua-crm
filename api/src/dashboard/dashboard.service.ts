import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS, LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { STAGE_COUNT_FROM, STAGE_COUNT_LIVE, leadWonConversionPct } from '../reports/shared-metrics';
import { toDateString } from '../common/date.util';

/**
 * ROLE-BASED DASHBOARDS (client decision, 14 Jul 2026).
 *
 *   Counsellor      -> own leads / tasks / targets
 *   Team Leader     -> their team
 *   Branch Manager  -> their branch + team
 *   Vertical Head   -> their vertical
 *   Admin           -> org-wide
 *
 * THE VIEW IS DERIVED FROM THE RBAC SCOPE, NOT FROM A ROLE NAME.
 * `viewOf()` reads the ResolvedScope the central ScopeResolver already produced for
 * `lead.read` and takes the WIDEST filter kind it contains. This matters because:
 *
 *   · custom roles are a first-class feature — a role called "Senior Counsellor" with
 *     branch scope must get the branch dashboard, and a role name lookup would miss it;
 *   · a user may span several units, and the union is what they may actually see;
 *   · the widget MIX changes with the view, but the DATA is scoped by the same
 *     `buildScopeWhere` fragment either way — so a counsellor cannot see branch numbers
 *     even if the view were mislabelled. The SQL simply cannot return them.
 *
 * Every query below therefore starts from `buildScopeWhere(scope, ...)`. There is no
 * hand-rolled `WHERE owner_id = me` anywhere in this file.
 */

export type DashboardView = 'counsellor' | 'team' | 'branch' | 'vertical' | 'admin';

/** Widest-wins: the dashboard follows the broadest thing the user is allowed to see. */
export function viewOf(scope: ResolvedScope): DashboardView {
  if (!scope.allowed) return 'counsellor';
  if (scope.all) return 'admin';
  const kinds = new Set(scope.filters.map((f) => f.kind));
  if (kinds.has('vertical')) return 'vertical';
  if (kinds.has('branch')) return 'branch';
  if (kinds.has('pipeline') || kinds.has('campaign')) return 'branch';  // unit managers, not individuals
  if (kinds.has('team')) return 'team';
  return 'counsellor';
}

/** Which widgets each view gets. The design language is identical; the mix differs. */
export const WIDGETS: Record<DashboardView, string[]> = {
  counsellor: ['kpis', 'my_tasks', 'today_followups', 'my_leads', 'my_targets', 'ai_insights'],
  team: ['kpis', 'my_tasks', 'today_followups', 'team_leaderboard', 'funnel', 'series', 'ai_insights'],
  branch: ['kpis', 'today_followups', 'overdue', 'team_leaderboard', 'funnel', 'series', 'sla', 'walkins', 'referrals', 'ai_insights'],
  vertical: ['kpis', 'today_followups', 'overdue', 'team_leaderboard', 'funnel', 'series', 'sla', 'walkins', 'referrals', 'ai_insights'],
  admin: ['kpis', 'today_followups', 'overdue', 'team_leaderboard', 'funnel', 'series', 'sla', 'walkins', 'referrals', 'sources', 'ai_insights'],
};

const isManagerView = (v: DashboardView) => v === 'branch' || v === 'vertical' || v === 'admin';

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /**
   * Quick Stats with a CUSTOM DATE RANGE (Phase-1 scope: "Quick Stats (custom date range)").
   * `from`/`to` are inclusive dates; defaults to the current month.
   */
  private range(from?: string, to?: string): { from: string; to: string } {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const now = new Date();
    // THE TRI-STATE MATTERS. `toDateString` returns `undefined` for "that is not a date"
    // and `null` for "there wasn't one" — and they must NOT be conflated: defaulting an
    // INVALID range to the current month turns `?from=last-tuesday` from a 400 into a
    // silently different answer, which is the widening bug this project keeps meeting.
    const parse = (v: unknown, dflt: string) => {
      const d = toDateString(v);
      if (d === undefined) throw new BadRequestException('from / to must be YYYY-MM-DD dates');
      return d ?? dflt;
    };
    const f = parse(from, iso(new Date(now.getFullYear(), now.getMonth(), 1)));
    const t = parse(to, iso(now));
    if (f > t) throw new BadRequestException('"from" must not be after "to"');
    return { from: f, to: t };
  }

  /** THE dashboard payload. One call, scoped, with the widget list for the caller's view. */
  async overview(scope: ResolvedScope, userId: number, q: { from?: string; to?: string } = {}) {
    const view = viewOf(scope);
    const { from, to } = this.range(q.from, q.to);

    const p: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p);
    p.push(from, to);
    const iFrom = `$${p.length - 1}`;
    const iTo = `$${p.length}`;

    const kpis = await this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE l.created_at::date = CURRENT_DATE)::int AS today,
              COUNT(*) FILTER (WHERE l.created_at::date BETWEEN ${iFrom}::date AND ${iTo}::date)::int AS in_range,
              COUNT(*) FILTER (WHERE st.stage_type = 'won')::int AS won,
              COUNT(*) FILTER (WHERE st.stage_type = 'won'
                                 AND l.updated_at::date BETWEEN ${iFrom}::date AND ${iTo}::date)::int AS won_in_range,
              COUNT(*) FILTER (WHERE st.stage_type = 'lost')::int AS lost,
              COUNT(*) FILTER (WHERE l.temperature = 'hot')::int  AS hot,
              COUNT(*) FILTER (WHERE l.temperature = 'warm')::int AS warm,
              COUNT(*) FILTER (WHERE l.temperature = 'cold')::int AS cold,
              COUNT(*) FILTER (WHERE l.is_flagged)::int AS flagged,
              COUNT(*) FILTER (WHERE l.owner_id IS NULL)::int AS unassigned
         FROM lead l
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL`, p,
    );

    // follow-ups: the SAME resolved scope, mapped onto the follow-up columns
    const pf: unknown[] = [];
    const wf = this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, pf);
    pf.push(userId);
    const me = `$${pf.length}`;
    const followUps = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE f.status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at::date = CURRENT_DATE)::int AS due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at < date_trunc('day', now()))::int AS overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at::date = CURRENT_DATE)::int AS done_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.escalated_at IS NOT NULL)::int AS escalated,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = ${me})::int AS my_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = ${me}
                                 AND f.scheduled_at::date = CURRENT_DATE)::int AS my_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = ${me}
                                 AND f.scheduled_at < date_trunc('day', now()))::int AS my_overdue
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${wf}) AND f.is_active AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, pf,
    );

    const p2: unknown[] = [];
    const w2 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p2);
    // Sprint 6: the FROM and the live-row predicate are imported constants shared with
    // the Funnel Analytics report (reports/shared-metrics.ts). The dashboard funnel and
    // the funnel report must count the same leads, and reconcile.spec.ts fails if one of
    // them is edited without the other. (DEF-S5-03: two screens, two definitions, one
    // client who stopped believing either.)
    const byStage = await this.db.query(
      `SELECT st.id AS stage_id, st.name, st.stage_type, st.sort_order, COUNT(l.id)::int AS ct
         FROM ${STAGE_COUNT_FROM}
        WHERE (${w2}) AND ${STAGE_COUNT_LIVE}
        GROUP BY st.id, st.name, st.stage_type, st.sort_order
        ORDER BY st.sort_order`, p2,
    );

    const p3: unknown[] = [];
    const w3 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p3);
    const series = await this.db.query(
      `SELECT d::date AS day,
              (SELECT COUNT(*)::int FROM lead l
                WHERE (${w3}) AND l.is_active AND l.deleted_at IS NULL AND l.created_at::date = d::date) AS leads,
              (SELECT COUNT(*)::int FROM lead l JOIN pipeline_stage st ON st.id = l.stage_id
                WHERE (${w3}) AND l.is_active AND l.deleted_at IS NULL AND st.stage_type = 'won'
                  AND l.updated_at::date = d::date) AS won
         FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, '1 day') d
        ORDER BY d`, p3,
    );

    // --- manager-only widgets. A counsellor never even issues these queries, and if
    //     they did, buildScopeWhere would reduce them to their own rows anyway.
    let leaderboard: unknown[] = [];
    let sla: Record<string, unknown> | null = null;
    if (isManagerView(view) || view === 'team') {
      const p4: unknown[] = [];
      const w4 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p4);
      p4.push(from, to);
      leaderboard = await this.db.query(
        `SELECT u.id AS user_id, u.name,
                COUNT(*)::int AS leads,
                COUNT(*) FILTER (WHERE st.stage_type = 'won')::int AS won,
                COUNT(*) FILTER (WHERE l.created_at::date BETWEEN $${p4.length - 1}::date AND $${p4.length}::date)::int AS new_in_range
           FROM lead l
           JOIN "user" u ON u.id = l.owner_id
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE (${w4}) AND l.is_active AND l.deleted_at IS NULL
          GROUP BY u.id, u.name
          ORDER BY won DESC, leads DESC
          LIMIT 10`, p4,
      );
    }
    if (isManagerView(view)) {
      const p5: unknown[] = [];
      const w5 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p5);
      sla = await this.db.one(
        `SELECT COUNT(*) FILTER (WHERE s.satisfied_at IS NULL AND s.due_at <= now())::int AS open_breaches,
                COUNT(*) FILTER (WHERE s.breached_at >= date_trunc('day', now()))::int AS breaches_today,
                COALESCE(ROUND(AVG(s.elapsed_seconds) FILTER (
                  WHERE s.metric = 'first_response' AND s.satisfied_at IS NOT NULL))::int, 0) AS avg_response_seconds
           FROM lead_sla s JOIN lead l ON l.id = s.lead_id
          WHERE (${w5}) AND l.deleted_at IS NULL AND l.is_active`, p5,
      );
    }

    // walk-ins & referrals (scoped through the lead they created; a counsellor sees theirs)
    const p6: unknown[] = [];
    const w6 = this.resolver.buildScopeWhere(scope, { owner: 'wl.owner_id', team: 'wl.team_id', branch: 'wl.branch_id', vertical: 'wl.vertical_id', pipeline: 'wl.pipeline_id', campaign: 'wl.campaign_id' }, p6);
    const walkins = await this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE w.visited_at::date = CURRENT_DATE)::int AS today,
              COUNT(*) FILTER (WHERE w.status = 'converted')::int AS converted
         FROM walk_in w LEFT JOIN lead wl ON wl.id = w.lead_id
        WHERE (${w6}) AND w.deleted_at IS NULL`, p6,
    );
    const p7: unknown[] = [];
    const w7 = this.resolver.buildScopeWhere(scope, { owner: 'rl.owner_id', team: 'rl.team_id', branch: 'rl.branch_id', vertical: 'rl.vertical_id', pipeline: 'rl.pipeline_id', campaign: 'rl.campaign_id' }, p7);
    const referrals = await this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE r.created_at >= date_trunc('month', now()))::int AS mtd,
              COUNT(*) FILTER (WHERE r.status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE r.status IN ('converted','rewarded'))::int AS rewardable
         FROM referral r LEFT JOIN lead rl ON rl.id = r.lead_id
        WHERE (${w7}) AND r.deleted_at IS NULL`, p7,
    );

    return {
      view,
      widgets: WIDGETS[view],
      range: { from, to },
      kpis,
      follow_ups: followUps,
      by_stage: byStage,
      series,
      leaderboard,
      sla,
      walkins,
      referrals,
    };
  }

  /**
   * Quick Stats — the same numbers for an ARBITRARY range (the client asked for a
   * custom date range). Separate endpoint so the range control doesn't refetch the
   * whole dashboard.
   */
  async quickStats(scope: ResolvedScope, q: { from?: string; to?: string }) {
    const { from, to } = this.range(q.from, q.to);
    const p: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p);
    p.push(from, to);
    const a = `$${p.length - 1}::date`;
    const b = `$${p.length}::date`;
    const row = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE l.created_at::date BETWEEN ${a} AND ${b})::int AS leads,
              COUNT(*) FILTER (WHERE st.stage_type = 'won'
                                 AND l.updated_at::date BETWEEN ${a} AND ${b})::int AS won,
              COUNT(*) FILTER (WHERE st.stage_type = 'lost'
                                 AND l.updated_at::date BETWEEN ${a} AND ${b})::int AS lost,
              COUNT(*) FILTER (WHERE l.temperature = 'hot'
                                 AND l.created_at::date BETWEEN ${a} AND ${b})::int AS hot,
              COUNT(*) FILTER (WHERE l.is_duplicate
                                 AND l.created_at::date BETWEEN ${a} AND ${b})::int AS duplicates
         FROM lead l LEFT JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL`, p,
    );
    const pf: unknown[] = [];
    const wf = this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, pf);
    pf.push(from, to);
    const fa = `$${pf.length - 1}::date`;
    const fb = `$${pf.length}::date`;
    const fu = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE f.status = 'done'
                                 AND f.completed_at::date BETWEEN ${fa} AND ${fb})::int AS followups_done,
              COUNT(*) FILTER (WHERE f.scheduled_at::date BETWEEN ${fa} AND ${fb})::int AS followups_scheduled
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${wf}) AND f.is_active AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, pf,
    );
    const leads = Number((row as any)?.leads ?? 0);
    const won = Number((row as any)?.won ?? 0);
    return {
      range: { from, to },
      view: viewOf(scope),
      ...row, ...fu,
      // OBS-S16-05: one definition, imported — and one decimal, like every other
      // reader. This used to round to a whole number all by itself.
      conversion_rate: leadWonConversionPct(won, leads),
    };
  }
}
