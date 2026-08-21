import { InvoiceService } from './invoice.service';

/**
 * dev/116 — "Generate Invoice" from a receipt/enrolment. If a non-cancelled invoice already
 * exists for the enrolment it is RETURNED (open it); otherwise a draft is created and issued.
 * Missing args are refused.
 */

const ENROL_CTX = {
  id: 5, enrolment_no: 'ENR-2026/0005', quotation_id: null, lead_id: 31, student_profile_id: null, course_id: 2,
  branch_id: 9, vertical_id: 1, pipeline_id: null, campaign_id: null, counsellor_id: 3, team_id: null,
  fee_minor: 4500000, discount_minor: 0, net_fee_minor: 4500000,
  lead_name: 'ZZTEST', lead_phone: '9990001111', lead_email: 'zz@example.com', lead_state_id: null,
  course_name: 'IELTS',
  seller_legal_name: 'Tech Lingua', seller_gstin: '29AAAAA0000A1Z5', seller_pan: 'AAAAA0000A',
  branch_name: 'HSR', seller_address: 'x', seller_state_id: null,
};

function build(opts: { existing?: any } = {}) {
  const inserted: string[] = [];
  const db: any = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM fee_receipt/.test(sql)) return { enrolment_id: 5 };
      // generate()'s existing-invoice probe
      if (/FROM gst_invoice gi\s+WHERE gi\.enrolment_id/.test(sql)) return opts.existing ?? null;
      // get() after issue (or when returning existing)
      if (/FROM gst_invoice gi/.test(sql) && /gi\.id = \$1/.test(sql)) {
        return { id: opts.existing ? opts.existing.id : 100, invoice_no: opts.existing ? opts.existing.invoice_no : 'INV/2026/0001',
          status: opts.existing ? opts.existing.status : 'draft', seller_gstin: '29AAAAA0000A1Z5',
          branch_id: 9, vertical_id: 1, org_id: 1, org_name: 'Tech Lingua', total_minor: 5310000 };
      }
      if (/FROM enrolment e/.test(sql)) return ENROL_CTX;
      return null;
    },
    query: async (sql: string) => { inserted.push(sql); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string) => { inserted.push(sql); return { rows: [{ id: 100 }] }; } }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocate: async () => 'INV/2026/0001' };
  const notif = { safeFire: async () => undefined };
  const svc = new InvoiceService(db as never, resolver as never, numbering as never, undefined, notif as never);
  return { svc, inserted };
}

describe('invoice generate (from receipt / enrolment)', () => {
  it('refuses when neither receipt_id nor enrolment_id is supplied', async () => {
    const { svc } = build();
    await expect(svc.generate({}, { id: 3 }, {} as never)).rejects.toThrow(/receipt_id or enrolment_id/);
  });

  it('RETURNS the existing (non-cancelled) invoice for the enrolment instead of making a second', async () => {
    const { svc, inserted } = build({ existing: { id: 42, invoice_no: 'INV/2026/0042', status: 'issued' } });
    const res = await svc.generate({ enrolment_id: 5 }, { id: 3 }, {} as never);
    expect(res.existing).toBe(true);
    expect(res.id).toBe(42);
    expect(inserted.some((q) => /INSERT INTO gst_invoice/.test(q))).toBe(false);
  });

  it('CREATES + issues a new invoice from a receipt when none exists', async () => {
    const { svc, inserted } = build();
    const res = await svc.generate({ receipt_id: 55 }, { id: 3 }, {} as never);
    expect(res.existing).toBe(false);
    expect(res.issued).toBe(true);
    expect(res.status).toBe('issued');
    expect(inserted.some((q) => /INSERT INTO gst_invoice/.test(q))).toBe(true);
  });
});
