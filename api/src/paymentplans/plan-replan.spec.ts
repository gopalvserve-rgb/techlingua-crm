import { PlanService, balanceSplit } from './plan.service';

/**
 * CLIENT 5 NOV (points 1 + 7) — "agar kisi ka 20000 fee hai aur usne pahle 10000 pay kiya hai,
 * chahe installment ya down payment ke through, ab uska agr fee reschedule karte hai to Balance
 * amount ka reschedule hona chahiye". Re-planning keeps what is paid as paid rows (with the
 * receipts that paid them) and schedules ONLY the balance. Driven through an in-memory database
 * that models the tables the re-plan touches.
 */
type Inst = { id: number; plan_id: number; seq_no: number; due_date: string; amount_minor: number; paid_minor: number; label: string; status: string };
type Alloc = { installment_id: number; fee_receipt_id: number; amount_minor: number };

function world(opts: {
  net: number;
  receipts: Array<{ id: number; amount: number; at: string }>;
  installments?: Inst[];
  allocations?: Alloc[];
}) {
  const plans = new Map<number, { id: number; status: string; deleted: boolean; total: number; plan_type: string }>();
  const inst: Inst[] = [...(opts.installments ?? [])];
  const alloc: Alloc[] = [...(opts.allocations ?? [])];
  for (const i of inst) if (!plans.has(i.plan_id)) plans.set(i.plan_id, { id: i.plan_id, status: 'active', deleted: false, total: opts.net, plan_type: 'installment' });
  const history: any[] = [];
  let nextPlan = 100; let nextInst = 1000;

  const q = async (sql: string, p: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const R = (rows: any[]) => ({ rows, rowCount: rows.length });
    if (/UPDATE payment_plan SET status = 'superseded'/.test(sql)) { plans.get(Number(p[0]))!.status = 'superseded'; return R([]); }
    if (/INSERT INTO payment_plan \(/.test(sql)) {
      const id = nextPlan++; plans.set(id, { id, status: 'active', deleted: false, total: Number(p[4]), plan_type: String(p[2]) }); return R([{ id: String(id) }]);
    }
    if (/INSERT INTO installment \(plan_id, enrolment_id, seq_no, due_date, amount_minor, paid_minor, label, status\)/.test(sql)) {
      const id = nextInst++;
      inst.push({ id, plan_id: Number(p[0]), seq_no: Number(p[2]), due_date: String(p[3]), amount_minor: Number(p[4]), paid_minor: Number(p[4]), label: String(p[5]), status: 'paid' });
      return R([{ id: String(id) }]);
    }
    if (/INSERT INTO installment \(plan_id, enrolment_id, seq_no, due_date, amount_minor, label\)/.test(sql)) {
      const id = nextInst++;
      inst.push({ id, plan_id: Number(p[0]), seq_no: Number(p[2]), due_date: String(p[3]), amount_minor: Number(p[4]), paid_minor: 0, label: String(p[5]), status: 'pending' });
      return R([]);
    }
    if (/UPDATE installment_payment SET installment_id/.test(sql)) {
      for (const a of alloc) if (a.installment_id === Number(p[0])) a.installment_id = Number(p[1]);
      return R([]);
    }
    if (/to_char\(min\(received_at\)/.test(sql)) return R([{ d: [...opts.receipts].sort((a, b) => a.at.localeCompare(b.at))[0]?.at ?? null }]);
    if (/SELECT fr.id, fr.amount_minor - COALESCE/.test(sql)) {
      return R(opts.receipts.map((r) => {
        const used = alloc.filter((a) => a.fee_receipt_id === r.id).filter((a) => {
          const i = inst.find((x) => x.id === a.installment_id); const pl = i ? plans.get(i.plan_id) : null;
          return !!pl && !pl.deleted && pl.status !== 'superseded';
        }).reduce((s, a) => s + a.amount_minor, 0);
        return { id: String(r.id), rest: String(r.amount - used) };
      }));
    }
    if (/SELECT COALESCE\(sum\(amount_minor\), 0\) AS s FROM installment_payment WHERE installment_id/.test(sql)) {
      return R([{ s: String(alloc.filter((a) => a.installment_id === Number(p[0])).reduce((s, a) => s + a.amount_minor, 0)) }]);
    }
    if (/INSERT INTO installment_payment/.test(sql)) { alloc.push({ installment_id: Number(p[0]), fee_receipt_id: Number(p[1]), amount_minor: Number(p[2]) }); return R([]); }
    if (/DELETE FROM installment WHERE plan_id/.test(sql)) { for (let k = inst.length - 1; k >= 0; k--) if (inst[k].plan_id === Number(p[0])) inst.splice(k, 1); return R([]); }
    if (/UPDATE payment_plan SET deleted_at/.test(sql)) { plans.get(Number(p[0]))!.deleted = true; return R([]); }
    if (/UPDATE payment_plan pp/.test(sql)) return R([]);
    if (/SELECT pp.org_id, pp.plan_type, pp.total_minor FROM payment_plan pp/.test(sql)) { const pl = plans.get(Number(p[0]))!; return R([{ org_id: 1, plan_type: pl.plan_type, total_minor: pl.total }]); }
    if (/SELECT seq_no, label, due_date, amount_minor, paid_minor, status FROM installment WHERE plan_id/.test(sql)) return R(inst.filter((i) => i.plan_id === Number(p[0])).sort((a, b) => a.seq_no - b.seq_no));
    if (/max\(version_no\)/.test(sql)) return R([{ v: history.length + 1 }]);
    if (/INSERT INTO payment_plan_history/.test(sql)) { history.push({ action: p[4], paid: p[7], balance: p[8], reason: p[10] }); return R([]); }
    return R([]);
  };
  const receiptsTotal = () => opts.receipts.reduce((s, r) => s + r.amount, 0);
  const db = {
    query: async (sql: string, p?: any[]) => (await q(sql, p)).rows,
    one: async (sql: string, p?: any[]) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/receipts_minor/.test(sql)) return { id: 7, net_fee_minor: opts.net, status: 'active', enrolment_no: 'FR001-2026-099', start_date: '2026-11-01', receipts_minor: receiptsTotal() };
      if (/AS paid_minor/.test(sql)) return { id: 7, org_id: 1, net_fee_minor: opts.net, status: 'active', enrolment_no: 'FR001-2026-099', start_date: '2026-11-01', paid_minor: receiptsTotal() };
      if (/SELECT 1 FROM payment_plan WHERE enrolment_id/.test(sql)) return [...plans.values()].some((x) => x.status === 'active' && !x.deleted) ? { '?column?': 1 } : null;
      return (await q(sql, p)).rows[0] ?? null;
    },
    tx: async (fn: (c: any) => Promise<any>) => fn({ query: q }),
  };
  const resolver = { buildScopeWhere: () => 'TRUE' };
  const svc = new PlanService(db as never, resolver as never);
  const livePlan = () => [...plans.values()].find((x) => x.status === 'active' && !x.deleted)!;
  const rowsOf = (planId: number) => inst.filter((i) => i.plan_id === planId).sort((a, b) => a.seq_no - b.seq_no);
  return { svc, inst, alloc, plans, history, livePlan, rowsOf };
}

