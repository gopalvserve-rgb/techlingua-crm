/**
 * GRADING — Assessment Batch D.
 *
 * PURE helpers for resolving a percentage to a grade band and for VALIDATING a scheme's bands.
 * Kept free of the DB so the boundary cases (49.99 vs 50, 89 vs 90, 100) and the gap/overlap
 * validation are unit-tested exhaustively. The service loads the bands and calls these.
 *
 * BAND MODEL: bands are contiguous over 0..100 as half-open intervals [min_pct, max_pct), with
 * the TOP band closing at 100 inclusive. Resolution picks the highest band whose min_pct <= pct
 * (so 89% -> the 80..90 band, 90% -> the 90..100 band, 100% -> the top band). The India default
 * seeds Fail 0..50 (fail), C 50..60, B 60..70, B+ 70..80, A 80..90, A+ 90..100.
 */

export interface Band {
  label: string;
  min_pct: number;
  max_pct: number;
  is_pass: boolean;
  ordering?: number;
}

/** Resolve a percentage (0..100) to its band, or null when there are no bands. */
export function resolveBand(bands: Band[], pct: number): Band | null {
  if (!bands.length) return null;
  const sorted = [...bands].sort((a, b) => Number(a.min_pct) - Number(b.min_pct));
  const p = Math.max(0, Math.min(100, Number(pct)));
  // highest band whose min_pct <= p; ties broken by the last (highest) match.
  let hit: Band | null = null;
  for (const b of sorted) {
    if (p >= Number(b.min_pct) && (p < Number(b.max_pct) || (Number(b.max_pct) >= 100 && p >= Number(b.min_pct)))) {
      hit = b;
    }
  }
  // p exactly at/above the top band's min but the half-open test missed 100 -> take the top.
  if (!hit) {
    for (const b of sorted) if (p >= Number(b.min_pct)) hit = b;
  }
  return hit ?? sorted[0];
}

export interface BandValidationError { ok: false; message: string }
export interface BandValidationOk { ok: true; bands: Band[] }

/**
 * Validate a set of bands: contiguous over 0..100 with no gap and no overlap, exactly one band
 * covering each point, and at least one PASS band. Returns the normalised (ordered) bands.
 */
export function validateBands(raw: Band[]): BandValidationOk | BandValidationError {
  if (!raw || raw.length < 2) return { ok: false, message: 'A grade scheme needs at least two bands (e.g. Fail and a pass band).' };
  const bands = raw.map((b, i) => ({
    label: String(b.label ?? '').trim(),
    min_pct: Number(b.min_pct),
    max_pct: Number(b.max_pct),
    is_pass: !!b.is_pass,
    ordering: i + 1,
  }));
  for (const b of bands) {
    if (!b.label) return { ok: false, message: 'Every band needs a label (e.g. A+, B, Fail).' };
    if (!Number.isFinite(b.min_pct) || !Number.isFinite(b.max_pct)) return { ok: false, message: `Band "${b.label}" has a non-numeric bound.` };
    if (b.min_pct < 0 || b.max_pct > 100) return { ok: false, message: `Band "${b.label}" must lie within 0–100.` };
    if (b.min_pct >= b.max_pct) return { ok: false, message: `Band "${b.label}" has min ≥ max (${b.min_pct}–${b.max_pct}).` };
  }
  const sorted = [...bands].sort((a, b) => a.min_pct - b.min_pct);
  if (sorted[0].min_pct !== 0) return { ok: false, message: 'The lowest band must start at 0%.' };
  if (sorted[sorted.length - 1].max_pct !== 100) return { ok: false, message: 'The highest band must end at 100%.' };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min_pct !== sorted[i - 1].max_pct) {
      return { ok: false, message: `Bands must be contiguous with no gap or overlap — "${sorted[i - 1].label}" ends at ${sorted[i - 1].max_pct}% but "${sorted[i].label}" starts at ${sorted[i].min_pct}%.` };
    }
  }
  if (!bands.some((b) => b.is_pass)) return { ok: false, message: 'At least one band must be a PASS band.' };
  // renumber ordering by ascending min_pct
  const out = sorted.map((b, i) => ({ ...b, ordering: i + 1 }));
  return { ok: true, bands: out };
}
