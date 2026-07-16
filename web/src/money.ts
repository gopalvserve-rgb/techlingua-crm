/**
 * MONEY, ON THE CLIENT.
 *
 * =============================================================================
 * THIS IS A PREVIEW. THE SERVER IS THE TRUTH.
 * =============================================================================
 * The quotation form shows live totals as the counsellor types, so these rules must
 * MATCH api/src/common/money.util.ts exactly — discount before tax, per line then sum,
 * half-up to the paisa, integer paise throughout. But the API NEVER trusts a total the
 * browser sends: `QuotationService` recomputes every line from the raw inputs and stores
 * its own numbers. So the worst a drift here can do is show a preview that the saved
 * quotation then corrects — never a wrong stored figure.
 *
 * `money.test.ts` pins the two implementations to the SAME canonical example
 * (the ₹71,465.00 three-line quote, which is also `api/src/common/money.util.spec.ts`'s).
 * If either side drifts, that test goes red.
 */

export type DiscountType = 'amount' | 'percent';

/** Half-up division, integers only — see the API's note on why not Math.round. */
export function divRoundHalfUp(num: number, den: number): number {
  const neg = num < 0;
  const a = Math.abs(num);
  const q = Math.floor(a / den);
  const r = a - q * den;
  const rounded = 2 * r >= den ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/** "45,000.50" / "₹45000" / 45000 -> paise. Returns null on junk — the caller SHOWS that,
 *  rather than quietly quoting ₹0 (the Campaign Budget bug, with money). */
export function parseRupees(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return 0;
  const cleaned = String(v).trim().replace(/[₹,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '.') return null;
  const [whole, frac = ''] = cleaned.split('.');
  const f3 = (frac + '000').slice(0, 3);
  return divRoundHalfUp(Number(whole || '0') * 1000 + Number(f3), 10);
}

/** ₹ with INDIAN digit grouping (2,2,3 — ₹12,34,567.00, not ₹1,234,567.00). */
export function fmtINR(minor: number | string | null | undefined, opts: { symbol?: boolean } = {}): string {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return '—';
  const symbol = opts.symbol !== false;
  const neg = n < 0;
  const a = Math.abs(Math.trunc(n));
  const paise = String(a % 100).padStart(2, '0');
  const rupees = String(Math.floor(a / 100));
  let grouped: string;
  if (rupees.length <= 3) grouped = rupees;
  else {
    const last3 = rupees.slice(-3);
    grouped = `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${grouped}.${paise}`;
}

/** paise -> the plain number a rupee <input> holds. */
export const minorToInput = (minor: number | string | null | undefined): string => {
  const n = Number(minor ?? 0);
  return n ? String(n / 100) : '';
};

export interface LineDraft {
  course_id?: number | null;
  description: string;
  qty: string;
  unit_price: string;
  discount_type: DiscountType;
  discount_value: string;
  tax_pct: string;
}

export interface LineTotals {
  gross_minor: number; discount_minor: number; taxable_minor: number;
  tax_minor: number; total_minor: number; error?: string;
}

/** One line — the same rules as the API, in the same order. */
export function computeLine(l: LineDraft): LineTotals {
  const zero = { gross_minor: 0, discount_minor: 0, taxable_minor: 0, tax_minor: 0, total_minor: 0 };
  const qty = Number(l.qty || 1);
  const unit = parseRupees(l.unit_price);
  if (unit === null) return { ...zero, error: 'The rate is not an amount' };
  if (!Number.isInteger(qty) || qty < 1) return { ...zero, error: 'Quantity must be a whole number of 1 or more' };

  const gross = unit * qty;
  let discount: number;
  if (l.discount_type === 'percent') {
    const p = Number(l.discount_value || 0);
    if (!Number.isFinite(p) || p < 0) return { ...zero, error: 'The discount is not a percentage' };
    if (p > 100) return { ...zero, error: 'A percentage discount cannot exceed 100%' };
    discount = divRoundHalfUp(gross * Math.round(p * 1000), 100 * 1000);
  } else {
    const d = parseRupees(l.discount_value);
    if (d === null) return { ...zero, error: 'The discount is not an amount' };
    discount = d;
  }
  if (discount > gross) discount = gross;          // a discount never exceeds its line

  const taxable = gross - discount;
  const t = Number(l.tax_pct || 0);
  if (!Number.isFinite(t) || t < 0 || t > 100) return { ...zero, error: 'Tax must be between 0 and 100%' };
  const tax = divRoundHalfUp(taxable * Math.round(t * 1000), 100 * 1000);   // on the DISCOUNTED amount
  return { gross_minor: gross, discount_minor: discount, taxable_minor: taxable, tax_minor: tax, total_minor: taxable + tax };
}

/** The totals are the SUM OF THE ROUNDED LINES — so the column on screen adds up. */
export function computeTotals(lines: LineDraft[]) {
  const computed = lines.map(computeLine);
  const t = { subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0 };
  for (const c of computed) {
    t.subtotal_minor += c.gross_minor;
    t.discount_minor += c.discount_minor;
    t.tax_minor += c.tax_minor;
    t.total_minor += c.total_minor;
  }
  return { ...t, lines: computed, error: computed.find((c) => c.error)?.error };
}
