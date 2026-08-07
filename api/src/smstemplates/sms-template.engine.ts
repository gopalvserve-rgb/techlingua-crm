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

export const DLT_MARKER = /\{#var#\}/g;

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
