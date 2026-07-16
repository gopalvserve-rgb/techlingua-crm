import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { ENROLMENT_COUNTS_AS_SOLD, ENROLMENT_REVENUE_COLUMN } from '../reports/shared-metrics';

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
 *   collected      cash receipted in the window AGAINST THIS COUNSELLOR'S ENROLMENTS —
 *                  regardless of who physically took the money. Shown SEPARATELY from
 *                  `revenue` on purpose: booked and collected are different questions.
 *                  See THE ATTRIBUTION RULE below.
 *   activities     timeline events they logged — the "calls" column of the prototype,
 *                  honestly named, because TELEPHONY IS OUT OF SCOPE and we do not have
 *                  call counts. Dispositions + follow-ups + notes are what we DO have.
 *   TAT            median minutes to first response, from `lead_stage_tat` — the
 *                  Sprint-3 table, not a second measurement.
 *   adherence      follow-ups completed on time / follow-ups due. A counsellor with
 *                  nothing due is shown "—", not 0% or 100%.
 *
 * =============================================================================
 * THE ATTRIBUTION RULE — decision log #45 (DEF-S5-03)
 * =============================================================================
 * **Revenue and collected cash attribute to the ENROLMENT'S COUNSELLOR, regardless of who
 * physically receipted the money. `fee_receipt.received_by` is the AUDIT RECORD of who took
 * the cash and is never an attribution key.**
 *
 * Why: an **Accountant** (role 10) or a front-desk clerk is the natural person to take a
 * fee, and in a branch with a cash counter that is the normal case, not an exception. The
 * old code keyed `collected` on `received_by` and only ever considered people who owned a
 * lead or counselled an enrolment — so an Accountant's receipt was credited to NOBODY and
 * then vanished from the org-wide total, because the total was the sum of the rows. Live,
 * `/fees/summary` reported Rs 50,000 while `/performance/summary` reported Rs 0.
 *
 * The rule is also the only one that means anything to the client: a counsellor's
 * leaderboard answers *"how much of the fee I sold has actually come in?"* — a question
 * about HIS enrolments. *"Which till took the cash?"* is a cashbook question, and the
 * cashbook (`received_by`, on every receipt and its PDF) still answers it, unchanged.
 *
 * Sprint 6's reports read this service as the single source of truth, so this had to be
 * right before anything was built on top of it.
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
                WHERE se.counsellor_id = p.user_id AND se.${ENROLMENT_COUNTS_AS_SOLD}
                  AND se.created_at >= w.d_from AND se.created_at < w.d_to) AS enrolments,
              (SELECT COALESCE(sum(se.${ENROLMENT_REVENUE_COLUMN}), 0) FROM scoped_enr se, win w
                WHERE se.counsellor_id = p.user_id AND se.${ENROLMENT_COUNTS_AS_SOLD}
                  AND se.created_at >= w.d_from AND se.created_at < w.d_to) AS revenue_minor,
              -- DEF-S5-03. Attribution is the ENROLMENT'S COUNSELLOR, never the
              -- receipt's received_by. An Accountant is the natural person to take a fee;
              -- keying this on who physically keyed it in credited the money to nobody and
              -- then DELETED it from the org-wide total. received_by remains the audit
              -- record of who took the cash — it is not, and never was, a claim about
              -- whose revenue it is. See THE ATTRIBUTION RULE in the header.
              (SELECT COALESCE(sum(fr.amount_minor), 0)
                 FROM fee_receipt fr JOIN scoped_enr se ON se.id = fr.enrolment_id, win w
                WHERE se.counsellor_id = p.user_id AND fr.deleted_at IS NULL
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

  /**
   * ORG-WIDE CASH COLLECTED in the window, computed **directly from the scoped receipts**.
   *
   * DEF-S5-03: `summary()` used to add up the leaderboard's per-person rows, so any receipt
   * that did not land on a person — an Accountant's, an Admin's — was silently dropped from
   * the total. `/fees/summary` said Rs 50,000 and `/performance/summary` said Rs 0 AT THE
   * SAME MOMENT. A total derived by summing rows can only ever be as complete as the row
   * set; this one is derived from the money itself, so the two screens cannot disagree
   * about cash again — which is the entire point of the booked-vs-collected discipline.
   *
   * Scoped on the ENROLMENT (the same fragment the leaderboard's enrolment aggregates use),
   * so a counsellor's total is his own and cannot return branch numbers.
   */
  private async collectedMinor(scope: ResolvedScope, f: { from?: string; to?: string }): Promise<number> {
    const params: unknown[] = [f.from ? String(f.from).slice(0, 10) : null, f.to ? String(f.to).slice(0, 10) : null];
    const enrWhere = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, params);
    const r = await this.db.one<any>(
      `WITH win AS (
         SELECT COALESCE($1::date, date_trunc('month', now())::date) AS d_from,
                COALESCE($2::date, (date_trunc('month', now()) + INTERVAL '1 month')::date) AS d_to
       )
       SELECT COALESCE(sum(fr.amount_minor), 0) AS collected_minor
         FROM fee_receipt fr
         JOIN enrolment e ON e.id = fr.enrolment_id, win w
        WHERE fr.deleted_at IS NULL AND e.deleted_at IS NULL AND ${enrWhere}
          AND fr.received_at >= w.d_from AND fr.received_at < w.d_to`,
      params,
    );
    return Number(r?.collected_minor ?? 0);
  }

  /** The KPI strip above the leaderboard — the same window, the same scope. */
  async summary(scope: ResolvedScope, f: { from?: string; to?: string } = {}) {
    const rows = await this.leaderboard(scope, f);
    const sum = (k: 'leads' | 'enrolments' | 'revenue_minor') =>
      rows.reduce((a, r) => a + (r[k] as number), 0);
    const leads = sum('leads');
    const enrolments = sum('enrolments');
    return {
      counsellors: rows.length,
      leads,
      enrolments,
      conversion_pct: leads > 0 ? Math.round((enrolments * 1000) / leads) / 10 : 0,
      revenue_minor: sum('revenue_minor'),
      // NOT `sum('collected_minor')` — see collectedMinor(). This is the money, not the rows.
      collected_minor: await this.collectedMinor(scope, f),
      best: rows[0] ? { user_name: rows[0].user_name, enrolments: rows[0].enrolments } : null,
    };
  }
}
