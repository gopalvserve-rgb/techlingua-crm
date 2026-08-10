import { PlanService } from './plan.service';

/**
 * COLLECTION APPLICATION — a receipt settles installments OLDEST-DUE FIRST (or a chosen
 * one first), and each installment's status follows its paid amount. Reversing a receipt
 * unwinds exactly what it applied. Driven through a stateful fake PoolClient so the
 * allocation logic is exercised without a database.
 */
type Inst = { id: number; seq_no: number; due_date: string; amount_minor: number; paid_minor: number; status: string };

function fakeClient(installments: Inst[]) {
  const allocations: Array<{ installment_id: number; fee_receipt_id: number; amount_minor: number }> = [];
  const client = {
    async query(sql: string, params: any[] = []) {
      if (/SELECT id FROM payment_plan/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      if (/FROM installment\b[\s\S]*FOR UPDATE/.test(sql)) {
        const chosen = Number(params[1]);
        const rows = installments
          .filter((i) => i.status !== 'waived' && i.paid_minor < i.amount_minor)
          .map((i) => ({ ...i, is_chosen: i.id === chosen }))
          .sort((a, b) => (Number(b.is_chosen) - Number(a.is_chosen)) || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.seq_no - b.seq_no));
        return { rows, rowCount: rows.length };
      }
      if (/UPDATE installment\s+SET\s+paid_minor = \$2/.test(sql)) {
        const [id, newPaid, amount] = params;
        const inst = installments.find((i) => i.id === Number(id))!;
        inst.paid_minor = Number(newPaid);
        inst.status = Number(newPaid) >= Number(amount) ? 'paid' : Number(newPaid) > 0 ? 'partial' : 'pending';
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO installment_payment/.test(sql)) {
        allocations.push({ installment_id: Number(params[0]), fee_receipt_id: Number(params[1]), amount_minor: Number(params[2]) });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT DISTINCT ip.installment_id/.test(sql)) {
        const rid = Number(params[0]);
        const seen = new Map<number, number>();
        for (const a of allocations.filter((x) => x.fee_receipt_id === rid)) seen.set(a.installment_id, 1);
        return { rows: [...seen.keys()].map((installment_id) => ({ installment_id, plan_id: 1 })), rowCount: seen.size };
      }
      if (/DELETE FROM installment_payment/.test(sql)) {
        const rid = Number(params[0]);
        for (let k = allocations.length - 1; k >= 0; k--) if (allocations[k].fee_receipt_id === rid) allocations.splice(k, 1);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE installment i[\s\S]*SET\s+paid_minor/.test(sql)) {
        // recomputeInstallment — recompute paid from live allocations
        const id = Number(params[0]);
        const inst = installments.find((i) => i.id === id)!;
        inst.paid_minor = allocations.filter((a) => a.installment_id === id).reduce((s, a) => s + a.amount_minor, 0);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE installment SET status/.test(sql)) {
        const id = Number(params[0]);
        const inst = installments.find((i) => i.id === id)!;
        if (inst.status !== 'waived') inst.status = inst.paid_minor >= inst.amount_minor ? 'paid' : inst.paid_minor > 0 ? 'partial' : 'pending';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE payment_plan pp/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, installments, allocations };
}

const svc = () => new PlanService({} as never, {} as never);

const SCHEDULE = (): Inst[] => [
  { id: 10, seq_no: 1, due_date: '2026-09-01', amount_minor: 1500000, paid_minor: 0, status: 'pending' },
  { id: 11, seq_no: 2, due_date: '2026-10-01', amount_minor: 1500000, paid_minor: 0, status: 'pending' },
  { id: 12, seq_no: 3, due_date: '2026-11-01', amount_minor: 1500000, paid_minor: 0, status: 'pending' },
];

describe('applyReceipt — oldest-due first', () => {
  it('a partial payment settles the earliest installment and marks it partial', async () => {
    const { client, installments, allocations } = fakeClient(SCHEDULE());
    await svc().applyReceipt(client as never, 500, 1, 1000000);   // ₹10,000 of the first ₹15,000
    expect(installments[0].paid_minor).toBe(1000000);
    expect(installments[0].status).toBe('partial');
    expect(installments[1].paid_minor).toBe(0);
    expect(allocations).toEqual([{ installment_id: 10, fee_receipt_id: 500, amount_minor: 1000000 }]);
  });

  it('a payment larger than one installment SPILLS to the next, oldest-first', async () => {
    const { client, installments, allocations } = fakeClient(SCHEDULE());
    await svc().applyReceipt(client as never, 501, 1, 2000000);   // ₹20,000 -> fills #1 (15k) + 5k of #2
    expect(installments[0].status).toBe('paid');
    expect(installments[0].paid_minor).toBe(1500000);
    expect(installments[1].paid_minor).toBe(500000);
    expect(installments[1].status).toBe('partial');
    expect(allocations).toHaveLength(2);
    expect(allocations[0].installment_id).toBe(10);
    expect(allocations[1].installment_id).toBe(11);
  });

  it('a CHOSEN installment is settled first, then overflow goes oldest-first', async () => {
    const { client, installments } = fakeClient(SCHEDULE());
    await svc().applyReceipt(client as never, 502, 1, 1500000, 12);   // target #3 fully
    expect(installments[2].status).toBe('paid');
    expect(installments[0].paid_minor).toBe(0);
  });
});

describe('reverseReceipt — unwinds the allocation', () => {
  it('drops the paid amount back and re-opens the installment', async () => {
    const { client, installments } = fakeClient(SCHEDULE());
    await svc().applyReceipt(client as never, 600, 1, 1500000);
    expect(installments[0].status).toBe('paid');
    await svc().reverseReceipt(client as never, 600);
    expect(installments[0].paid_minor).toBe(0);
    expect(installments[0].status).toBe('pending');
  });
});
