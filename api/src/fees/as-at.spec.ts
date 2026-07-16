import { FeeService } from './fee.service';
import { isAtOrBefore, paidAsAtMinor } from './as-at';

/**
 * DEF-S5-02 — THE RECEIPT MUST SHOW THE BALANCE AS AT THAT RECEIPT.
 *
 * The Tester's live repro, as fixtures: Rs 50,000 net fee, THREE PARTIALS ON ONE DAY
 * (part-cash/part-UPI at the desk — the normal case, not an edge case). Before the fix all
 * three receipts printed "paid 50,000.00 / balance 0.00", so a Rs 20,000 first receipt told
 * the customer he had paid in full and owed nothing.
 *
 * WHY THESE FIXTURES ARE ALL SAME-DAY: every pre-existing fee fixture used receipts on
 * DISTINCT dates, where the old `x.received_at <= fr.received_at` happens to be right.
 * That is exactly why 1047 green tests missed a false financial document. Any new fixture
 * here must keep at least one same-day pair or it is testing the wrong thing.
 */

/** The live repro, to the paisa. All three at midnight — as the collect form posts them. */
const D = '2026-07-16T00:00:00.000Z';
const RC1 = { id: 1, amount_minor: 2_000_000, received_at: D };   // RC-2026/0001  Rs 20,000.00
const RC2 = { id: 2, amount_minor: 1_500_055, received_at: D };   // RC-2026/0002  Rs 15,000.55
const RC3 = { id: 3, amount_minor: 1_499_945, received_at: D };   // RC-2026/0003  Rs 14,999.45
const ALL = [RC1, RC2, RC3];
const NET = 5_000_000;

describe('DEF-S5-02 — same-day partials each show THEIR OWN balance', () => {
  it('the first receipt of three taken on ONE day shows 20,000 paid / 30,000 balance', () => {
    const paid = paidAsAtMinor(ALL, RC1);
    expect(paid).toBe(2_000_000);            // was 5_000_000 — the final balance, on receipt #1
    expect(NET - paid).toBe(3_000_000);      // was 0 — "you owe nothing", to a man who owes Rs 30,000
  });

  it('the second shows the RUNNING total, not the final one', () => {
    const paid = paidAsAtMinor(ALL, RC2);
    expect(paid).toBe(3_500_055);
    expect(NET - paid).toBe(1_499_945);
  });

  it('the last one closes the fee exactly — 0.00 outstanding, to the paisa', () => {
    const paid = paidAsAtMinor(ALL, RC3);
    expect(paid).toBe(5_000_000);
    expect(NET - paid).toBe(0);
  });

  it('the three as-at totals are STRICTLY INCREASING — a receipt is a running total', () => {
    const totals = ALL.map((r) => paidAsAtMinor(ALL, r));
    expect(totals).toEqual([2_000_000, 3_500_055, 5_000_000]);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
  });

  it('THE REGRESSION ITSELF: the old no-tiebreak rule gave all three the same number', () => {
    // `x.received_at <= fr.received_at`, evaluated in JS over the same rows.
    const oldRule = (cur: typeof RC1) =>
      ALL.filter((x) => new Date(x.received_at) <= new Date(cur.received_at))
        .reduce((a, x) => a + x.amount_minor, 0);
    expect(ALL.map(oldRule)).toEqual([5_000_000, 5_000_000, 5_000_000]);   // the defect
    expect(ALL.map((r) => paidAsAtMinor(ALL, r))).not.toEqual(ALL.map(oldRule));
  });

  it('order is (received_at, id) — a LOWER id on the SAME timestamp is earlier', () => {
    expect(isAtOrBefore(RC1, RC2)).toBe(true);
    expect(isAtOrBefore(RC2, RC1)).toBe(false);
    expect(isAtOrBefore(RC2, RC2)).toBe(true);      // inclusive: "as at" includes itself
  });

  it('rows arriving in ANY order give the same answer — the query has no ORDER BY', () => {
    const shuffled = [RC3, RC1, RC2];
    expect(paidAsAtMinor(shuffled, RC2)).toBe(3_500_055);
  });
});

