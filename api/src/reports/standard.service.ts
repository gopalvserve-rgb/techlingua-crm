import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { entityByKey } from './entities';
import { Me, ReportService } from './report.service';
import {
  ENROLMENT_COUNTS_AS_SOLD, SLA_ELAPSED_COLUMN, SLA_FIRST_RESPONSE_METRIC,
  STAGE_COUNT_FROM, STAGE_COUNT_LIVE,
} from './shared-metrics';

/**
 * THE STANDARD REPORTS — the four the client asked for by name (§5):
 * activity · TAT · funnel analytics · campaign reports / ROI.
 *
 * Each one is an AGGREGATE, not a row list, which is why they are endpoints rather than
 * saved report definitions: "conversion from Contacted to Qualified" is not a column of
 * anything. The Report Builder covers the row-list half; this covers the shaped half.
 *
 * EVERY ONE IS SCOPED THROUGH THE SAME ScopeResolver AS EVERYTHING ELSE, and every one
 * imports its definitions from shared-metrics.ts, so the numbers here and the numbers on
 * the dashboard are the same numbers — see reconcile.spec.ts, which fails if they drift.
 */
@Injectable()
export class StandardReportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly reports: ReportService,
  ) {}

  private async leadScope(me: Me): Promise<ResolvedScope> {
    return this.reports.scopeFor(me.id, 'lead.read');
  }

  private window(f: { from?: string; to?: string }) {
    return [f.from ? String(f.from).slice(0, 10) : null, f.to ? String(f.to).slice(0, 10) : null];
  }

  /* ==================================================================== FUNNEL */

  /**
   * FUNNEL ANALYTICS — stage-to-stage conversion and DROP-OFF.
   *
   * The counting core is `STAGE_COUNT_FROM` / `STAGE_COUNT_LIVE`, imported — the same
   * literals the dashboard's `by_stage` uses. That is not tidiness: the client's
   * dashboard shows a funnel, this screen shows a funnel, and if they ever differ by one
   * lead he is right to distrust both.
   *
   * Stages are aggregated BY NAME across pipelines, exactly as the web funnel already
   * does (dyn.tsx `funnelRows`), because "Contacted" in the Admissions pipeline and
   * "Contacted" in the Corporate pipeline are the same step to the person reading it.
   */
  async funnel(me: Me, f: { from?: string; to?: string } = {}) {
    const scope = await this.leadScope(me);
    const [from, to] = this.window(f);
    const params: unknown[] = [from, to];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);

    const rows = await this.db.query<any>(
      `SELECT st.name,
              min(st.sort_order)::int AS sort_order,
              max(st.stage_type)      AS stage_type,
              count(l.id)::int        AS ct
         FROM ${STAGE_COUNT_FROM}
        WHERE (${w}) AND ${STAGE_COUNT_LIVE}
          AND ($1::date IS NULL OR l.created_at >= $1::date)
          AND ($2::date IS NULL OR l.created_at <  $2::date)
        GROUP BY st.name
        ORDER BY min(st.sort_order)`,
      params,
    );

    const stages = rows.map((r) => ({ name: r.name, stage_type: r.stage_type, sort_order: Number(r.sort_order), count: Number(r.ct) }));
    const entered = stages.reduce((a, s) => a + s.count, 0);
    const first = stages[0]?.count ?? 0;

    // CONVERSION IS "OF THE STAGE BEFORE IT". Not "of the total" — those are different
    // questions and mixing them is how a funnel says 140%. Drop-off is the complement.
    const steps = stages.map((s, i) => {
      const prev = i === 0 ? null : stages[i - 1].count;
      const conv = prev == null ? null : prev === 0 ? null : Math.round((s.count * 1000) / prev) / 10;
      return {
        ...s,
        from_previous_pct: conv,
        dropped: prev == null ? null : Math.max(0, prev - s.count),
        of_first_pct: first === 0 ? null : Math.round((s.count * 1000) / first) / 10,
      };
    });
    const won = stages.filter((s) => s.stage_type === 'won').reduce((a, s) => a + s.count, 0);
    const lost = stages.filter((s) => s.stage_type === 'lost').reduce((a, s) => a + s.count, 0);

    return {
      range: { from, to },
      stages: steps,
      totals: {
        leads: entered, won, lost,
        // Overall conversion is won/ALL leads in the window — the same arithmetic the
        // dashboard's "won" KPI implies. It is NOT the product of the step ratios.
        conversion_pct: entered === 0 ? 0 : Math.round((won * 1000) / entered) / 10,
      },
      scope: { unrestricted: scope.all === true },
    };
  }

  /* ======================================================================= TAT */

  /**
   * TAT REPORTS — first response, time in stage, lead-to-enrolment.
   *
   * FIRST RESPONSE comes from `lead_sla` (metric 'first_response'), and TIME IN STAGE
   * from `lead_stage_tat` — the two Sprint-3 tables, which exist for exactly this. No
   * new measurement was invented for this screen.
   *
   * MEDIAN, not mean, on both. One lead created on Friday evening and answered on Monday
   * drags a mean into meaninglessness, and the client would be looking at an average
   * that describes nobody. The mean is shown too, and labelled, because a manager
   * chasing an outlier wants to know it is there.
   */
  async tat(me: Me, f: { from?: string; to?: string } = {}) {
    const scope = await this.leadScope(me);
    const [from, to] = this.window(f);

    const p1: unknown[] = [from, to];
    const w1 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p1);
    const first = await this.db.one<any>(
      `SELECT count(*)::int AS n,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY sla.${SLA_ELAPSED_COLUMN})::int AS median_seconds,
              avg(sla.${SLA_ELAPSED_COLUMN})::numeric AS mean_seconds,
              count(*) FILTER (WHERE sla.breached_at IS NOT NULL)::int AS breached
         FROM lead_sla sla JOIN lead l ON l.id = sla.lead_id
        WHERE (${w1}) AND l.deleted_at IS NULL
          AND sla.metric = ${SLA_FIRST_RESPONSE_METRIC}
          AND sla.${SLA_ELAPSED_COLUMN} IS NOT NULL
          AND ($1::date IS NULL OR sla.started_at >= $1::date)
          AND ($2::date IS NULL OR sla.started_at <  $2::date)`,
      p1,
    );

    const p2: unknown[] = [from, to];
    const w2 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p2);
    // TIME IN STAGE only counts stages the lead has LEFT (`seconds IS NOT NULL`).
    // Counting the stage a lead currently sits in would report "0 minutes in Contacted"
    // for every lead contacted this morning and pull the median to the floor.
    const byStage = await this.db.query<any>(
      `SELECT st.name,
              min(st.sort_order)::int AS sort_order,
              count(*)::int AS n,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY t.seconds)::int AS median_seconds,
              avg(t.seconds)::numeric AS mean_seconds
         FROM lead_stage_tat t
         JOIN lead l ON l.id = t.lead_id
         JOIN pipeline_stage st ON st.id = t.stage_id
        WHERE (${w2}) AND l.deleted_at IS NULL AND t.seconds IS NOT NULL
          AND ($1::date IS NULL OR t.entered_at >= $1::date)
          AND ($2::date IS NULL OR t.entered_at <  $2::date)
        GROUP BY st.name
        ORDER BY min(st.sort_order)`,
      p2,
    );

    const p3: unknown[] = [from, to];
    const w3 = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, p3);
    const toEnrol = await this.db.one<any>(
      `SELECT count(*)::int AS n,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.created_at - l.created_at)))::int AS median_seconds,
              avg(EXTRACT(EPOCH FROM (e.created_at - l.created_at)))::numeric AS mean_seconds
         FROM enrolment e JOIN lead l ON l.id = e.lead_id
        WHERE (${w3}) AND e.deleted_at IS NULL AND l.deleted_at IS NULL AND e.${ENROLMENT_COUNTS_AS_SOLD}
          AND ($1::date IS NULL OR e.created_at >= $1::date)
          AND ($2::date IS NULL OR e.created_at <  $2::date)`,
      p3,
    );

    const mins = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) / 60));
    return {
      range: { from, to },
      first_response: {
        n: Number(first?.n ?? 0),
        median_minutes: mins(first?.median_seconds),
        mean_minutes: mins(first?.mean_seconds),
        breached: Number(first?.breached ?? 0),
      },
      by_stage: byStage.map((r) => ({
        stage: r.name, n: Number(r.n),
        median_minutes: mins(r.median_seconds), mean_minutes: mins(r.mean_seconds),
      })),
      lead_to_enrolment: {
        n: Number(toEnrol?.n ?? 0),
        median_minutes: mins(toEnrol?.median_seconds),
        mean_minutes: mins(toEnrol?.mean_seconds),
      },
      scope: { unrestricted: scope.all === true },
    };
  }

  /* ================================================================== ACTIVITY */

  /**
   * ACTIVITY REPORTS — who did what, by user.
   *
   * The old screen counted `audit_log` rows in the BROWSER and called one column "Calls"
   * with a dash in it. This reads the real tables, server-side, scoped:
   *   · activities  = lead_activity rows the user logged (dispositions, notes, stage moves)
   *   · follow-ups  = tasks completed
   *   · logins      = audit_log action 'login'
   *   · edits       = audit_log action 'update'
   *
   * THERE IS STILL NO "CALLS" COLUMN, and there will not be one: TELEPHONY IS OUT OF
   * SCOPE (a standing project rule). The prototype drew the column; inventing a call
   * count from nothing would be the worst kind of green tick, so the column is named
   * "Activity" and reports what we actually have.
   */
  async activity(me: Me, f: { from?: string; to?: string } = {}) {
    const scope = await this.leadScope(me);
    const [from, to] = this.window(f);
    const params: unknown[] = [from, to];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);

    const rows = await this.db.query<any>(
      `WITH scoped_leads AS (
         SELECT l.id, l.owner_id FROM lead l WHERE l.deleted_at IS NULL AND (${w})
       ),
       people AS (
         SELECT DISTINCT owner_id AS user_id FROM scoped_leads WHERE owner_id IS NOT NULL
       )
       SELECT p.user_id, u.name AS user_name,
              (SELECT count(*)::int FROM lead_activity la JOIN scoped_leads sl ON sl.id = la.lead_id
                WHERE la.actor_id = p.user_id
                  AND ($1::date IS NULL OR la.occurred_at >= $1::date)
                  AND ($2::date IS NULL OR la.occurred_at <  $2::date)) AS activities,
              (SELECT count(*)::int FROM lead_activity la2 JOIN scoped_leads sl2 ON sl2.id = la2.lead_id
                WHERE la2.actor_id = p.user_id AND la2.type = 'note'
                  AND ($1::date IS NULL OR la2.occurred_at >= $1::date)
                  AND ($2::date IS NULL OR la2.occurred_at <  $2::date)) AS notes,
              (SELECT count(*)::int FROM follow_up fu JOIN scoped_leads sl3 ON sl3.id = fu.lead_id
                WHERE fu.owner_id = p.user_id AND fu.deleted_at IS NULL AND fu.completed_at IS NOT NULL
                  AND ($1::date IS NULL OR fu.completed_at >= $1::date)
                  AND ($2::date IS NULL OR fu.completed_at <  $2::date)) AS followups_done,
              (SELECT count(*)::int FROM audit_log al
                WHERE al.actor_id = p.user_id AND al.action = 'login'
                  AND ($1::date IS NULL OR al.occurred_at >= $1::date)
                  AND ($2::date IS NULL OR al.occurred_at <  $2::date)) AS logins,
              (SELECT count(*)::int FROM audit_log al2
                WHERE al2.actor_id = p.user_id AND al2.action = 'update'
                  AND ($1::date IS NULL OR al2.occurred_at >= $1::date)
                  AND ($2::date IS NULL OR al2.occurred_at <  $2::date)) AS edits
         FROM people p JOIN "user" u ON u.id = p.user_id
        WHERE u.deleted_at IS NULL
        ORDER BY activities DESC, u.name
        LIMIT 200`,
      params,
    );

    return {
      range: { from, to },
      // `telephony: false` is in the payload on purpose: the UI reads it and prints the
      // reason next to the missing Calls column, rather than showing an em-dash the
      // client has to ask about.
      telephony: false,
      rows: rows.map((r) => ({
        user_id: Number(r.user_id), user_name: r.user_name,
        activities: Number(r.activities), notes: Number(r.notes),
        followups_done: Number(r.followups_done), logins: Number(r.logins), edits: Number(r.edits),
      })),
      scope: { unrestricted: scope.all === true },
    };
  }

  /* ======================================================================= ROI */

  /**
   * CAMPAIGN REPORTS / ROI.
   *
   * This deliberately runs THE REPORT BUILDER, on the `campaigns` entity, with the ROI
   * columns. It is not a second query: cost, leads, enrolments, CPL and revenue are
   * defined once, in entities.ts, and both the ROI screen and a user-built campaign
   * report read the same definitions. Two implementations of "cost per lead" is exactly
   * the DEF-S5-03 shape of bug, and this is how it is prevented rather than fixed later.
   */
  async roi(me: Me, f: { from?: string; to?: string } = {}) {
    const entity = entityByKey('campaigns')!;
    const out = await this.reports.execute(entity, {
      columns: ['name', 'branch', 'vertical', 'cost', 'leads', 'enrolments', 'cpl', 'revenue'],
      sort: [{ col: 'revenue', dir: 'desc' }],
      date_field: 'created_at',
      date_preset: f.from || f.to ? 'custom' : 'all',
      date_from: f.from, date_to: f.to,
      limit: 500,
    }, me);

    const idx = (k: string) => out.columns.findIndex((c) => c.key === k);
    const iCost = idx('cost'); const iLeads = idx('leads'); const iEnr = idx('enrolments'); const iRev = idx('revenue');
    const num = (r: unknown[], i: number) => (i < 0 ? 0 : Number(r[i] ?? 0));
    const totals = out.rows.reduce((a, r) => ({
      cost_minor: a.cost_minor + num(r, iCost),
      leads: a.leads + num(r, iLeads),
      enrolments: a.enrolments + num(r, iEnr),
      revenue_minor: a.revenue_minor + num(r, iRev),
    }), { cost_minor: 0, leads: 0, enrolments: 0, revenue_minor: 0 });

    return {
      range: { from: f.from ?? null, to: f.to ?? null },
      columns: out.columns,
      rows: out.rows,
      totals: {
        ...totals,
        cpl_minor: totals.leads === 0 ? null : Math.round(totals.cost_minor / totals.leads),
        cpa_minor: totals.enrolments === 0 ? null : Math.round(totals.cost_minor / totals.enrolments),
        // ROI as a MULTIPLE of spend, not a percentage: "3.4x" is what a marketer says.
        // Null when nothing was spent — "infinite ROI" is a joke, not a number.
        roi_x: totals.cost_minor === 0 ? null : Math.round((totals.revenue_minor / totals.cost_minor) * 100) / 100,
      },
      // Revenue here is BOOKED (decision pending with the client — PROJECT_STATUS §4b).
      // The screen says so; a marketer comparing spend against cash would otherwise
      // conclude the campaign lost money because the student pays in three instalments.
      basis: 'booked',
      scope: out.scope,
    };
  }
}
