import { FeeService } from './fee.service';

/**
 * THE MONEY GUARD-RAILS. Every one of these is a sentence a front-desk clerk would
 * otherwise hear from a customer instead of from the app.
 */

/** A fake db that plays a scripted enrolment through the FOR UPDATE lock. */
function feeSvc(enrolment: Record<string, unknown> | null, opts: { preStatus?: string } = {}) {
  const queries: string[] = [];
  const db = {
    one: async (sql: string) => {
      queries.push(sql);
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM enrolment e/.test(sql)) {
        return enrolment ? { id: 1, status: opts.preStatus ?? 'active', enrolment_no: 'ENR-2026/0001' } : null;
      }
      return null;
    },
    query: async (sql: string) => { queries.push(sql); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, _p: unknown[]) => {
        queries.push(sql);
        if (/FOR UPDATE/.test(sql)) return { rows: enrolment ? [enrolment] : [] };
        if (/RETURNING id/.test(sql)) return { rows: [{ id: 99 }] };
        return { rows: [] };
      },
    }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocate: async () => 'RCP-2026/0001' };
  return { svc: new FeeService(db as never, resolver as never, numbering as never), queries };
}

const ENR = {
  id: 1, enrolment_no: 'ENR-2026/0001', net_fee_minor: 4_500_000,
  branch_id: 9, vertical_id: 1, lead_id: 31, status: 'active', paid_minor: 0,
};

describe('OVER-COLLECTION IS REFUSED', () => {
  it('refuses more than the outstanding balance, and says the actual numbers', async () => {
    const { svc } = feeSvc({ ...ENR, paid_minor: 4_000_000 });   // ₹40,000 paid of ₹45,000
    await expect(svc.collect({ enrolment_id: 1, amount: '10000', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/outstanding.*500\.00|Collect ₹5,000\.00 or less/);
  });

  it('refuses ANY amount once the fee is fully paid', async () => {
    const { svc } = feeSvc({ ...ENR, paid_minor: 4_500_000 });
    await expect(svc.collect({ enrolment_id: 1, amount: '1', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/already paid in full/);
  });

  it('ACCEPTS exactly the balance — the boundary is inclusive', async () => {
    const { svc } = feeSvc({ ...ENR, paid_minor: 4_000_000 });
    const r = await svc.collect({ enrolment_id: 1, amount: '5000', mode: 'cash' }, { id: 3 }, {} as never);
    expect(r.balance_minor).toBe(0);
    expect(r.fully_paid).toBe(true);
    expect(r.paid_minor).toBe(4_500_000);
  });

  it('the check happens INSIDE the transaction, behind FOR UPDATE — not before it', async () => {
    const { svc, queries } = feeSvc({ ...ENR });
    await svc.collect({ enrolment_id: 1, amount: '1000', mode: 'cash' }, { id: 3 }, {} as never);
    const lock = queries.findIndex((q) => /FOR UPDATE/.test(q));
    const insert = queries.findIndex((q) => /INSERT INTO fee_receipt/.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(lock);   // two clerks cannot jointly overshoot
  });
});

describe('PARTIAL PAYMENTS sum correctly', () => {
  it('three partials against ₹45,000 land exactly on zero', async () => {
    let paid = 0;
    for (const amt of ['20000', '15000', '10000']) {
      const { svc } = feeSvc({ ...ENR, paid_minor: paid });
      const r = await svc.collect({ enrolment_id: 1, amount: amt, mode: 'cash' }, { id: 3 }, {} as never);
      paid = r.paid_minor;
    }
    expect(paid).toBe(4_500_000);
  });

  it('paise-level partials do not drift (integers, not floats)', async () => {
    let paid = 0;
    const enr = { ...ENR, net_fee_minor: 30 };
    for (const amt of ['0.10', '0.10', '0.10']) {
      const { svc } = feeSvc({ ...enr, paid_minor: paid });
      const r = await svc.collect({ enrolment_id: 1, amount: amt, mode: 'cash' }, { id: 3 }, {} as never);
      paid = r.paid_minor;
    }
    expect(paid).toBe(30);            // 0.1+0.1+0.1 === 0.3 exactly, in paise
  });
});

describe('what the desk may and may not record', () => {
  it('refuses a zero or negative amount', async () => {
    const { svc } = feeSvc({ ...ENR });
    await expect(svc.collect({ enrolment_id: 1, amount: '0', mode: 'cash' }, { id: 3 }, {} as never)).rejects.toThrow(/more than zero/);
    await expect(svc.collect({ enrolment_id: 1, amount: '-500', mode: 'cash' }, { id: 3 }, {} as never)).rejects.toThrow(/more than zero/);
  });

  it('refuses junk rather than silently collecting ₹0 (the Campaign Budget bug, with money)', async () => {
    const { svc } = feeSvc({ ...ENR });
    await expect(svc.collect({ enrolment_id: 1, amount: 'five thousand', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/not an amount/);
  });

  it('refuses an unknown mode and names the ones that exist', async () => {
    const { svc } = feeSvc({ ...ENR });
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'bitcoin' }, { id: 3 }, {} as never))
      .rejects.toThrow(/Cash, UPI, Card, Cheque, Online transfer/);
  });

  it('DEMANDS a reference for cheque / UPI / online — a receipt nobody can reconcile is a rumour', async () => {
    for (const mode of ['cheque', 'upi', 'online']) {
      const { svc } = feeSvc({ ...ENR });
      await expect(svc.collect({ enrolment_id: 1, amount: '100', mode }, { id: 3 }, {} as never))
        .rejects.toThrow(/needs a reference/);
    }
  });

  it('…but not for cash or card at the desk', async () => {
    for (const mode of ['cash', 'card']) {
      const { svc } = feeSvc({ ...ENR });
      await expect(svc.collect({ enrolment_id: 1, amount: '100', mode }, { id: 3 }, {} as never)).resolves.toBeTruthy();
    }
  });

  it('REFUSES a gateway payment — Razorpay capture is PHASE 3 and says so', async () => {
    const { svc } = feeSvc({ ...ENR });
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'online', reference: 'X', gateway: 'razorpay' }, { id: 3 }, {} as never))
      .rejects.toThrow(/Phase 3/);
  });

  it('refuses a payment received in the future', async () => {
    const { svc } = feeSvc({ ...ENR });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'cash', received_at: tomorrow }, { id: 3 }, {} as never))
      .rejects.toThrow(/cannot be received in the future/);
  });

  it('refuses to collect against an UNAPPROVED enrolment', async () => {
    const { svc } = feeSvc({ ...ENR }, { preStatus: 'pending_approval' });
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/waiting for approval/);
  });

  it('refuses to collect against a CANCELLED enrolment', async () => {
    const { svc } = feeSvc({ ...ENR }, { preStatus: 'cancelled' });
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/cancelled; money cannot be collected/);
  });

  it('404s on an enrolment outside the caller\'s scope — not a 403 that confirms it exists', async () => {
    const { svc } = feeSvc(null);
    await expect(svc.collect({ enrolment_id: 1, amount: '100', mode: 'cash' }, { id: 3 }, {} as never))
      .rejects.toThrow(/not found/i);
  });
});
