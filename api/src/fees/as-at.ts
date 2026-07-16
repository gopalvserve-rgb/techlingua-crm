/**
 * "PAID AS AT THIS RECEIPT" — the arithmetic behind the one number on a receipt that a
 * customer will argue about.
 *
 * =============================================================================
 * WHY THIS IS A PURE FUNCTION AND NOT A LINE OF SQL (DEF-S5-02)
 * =============================================================================
 * It used to be a `LEFT JOIN LATERAL` inside `FeeService.get()`:
 *
 *     WHERE x.enrolment_id = fr.enrolment_id AND x.deleted_at IS NULL
 *       AND x.received_at <= fr.received_at          -- <-- no tiebreak
 *
 * `fee_receipt.received_at` is a timestamptz, but the collect form posts a DATE, so every
 * receipt taken on one day is stored at exactly midnight. `<=` is therefore true for every
 * same-day receipt INCLUDING THE ONES TAKEN LATER, and all of them printed the FINAL
 * balance. A Rs 20,000 first receipt told the customer he had paid Rs 50,000 and owed
 * nothing. Part-cash/part-UPI at the counselling desk is not an edge case — it is the
 * normal case.
 *
 * The fix is four lines of SQL. It is NOT four lines of SQL here, on purpose:
 *
 *   **no unit test could ever have caught this while the arithmetic lived in SQL.**
 *
 * Every fee spec drives a hand-built in-memory `db` double that returns whatever
 * `paid_minor` it likes and never parses a predicate — so the SQL was, structurally,
 * untestable, and 1047 green tests said nothing about it. That is the same lesson as the
 * API booting with a broken injector no spec ever exercised: *the broken thing was the
 * thing no test could reach.* Moving the arithmetic into a pure function over rows puts it
 * where a same-day fixture proves it, for ever, with no database.
 *
 * =============================================================================
 * THE ORDER
 * =============================================================================
 * `(received_at, id)`, lexicographically — the exact order the receipt NUMBERS are issued
 * in, because `id` and the numbering series both advance with the same insert. So "paid as
 * at RC-2026/0002" means RC-0001 + RC-0002 and nothing else, whatever the clock says.
 */

export interface AsAtReceipt {
  id: number | string;
  amount_minor: number | string;
  received_at: string | Date;
}

const ms = (d: string | Date): number => (d instanceof Date ? d : new Date(d)).getTime();

/**
 * Is `x` at-or-before `cur` in receipt order? Ties on `received_at` — which is EVERY
 * same-day receipt, since the form posts a date — are broken by `id`.
 */
export function isAtOrBefore(x: AsAtReceipt, cur: AsAtReceipt): boolean {
  const xt = ms(x.received_at);
  const ct = ms(cur.received_at);
  if (xt !== ct) return xt < ct;
  return Number(x.id) <= Number(cur.id);
}

/**
 * Total received against this enrolment up to AND INCLUDING `cur`.
 *
 * `all` is every live receipt for the enrolment (soft-deleted ones are filtered out by the
 * caller's query — a cancelled receipt is not money). Integers of paise throughout; there
 * is no float in this file and there must never be one.
 */
export function paidAsAtMinor(all: AsAtReceipt[], cur: AsAtReceipt): number {
  let total = 0;
  for (const r of all) if (isAtOrBefore(r, cur)) total += Number(r.amount_minor);
  return total;
}
