import { FeeService } from './fee.service';

/**
 * POSTED PAYMENTS (client 4 Sep 2026): "After any payment is posted, staff should not directly
 * edit or delete it. Use Reverse Payment with a reason and approval so the audit history remains
 * accurate." This pins:
 *   · the amount / mode / date of a posted receipt cannot be edited (reference / note still can);
 *   · a receipt cannot be deleted;
 *   · a reversal needs a reason; a non-approver's reversal is only a REQUEST (money still counts);
 *   · an approver's reversal (or approval of a request) unwinds the allocation, marks the receipt
 *     reversed and writes an audit_log row — inside one transaction.
 * Driven through a scripted db double + a plans stub, no database.
 */

interface Receipt {
  id: number; org_id: number; receipt_no: string; enrolment_id: number; lead_id: number;
  amount_minor: number; mode: string; reference: string | null; received_at: string; note: string | null;
  net_fee_minor: number; gateway: string | null; gateway_payment_id: string | null; reversal_status?: string | null;
  reversal_reason?: string | null;
}

function svcFor(receipt: Receipt, enrolmentPaidMinor: number) {
  const audits: Array<{ sql: string; params: any[] }> = [];
  const plansCalls: string[] = [];
  const updates: Array<{ sql: string; params: any[] }> = [];
  const direct: Array<{ sql: string; params: any[] }> = [];

  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM fee_receipt fr/.test(sql)) return { ...receipt };
      return null;
    },
    query: async (sql: string, params: any[] = []) => { direct.push({ sql, params }); return []; },
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
  return { svc, audits, plansCalls, updates, direct };
}

const REC = (): Receipt => ({
  id: 77, org_id: 1, receipt_no: 'RCP-2026/0001', enrolment_id: 5, lead_id: 31,
  amount_minor: 100000, mode: 'cash', reference: null, received_at: '2026-08-01T06:00:00.000Z', note: null,
  net_fee_minor: 500000, gateway: null, gateway_payment_id: null,
});

describe('a posted payment cannot be edited or deleted (client 4 Sep)', () => {
  it('refuses changing the AMOUNT', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.update(77, { amount: '3000', mode: 'cash' }, { id: 9 }, {} as never)).rejects.toThrow(/Reverse payment/);
  });
  it('refuses changing the MODE', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.update(77, { amount: '1000', mode: 'upi', reference: 'UTR-9' }, { id: 9 }, {} as never)).rejects.toThrow(/Reverse payment/);
  });
  it('refuses changing the DATE', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.update(77, { amount: '1000', mode: 'cash', received_at: '2026-07-01' }, { id: 9 }, {} as never)).rejects.toThrow(/Reverse payment/);
  });
  it('still allows correcting the note / reference, with an audit row', async () => {
    const { svc, audits } = svcFor(REC(), 100000);
    const out = await svc.update(77, { amount: '1000', mode: 'cash', note: 'paid by father' }, { id: 9 }, {} as never);
    expect(out.amount_minor).toBe(100000);
    expect(audits).toHaveLength(1);
  });
  it('refuses a delete', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.remove(77, { id: 9 }, {} as never)).rejects.toThrow(/Reverse payment/);
  });
  it('refuses a gateway-captured receipt', async () => {
    const rec = { ...REC(), gateway: 'razorpay', gateway_payment_id: 'pay_x' };
    const { svc } = svcFor(rec, 100000);
    await expect(svc.update(77, { amount: '1000', mode: 'cash' }, { id: 9 }, {} as never)).rejects.toThrow(/gateway-captured/);
  });
});

describe('Reverse payment — reason + approval (client 4 Sep)', () => {
  it('needs a reason', async () => {
    const { svc } = svcFor(REC(), 100000);
    await expect(svc.requestReversal(77, { reason: '' }, { id: 9 }, {} as never, false)).rejects.toThrow(/reason/);
  });
  it('a cashier only REQUESTS it — no allocation is unwound, the money still counts', async () => {
    const { svc, plansCalls, direct } = svcFor(REC(), 100000);
    const out = await svc.requestReversal(77, { reason: 'wrong student' }, { id: 9 }, {} as never, false);
    expect(out.reversal_status).toBe('requested');
    expect(plansCalls).toEqual([]);
    expect(direct.some((d) => /reversal_status = 'requested'/.test(d.sql))).toBe(true);
  });
  it('a finance approver reverses at once: allocation unwound, receipt marked, audit written', async () => {
    const { svc, plansCalls, updates, audits } = svcFor(REC(), 100000);
    const out = await svc.requestReversal(77, { reason: 'duplicate entry' }, { id: 2 }, {} as never, true);
    expect(out.reversal_status).toBe('reversed');
    expect(plansCalls).toEqual(['reverse']);
    expect(updates[0].sql).toMatch(/reversal_status = 'reversed'/);
    expect(updates[0].sql).toMatch(/deleted_at = now\(\)/);
    expect(audits).toHaveLength(1);
  });
  it('approving a pending request performs the reversal', async () => {
    const { svc, plansCalls } = svcFor({ ...REC(), reversal_status: 'requested', reversal_reason: 'wrong amount' }, 100000);
    const out = await svc.approveReversal(77, { id: 2 }, {} as never);
    expect(out.reversal_status).toBe('reversed');
    expect(plansCalls).toEqual(['reverse']);
  });
  it('rejecting a request leaves the payment standing', async () => {
    const { svc, plansCalls } = svcFor({ ...REC(), reversal_status: 'requested' }, 100000);
    const out = await svc.rejectReversal(77, { remarks: 'not an error' }, { id: 2 }, {} as never);
    expect(out.reversal_status).toBe('rejected');
    expect(plansCalls).toEqual([]);
  });
});
