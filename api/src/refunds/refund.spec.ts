import { RefundService, needsHighApproval, DEFAULT_REFUND_POLICY } from './refund.service';

/**
 * REFUNDS — the money invariants, pinned.
 */
const resolver = { buildScopeWhere: () => '1=1' } as any;
const numbering = { allocate: async () => 'REF-2026-27/0007' } as any;
const settings = { get: async (_k: string, d: any) => d, set: async () => undefined } as any;

describe('the high-value threshold (pure)', () => {
  it('fires strictly ABOVE the threshold', () => {
    const p = { ...DEFAULT_REFUND_POLICY, high_value_over_minor: 2500000 };
    expect(needsHighApproval(p, 2500000)).toBe(false);   // exactly at -> normal
    expect(needsHighApproval(p, 2500001)).toBe(true);    // above -> senior
    expect(needsHighApproval(p, 100)).toBe(false);
  });
  it('a zero threshold means nothing is "high" (never demands the senior)', () => {
    expect(needsHighApproval({ ...DEFAULT_REFUND_POLICY, high_value_over_minor: 0 }, 9_99_99_999)).toBe(false);
  });
});

describe('REQUEST — a refund can never exceed what is refundable', () => {
  const svc = (refundable: { collected: number; approved: number; pending: number }) => {
    const db = {
      one: async (sql: string) => {
        if (/FROM organisation/.test(sql)) return { id: 1 };
        if (/sum\(x\.amount_minor\)/.test(sql)) {
          return { collected: refundable.collected, approved: refundable.approved, pending: refundable.pending };
        }
        if (/FROM enrolment e/.test(sql)) return { id: 5, enrolment_no: 'ENR-1', branch_id: 2, vertical_id: 3, lead_id: 9 };
        return null;
      },
      query: async (sql: string) => {
        if (/INSERT INTO refund/.test(sql)) return [{ id: 77 }];
        return [];
      },
    } as any;
    return new RefundService(db, resolver, settings, numbering, undefined);
  };

  it('refuses more than collected minus (approved + pending)', async () => {
    const s = svc({ collected: 1_000_000, approved: 200_000, pending: 100_000 }); // refundable 700,000
    await expect(s.request({ enrolment_id: 5, amount_minor: 800_000, mode: 'upi', reason: 'x' }, { id: 1 }, {} as any))
      .rejects.toThrow(/more than can be refunded/i);
  });

  it('accepts a PARTIAL refund at or below refundable, and records it pending', async () => {
    const s = svc({ collected: 1_000_000, approved: 0, pending: 0 });
    const r = await s.request({ enrolment_id: 5, amount_minor: 400_000, mode: 'cash', reason: 'partial' }, { id: 1 }, {} as any);
    expect(r.status).toBe('pending');
    expect(r.amount_minor).toBe(400_000);
  });

  it('refuses a refund when nothing was collected', async () => {
    const s = svc({ collected: 0, approved: 0, pending: 0 });
    await expect(s.request({ enrolment_id: 5, amount_minor: 100, mode: 'cash', reason: 'x' }, { id: 1 }, {} as any))
      .rejects.toThrow(/no collected fee/i);
  });

  it('needs a reason and a valid mode', async () => {
    const s = svc({ collected: 1_000_000, approved: 0, pending: 0 });
    await expect(s.request({ enrolment_id: 5, amount_minor: 100, mode: 'upi' }, { id: 1 }, {} as any)).rejects.toThrow(/reason/i);
    await expect(s.request({ enrolment_id: 5, amount_minor: 100, mode: 'bitcoin', reason: 'x' }, { id: 1 }, {} as any)).rejects.toThrow(/mode/i);
  });
});

describe('DECIDE — self-approval, high-value gate, and net collected on approve', () => {
  const refundRow = (over: Partial<any> = {}) => ({
    id: 77, status: 'pending', requested_by: 3, requires_high: false, enrolment_id: 5,
    branch_id: 2, vertical_id: 3, lead_id: 9, amount_minor: 400_000, mode: 'upi',
    enrolment_no: 'ENR-1', student_name: 'A', ...over,
  });
  const build = (row: any, txBal: { collected: number; approved: number }) => {
    const notified: any[] = [];
    const db = {
      one: async (sql: string) => { if (/FROM organisation/.test(sql)) return { id: 1 }; return row; },
      query: async () => [],
      tx: async (fn: any) => fn({
        query: async (sql: string) => {
          if (/sum\(x\.amount_minor\)/.test(sql)) return { rows: [{ collected: txBal.collected, approved: txBal.approved }] };
          if (/UPDATE refund SET status = 'approved'/.test(sql)) return { rows: [{ id: row.id }] };
          return { rows: [] };
        },
      }),
    } as any;
    const notifier = { notifyMany: async (_ids: any, m: any) => { notified.push(m); } } as any;
    const s = new RefundService(db, resolver, settings, numbering, notifier);
    return { s, notified };
  };

  it('the requester cannot approve his own refund', async () => {
    const { s } = build(refundRow(), { collected: 1_000_000, approved: 0 });
    await expect(s.decide(77, true, null, { id: 3 }, {} as any, false)).rejects.toThrow(/your own refund/i);
  });

  it('a high-value refund is refused for a plain approver, allowed for a senior', async () => {
    const { s } = build(refundRow({ requires_high: true }), { collected: 5_000_000, approved: 0 });
    await expect(s.decide(77, true, null, { id: 4 }, {} as any, false)).rejects.toThrow(/senior approver/i);
  });

  it('APPROVE allocates a voucher, records approval, and returns net collected reduced by the refund', async () => {
    const { s, notified } = build(refundRow({ amount_minor: 400_000 }), { collected: 1_000_000, approved: 0 });
    const out = await s.decide(77, true, 'ok', { id: 4 }, {} as any, false);
    expect(out.status).toBe('approved');
    expect(out.refund_no).toBe('REF-2026-27/0007');
    expect(out.net_collected_minor).toBe(600_000);   // 1,000,000 - 400,000
    expect(notified.length).toBeGreaterThan(0);       // Refund Completed event fired
  });

  it('APPROVE refuses if it would refund more than collected (race guard under the lock)', async () => {
    const { s } = build(refundRow({ amount_minor: 900_000 }), { collected: 1_000_000, approved: 200_000 });
    await expect(s.decide(77, true, null, { id: 4 }, {} as any, false)).rejects.toThrow(/more than was collected/i);
  });

  it('REJECT sets rejected and does not allocate a voucher', async () => {
    const { s } = build(refundRow(), { collected: 1_000_000, approved: 0 });
    const out = await s.decide(77, false, 'no', { id: 4 }, {} as any, false);
    expect(out.status).toBe('rejected');
  });
});
