/**
 * THE CONVERSION LABELS — the web half of `api/src/reports/shared-metrics.ts`.
 *
 * OBS-S16-05: at one moment QA-16 saw the funnel report say 50% and Counsellor
 * Performance say 100%, both labelled "Conversion". Both numbers were right; the LABEL
 * was the lie. They answer different questions:
 *
 *   Lead→won conversion              won leads / ALL leads in the window
 *   Counsellor conversion            enrolments / the leads THAT COUNSELLOR OWNS
 *
 * The arithmetic is defined once, server-side, and imported by every reader. The words
 * are defined once, here, and imported by every screen — because a shared definition with
 * two different captions on it is still two different numbers as far as the client is
 * concerned, and he will (rightly) report it as a bug.
 *
 * `reconcile.spec.ts` pins the server side; `sprint5/sprint6` tests pin these captions.
 */

/** won / ALL leads. The dashboard KPI and the Funnel report — the same number. */
export const CONVERSION_LABEL_LEAD_WON = 'Lead\u2192won conversion';

/** enrolments / leads the counsellor OWNS. May exceed 100% and that is correct. */
export const CONVERSION_LABEL_COUNSELLOR = 'Counsellor conversion (own leads)';
