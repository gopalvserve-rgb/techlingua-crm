import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * COUNSELLOR PERFORMANCE — "leads handled, calls, conversion %, revenue, TAT,
 * follow-up adherence & enrolments, with a leaderboard" (§5 / the prototype's own
 * column list).
 *
 * =============================================================================
 * SCOPING — the Sprint-3 dashboard rule, unchanged
 * =============================================================================
 * The rows are the USERS the caller may see, derived from the ScopeResolver and NOT
 * from a role name (custom roles are first-class). A counsellor with `performance.read`
 * at `own` scope gets a leaderboard of exactly one row — himself. He cannot see his
 * colleague's conversion rate, by construction: the scope fragment is inside the SQL,
 * not applied afterwards in JavaScript.
 *
 * =============================================================================
 * WHAT EACH COLUMN MEANS (so the client and the Sprint-6 reports agree)
 * =============================================================================
 *   leads          leads currently OWNED by the counsellor, created in the window.
 *   enrolments     `active` enrolments they closed in the window. Not pending ones.
 *   conversion %   enrolments / leads. It can exceed 100% in a window where somebody
 *                  closes leads created last month — that is TRUE, and hiding it by
 *                  capping would be a lie. The screen says "of leads created in range".
 *   revenue        BOOKED (`net_fee_minor` of those enrolments), not collected.
 *   collected      cash actually receipted in the window. Shown SEPARATELY on purpose.
 *   activities     timeline events they logged — the "calls" column of the prototype,
 *                  honestly named, because TELEPHONY IS OUT OF SCOPE and we do not have
 *                  call counts. Dispositions + follow-ups + notes are what we DO have.
 *   TAT            median minutes to first response, from `lead_stage_tat` — the
 *                  Sprint-3 table, not a second measurement.
 *   adherence      follow-ups completed on time / follow-ups due. A counsellor with
 *                  nothing due is shown "—", not 0% or 100%.
 *
 * CALLS: the column exists in the prototype. It reports ACTIVITIES, and the UI labels
 * it "Activity". Telephony is out of scope (a standing project rule) — inventing a call
 * count from nothing would be the worst kind of green tick.
 */

