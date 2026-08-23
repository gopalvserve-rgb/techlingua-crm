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

import { applyPct } from '../common/money.util';

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
  // Per-level discount (only used when scope = 'level'). The client sends EITHER a natural
  // discount_type + discount_value (`amount` → rupees, `percent` → a % number), which the
  // server converts to a paise amount, OR a raw discount_minor (paise) for back-compat.
  discount_type?: string | null;
  discount_value?: number | string | null;
  discount_minor?: number | string | null;
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
export function resolveLevels(master: MasterLevel[], input: unknown, scope: DiscountScope, standardFeeMinor = 0): ResolvedLevel[] {
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
    let feeMinor = overrideFee != null ? overrideFee : Math.trunc(Number(m.fee_minor) || 0);
    // Item 10 (dev/131): a level whose fee is left BLANK/ZERO falls back to the course's Standard
    // Fee (m_course.meta.fee, passed in as standardFeeMinor) instead of being priced at ₹0.
    if ((!Number.isFinite(feeMinor) || feeMinor <= 0) && Number(standardFeeMinor) > 0) feeMinor = Math.trunc(Number(standardFeeMinor));
    if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new Error(`Level "${m.code}": fee must be zero or more`);
    // Per-level discount (level scope only). Prefer the natural (discount_type, discount_value):
    // `amount` → rupees, `percent` → a % of THIS level's fee; else fall back to a raw
    // discount_minor (paise). The server always computes the paise amount — a client net is never trusted.
    let discMinor = 0;
    if (scope === 'level') {
      const dt = String(r.discount_type ?? '').trim().toLowerCase();
      if (dt === 'percent') {
        let pct = Number(r.discount_value ?? 0);
        if (!Number.isFinite(pct) || pct < 0) pct = 0;
        if (pct > 100) throw new Error(`Level "${m.code}": a percentage discount cannot exceed 100%`);
        discMinor = applyPct(feeMinor, pct);
      } else if (dt === 'amount') {
        const rupees = Number(r.discount_value ?? 0);
        discMinor = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0;
      } else {
        discMinor = intMinor(r.discount_minor) ?? 0;
      }
    }
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
