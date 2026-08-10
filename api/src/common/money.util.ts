/**
 * MONEY — integer minor units (paise), and the rounding rules, in one pure module.
 *
 * =============================================================================
 * THE RULES (documented in PROJECT_DOCUMENTATION's decision log, and TESTED below
 * in money.util.spec.ts — these are not aspirations, they are pinned)
 * =============================================================================
 *
 * 1. EVERY amount is an INTEGER number of PAISE. Never a float. `45000.10` cannot be
 *    represented exactly in binary floating point; `4500010` can. A rupee value only
 *    exists at the edges — the UI parses one on the way in and formats one on the way
 *    out, and both conversions live here so there is exactly one of each.
 *
 * 2. DISCOUNT IS APPLIED BEFORE TAX. (Tax on a discount nobody paid is not a tax.)
 *
 * 3. PER LINE, THEN SUM — not "sum, then apply". Each line's discount and tax are
 *    computed and rounded to the paisa on that line, and the totals are the SUM OF THE
 *    ROUNDED LINES. This is the rule that makes the PDF honest: the Amount column adds
 *    up to the Total, exactly, with no stray paisa that a customer can point at. The
 *    alternative (round only the total) is arithmetically defensible and produces a
 *    document whose own column does not add up.
 *
 * 4. ROUNDING IS HALF-UP on the absolute value (0.5 paise -> 1 paisa). This is what
 *    Indian invoicing does and what a human doing it by hand does. `Math.round` is NOT
 *    used: it is float-based, and it rounds half toward +Infinity (so -0.5 -> -0), which
 *    is a different rule. Everything below is integer arithmetic.
 *
 * 5. A DISCOUNT CAN NEVER EXCEED THE LINE. 120% off does not pay the customer; it is
 *    clamped to 100% and the line goes to zero. Likewise a negative discount is refused
 *    upstream (a CHECK constraint) — a "negative discount" is a price rise in disguise.
 *
 * NOTE ON TAX: tax is SHOWN and computed, but this is NOT GST machinery. There is no
 * CGST/SGST/IGST split, no place-of-supply, no HSN/SAC, no tax invoice. That is Phase 3
 * (PROJECT_DOCUMENTATION §5). A quotation may legitimately show "Tax @18%" as a line;
 * a tax INVOICE is a legal document and we are deliberately not forging one.
 */

/** Fixed-point scale for percentages: 3 decimal places (18.5% -> 18500). */
const PCT_SCALE = 1000;
const PCT_DIVISOR = 100 * PCT_SCALE;   // percent -> fraction

export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/** Guard every integer that leaves this module — a silently-lossy money value is a bug
 *  that only shows up in the client's ledger, months later. */
