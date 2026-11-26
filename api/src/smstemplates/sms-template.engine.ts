/**
 * THE {#var#} RESOLVER — a PURE function, like the {{merge}} template engine.
 *
 * A DLT-approved SMS body carries ordered `{#var#}` markers. Unlike the {{merge}} system,
 * these markers are POSITIONAL and NAMELESS: the DLT portal knows them only by order. So
 * we resolve them IN ORDER against a per-template mapping of field keys (default
 * [name, course] for the lead-creation templates), and we substitute the values INTO the
 * registered body rather than rebuilding it — because DLT rejects any deviation from the
 * approved text, so the surrounding words must survive byte-for-byte.
 *
 * A missing value renders BLANK (never the literal "{#var#}", never a crash) and is
 * reported, exactly like the {{merge}} engine, so the UI can warn before a send.
 */

/**
 * Every DLT variable marker, not only {#var#}: the portal also registers {#cbn#} (call-back
 * number), {#num#} (numeric), {#url#}, {#urlott#}, {#email#} and {#alphanumeric#}. They are all
 * POSITIONAL — the mapping's Nth entry fills the Nth marker of any kind. (23 Nov 2026: the
 * client's 23 approved templates use {#cbn#} and {#num#}; matching only {#var#} left them in
 * the text, and DLT rejects that.)
 */
export const DLT_MARKER = /\{#(?:var|cbn|num|url|urlott|email|alphanumeric)#\}/gi;

/** The kinds of marker in a body, in order — e.g. ['var', 'var', 'var', 'cbn']. */
export function markerKinds(body: string): string[] {
  return (String(body ?? '').match(DLT_MARKER) ?? []).map((m) => m.slice(2, -2).toLowerCase());
}

/**
 * The fields a marker can be filled from — what the SMS Templates screen offers in each
 * marker's dropdown. Event-specific values (date, time, discount …) come from the event that
 * sends the SMS; the rest come from the lead / student, their counsellor and their vertical.
 */
export const SMS_VARIABLES: Array<{ key: string; label: string; sample: string }> = [
  { key: 'name', label: 'Lead / student name', sample: 'Riya Sharma' },
  { key: 'first_name', label: 'First name', sample: 'Riya' },
  { key: 'course', label: 'Course', sample: 'German A1' },
  { key: 'counsellor', label: 'Assigned counsellor', sample: 'Asha' },
  { key: 'counsellor_phone', label: "Counsellor's contact number", sample: '+91 98110 00000' },
  { key: 'callback', label: 'Call-back number (vertical)', sample: '+918506067041' },
  { key: 'institute', label: 'Institute name (vertical)', sample: 'British College of Language' },
  { key: 'branch', label: 'Branch', sample: 'Vikaspuri' },
  { key: 'date', label: 'Date (from the event)', sample: '25 Nov 2026' },
  { key: 'time', label: 'Time (from the event)', sample: '11:00 AM' },
  { key: 'discount', label: 'Discount (offer)', sample: '20%' },
  { key: 'last_date', label: 'Last date (offer / due date)', sample: '30 Nov 2026' },
  { key: 'amount', label: 'Amount', sample: '₹5,000' },
  { key: 'otp', label: 'OTP code', sample: '482913' },
  { key: 'otp_minutes', label: 'OTP valid for (minutes)', sample: '5' },
  { key: 'phone', label: 'Lead phone', sample: '+919811111111' },
];
export const SAMPLE_VARS: Record<string, string> = Object.fromEntries(SMS_VARIABLES.map((v) => [v.key, v.sample]));

/** What a template may be sent for, besides the notification events. */
export const EXTRA_TRIGGERS = [
  { key: 'manual', name: 'Manual / campaign only (never sent automatically)' },
  { key: 'login_otp', name: 'Login OTP' },
];
/** 'lead_created' is the old name of the new-lead trigger; both mean the same. */
export function triggerAliases(trigger: string): string[] {
  return trigger === 'lead_created' || trigger === 'new_lead_created' ? ['lead_created', 'new_lead_created'] : [trigger];
}

export interface DltRenderResult {
  text: string;
  /** the mapped field keys the lead could not answer (in order) */
  missing: string[];
  /** how many {#var#} markers the body contains */
  count: number;
}

/**
 * @param body     the DLT-approved template body with {#var#} markers
 * @param mapping  ordered field keys: mapping[0] fills the 1st {#var#}, etc.
 * @param vars     field key -> resolved value (from the lead)
 */
export function resolveDltBody(
  body: string,
  mapping: string[],
  vars: Record<string, unknown>,
): DltRenderResult {
  const markers = String(body ?? '').match(DLT_MARKER);
  const count = markers ? markers.length : 0;
  const map = Array.isArray(mapping) ? mapping : [];
  const missing: string[] = [];
  let i = 0;
  const text = String(body ?? '').replace(DLT_MARKER, () => {
    const field = i < map.length ? String(map[i] ?? '') : '';
    i++;
    const v = field ? vars[field] : undefined;
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(field || `var${i}`);
      return '';
    }
    return String(v);
  });
  return { text, missing, count };
}

/** Default mapping for the lead-creation templates: 1st {#var#}=name, 2nd={#var#}=course. */
export const DEFAULT_VAR_MAPPING = ['name', 'course'];

/** Normalise a stored mapping (JSONB) into a clean string[]. */
export function normaliseMapping(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((x) => String(x)).filter(Boolean); } catch { /* csv */ }
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_VAR_MAPPING];
}

/**
 * Pick the best template for a lead from the active candidates, MOST-SPECIFIC first:
 * exact (branch,vertical) > (vertical only) > (branch only) > org-wide. Null when none.
 * Kept pure so the "BCL lead -> BCL template, INSTA -> INSTA, no match -> none" rule is
 * unit-tested without a database.
 */
export function pickTemplate<T extends { branch_id?: number | null; vertical_id?: number | null; id?: number | string }>(
  candidates: T[], branchId: number | null, verticalId: number | null,
): T | null {
  const rank = (t: T): number => {
    const b = t.branch_id == null ? null : Number(t.branch_id);
    const v = t.vertical_id == null ? null : Number(t.vertical_id);
    if (b !== null && b !== branchId) return -1;         // pinned to a different branch
    if (v !== null && v !== verticalId) return -1;       // pinned to a different vertical
    return (b !== null ? 2 : 0) + (v !== null ? 1 : 0);  // exact both = 3
  };
  let best: T | null = null; let bestRank = -1;
  for (const t of candidates) {
    const r = rank(t);
    if (r < 0) continue;
    if (r > bestRank || (r === bestRank && Number(t.id) < Number((best as any)?.id ?? Infinity))) {
      best = t; bestRank = r;
    }
  }
  return best;
}
