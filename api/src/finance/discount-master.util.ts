/**
 * DISCOUNT MASTER — a pure, unit-tested cap resolver. No DB, no floats-as-money.
 *
 * A discount_master row caps a discount by PERCENT and/or AMOUNT (paise), optionally scoped
 * by branch / vertical / course. A NULL scope column = "applies to all". Given a concrete
 * (branch, vertical, course) the applicable cap is resolved MOST-SPECIFIC-WINS: among the
 * ACTIVE rows whose every non-null scope column matches the query, the one that pins the
 * MOST (and most specific) scope columns wins — course beats vertical beats branch — with a
 * newer row breaking a tie. This is the same "per-scope override" mental model as
 * number_series / finance_setting.
 */
import { applyPct } from '../common/money.util';

export interface DiscountCapRow {
  id: number;
  branch_id: number | null;
  vertical_id: number | null;
  course_id: number | null;
  max_percent: number | null;
  max_amount_minor: number | null;
}

export interface CapCtx {
  branch_id?: number | null;
  vertical_id?: number | null;
  course_id?: number | null;
}

const eq = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || Number(a) === Number(b);

/** Does this cap's scope apply to the given context? A NULL scope column matches anything. */
export function capMatches(cap: DiscountCapRow, ctx: CapCtx): boolean {
  return eq(cap.branch_id, ctx.branch_id) && eq(cap.vertical_id, ctx.vertical_id) && eq(cap.course_id, ctx.course_id);
}

/** Specificity — course (4) beats vertical (2) beats branch (1) so a course-specific cap wins. */
export function capSpecificity(cap: DiscountCapRow): number {
  return (cap.course_id != null ? 4 : 0) + (cap.vertical_id != null ? 2 : 0) + (cap.branch_id != null ? 1 : 0);
}

/** The single applicable cap (most-specific-wins; newer id breaks a tie), or null if none match. */
export function pickCap(caps: DiscountCapRow[], ctx: CapCtx): DiscountCapRow | null {
  let best: DiscountCapRow | null = null;
  let bestScore = -1;
  for (const c of caps) {
    if (!capMatches(c, ctx)) continue;
    const score = capSpecificity(c);
    if (score > bestScore || (score === bestScore && best != null && c.id > best.id)) {
      best = c; bestScore = score;
    }
  }
  return best;
}

/**
 * The maximum discount (paise) allowed on a base by a resolved cap. The stricter of the
 * percent ceiling and the amount ceiling binds; leaving either side null switches it off.
 * Returns null when no cap applies OR the matched cap constrains neither dimension (= no
 * limit — a discount of any size is allowed).
 */
export function capMinor(cap: DiscountCapRow | null, base: number): number | null {
  if (!cap) return null;
  const byPct = cap.max_percent != null ? applyPct(base, Number(cap.max_percent)) : null;
  const byAmt = cap.max_amount_minor != null ? Math.trunc(Number(cap.max_amount_minor)) : null;
  if (byPct == null && byAmt == null) return null;
  if (byPct == null) return byAmt;
  if (byAmt == null) return byPct;
  return Math.min(byPct, byAmt);
}

/** Convenience: resolve the cap and the max discount minor for a base, in one call. */
export function resolveCapMinor(caps: DiscountCapRow[], ctx: CapCtx, base: number): { cap: DiscountCapRow | null; capMinor: number | null } {
  const cap = pickCap(caps, ctx);
  return { cap, capMinor: capMinor(cap, base) };
}