describe('as-at still behaves on the cases that always worked', () => {
  it('receipts on DISTINCT dates (the old fixtures) are unchanged', () => {
    const a = { id: 1, amount_minor: 1000, received_at: '2026-01-10T00:00:00Z' };
    const b = { id: 2, amount_minor: 2000, received_at: '2026-02-10T00:00:00Z' };
    expect(paidAsAtMinor([a, b], a)).toBe(1000);
    expect(paidAsAtMinor([a, b], b)).toBe(3000);
  });

  it('a LATER receipt with a LOWER id (back-dated entry) still sorts by date first', () => {
    const late = { id: 9, amount_minor: 500, received_at: '2026-01-01T00:00:00Z' };
    const cur = { id: 2, amount_minor: 700, received_at: '2026-06-01T00:00:00Z' };
    expect(paidAsAtMinor([late, cur], cur)).toBe(1200);   // date wins over id
    expect(paidAsAtMinor([late, cur], late)).toBe(500);
  });

  it('a single receipt against a fee is just itself', () => {
    expect(paidAsAtMinor([RC1], RC1)).toBe(2_000_000);
  });

  it('string amounts and Date objects (what node-postgres actually hands back) work', () => {
    const rows = [
      { id: '1', amount_minor: '2000000', received_at: new Date(D) },
      { id: '2', amount_minor: '1500055', received_at: new Date(D) },
    ];
    expect(paidAsAtMinor(rows, rows[0])).toBe(2_000_000);
    expect(paidAsAtMinor(rows, rows[1])).toBe(3_500_055);
  });

  it('paise never drift — integers, never floats', () => {
    const rows = [
      { id: 1, amount_minor: 10, received_at: D },
      { id: 2, amount_minor: 10, received_at: D },
      { id: 3, amount_minor: 10, received_at: D },
    ];
    expect(paidAsAtMinor(rows, rows[2])).toBe(30);        // 0.1+0.1+0.1 === 0.3, in paise
  });
});

/**
 * ...AND THROUGH THE SERVICE, because a pure function nothing calls is decoration. This
 * drives the real `FeeService.get()` and asserts the number that reaches the PDF.
 */
function svcWithReceipts(rows: Array<Record<string, unknown>>, current: Record<string, unknown>) {
  const db = {
    one: async (sql: string) => (/FROM fee_receipt fr/.test(sql)
      ? { ...current, enrolment_id: 1, net_fee_minor: NET, receipt_no: 'RC-2026/0001' }
      : null),
    query: async (sql: string) => (/FROM fee_receipt\s*$|FROM fee_receipt\b/.test(sql) ? rows : []),
    tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  return new FeeService(db as never, resolver as never, { allocate: async () => 'RC-2026/0001' } as never);
}

describe('FeeService.get() — the number that actually reaches the receipt PDF', () => {
  it('returns paid AS AT the first same-day receipt, not the final total', async () => {
    const svc = svcWithReceipts(ALL, RC1);
    const r = await svc.get(1, {} as never);
    expect(r.paid_minor).toBe(2_000_000);
    expect(Number(r.net_fee_minor) - r.paid_minor).toBe(3_000_000);
  });

  it('returns the running total as at the second same-day receipt', async () => {
    const svc = svcWithReceipts(ALL, RC2);
    const r = await svc.get(2, {} as never);
    expect(r.paid_minor).toBe(3_500_055);
  });

  it('the SQL no longer carries the defective no-tiebreak predicate', async () => {
    const seen: string[] = [];
    const db = {
      one: async (sql: string) => { seen.push(sql); return { ...RC1, enrolment_id: 1, net_fee_minor: NET }; },
      query: async (sql: string) => { seen.push(sql); return ALL; },
      tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
    };
    const svc = new FeeService(db as never, { buildScopeWhere: () => '1=1' } as never, {} as never);
    await svc.get(1, {} as never);
    for (const sql of seen) expect(sql).not.toMatch(/received_at\s*<=\s*fr\.received_at/);
  });
});
