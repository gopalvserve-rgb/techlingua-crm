/**
 * ENROLMENT LEVELS — pure, unit-tested resolution of the selected course levels into
 * line-items with a snapshot fee. No DB (the caller loads the course's master levels and
 * hands them in), so the sum/validate logic is testable in isolation.
 *
 * enrollment re-model, batch 2: ONE enrolment per course carries one or MORE levels as
 * line-items. Total Fee = Σ level fees; a discount is either OVERALL (on the total) or
 * LEVEL-wise (per line-item, summed). fee_minor is a SNAPSHOT taken at enroll time so a
 * later master fee edit never re-prices a signed-up student.
 */

export type DiscountScope = 'overall' | 'level';

/** A course's level as it lives in the `course_level` master (what the caller loads). */
export interface MasterLevel {
  id: number;
  code: string;
  label?: string | null;
  fee_minor: number;
}

/** One selected level as the client sends it. */
export interface LevelInput {
  course_level_id?: number | string | null;
  code?: string | null;
  fee_minor?: number | string | null;   // optional override; else the master fee is snapshotted
  discount_minor?: number | string | null; // per-level discount (only used when scope = 'level')
}

/** A resolved level line-item, ready to insert into `enrolment_level`. */
export interface ResolvedLevel {
  course_level_id: number | null;
  code: string;
  label: string | null;
  fee_minor: number;
  discount_minor: number;
  ordering: number;
}

function intMinor(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Match each selected level to the course's master levels (by id, else by code), snapshot
 * the fee, carry a per-level discount when the scope is level-wise. Throws (plain Error) on
 * an unknown level, a duplicate, or a bad fee/discount — the caller turns it into a 400.
 */
export function resolveLevels(master: MasterLevel[], input: unknown, scope: DiscountScope): ResolvedLevel[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('levels must be an array');
  const byId = new Map<number, MasterLevel>();
  const byCode = new Map<string, MasterLevel>();
  for (const m of master) {
    byId.set(Number(m.id), m);
    byCode.set(String(m.code).toLowerCase(), m);
  }
  const out: ResolvedLevel[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const r = (raw ?? {}) as LevelInput;
    const idNum = r.course_level_id != null && String(r.course_level_id).trim() !== '' ? Number(r.course_level_id) : null;
    let m: MasterLevel | undefined;
    if (idNum != null) m = byId.get(idNum);
    if (!m && r.code != null && String(r.code).trim() !== '') m = byCode.get(String(r.code).trim().toLowerCase());
    if (!m) throw new Error(`Level #${i + 1}: not a valid level of this course`);
    const key = String(m.code).toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate level "${m.code}" — each level can be selected once`);
    seen.add(key);
    const overrideFee = intMinor(r.fee_minor);
    const feeMinor = overrideFee != null ? overrideFee : Math.trunc(Number(m.fee_minor) || 0);
    if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new Error(`Level "${m.code}": fee must be zero or more`);
    let discMinor = scope === 'level' ? (intMinor(r.discount_minor) ?? 0) : 0;
    if (!Number.isFinite(discMinor) || discMinor < 0) discMinor = 0;
    if (discMinor > feeMinor) throw new Error(`Level "${m.code}": the discount cannot exceed that level's fee`);
    out.push({
      course_level_id: Number(m.id),
      code: String(m.code),
      label: m.label != null && String(m.label).trim() !== '' ? String(m.label) : String(m.code),
      fee_minor: feeMinor,
      discount_minor: discMinor,
      ordering: i,
    });
  });
  return out;
}

export function sumLevelFees(levels: ResolvedLevel[]): number {
  return levels.reduce((s, l) => s + Number(l.fee_minor || 0), 0);
}

export function sumLevelDiscounts(levels: ResolvedLevel[]): number {
  return levels.reduce((s, l) => s + Number(l.discount_minor || 0), 0);
}
