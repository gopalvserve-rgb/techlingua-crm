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

/* -------------------------------------------------------------------------- */
/*  ENROLMENT DISCOUNT + PAYMENT-PLAN PREVIEW (client feedback item 4)         */
/*  Mirrors api/src/enrolments/discount.util.ts + paymentplans/schedule.util.ts */
/*  — a LIVE PREVIEW only; the server recomputes and is the truth.             */
/* -------------------------------------------------------------------------- */

export type EnrolDiscountType = 'none' | 'amount' | 'percent';

/** Derive the discount amount + net from the gross fee + how the discount was entered.
 *  `grossMinor` and (for amount) `valueMinor` are paise; for percent, `value` is a % number. */
export function enrolDiscount(grossMinor: number, type: EnrolDiscountType, value: number): { discount_minor: number; net_minor: number } {
  const gross = Math.trunc(Number(grossMinor) || 0);
  let disc = 0;
  if (type === 'amount') disc = Math.trunc(Number(value) || 0);
  else if (type === 'percent') {
    const p = Number(value) || 0;
    disc = divRoundHalfUp(gross * Math.round(p * 1000), 100 * 1000);
  }
  if (disc < 0) disc = 0;
  if (disc > gross) disc = gross;
  return { discount_minor: disc, net_minor: gross - disc };
}

/** Split `amount` paise into `n` integer parts summing EXACTLY to it (earlier parts +1). */
export function splitEvenly(amount: number, n: number): number[] {
  const a = Math.trunc(Number(amount) || 0);
  const count = Math.max(1, Math.trunc(Number(n) || 1));
  const base = Math.floor(a / count);
  let leftover = a - base * count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) { out.push(base + (leftover > 0 ? 1 : 0)); if (leftover > 0) leftover--; }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Add `months` to a 'YYYY-MM-DD', clamping the day to the target month. */
export function addMonthsYmd(date: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  if (!m) return date;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const total = (y * 12 + (mo - 1)) + months;
  const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, dim))}`;
}

export interface PlanPreviewInput {
  plan_type: 'full' | 'installment' | 'custom';
  net_minor: number;
  down_minor?: number;
  num_installments?: number;
  start_date?: string;                 // 'YYYY-MM-DD'
  custom_amounts_minor?: number[];     // custom only
  custom_dates?: string[];             // custom only (optional; else monthly)
}
export interface PlanPreviewRow { seq_no: number; label: string; due_date: string; amount_minor: number }
export interface PlanPreview { rows: PlanPreviewRow[]; sum_minor: number; balances: boolean; error?: string }

/** Build a schedule PREVIEW that sums to the net (down + installments). Returns balances:false
 *  (with an error) for a custom set whose amounts don't add up — the UI shows that. */
export function previewSchedule(inp: PlanPreviewInput): PlanPreview {
  const net = Math.trunc(Number(inp.net_minor) || 0);
  const down = Math.trunc(Number(inp.down_minor) || 0);
  const start = inp.start_date && /^\d{4}-\d{2}-\d{2}/.test(inp.start_date) ? inp.start_date : new Date().toISOString().slice(0, 10);
  if (down > net) return { rows: [], sum_minor: 0, balances: false, error: 'The down payment cannot exceed the net fee.' };
  if (inp.plan_type === 'full') {
    const rows = [{ seq_no: 1, label: 'Full payment', due_date: start, amount_minor: net }];
    return { rows, sum_minor: net, balances: true };
  }
  const remainder = net - down;
  const rows: PlanPreviewRow[] = [];
  let seq = 1;
  if (down > 0) rows.push({ seq_no: seq++, label: 'Down payment', due_date: start, amount_minor: down });
  const off = down > 0 ? 1 : 0;
  let parts: number[]; let err: string | undefined;
  if (inp.plan_type === 'custom' && (inp.custom_amounts_minor?.length)) {
    parts = inp.custom_amounts_minor.map((a) => Math.trunc(Number(a) || 0));
    const psum = parts.reduce((a, b) => a + b, 0);
    if (psum !== remainder) err = `The installments total ${fmtINR(psum)} but the payable after down payment is ${fmtINR(remainder)}.`;
  } else {
    parts = splitEvenly(remainder, Math.max(1, Number(inp.num_installments) || 1));
  }
  parts.forEach((amt, i) => {
    const due = inp.plan_type === 'custom' && inp.custom_dates?.[i] ? inp.custom_dates[i] : addMonthsYmd(start, i + off);
    rows.push({ seq_no: seq++, label: `Installment ${i + 1} of ${parts.length}`, due_date: due, amount_minor: amt });
  });
  const sum = rows.reduce((a, r) => a + r.amount_minor, 0);
  return { rows, sum_minor: sum, balances: !err && sum === net, error: err };
}
