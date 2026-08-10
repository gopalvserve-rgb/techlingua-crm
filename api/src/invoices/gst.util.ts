/**
 * GST — the India tax split that sits ON TOP of common/money.util.ts.
 *
 * money.util already owns paise, discount-before-tax, half-up rounding and the
 * "per line, then sum" rule. This module adds the ONE thing a tax invoice needs that a
 * quotation did not: the CGST / SGST / IGST split, decided by INTRA vs INTER state.
 *
 *   · INTRA-state (seller state == place of supply):  CGST = SGST = rate/2, IGST = 0.
 *   · INTER-state (seller state != place of supply):  IGST = rate,          CGST = SGST = 0.
 *
 * Each half is rounded half-up on its own line (via applyPct), so the printed CGST and
 * SGST columns each add up to their footer, and the line total = taxable + all taxes.
 * The grand total is rounded to the nearest rupee and the delta is the round-off line —
 * exactly what an Indian tax invoice shows. All of this is PURE and unit-tested; the
 * service does I/O, never arithmetic.
 */
import { applyPct, computeLine } from '../common/money.util';

export type SupplyType = 'intra' | 'inter';

export interface GstLineInput {
  qty: number;
  unit_price_minor: number;
  discount_type: 'amount' | 'percent';
  discount_value: number;   // paise when 'amount', a percentage when 'percent'
  gst_pct: number;          // the full GST rate on the line (e.g. 18)
}

export interface GstLineComputed {
  gross_minor: number;
  discount_minor: number;
  taxable_minor: number;
  cgst_minor: number;
  sgst_minor: number;
  igst_minor: number;
  total_minor: number;
}

export interface GstTotals {
  taxable_minor: number;
  discount_minor: number;
  cgst_minor: number;
  sgst_minor: number;
  igst_minor: number;
  tax_minor: number;         // cgst + sgst + igst
  sub_total_minor: number;   // taxable + tax (before round-off)
  round_off_minor: number;   // total - sub_total  (may be negative)
  total_minor: number;       // grand total, rounded to the nearest rupee
}

/** Same state (or unknown place of supply) -> intra; different state -> inter. */
export function supplyTypeFor(sellerStateId: number | null | undefined, posStateId: number | null | undefined): SupplyType {
  if (sellerStateId != null && posStateId != null && Number(sellerStateId) !== Number(posStateId)) return 'inter';
  return 'intra';
}

/** Round a paise amount to the nearest RUPEE, half-up on the absolute value. */
export function roundToRupeeHalfUp(minor: number): number {
  const neg = minor < 0;
  const a = Math.abs(Math.trunc(minor));
  const r = a % 100;
  const base = a - r;
  const up = r >= 50 ? base + 100 : base;
  return neg ? -up : up;
}

/** One invoice line: discount-before-tax (money.util) then the CGST/SGST or IGST split. */
export function computeGstLine(l: GstLineInput, supply: SupplyType): GstLineComputed {
  // let money.util do gross/discount/taxable (tax handled here, so tax_pct = 0 there)
  const base = computeLine({
    qty: l.qty, unit_price_minor: l.unit_price_minor,
    discount_type: l.discount_type, discount_value: l.discount_value, tax_pct: 0,
  });
  const taxable = base.taxable_minor;
  let cgst = 0, sgst = 0, igst = 0;
  const rate = Number(l.gst_pct) || 0;
  if (supply === 'inter') {
    igst = applyPct(taxable, rate);
  } else {
    cgst = applyPct(taxable, rate / 2);
    sgst = cgst;                 // CGST == SGST by construction for intra-state
  }
  return {
    gross_minor: base.gross_minor,
    discount_minor: base.discount_minor,
    taxable_minor: taxable,
    cgst_minor: cgst, sgst_minor: sgst, igst_minor: igst,
    total_minor: taxable + cgst + sgst + igst,
  };
}

/** Sum the rounded lines, then round the grand total to the nearest rupee (round-off line). */
export function computeGstTotals(lines: GstLineComputed[]): GstTotals {
  const t = { taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0 };
  for (const l of lines) {
    t.taxable += l.taxable_minor;
    t.discount += l.discount_minor;
    t.cgst += l.cgst_minor;
    t.sgst += l.sgst_minor;
    t.igst += l.igst_minor;
  }
  const tax = t.cgst + t.sgst + t.igst;
  const sub = t.taxable + tax;
  const total = roundToRupeeHalfUp(sub);
  return {
    taxable_minor: t.taxable, discount_minor: t.discount,
    cgst_minor: t.cgst, sgst_minor: t.sgst, igst_minor: t.igst,
    tax_minor: tax, sub_total_minor: sub,
    round_off_minor: total - sub, total_minor: total,
  };
}
