/**
 * FIELD-MERGE RULES (NeoDove §4, "merge" / "merge_and_reopen").
 *
 * THE RULE, in one line: **a merge never destroys data.**
 *
 *   - blank on the existing lead + a value incoming  -> FILL it            ("filled")
 *   - both have a value and they differ              -> KEEP the existing  ("conflict"),
 *                                                       and record the incoming value in
 *                                                       the merge diff + the lead timeline
 *                                                       so nothing is lost
 *   - same value / nothing incoming                  -> no-op
 *
 * Custom fields merge by exactly the same rule, key by key. Tags are UNIONed
 * (append, never replace). Notes/activities are appended, never overwritten.
 *
 * Deliberately NOT merged:
 *   phone     — it is the match key; by definition identical
 *   owner_id  — §4: an open duplicate stays with the SAME owner and a merge must
 *               never re-run round-robin. Ownership only ever changes through an
 *               explicit assign.
 *   stage/status — a merge does not move a lead through the pipeline. The single
 *               exception is `merge_and_reopen`, which reopens a won/lost lead
 *               (handled by the service, logged as a stage_change).
 */

/** Scalar lead columns a merge may fill. */
export const MERGEABLE_FIELDS = [
  'full_name', 'email', 'alt_phone', 'whatsapp_phone', 'dob',
  'state_id', 'city_id', 'course_id', 'qualification_id', 'budget_id',
  'temperature', 'priority', 'score', 'next_follow_up_at',
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];

/** Human labels for the timeline note + the UI diff. */
export const FIELD_LABEL: Record<string, string> = {
  full_name: 'Name', email: 'Email', alt_phone: 'Alternate phone', whatsapp_phone: 'WhatsApp number', dob: 'Date of birth',
  state_id: 'State', city_id: 'City', course_id: 'Course', qualification_id: 'Qualification',
  budget_id: 'Budget', temperature: 'Temperature', priority: 'Priority', score: 'Score',
  next_follow_up_at: 'Next follow-up',
};

export interface MergeDiff {
  /** blank before, value now: field -> the value written */
  filled: Record<string, unknown>;
  /** both set and different: field -> { kept (existing, still wins), incoming (recorded only) } */
  conflicts: Record<string, { kept: unknown; incoming: unknown }>;
  custom_filled: Record<string, unknown>;
  custom_conflicts: Record<string, { kept: unknown; incoming: unknown }>;
  /** tag ids added to the existing lead */
  tags_added: number[];
  /** free-text note carried over from the incoming record (appended, never merged into a field) */
  note?: string | null;
}

export const emptyDiff = (): MergeDiff => ({
  filled: {}, conflicts: {}, custom_filled: {}, custom_conflicts: {}, tags_added: [],
});

export const diffIsEmpty = (d: MergeDiff): boolean =>
  !Object.keys(d.filled).length && !Object.keys(d.conflicts).length
  && !Object.keys(d.custom_filled).length && !Object.keys(d.custom_conflicts).length
  && !d.tags_added.length && !d.note;

/**
 * "Blank" = nothing a user would consider a value.
 * `score` is special: its column default is 0, so 0 means "not scored" and is
 * treated as blank (an incoming score fills it rather than conflicting with it).
 * `priority` default 'med' is NOT treated as blank — 'med' is a real choice, so
 * an incoming 'high' is a conflict (existing wins, incoming recorded).
 */
export function isBlank(field: string, v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (field === 'score' && Number(v) === 0) return true;
  return false;
}

/** Compare two values the way a user would (dates by instant, ids/numbers by value). */
export function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (field === 'next_follow_up_at') {
    const ta = new Date(a as string).getTime();
    const tb = new Date(b as string).getTime();
    if (!isNaN(ta) && !isNaN(tb)) return ta === tb;
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a).trim() === String(b).trim();
}

/**
 * Compute what a merge WOULD do. Pure — no DB, no side effects, so the UI can
 * preview exactly what the server will write.
 *
 * @param existing  the surviving lead row (DB shape)
 * @param incoming  the normalised incoming record (same column names) — from a
 *                  capture channel, or built from the lead being merged away
 * @param incomingTagIds tags on the incoming record
 * @param existingTagIds tags already on the surviving lead
 */
export function computeMergeDiff(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  incomingTagIds: number[] = [],
  existingTagIds: number[] = [],
  note?: string | null,
): MergeDiff {
  const diff = emptyDiff();

  for (const f of MERGEABLE_FIELDS) {
    const inc = incoming[f];
    if (isBlank(f, inc)) continue;                     // nothing offered
    const cur = existing[f];
    if (isBlank(f, cur)) { diff.filled[f] = inc; continue; }   // fill the blank
    if (sameValue(f, cur, inc)) continue;              // identical -> no-op
    diff.conflicts[f] = { kept: cur, incoming: inc };  // existing WINS, incoming preserved
  }

  const curCf = (existing.custom_fields ?? {}) as Record<string, unknown>;
  const incCf = (incoming.custom_fields ?? {}) as Record<string, unknown>;
  for (const [k, inc] of Object.entries(incCf)) {
    if (isBlank(k, inc)) continue;
    const cur = curCf[k];
    if (isBlank(k, cur)) { diff.custom_filled[k] = inc; continue; }
    if (sameValue(k, cur, inc)) continue;
    diff.custom_conflicts[k] = { kept: cur, incoming: inc };
  }

  const have = new Set(existingTagIds.map(Number));
  diff.tags_added = [...new Set(incomingTagIds.map(Number))].filter((t) => !have.has(t));

  if (note && String(note).trim()) diff.note = String(note).trim();
  return diff;
}

/** The custom_fields object to persist after a merge (existing wins on conflict). */
export function mergedCustomFields(
  existing: Record<string, unknown>, diff: MergeDiff,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...diff.custom_filled };
}

/** One-line human summary for the lead timeline. */
export function describeDiff(diff: MergeDiff): string {
  const parts: string[] = [];
  const filled = [...Object.keys(diff.filled), ...Object.keys(diff.custom_filled)];
  const conflicts = [...Object.keys(diff.conflicts), ...Object.keys(diff.custom_conflicts)];
  if (filled.length) parts.push(`filled ${filled.map((f) => FIELD_LABEL[f] ?? f).join(', ')}`);
  if (conflicts.length) {
    parts.push(`kept existing ${conflicts.map((f) => FIELD_LABEL[f] ?? f).join(', ')} (incoming value recorded)`);
  }
  if (diff.tags_added.length) parts.push(`${diff.tags_added.length} tag(s) added`);
  if (diff.note) parts.push('note appended');
  return parts.length ? parts.join(' · ') : 'no new information';
}
