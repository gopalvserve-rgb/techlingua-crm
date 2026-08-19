import { StudentService } from './student.service';

/**
 * OBS-1 (dev/105) — Fee Management Due must equal Net − Paid after a discount edit and/or a
 * level upgrade. The bug: student.service.updateEnrolment wrote the new net but never rebuilt
 * the installment schedule, so Due (Σ outstanding) stayed at the OLD net; a subsequent add-level
 * only pushed the delta on top, preserving the gap. The fix rebuilds an UNPAID plan to the current
 * Net (rebuildUnpaidPlanToNet) and, for a plan with money applied, carries the increase
 * (reconcilePlanIncrease). These are exercised here through a stateful fake PoolClient.
 */
type Inst = { id: number; seq_no: number; due_date: string; amount_minor: number; paid_minor: number; status: string };

function fakeClient(state: { net: number; plan: any; installments: Inst[] }) {
  let nextId = Math.max(0, ...state.installments.map((i) => i.id)) + 1;
  return {
    async query(sql: string, params: any[] = []) {
      // rebuild: load active plan(s) + enrolment net
      if (/FROM payment_plan pp JOIN enrolment e/.test(sql)) {
        return { rows: [{ ...state.plan, net_fee_minor: state.net }], rowCount: 1 };
      }
      // sum paid across a plan's installments
      if (/SELECT COALESCE\(sum\(paid_minor\), 0\) AS p FROM installment WHERE plan_id/.test(sql)) {
        const p = state.installments.reduce((a, i) => a + i.paid_minor, 0);
        return { rows: [{ p }], rowCount: 1 };
      }
      if (/DELETE FROM installment WHERE plan_id/.test(sql)) {
        state.installments.length = 0;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO installment \(plan_id/.test(sql)) {
        state.installments.push({
          id: nextId++, seq_no: Number(params[2]), due_date: String(params[3]),
          amount_minor: Number(params[4]), paid_minor: 0, status: 'pending',
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE payment_plan SET total_minor = \$2::bigint, updated_at/.test(sql)) {
        state.plan.total_minor = Number(params[1]);
        return { rows: [], rowCount: 1 };
      }
      // reconcilePlanIncrease: locate active plan
      if (/SELECT id FROM payment_plan WHERE enrolment_id/.test(sql)) {
        return { rows: [{ id: state.plan.id }], rowCount: 1 };
      }
      if (/UPDATE payment_plan SET total_minor = total_minor \+ \$2/.test(sql)) {
        state.plan.total_minor = Number(state.plan.total_minor) + Number(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT id, amount_minor, paid_minor FROM installment/.test(sql)) {
        const open = state.installments
          .filter((i) => i.status !== 'waived' && i.paid_minor < i.amount_minor)
          .sort((a, b) => b.seq_no - a.seq_no)[0];
        return { rows: open ? [{ id: open.id, amount_minor: open.amount_minor, paid_minor: open.paid_minor }] : [], rowCount: open ? 1 : 0 };
      }
      if (/UPDATE installment\s+SET amount_minor = \$2::bigint/.test(sql)) {
        const inst = state.installments.find((i) => i.id === Number(params[0]))!;
        inst.amount_minor = Number(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT COALESCE\(MAX\(seq_no\),0\) AS seq/.test(sql)) {
        const seq = Math.max(0, ...state.installments.map((i) => i.seq_no));
        return { rows: [{ seq, d: '2026-01-01' }], rowCount: 1 };
      }
      // status recompute — ignore
      if (/UPDATE payment_plan pp\s+SET status/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function svc() {
  return new StudentService({} as any, {} as any, {} as any);
}
const sum = (xs: Inst[]) => xs.reduce((a, i) => a + i.amount_minor, 0);
const outstanding = (xs: Inst[]) => xs.reduce((a, i) => a + (i.amount_minor - i.paid_minor), 0);

describe('OBS-1 plan reconcile keeps Due == Net − Paid', () => {
  const basePlan = { id: 1, plan_type: 'emi', frequency: 'monthly', down_payment_minor: 0, num_installments: 3, start_date: '2026-01-01', total_minor: 30000 };

  it('discount edit (net drops) rebuilds an UNPAID schedule to the new net', async () => {
    // plan was built for old net 30000 (3×10000); net just dropped to 24000
    const state = {
      net: 24000, plan: { ...basePlan, total_minor: 30000 },
      installments: [
        { id: 1, seq_no: 1, due_date: '2026-01-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
        { id: 2, seq_no: 2, due_date: '2026-02-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
        { id: 3, seq_no: 3, due_date: '2026-03-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
      ] as Inst[],
    };
    await (svc() as any).rebuildUnpaidPlanToNet(fakeClient(state), 99);
    expect(sum(state.installments)).toBe(24000);       // schedule sums to net
    expect(outstanding(state.installments)).toBe(24000); // Due == Net − 0 paid
    expect(Number(state.plan.total_minor)).toBe(24000);
  });

  it('edit-discount THEN add-level: rebuild then increase keeps Due == Net (no ₹1,000 gap)', async () => {
    // Repro: net was 30000, discount edit dropped it to 24000 (rebuild), then add a level of 6000
    const state = {
      net: 24000, plan: { ...basePlan, total_minor: 30000 },
      installments: [
        { id: 1, seq_no: 1, due_date: '2026-01-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
        { id: 2, seq_no: 2, due_date: '2026-02-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
        { id: 3, seq_no: 3, due_date: '2026-03-01', amount_minor: 10000, paid_minor: 0, status: 'pending' },
      ] as Inst[],
    };
    const client = fakeClient(state);
    // discount edit (updateEnrolment) reconciles the plan to the new net 24000...
    await (svc() as any).rebuildUnpaidPlanToNet(client, 99);
    expect(sum(state.installments)).toBe(24000);
    expect(Number(state.plan.total_minor)).toBe(24000);
    // ...then a level of 6000 is added (addEnrolmentLevel): the delta rides on the reconciled base.
    state.net = 30000;
    await (svc() as any).reconcilePlanIncrease(client, 99, 6000);
    expect(outstanding(state.installments)).toBe(30000); // Due == Net, no stale +1000 gap
    expect(Number(state.plan.total_minor)).toBe(30000);
  });

  it('add-level on a PARTIALLY-PAID plan carries the delta and keeps Due == Net − Paid', async () => {
    // net 24000, first installment fully paid (8000), remaining outstanding 16000; add level +6000
    const state = {
      net: 30000, plan: { ...basePlan, total_minor: 24000 },
      installments: [
        { id: 1, seq_no: 1, due_date: '2026-01-01', amount_minor: 8000, paid_minor: 8000, status: 'paid' },
        { id: 2, seq_no: 2, due_date: '2026-02-01', amount_minor: 8000, paid_minor: 0, status: 'pending' },
        { id: 3, seq_no: 3, due_date: '2026-03-01', amount_minor: 8000, paid_minor: 0, status: 'pending' },
      ] as Inst[],
    };
    await (svc() as any).reconcilePlanIncrease(fakeClient(state), 99, 6000);
    expect(outstanding(state.installments)).toBe(30000 - 8000); // Due == Net − Paid
    expect(Number(state.plan.total_minor)).toBe(30000);
  });
});
