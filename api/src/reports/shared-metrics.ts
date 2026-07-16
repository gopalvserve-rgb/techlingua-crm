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