function safe(n: number, what: string): number {
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${what} is not a safe integer (${n}) — the amount is too large to represent exactly`);
  }
  return n;
}

/** Half-up rounding of `num / den` using integer arithmetic only. den > 0. */
export function divRoundHalfUp(num: number, den: number): number {
  if (den <= 0) throw new Error('divRoundHalfUp: denominator must be positive');
  const neg = num < 0;
  const a = Math.abs(num);
  const q = Math.floor(a / den);
  const r = a - q * den;
  // r/den >= 0.5  <=>  2r >= den
  const rounded = 2 * r >= den ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/** A percentage string/number -> fixed-point (3dp). Rejects nonsense rather than coercing. */
export function pctToFixed(pct: unknown): number {
  const n = typeof pct === 'number' ? pct : Number(String(pct ?? '0').trim());
  if (!Number.isFinite(n)) throw new Error(`"${String(pct)}" is not a percentage`);
  if (n < 0) throw new Error('A percentage cannot be negative');
  // round the INPUT to the stored scale so what we compute is what the column holds
  return divRoundHalfUp(Math.round(n * PCT_SCALE * 1000), 1000);
}

/** `gross * pct%`, rounded half-up to the paisa. */
export function applyPct(minor: number, pct: unknown): number {
  const p = pctToFixed(pct);
  if (p === 0) return 0;
  return safe(divRoundHalfUp(minor * p, PCT_DIVISOR), 'percentage result');
}

/* -------------------------------------------------------------------------- */
/*  RUPEES <-> PAISE — the ONLY two conversions in the codebase.               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a user-typed rupee amount into paise. Accepts "45000", "45,000.50", "₹45000",
 * " 45000.5 ", 45000. Refuses anything else LOUDLY — a money field that silently
 * becomes 0 is exactly the Campaign Budget bug (QA-13 §4), and it is worse with money.
 */
export function rupeesToMinor(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`"${String(v)}" is not an amount`);
    return safe(divRoundHalfUp(Math.round(v * 1000), 10), 'amount');
  }
  const cleaned = String(v).trim().replace(/[₹,\s]/g, '');
  if (cleaned === '') return 0;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === '.' || cleaned === '-') {
    throw new Error(`"${String(v)}" is not an amount`);
  }
  const neg = cleaned.startsWith('-');
  const [whole, frac = ''] = cleaned.replace(/^-/, '').split('.');
  // take 3 decimals then round to 2 — so "10.005" -> 10.01, not 10.00
  const f3 = (frac + '000').slice(0, 3);
  const thousandths = Number(whole || '0') * 1000 + Number(f3);
  const minor = divRoundHalfUp(thousandths, 10);
  return safe(neg ? -minor : minor, 'amount');
}

/** Paise -> a plain decimal string ("4500050" -> "45000.50"). No symbol, no grouping. */
export function minorToRupeeString(minor: number): string {
  const neg = minor < 0;
  const a = Math.abs(Math.trunc(minor));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * ₹ with INDIAN DIGIT GROUPING (2,2,3 — "₹12,34,567.00", not "₹1,234,567.00").
 * Hand-rolled rather than Intl: Node's ICU build on the deploy image is not something
 * a receipt's grouping should depend on, and this is six lines.
 */
export function formatINR(minor: number, opts: { symbol?: boolean } = {}): string {
  const symbol = opts.symbol !== false;
  const neg = minor < 0;
  const a = Math.abs(Math.trunc(minor));
  const paise = String(a % 100).padStart(2, '0');
  const rupees = String(Math.floor(a / 100));
  let grouped: string;
  if (rupees.length <= 3) grouped = rupees;
  else {
    const last3 = rupees.slice(-3);
    const rest = rupees.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  return `${neg ? '-' : ''}${symbol ? '₹' : ''}${grouped}.${paise}`;
}

/* -------------------------------------------------------------------------- */
/*  THE LINE MATHS                                                             */
/* -------------------------------------------------------------------------- */

export type DiscountType = 'amount' | 'percent';

export interface LineInput {
  qty: number;
  unit_price_minor: number;
  discount_type: DiscountType;
  /** paise when `amount`; a percentage when `percent` */
  discount_value: number;
  tax_pct: number;
}

export interface LineComputed {
  gross_minor: number;
  discount_minor: number;
  taxable_minor: number;
  tax_minor: number;
  total_minor: number;
}

export interface Totals {
  subtotal_minor: number;   // sum of gross
  discount_minor: number;   // sum of line discounts
  tax_minor: number;        // sum of line taxes
  total_minor: number;      // sum of line totals — and it equals subtotal - discount + tax
}

/**
 * One line, exactly. Rule 2 (discount then tax), rule 3 (rounded here, on the line),
 * rule 4 (half-up), rule 5 (clamped).
 */
export function computeLine(l: LineInput): LineComputed {
  const qty = Math.trunc(Number(l.qty));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be a whole number of 1 or more');
  const unit = Math.trunc(Number(l.unit_price_minor));
  if (!Number.isFinite(unit) || unit < 0) throw new Error('Unit price cannot be negative');

  const gross = safe(unit * qty, 'line gross');

  let discount: number;
  if (l.discount_type === 'percent') {
    discount = applyPct(gross, l.discount_value);
  } else {
    const d = Math.trunc(Number(l.discount_value));
    if (!Number.isFinite(d) || d < 0) throw new Error('A discount cannot be negative');
    discount = d;
  }
  // RULE 5 — a discount never exceeds its line.
  if (discount > gross) discount = gross;

  const taxable = gross - discount;
  const tax = applyPct(taxable, l.tax_pct);          // RULE 2 — on the DISCOUNTED amount
  const total = safe(taxable + tax, 'line total');

  return {
    gross_minor: gross, discount_minor: discount, taxable_minor: taxable,
    tax_minor: tax, total_minor: total,
  };
}

/** RULE 3 — the totals are the SUM OF THE ROUNDED LINES. */
export function computeTotals(lines: LineComputed[]): Totals {
  const t: Totals = { subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0 };
  for (const l of lines) {
    t.subtotal_minor += l.gross_minor;
    t.discount_minor += l.discount_minor;
    t.tax_minor += l.tax_minor;
    t.total_minor += l.total_minor;
  }
  safe(t.total_minor, 'quotation total');
  return t;
}

/* -------------------------------------------------------------------------- */
/*  AMOUNT IN WORDS — Indian numbering (crore / lakh / thousand), for the GST   */
/*  tax invoice's mandatory "amount in words" line. Pure + unit-tested.         */
/* -------------------------------------------------------------------------- */

const WORDS_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const WORDS_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n: number): string {
  return n < 20 ? WORDS_ONES[n] : `${WORDS_TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + WORDS_ONES[n % 10] : ''}`;
}
function threeDigitWords(n: number): string {
  return n >= 100
    ? `${WORDS_ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + twoDigitWords(n % 100) : ''}`
    : twoDigitWords(n);
}

/** Whole-number -> Indian words (Crore/Lakh/Thousand grouping). `0` -> "Zero". */
export function integerToIndianWords(num: number): string {
  let n = Math.abs(Math.trunc(num));
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  let out = '';
  // >99 crore recurses so arbitrarily large figures still read correctly.
  if (crore) out += `${integerToIndianWords(crore)} Crore `;
  if (lakh) out += `${twoDigitWords(lakh)} Lakh `;
  if (thousand) out += `${twoDigitWords(thousand)} Thousand `;
  if (n) out += `${threeDigitWords(n)} `;
  return out.trim();
}

/**
 * Paise -> "Rupees … and … Paise Only" in Indian words — the line a GST tax invoice
 * must carry. Negative amounts (a credit) are prefixed "Minus".
 */
export function amountInWordsINR(minor: number): string {
  const neg = minor < 0;
  const a = Math.abs(Math.trunc(minor));
  const rupees = Math.floor(a / 100);
  const paise = a % 100;
  let out = `Rupees ${integerToIndianWords(rupees)}`;
  if (paise) out += ` and ${integerToIndianWords(paise)} Paise`;
  out += ' Only';
  return neg ? `Minus ${out}` : out;
}
