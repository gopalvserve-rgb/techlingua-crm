import { FeeService } from './fee.service';

/**
 * EDIT PAYMENT (dev/115). Correcting a recorded receipt must:
 *   · reverse this receipt's installment allocation, then re-apply the new amount (so the
 *     schedule + balance stay exact);
 *   · refuse a new amount beyond the outstanding EXCLUDING this receipt (the over-collection
 *     guard still holds after the edit);
 *   · write an audit_log old→new row inside the same transaction.
 * Driven through a scripted db double + a plans stub, no database.
 */

interface Receipt {
  id: number; receipt_no: string; enrolment_id: number; lead_id: number;
  amount_minor: number; mode: string; reference: string | null; received_at: string; note: string | null;
  net_fee_minor: number; gateway: string | null; gateway_payment_id: string | null;
}

function svcFor(receipt: Receipt, enrolmentPaidMinor: number) {
  const audits: Array<{ sql: string; params: any[] }> = [];
  const plansCalls: string[] = [];
  const updates: Array<{ sql: string; params: any[] }> = [];

  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM fee_receipt fr/.test(sql)) return { ...receipt };
      return null;
    },
    query: async () => [], // siblings lookup in get() — empty is fine (paid_as_at not used here)
    tx: async (fn: any) => fn({
      query: async (sql: string, params: any[] = []) => {
        if (/FOR UPDATE/.test(sql)) {
          return { rows: [{ id: receipt.enrolment_id, enrolment_no: 'ENR-2026/0001',
            net_fee_minor: receipt.net_fee_minor, lead_id: receipt.lead_id, paid_minor: enrolmentPaidMinor }] };
        }
        if (/INSERT INTO audit_log/.test(sql)) { audits.push({ sql, params }); return { rows: [] }; }
        if (/UPDATE fee_receipt/.test(sql)) { updates.push({ sql, params }); return { rows: [] }; }
        return { rows: [] };
      },
    }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocate: async () => 'RCP-2026/0001' };
  const plans = {
    reverseReceipt: async () => { plansCalls.push('reverse'); },
    applyReceipt: async (_c: any, _rid: number, _eid: number, amt: number, chosen: number | null) => {
      plansCalls.push(`apply:${amt}:${chosen ?? 'none'}`);
    },
  };
  const svc = new FeeService(db as never, resolver as never, numbering as never, plans as never);
  return { svc, audits, plansCalls, updates };
}

const REC = (): Receipt => ({
  id: 77, receipt_no: 'RCP-2026/0001', enrolment_id: 5, lead_id: 31,
  amount_minor: 100000, mode: 'cash', reference: null, received_at: '2026-08-01T06:00:00.000Z', note: null,
  net_fee_minor: 500000, gateway: null, gateway_payment_id: null,
});

describe('update — reverse + re-apply + audit', () => {
  it('re-states the receipt, re-runs allocation and returns the new balance', async () => {
    const { svc, plansCalls, updates } = svcFor(REC(), 100000); // only this ₹1,000 receipt on the enrolment
    const out = await svc.update(77, { amount: '3000', mode: 'cash' }, { id: 9 }, {} as never);
    expect(out.amount_minor).toBe(300000);
    expect(out.paid_minor).toBe(300000);              // paidWithout(0) + new(300000)
    expect(out.balance_minor).toBe(200000);           // net 500000 − 300000
    // reverse ran BEFORE the re-apply, and the re-apply used the NEW amount
    expect(plansCalls[0]).toBe('reverse');
    expect(plansCalls).toContain('apply:300000:none');
    expect(updates).toHaveLength(1);                  // the fee_receipt restate
  });

  it('writes an audit_log entry with before → after', async () => {
    const { svc, audits } = svcFor(REC(), 100000);
    await svc.update(77, { amount: '2500', mode: 'upi', reference: 'UTR-9' }, { id: 9 }, {} as never);
    expect(audits).toHaveLength(1);
    expect(/'fee_receipt'/.test(audits[0].sql)).toBe(true);
    expect(/'update'/.test(audits[0].sql)).toBe(true);
    const before = JSON.parse(audits[0].params[3]);
    const after = JSON.parse(audits[0].params[4]);
    expect(before.amount_minor).toBe(100000);
    expect(after.amount_minor).toBe(250000);
    expect(after.mode).toBe('upi');
    expect(after.reference).toBe('UTR-9');
  });

  it('targets a chosen installment when installment_id is supplied', async () => {
    const { svc, plansCalls } = svcFor(REC(), 100000);
    await svc.update(77, { amount: '1000', mode: 'cash', installment_id: 42 }, { id: 9 }, {} as never);
    expect(plansCalls).toContain('apply:100000:42');
  });
});

describe('update — the over-collection guard survives the edit', () => {
  it('refuses raising a receipt beyond the outstanding EXCLUDING itself', async () => {
    // net 500000, enrolment already paid 500000 (400000 elsewhere + this 100000). Raising this
    // receipt to 200000 would total 600000 → refused; room is only 100000.
    const { svc } = svcFor(REC(), 500000);
    await expect(svc.update(77, { amount: '2000', mode: 'cash' }, { id: 9 }, {} as never))
      .rejects.toThrow(/more than the outstanding balance/);
  });

  it('ACCEPTS raising it exactly to the available room (boundary inclusive)', async () => {
    const { svc } = svcFor(REC(), 500000);            // room = 100000 (this receipt reversed out)
    const out = await svc.update(77, { amount: '1000', mode: 'cash' }, { id: 9 }, {} as never);
    expect(out.amount_minor).toBe(100000);
    expect(out.balance_minor).toBe(0);
    expect(out.fully_paid).toBe(true);
  });

  it('demands a reference when the corrected mode is cheque / UPI / online', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.update(77, { amount: '1000', mode: 'cheque' }, { id: 9 }, {} as never))
      .rejects.toThrow(/needs a reference/);
  });

  it('refuses a gateway-captured receipt', async () => {
    const rec = { ...REC(), gateway: 'razorpay', gateway_payment_id: 'pay_x' };
    const { svc } = svcFor(rec, 100000);
    await expect(svc.update(77, { amount: '1000', mode: 'cash' }, { id: 9 }, {} as never))
      .rejects.toThrow(/gateway-captured/);
  });
});
