/**
 * dev/117 / dev/130 — the single source of truth for the "stage -> Lead Status" auto-rule.
 *
 * The client's rule: a WON stage forces Status = Won, a LOST/closed stage forces Status = Lost.
 * Primary key is the stage's TYPE (won | lost | open). A NAME fallback then covers a terminal
 * stage that was mis-configured as `open` but is clearly named "Enrolled"/"Closed" — so the
 * "Enrolled -> Won, Closed -> Loss" promise holds regardless of the live stage_type config.
 *
 * Returns the m_status CODE ('WON' | 'LOST') to force, or null for an ordinary open stage
 * (e.g. "New Enquiry", "Negotiation") which must NOT force a terminal status. Callers that need
 * a concrete OPEN status for an ordinary open stage (e.g. re-opening a closed lead) map a null
 * result onto the org's 'NEW' status themselves.
 *
 * Pure + leaf (no imports) so both LeadsService and the ingestion MergeService can share it
 * without a module cycle. Re-exported from leads.service.ts so existing import sites are unchanged.
 */
export function autoStatusFromStage(
  stageType: string | null | undefined,
  stageName: string | null | undefined,
): 'WON' | 'LOST' | null {
  const t = String(stageType ?? '').toLowerCase().trim();
  if (t === 'won') return 'WON';
  if (t === 'lost') return 'LOST';
  const n = String(stageName ?? '').toLowerCase();
  if (/enrol/.test(n)) return 'WON';          // "Enrolled", "Enrollment done"
  if (/clos|lost/.test(n)) return 'LOST';     // "Closed", "Closed - Lost"
  return null;
}
