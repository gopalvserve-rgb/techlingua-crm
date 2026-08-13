/**
 * PAYMENT-PLAN SCHEDULE — a pure, unit-tested generator. No DB, no clock, no floats.
 *
 * =============================================================================
 * THE ONE RULE THE CLIENT WILL CHECK: the installments SUM EXACTLY TO THE TOTAL.
 * =============================================================================
 * `total_minor` is the enrolment's NET fee (fee − discount), in paise. A schedule of N
 * installments must add up to it to the paisa — a plan whose rows do not total the fee
 * is a plan an accountant will reject. We split with INTEGER arithmetic only:
 *
 *   base      = floor(remainder / N)
 *   leftover  = remainder − base * N          (0 <= leftover < N)
 *   the first `leftover` installments get base + 1 paisa, the rest get base.
 *
 * So sum = base*N + leftover = remainder, exactly, and the paisa never leaks. The
 * EARLIER installments carry the extra paisa (a customer pays the odd paisa sooner, not
 * later — the same convention Indian EMI schedules use).
 *
 * DOWN PAYMENT: if given, it is installment #1 (due on the start date), and the remainder
 * (total − down) is split across the remaining N installments. If no down payment, all N
 * installments split the total. FULL = a single installment equal to the total.
 *
 * DUE DATES: monthly adds calendar months (clamped to the month's last day so 31 Jan → 28
 * Feb, never a rolled-over 3 Mar); weekly adds 7 days. All dates are plain 'YYYY-MM-DD'
 * calendar days — no timezone, because a due DATE has none.
 */

export type PlanType = 'full' | 'installment' | 'emi' | 'custom';
export type Frequency = 'once' | 'weekly' | 'monthly' | 'custom';

export interface ScheduleInput {
  plan_type: PlanType;
  total_minor: number;
  down_payment_minor?: number;
  num_installments: number;   // count of NON-down-payment installments (>=1)
  frequency: Frequency;
  start_date: string;         // 'YYYY-MM-DD' — first due date
  /** CUSTOM only: explicit due dates for each installment (overrides frequency spacing) */
  custom_dates?: string[];
  /** CUSTOM only: explicit installment AMOUNTS (paise). When given, they REPLACE the equal
   *  split — the client types each installment's amount and they must sum to the remaining
   *  payable (total − down payment). The count of installments becomes custom_amounts.length. */
  custom_amounts?: number[];
}

export interface ScheduleRow {
  seq_no: number;
  due_date: string;
  amount_minor: number;
  label: string;
}

/** Split `amount` into `n` integer parts that sum EXACTLY to `amount` (earlier parts +1). */
export function splitEvenly(amount: number, n: number): number[] {
  const a = Math.trunc(Number(amount));
  const count = Math.trunc(Number(n));
  if (!Number.isFinite(a) || a < 0) throw new Error('amount must be a non-negative integer of paise');
  if (!Number.isFinite(count) || count < 1) throw new Error('installment count must be 1 or more');
  const base = Math.floor(a / count);
  let leftover = a - base * count;   // 0..count-1
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(base + (leftover > 0 ? 1 : 0));
    if (leftover > 0) leftover--;
  }
  return out;
}

/** Parse 'YYYY-MM-DD' into [y,m,d] (m is 1-12). Strict — throws on nonsense. */
function parseYmd(s: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? '').trim());
  if (!m) throw new Error(`"${s}" is not a YYYY-MM-DD date`);
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`"${s}" is not a valid date`);
  return [y, mo, d];
}
const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();  // m 1-12
/** Normalise any accepted date to a clean 'YYYY-MM-DD' WITHOUT String(x).slice (the
 *  date-pattern guard forbids that shape; parseYmd validates and we reformat). */
function ymd(v: string): string { const [y, m, d] = parseYmd(v); return `${y}-${pad(m)}-${pad(d)}`; }

/** Add `months` calendar months to a 'YYYY-MM-DD', clamping the day to the target month. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parseYmd(date);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(nd)}`;
}
/** Add `days` to a 'YYYY-MM-DD' (UTC arithmetic — a plain calendar day has no tz). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseYmd(date);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function dueDateFor(i: number, offset: number, input: ScheduleInput): string {
  // i is the 0-based index among the NON-down-payment installments; offset shifts the
  // period spacing by 1 when a down payment already occupies the start date.
  if (input.frequency === 'custom' && input.custom_dates && input.custom_dates.length) {
    const d = input.custom_dates[i] ?? input.custom_dates[input.custom_dates.length - 1];
    return ymd(String(d));
  }
  if (input.frequency === 'weekly') return addDays(input.start_date, (i + offset) * 7);
  // monthly (default) — first at start_date, then +1 month each
  return addMonths(input.start_date, i + offset);
}

/**
 * Generate the installment schedule. The returned rows' `amount_minor` sum EXACTLY to
 * `total_minor` (asserted here — a schedule that does not is a bug, not a rounding
 * artefact to be tolerated).
 */
export function generateSchedule(input: ScheduleInput): ScheduleRow[] {
  const total = Math.trunc(Number(input.total_minor));
  if (!Number.isFinite(total) || total < 0) throw new Error('total_minor must be a non-negative integer of paise');
  const down = Math.trunc(Number(input.down_payment_minor ?? 0));
  if (down < 0) throw new Error('down payment cannot be negative');
  if (down > total) throw new Error('down payment cannot exceed the total fee');

  if (input.plan_type === 'full' || input.frequency === 'once') {
    return [{ seq_no: 1, due_date: ymd(input.start_date), amount_minor: total, label: 'Full payment' }];
  }

  const remainder = total - down;
  // CUSTOM amounts: the caller supplied each installment's amount — they must sum EXACTLY to
  // the remaining payable (total − down). This is the client's "custom" plan: user-defined
  // amounts + due dates. We validate the sum here so a plan that does not add up is rejected.
  const hasCustomAmounts = input.plan_type === 'custom'
    && Array.isArray(input.custom_amounts) && input.custom_amounts.length > 0;
  let parts: number[];
  let n: number;
  if (hasCustomAmounts) {
    parts = (input.custom_amounts as number[]).map((a) => Math.trunc(Number(a)));
    if (parts.some((a) => !Number.isFinite(a) || a < 0)) throw new Error('every custom installment amount must be a non-negative amount');
    n = parts.length;
    const psum = parts.reduce((a, b) => a + b, 0);
    if (psum !== remainder) {
      throw new Error(`the custom installment amounts (${psum}) must sum to the payable after down payment (${remainder})`);
    }
  } else {
    n = Math.trunc(Number(input.num_installments));
    if (!Number.isFinite(n) || n < 1) throw new Error('installment count must be 1 or more');
    parts = splitEvenly(remainder, n);
  }

  const rows: ScheduleRow[] = [];
  let seq = 1;
  if (down > 0) {
    rows.push({ seq_no: seq++, due_date: ymd(input.start_date), amount_minor: down, label: 'Down payment' });
  }
  // when there IS a down payment, the N installments start one period AFTER the start date
  const baseOffset = down > 0 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    rows.push({
      seq_no: seq++,
      due_date: dueDateFor(i, baseOffset, input),
      amount_minor: parts[i],
      label: `Installment ${i + 1} of ${n}`,
    });
  }

  const sum = rows.reduce((a, r) => a + r.amount_minor, 0);
  if (sum !== total) throw new Error(`schedule does not sum to the total (${sum} != ${total})`);
  return rows;
}