const ME = { id: 1 };
const ALL = { all: true } as never;

describe('balanceSplit', () => {
  it('20,000 fee with 10,000 paid on instalments leaves 10,000 to schedule', () => {
    expect(balanceSplit(2000000, [500000, 500000], 1000000)).toEqual({ paidKept: 1000000, earlier: 0, balance: 1000000, over: false });
  });
  it('money on no instalment counts as paid, it is not re-scheduled', () => {
    expect(balanceSplit(2000000, [], 1000000)).toEqual({ paidKept: 0, earlier: 1000000, balance: 1000000, over: false });
  });
  it('flags a receipt total above the net (refund case)', () => {
    expect(balanceSplit(1000000, [], 1200000).over).toBe(true);
  });
});

describe('re-setup keeps the paid part and schedules only the balance (client 5 Nov, 1 + 7)', () => {
  it('fee 20,000 · down payment 5,000 + instalment 5,000 paid → 4 new instalments of 2,500', async () => {
    const w = world({
      net: 2000000,
      receipts: [{ id: 1, amount: 500000, at: '2026-11-01' }, { id: 2, amount: 500000, at: '2026-11-05' }],
      installments: [
        { id: 1, plan_id: 9, seq_no: 1, due_date: '2026-11-01', amount_minor: 500000, paid_minor: 500000, label: 'Down payment', status: 'paid' },
        { id: 2, plan_id: 9, seq_no: 2, due_date: '2026-12-01', amount_minor: 500000, paid_minor: 500000, label: 'Installment 1 of 3', status: 'paid' },
        { id: 3, plan_id: 9, seq_no: 3, due_date: '2027-01-01', amount_minor: 500000, paid_minor: 0, label: 'Installment 2 of 3', status: 'pending' },
        { id: 4, plan_id: 9, seq_no: 4, due_date: '2027-02-01', amount_minor: 500000, paid_minor: 0, label: 'Installment 3 of 3', status: 'pending' },
      ],
      allocations: [{ installment_id: 1, fee_receipt_id: 1, amount_minor: 500000 }, { installment_id: 2, fee_receipt_id: 2, amount_minor: 500000 }],
    });
    const old = { id: 9, enrolment_id: 7, status: 'active', installments: w.inst.filter((i) => i.plan_id === 9).map((i) => ({ ...i })) };
    const out = await (w.svc as any).replan(7, old, { plan_type: 'installment', num_installments: 4, start_date: '2026-12-10' }, ME, 'resetup');

    expect(out.paid_kept_minor).toBe(1000000);
    expect(out.balance_minor).toBe(1000000);
    const rows = w.rowsOf(out.id);
    expect(rows.map((r) => [r.label, r.amount_minor, r.status])).toEqual([
      ['Paid · Down payment', 500000, 'paid'],
      ['Paid · Installment 1 of 3', 500000, 'paid'],
      ['Installment 1 of 4', 250000, 'pending'],
      ['Installment 2 of 4', 250000, 'pending'],
      ['Installment 3 of 4', 250000, 'pending'],
      ['Installment 4 of 4', 250000, 'pending'],
    ]);
    // the plan still totals the full fee; nothing paid is in the new instalments
    expect(rows.reduce((s, r) => s + r.amount_minor, 0)).toBe(2000000);
    expect(rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount_minor, 0)).toBe(1000000);
    // the receipts moved with the paid rows; no double allocation
    expect(w.alloc.map((a) => [rows.find((r) => r.id === a.installment_id)?.label, a.fee_receipt_id, a.amount_minor])).toEqual([
      ['Paid · Down payment', 1, 500000], ['Paid · Installment 1 of 3', 2, 500000],
    ]);
    expect(w.plans.get(9)!.deleted).toBe(true);
    expect(w.history[0]).toMatchObject({ action: 'resetup', paid: 1000000, balance: 1000000 });
  });

  it('money received with NO instalment link (plan built after the payment) is kept as paid, not spread', async () => {
    // FR001-2026-001's shape: the plan was created after a receipt, so its rows carry paid_minor
    // with no receipt allocation, and another receipt sits on nothing at all
    const w = world({
      net: 2000000,
      receipts: [{ id: 5, amount: 600000, at: '2026-10-31' }, { id: 6, amount: 400000, at: '2026-11-02' }],
      installments: [
        { id: 1, plan_id: 9, seq_no: 1, due_date: '2026-11-03', amount_minor: 1000000, paid_minor: 600000, label: 'Installment 1 of 2', status: 'partial' },
        { id: 2, plan_id: 9, seq_no: 2, due_date: '2026-12-03', amount_minor: 1000000, paid_minor: 0, label: 'Installment 2 of 2', status: 'pending' },
      ],
    });
    const old = { id: 9, enrolment_id: 7, status: 'active', installments: w.inst.map((i) => ({ ...i })) };
    const out = await (w.svc as any).replan(7, old, { plan_type: 'installment', num_installments: 2, start_date: '2026-12-01' }, ME, 'resetup');
    const rows = w.rowsOf(out.id);
    expect(rows.map((r) => [r.label, r.amount_minor])).toEqual([
      ['Paid · Installment 1 of 2', 600000],
      ['Paid · received before this plan', 400000],
      ['Installment 1 of 2', 500000],
      ['Installment 2 of 2', 500000],
    ]);
    // both paid rows are now backed by the receipts that paid them
    expect(w.alloc).toEqual([
      { installment_id: rows[0].id, fee_receipt_id: 5, amount_minor: 600000 },
      { installment_id: rows[1].id, fee_receipt_id: 6, amount_minor: 400000 },
    ]);
  });

  it('custom amounts must add up to the BALANCE, and the error says so in rupees', async () => {
    const w = world({ net: 2000000, receipts: [{ id: 1, amount: 1000000, at: '2026-11-01' }] });
    await expect((w.svc as any).replan(7, null, { plan_type: 'custom', custom_amounts_minor: [1000000, 1000000], custom_dates: ['2026-12-01', '2027-01-01'] }, ME, 'created'))
      .rejects.toThrow(/balance still to be paid, 10000\.00/);
  });

  it('a down payment larger than the balance is refused', async () => {
    const w = world({ net: 2000000, receipts: [{ id: 1, amount: 1500000, at: '2026-11-01' }] });
    await expect((w.svc as any).replan(7, null, { plan_type: 'installment', num_installments: 2, down_payment_minor: 600000 }, ME, 'created'))
      .rejects.toThrow(/cannot exceed the balance/);
  });
});

describe('Fee setup on an enrolment that already received money (create, balance_only)', () => {
  it('20,000 fee, 10,000 received, no plan yet → paid row 10,000 + 2 × 5,000', async () => {
    const w = world({ net: 2000000, receipts: [{ id: 3, amount: 1000000, at: '2026-11-04' }] });
    const out: any = await w.svc.create({ enrolment_id: 7, balance_only: true, plan_type: 'installment', num_installments: 2, start_date: '2026-12-01' }, ME, ALL);
    const rows = w.rowsOf(out.id);
    expect(rows.map((r) => [r.label, r.amount_minor, r.status])).toEqual([
      ['Paid · received before this plan', 1000000, 'paid'],
      ['Installment 1 of 2', 500000, 'pending'],
      ['Installment 2 of 2', 500000, 'pending'],
    ]);
    expect(w.alloc).toEqual([{ installment_id: rows[0].id, fee_receipt_id: 3, amount_minor: 1000000 }]);
    expect(w.history[0]).toMatchObject({ action: 'created', paid: 1000000, balance: 1000000 });
  });
});
