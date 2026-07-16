/**
 * =============================================================================
 * THE SHARED METRIC DEFINITIONS — one definition, every reader.
 * =============================================================================
 *
 * This file exists because of DEF-S5-03.
 *
 * `/fees/summary` said Rs 50,000 and `/performance/summary` said Rs 0 AT THE SAME
 * MOMENT, because two screens had each written their own idea of "collected". Nothing
 * was broken in either query; they simply disagreed, and the client — reasonably —
 * stopped trusting both. The fix was to derive one of them from the other.
 *
 * Sprint 6 adds SIX MORE READERS of the same numbers (the funnel report, the TAT report,
 * campaign ROI, the report builder's `enrolments`/`receipts` entities, a scheduled email,
 * an Excel export). Six new chances for two screens to disagree — so the definitions
 * move HERE, as constants, and the readers import them.
 *
 * `reconcile.spec.ts` then asserts that the SQL each service actually emits contains
 * these constants. Change one reader's definition and the build goes red — you cannot
 * make the funnel report and the dashboard disagree without deleting a test that says,
 * in words, that they must not.
 *
 * These are SQL FRAGMENTS, not query builders. They are constants. Nothing is
 * interpolated into them.
 */

/* ------------------------------------------------------- leads by stage (the funnel) */

/**
 * The dashboard's funnel and the Funnel Analytics report count the same thing:
 * live leads joined to their stage. `is_active AND deleted_at IS NULL` is the pair —
 * a deleted lead is gone, an inactive one is archived, and BOTH are excluded, because
 * that is what the dashboard has always done and the report must match it exactly.
 */
export const STAGE_COUNT_FROM = `lead l JOIN pipeline_stage st ON st.id = l.stage_id`;
export const STAGE_COUNT_LIVE = `l.is_active AND l.deleted_at IS NULL`;

/* ---------------------------------------------------------------- booked revenue */

/**
 * BOOKED REVENUE = the net fee of ACTIVE enrolments.
 *
 * `status = 'active'` is the whole rule and it is not decoration: a `pending_approval`
 * enrolment "counts for nothing and takes no money until a manager approves"
 * (decision #41). A report that added pending enrolments into revenue would show the
 * client money he has not sold. Both PerformanceService and the campaigns entity's
 * `revenue` column use this literal.
 */
export const ENROLMENT_COUNTS_AS_SOLD = `status = 'active'`;
export const ENROLMENT_REVENUE_COLUMN = `net_fee_minor`;

/* -------------------------------------------------------------- collected cash */

/**
 * COLLECTED CASH attributes to the ENROLMENT'S COUNSELLOR (decision #45), never to
 * `fee_receipt.received_by` — an Accountant is the natural person to take a fee, and
 * keying on who physically receipted it credited the money to nobody and then deleted
 * it from the org-wide total.
 *
 * `received_by` remains the audit record of which till took the cash, and the reports
 * still SHOW it (receipts › "Received by (till)") — it is simply never an attribution
 * key or a scope column.
 */
export const RECEIPT_ATTRIBUTION_KEY = `e.counsellor_id`;
export const RECEIPT_LIVE = `fr.deleted_at IS NULL`;

/* ------------------------------------------------------------------ first response */

/**
 * TAT / first response is `lead_sla.elapsed_seconds` where `metric = 'first_response'`
 * — the SPRINT-3 clock, not a second measurement. `lead_stage_tat` measures TIME IN
 * STAGE and has no first-response column at all (the schema guard pins that: an early
 * draft of PerformanceService read `lead_stage_tat.first_response_minutes`, which has
 * never existed).
 */
export const SLA_FIRST_RESPONSE_METRIC = `'first_response'`;
export const SLA_ELAPSED_COLUMN = `elapsed_seconds`;

/* ------------------------------------------------------------------ conversion % */

/**
 * =============================================================================
 * CONVERSION — TWO QUESTIONS, TWO NAMES, ONE DEFINITION EACH. (OBS-S16-05)
 * =============================================================================
 *
 * QA-16 found THREE conversion percentages that were all correct and all different:
 * the funnel said 50%, Counsellor Performance said 100%, and the dashboard rounded to a
 * whole number while the other two carried a decimal. Nothing was broken — they simply
 * answered different questions with the same word, and `conversion_pct` was NOT in this
 * file, while `docs/dev/08` §2 claimed every definition here was imported by every reader.
 * For conversion, it wasn't: two independent definitions that happened to be right.
 *
 * That is the DEF-S5-03 SHAPE (two screens, two numbers, no shared constant) without the
 * bug yet — and DEF-S5-03 is the one where the client stopped trusting both screens.
 *
 * So there are exactly two definitions, they live here, and THEY ARE NAMED DIFFERENTLY
 * ON THE SCREEN, because the honest fix is not to force them to agree — they are not the
 * same number — but to stop calling them the same thing:
 *
 *   leadWonConversionPct       "of the leads that came in, how many did we win?"
 *   counsellorConversionPct    "of the leads I own, how many did I enrol?"
 *
 * The second can exceed 100% in a window where somebody closes last month's leads, and
 * that is correct, not a cap to apply.
 */

/** One decimal, half-up. The dashboard used to round to a whole number, so a third of the
 *  leads read 33 on one screen and 33.3 on another — the same number disagreeing with
 *  itself. Every reader now rounds identically because every reader calls this. */
const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num * 1000) / den) / 10 : 0);

/**
 * LEAD -> WON conversion: won leads / ALL leads in the window.
 * Read by the dashboard KPI and by the funnel report's `totals`, which is the pairing
 * that would break first — and `reconcile.spec.ts` asserts they cannot drift.
 * It is NOT the product of the funnel's step ratios.
 */
export function leadWonConversionPct(won: number, leads: number): number {
  return pct1(won, leads);
}

/**
 * COUNSELLOR conversion: enrolments / leads THE COUNSELLOR OWNS.
 * A different denominator, on purpose — an unowned lead has no counsellor to credit, so
 * it cannot be in a counsellor's denominator. Read by PerformanceService (per-row and the
 * org summary).
 */
export function counsellorConversionPct(enrolments: number, ownedLeads: number): number {
  return pct1(enrolments, ownedLeads);
}

/**
 * THE LABELS ARE PART OF THE DEFINITION. Gopal seeing "Conversion 50%" on one screen and
 * "Conversion 100%" on another will report a bug — correctly, because the screens are
 * lying by omission. The web imports these so a label cannot drift from its arithmetic.
 */
export const CONVERSION_LABEL_LEAD_WON = 'Lead→won conversion';
export const CONVERSION_LABEL_COUNSELLOR = 'Counsellor conversion (own leads)';
