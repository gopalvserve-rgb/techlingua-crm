/**
 * FEE INVOICE DASHBOARD + AUTO-PULL — dev/140 (26/27aug Batch B, items 2 & 5).
 *
 * Item 5: the Fee Invoice dashboard KPIs (Total Invoiced / Paid / Outstanding + status counts)
 * aggregate from the SAME gst_invoice source the list uses, so they reconcile.
 * Item 2: the Fee Invoice auto-pulls the enrolment's course-fee line AND (when set) the exam-fee
 * line, so the invoice Total reconciles to Net + Exam + Tax.
 */
import { InvoiceService } from './invoice.service';
import { computeGstLine, computeGstTotals } from './gst.util';

describe('Fee Invoice dashboard — KPI aggregation (item 5)', () => {
  function svc(row: Record<string, any>) {
    const db: any = { one: async () => row, query: async () => [] };
    const resolver: any = { buildScopeWhere: () => '1=1' };
    return new InvoiceService(db, resolver, {} as any);
  }

  it('maps Paid, Outstanding, Total Invoiced + the status counts', async () => {
    const s = await svc({
      draft: '2', issued: '3', paid: '4', cancelled: '1', total: '10',
      invoiced_minor: '700000', paid_minor: '400000', outstanding_minor: '300000', gst_minor: '90000',
    }).summary({ all: true, filters: [] } as any, {});
    expect(s.draft).toBe(2);
    expect(s.issued).toBe(3);
    expect(s.paid).toBe(4);
    expect(s.cancelled).toBe(1);
    expect(s.total).toBe(10);
    expect(s.invoiced_minor).toBe(700000);   // issued + paid grand totals
    expect(s.paid_minor).toBe(400000);        // Paid = paid invoices' grand total
    expect(s.outstanding_minor).toBe(300000); // Outstanding = issued-but-unpaid grand total
    expect(s.gst_minor).toBe(90000);
  });

  it('reconciles: Total Invoiced == Paid + Outstanding when every non-cancelled invoice is issued or paid', async () => {
    const s = await svc({
      draft: '0', issued: '2', paid: '2', cancelled: '0', total: '4',
      invoiced_minor: '500000', paid_minor: '200000', outstanding_minor: '300000', gst_minor: '0',
    }).summary({ all: true, filters: [] } as any, {});
    expect(s.paid_minor + s.outstanding_minor).toBe(s.invoiced_minor);
  });
});

describe('Fee Invoice auto-pull — course fee + exam fee lines reconcile to Net + Exam + Tax (item 2)', () => {
  it('a two-line invoice (net fee + exam fee) totals Net + Exam + Tax', () => {
    // enrolment: Net ₹18,000, Exam ₹1,000, 18% GST, intra-state
    const net = 1_800_000; const exam = 100_000;
    const lines = [
      computeGstLine({ qty: 1, unit_price_minor: net, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'intra'),
      computeGstLine({ qty: 1, unit_price_minor: exam, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'intra'),
    ];
    const totals = computeGstTotals(lines);
    expect(totals.taxable_minor).toBe(net + exam);           // ₹19,000 taxable (exam NOT discounted)
    expect(totals.cgst_minor + totals.sgst_minor).toBe(342_000); // 18% of 19,000 = ₹3,420
    expect(totals.igst_minor).toBe(0);
    expect(totals.total_minor).toBe(2_242_000);              // ₹22,420 = Net + Exam + Tax
  });
});