@Injectable()
export class PerformanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /**
   * The leaderboard. `from`/`to` default to the current month.
   *
   * One query. Every per-counsellor aggregate is a LATERAL against the SAME scoped user
   * set, so a counsellor cannot appear in one column and vanish from another.
   */
  async leaderboard(scope: ResolvedScope, f: { from?: string; to?: string } = {}) {
    const from = f.from ? `${String(f.from).slice(0, 10)}` : null;
    const to = f.to ? `${String(f.to).slice(0, 10)}` : null;

    // WHICH USERS. The scope is applied to the LEADS a user owns — a counsellor's own
    // scope resolves to `l.owner_id = me`, so the user set collapses to himself.
    const params: unknown[] = [from, to];
    const leadWhere = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const enrWhere = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, params);

    // `$1`/`$2` are the window; NULL means "no bound". The explicit ::date casts are the
    // Sprint-3 `$3`-cast lesson — an inferred parameter type is a live-only failure.
    const rows = await this.db.query<any>(
      `WITH win AS (
         SELECT COALESCE($1::date, date_trunc('month', now())::date) AS d_from,
                COALESCE($2::date, (date_trunc('month', now()) + INTERVAL '1 month')::date) AS d_to
       ),
       scoped_leads AS (
         SELECT l.id, l.owner_id, l.created_at
           FROM lead l WHERE l.deleted_at IS NULL AND ${leadWhere}
       ),
       scoped_enr AS (
         SELECT e.id, e.counsellor_id, e.created_at, e.net_fee_minor, e.status
           FROM enrolment e WHERE e.deleted_at IS NULL AND ${enrWhere}
       ),
       people AS (
         SELECT DISTINCT owner_id AS user_id FROM scoped_leads WHERE owner_id IS NOT NULL
         UNION
         SELECT DISTINCT counsellor_id FROM scoped_enr WHERE counsellor_id IS NOT NULL
       )
       SELECT p.user_id,
              u.name AS user_name,
              (SELECT count(*) FROM scoped_leads sl, win w
                WHERE sl.owner_id = p.user_id
                  AND sl.created_at >= w.d_from AND sl.created_at < w.d_to) AS leads,
              (SELECT count(*) FROM scoped_enr se, win w
                WHERE se.counsellor_id = p.user_id AND se.status = 'active'
                  AND se.created_at >= w.d_from AND se.created_at < w.d_to) AS enrolments,
              (SELECT COALESCE(sum(se.net_fee_minor), 0) FROM scoped_enr se, win w
                WHERE se.counsellor_id = p.user_id AND se.status = 'active'
                  AND se.created_at >= w.d_from AND se.created_at < w.d_to) AS revenue_minor,
              (SELECT COALESCE(sum(fr.amount_minor), 0)
                 FROM fee_receipt fr JOIN scoped_enr se ON se.id = fr.enrolment_id, win w
                WHERE fr.received_by = p.user_id AND fr.deleted_at IS NULL
                  AND fr.received_at >= w.d_from AND fr.received_at < w.d_to) AS collected_minor,
              (SELECT count(*) FROM lead_activity la JOIN scoped_leads sl ON sl.id = la.lead_id, win w
                WHERE la.actor_id = p.user_id
                  AND la.occurred_at >= w.d_from AND la.occurred_at < w.d_to) AS activities,
              -- follow_up's due column is scheduled_at (005_lead.sql). There is no
              -- due_at on this table; there IS one on lead_sla, which is a different
              -- clock entirely. Pinned by sprint5-sql-schema.spec.ts.
              (SELECT count(*) FROM follow_up fu JOIN scoped_leads sl ON sl.id = fu.lead_id, win w
                WHERE fu.owner_id = p.user_id AND fu.deleted_at IS NULL
                  AND fu.scheduled_at >= w.d_from AND fu.scheduled_at < w.d_to) AS followups_due,
              (SELECT count(*) FROM follow_up fu JOIN scoped_leads sl ON sl.id = fu.lead_id, win w
                WHERE fu.owner_id = p.user_id AND fu.deleted_at IS NULL
                  AND fu.scheduled_at >= w.d_from AND fu.scheduled_at < w.d_to
                  AND fu.completed_at IS NOT NULL AND fu.completed_at <= fu.scheduled_at) AS followups_ontime,
              -- TAT = the SPRINT-3 first-response clock (lead_sla, metric
              -- 'first_response', elapsed_seconds) -- NOT a second measurement, and NOT
              -- lead_stage_tat, which measures time-in-stage and has no first-response
              -- column. Median, because one lead found on Monday morning after a weekend
              -- would drag a mean into meaninglessness.
              (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY sla.elapsed_seconds)
                 FROM lead_sla sla JOIN scoped_leads sl ON sl.id = sla.lead_id, win w
                WHERE sl.owner_id = p.user_id AND sla.metric = 'first_response'
                  AND sla.elapsed_seconds IS NOT NULL
                  AND sla.started_at >= w.d_from AND sla.started_at < w.d_to) AS tat_median_seconds
         FROM people p
         JOIN "user" u ON u.id = p.user_id
        WHERE u.deleted_at IS NULL
        ORDER BY enrolments DESC, revenue_minor DESC, leads DESC
        LIMIT 200`,
      params,
    );

    return rows.map((r) => {
      const leads = Number(r.leads ?? 0);
      const enrolments = Number(r.enrolments ?? 0);
      const due = Number(r.followups_due ?? 0);
      const ontime = Number(r.followups_ontime ?? 0);
      return {
        user_id: Number(r.user_id),
        user_name: r.user_name,
        leads,
        enrolments,
        // NOT capped at 100 — see the header. A counsellor may close last month's leads.
        conversion_pct: leads > 0 ? Math.round((enrolments * 1000) / leads) / 10 : 0,
        revenue_minor: Number(r.revenue_minor ?? 0),
        collected_minor: Number(r.collected_minor ?? 0),
        activities: Number(r.activities ?? 0),
        followups_due: due,
        followups_ontime: ontime,
        // "—" not 0%: a counsellor with nothing due has not failed to do anything.
        adherence_pct: due > 0 ? Math.round((ontime * 1000) / due) / 10 : null,
        tat_median_minutes: r.tat_median_seconds === null || r.tat_median_seconds === undefined
          ? null : Math.round(Number(r.tat_median_seconds) / 60),
      };
    });
  }

  /** The KPI strip above the leaderboard — the same window, the same scope. */
  async summary(scope: ResolvedScope, f: { from?: string; to?: string } = {}) {
    const rows = await this.leaderboard(scope, f);
    const sum = (k: 'leads' | 'enrolments' | 'revenue_minor' | 'collected_minor') =>
      rows.reduce((a, r) => a + (r[k] as number), 0);
    const leads = sum('leads');
    const enrolments = sum('enrolments');
    return {
      counsellors: rows.length,
      leads,
      enrolments,
      conversion_pct: leads > 0 ? Math.round((enrolments * 1000) / leads) / 10 : 0,
      revenue_minor: sum('revenue_minor'),
      collected_minor: sum('collected_minor'),
      best: rows[0] ? { user_name: rows[0].user_name, enrolments: rows[0].enrolments } : null,
    };
  }
}
