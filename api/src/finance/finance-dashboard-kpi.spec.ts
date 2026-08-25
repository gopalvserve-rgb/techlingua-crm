import { FinanceDashboardService } from './finance-dashboard.service';

/**
 * crm25aug (#5) — the 12 Finance-dashboard KPI cards each compute from the live sources.
 * A pg-shaped DB double returns one canned row per aggregate (matched by a distinctive column
 * in its SELECT); the test asserts every KPI field maps to the right figure, incl. the derived
 * Collection Rate and GST total.
 */
function svcWith(canned: Record<string, any>) {
  const one = async (sql: string) => {
    if (/today_minor/.test(sql)) return canned.coll;
    if (/range_receipts/.test(sql)) return canned.rangeColl;
    if (/collectible_minor/.test(sql)) return canned.coll2;
    if (/current_month_minor/.test(sql)) return canned.inst;
    if (/overdue_collected_minor/.test(sql)) return canned.overdueColl;
    if (/with_dues/.test(sql)) return canned.dues;
    if (/invoiced_minor/.test(sql)) return canned.inv;
    if (/AS n\b/.test(sql) && /refund/.test(sql)) return canned.refAll;
    if (/range_minor/.test(sql) && /refund/.test(sql)) return canned.refRange;
    if (/FROM organisation/.test(sql)) return { id: '1' };
    return null;
  };
  const db: any = { one, query: async () => [] };
  const resolver: any = { buildScopeWhere: () => '1=1' };
  return new FinanceDashboardService(db, resolver);
}

describe('Finance dashboard — 12 KPI cards (crm25aug #5)', () => {
  const canned = {
    coll: { all_time_minor: '100000', mtd_minor: '40000', today_minor: '15000', receipts: '7' },
    rangeColl: { range_minor: '100000', range_receipts: '7' },
    dues: { outstanding_minor: '250000', with_dues: '3' },
    refAll: { all_time_minor: '2000', n: '1' },
    refRange: { range_minor: '0' },
    inv: { invoiced_minor: '300000', taxable_minor: '254237', cgst_minor: '22881', sgst_minor: '22881', igst_minor: '0', issued: '2', paid: '1', draft: '0' },
    coll2: { collectible_minor: '400000', net_revenue_range_minor: '120000' },
    inst: { current_month_minor: '50000', overdue_minor: '30000' },
    overdueColl: { overdue_collected_minor: '12000' },
  };

  it('maps all 12 KPIs (incl. Collection Rate + GST total)', async () => {
    const svc = svcWith(canned);
    const { kpis } = await svc.dashboard({ all: true, filters: [] } as any, {});
    expect(kpis.collected_today_minor).toBe(15000);            // Today's Collection
    expect(kpis.overdue_fee_collected_minor).toBe(12000);      // Overdue Fee Collected
    expect(kpis.total_collected_minor).toBe(100000);           // Total Collected Fee
    expect(kpis.collection_rate_pct).toBe(25);                 // 100000 / 400000 * 100
    expect(kpis.total_invoiced_minor).toBe(300000);            // Total Invoiced
    expect(kpis.net_revenue_minor).toBe(120000);               // Net Revenue
    expect(kpis.total_unpaid_minor).toBe(250000);              // Total Unpaid Fee
    expect(kpis.current_month_installment_minor).toBe(50000);  // Current Month Instalment Fee
    expect(kpis.overdue_fee_minor).toBe(30000);                // Overdue Fee
    expect(kpis.gst_collected_minor).toBe(45762);              // 22881 + 22881 + 0
    expect(kpis.refunds_minor).toBe(2000);                     // Refunds
    expect(kpis.receipts).toBe(7);                             // Receipts (count)
  });

  it('Collection Rate is 0 when nothing is collectible (no divide-by-zero)', async () => {
    const svc = svcWith({ ...canned, coll2: { collectible_minor: '0', net_revenue_range_minor: '0' } });
    const { kpis } = await svc.dashboard({ all: true, filters: [] } as any, {});
    expect(kpis.collection_rate_pct).toBe(0);
  });
});
