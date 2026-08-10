import { RevenueService } from './revenue.service';
import { CollectionReportService } from './collection-report.service';

const resolver = { buildScopeWhere: () => '1=1' } as any;

/** A db double whose `query` returns a scripted sequence of result sets in call order. */
function seqDb(sequences: any[][], one?: (sql: string) => any) {
  let i = 0;
  return {
    one: async (sql: string) => (one ? one(sql) : { name: 'Tech Lingua' }),
    query: async () => sequences[i++] ?? [],
  } as any;
}

describe('REVENUE — collection is NET of approved refunds', () => {
  it('nets refunds against receipts per group and in the totals', async () => {
    const db = seqDb([
      [{ label: 'Main', gross_minor: '1000000', n: '3' }],   // receipts
      [{ label: 'Main', refunds_minor: '400000', n: '1' }],  // refunds
    ]);
    const svc = new RevenueService(db, resolver);
    const out = await svc.collection({} as any, { group_by: 'branch' });
    expect(out.view).toBe('collection');
    expect(out.rows[0].gross_minor).toBe(1_000_000);
    expect(out.rows[0].refunds_minor).toBe(400_000);
    expect(out.rows[0].net_minor).toBe(600_000);
    expect(out.totals.net_minor).toBe(600_000);
  });

  it('a refund with no matching receipt group still appears as a negative net', async () => {
    const db = seqDb([
      [],                                                    // no receipts
      [{ label: 'Cash', refunds_minor: '50000', n: '1' }],   // a refund
    ]);
    const svc = new RevenueService(db, resolver);
    const out = await svc.collection({} as any, { group_by: 'mode' });
    expect(out.rows[0].net_minor).toBe(-50_000);
    expect(out.totals.net_minor).toBe(-50_000);
  });

  it('rejects an unknown dimension', async () => {
    const svc = new RevenueService(seqDb([]), resolver);
    await expect(svc.collection({} as any, { group_by: 'zodiac' })).rejects.toThrow(/Unknown collection dimension/);
  });
});

describe('REVENUE — accrual is the net fee recognised in the period', () => {
  it('sums enrolment net fee by group', async () => {
    const db = seqDb([[{ label: 'IELTS', accrual_minor: '2500000', n: '5' }]]);
    const svc = new RevenueService(db, resolver);
    const out = await svc.accrual({} as any, { group_by: 'course' });
    expect(out.view).toBe('accrual');
    expect(out.totals.accrual_minor).toBe(2_500_000);
    expect(out.totals.enrolments).toBe(5);
  });

  it('rejects payment mode for accrual (accrual has no mode)', async () => {
    const svc = new RevenueService(seqDb([]), resolver);
    await expect(svc.accrual({} as any, { group_by: 'mode' })).rejects.toThrow(/no payment mode/i);
  });
});

describe('TALLY EXPORT — a valid Tally voucher file', () => {
  const revenue = { collection: async () => ({}) } as any;
  const build = () => {
    const db = seqDb([
      [{ receipt_no: 'RCP-1', amount_minor: '450050', mode: 'upi', reference: 'UTR9', received_at: '2026-08-10T10:00:00Z', party: 'Asha', enrolment_no: 'ENR-1' }],
      [{ refund_no: 'REF-2', amount_minor: '100000', mode: 'cash', reference: null, refunded_at: '2026-08-11T10:00:00Z', party: 'Asha', enrolment_no: 'ENR-1' }],
    ], (sql: string) => ({ name: 'Tech Lingua LLP' }));
    return new CollectionReportService(db, resolver, revenue);
  };

  it('emits the ENVELOPE > IMPORTDATA > Vouchers structure Tally imports', async () => {
    const { xml, receipts, refunds } = await build().tally({} as any, {});
    expect(xml).toContain('<ENVELOPE>');
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
    expect(xml).toContain('<SVCURRENTCOMPANY>Tech Lingua LLP</SVCURRENTCOMPANY>');
    expect(receipts).toBe(1);
    expect(refunds).toBe(1);
  });

  it('a collection is a Receipt voucher: Dr Bank (upi), Cr Fees Received, rupee amount', async () => {
    const { xml } = await build().tally({} as any, {});
    expect(xml).toContain('VCHTYPE="Receipt"');
    expect(xml).toContain('<LEDGERNAME>Bank</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Fees Received</LEDGERNAME>');
    expect(xml).toContain('<AMOUNT>-4500.50</AMOUNT>');  // debit Bank (paise 450050 -> 4500.50)
    expect(xml).toContain('<AMOUNT>4500.50</AMOUNT>');   // credit Fees Received
    expect(xml).toContain('<VOUCHERNUMBER>RCP-1</VOUCHERNUMBER>');
  });

  it('a refund is a Payment voucher: Cr Cash (cash mode), Dr Fees Refund', async () => {
    const { xml } = await build().tally({} as any, {});
    expect(xml).toContain('VCHTYPE="Payment"');
    expect(xml).toContain('<LEDGERNAME>Fees Refund</LEDGERNAME>');
    expect(xml).toContain('<LEDGERNAME>Cash</LEDGERNAME>');
    expect(xml).toContain('<VOUCHERNUMBER>REF-2</VOUCHERNUMBER>');
  });
});

describe('COLLECTION REPORT — grouped rows with a TOTAL and value columns', () => {
  it('appends a TOTAL row and money columns for export', async () => {
    const db = seqDb([
      [{ label: 'Cash', gross_minor: '300000', n: '2' }],
      [{ label: 'Cash', refunds_minor: '0', n: '0' }],
    ], () => ({ name: 'Org' }));
    const revenueSvc = new RevenueService(db, resolver);
    const svc = new CollectionReportService(db, resolver, revenueSvc);
    const rep = await svc.report({} as any, { dimension: 'mode' });
    expect(rep.dimension).toBe('mode');
    expect(rep.rows[0].net_minor).toBe(300_000);
  });
});
