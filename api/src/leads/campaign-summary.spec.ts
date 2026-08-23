import { LeadsService } from './leads.service';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';

/**
 * dev/131 (task #213 items 2 + 3) — the Campaign module's rolled-up KPI cards come from
 * /leads/summary: Won / Lost / Active(open) / Closed lead counts + Revenue (collected fee
 * receipts, the Finance-dashboard source), and an optional Lead Counsellor (owner) narrow.
 */
function harness() {
  const sqls: string[] = [];
  const db = {
    one: async (sql: string) => {
      sqls.push(sql);
      if (/revenue_minor/.test(sql)) return { revenue_minor: '750000' };
      if (/due_today/.test(sql)) return { due_today: 0, overdue: 0, pending: 0, done_today: 0, done_week: 0, my_open: 0 };
      return { total: 10, today: 1, mtd: 4, won: 3, won_today: 1, lost: 2, closed: 5, active: 5, hot: 1, warm: 1, cold: 1, walkins: 0 };
    },
    query: async (sql: string) => { sqls.push(sql); return []; },
  } as unknown as DatabaseService;
  const resolver = { buildScopeWhere: () => '1=1' } as unknown as ScopeResolverService;
  const svc = new LeadsService(db, resolver, {} as any, {} as any, {} as any, {} as any);
  return { svc, sqls };
}

describe('Campaign summary aggregation (dev/131)', () => {
  it('kpis SELECT rolls up Won / Lost / Active / Closed and merges Revenue from fee receipts', async () => {
    const { svc, sqls } = harness();
    const out: any = await svc.summary({} as any, 1);
    const kpiSql = sqls.find((s) => /AS walkins/.test(s))!;
    expect(kpiSql).toContain("st.stage_type = 'lost')::int AS lost");
    expect(kpiSql).toContain("st.stage_type IN ('won','lost'))::int AS closed");
    expect(kpiSql).toContain('AS active');
    const revSql = sqls.find((s) => /revenue_minor/.test(s))!;
    expect(revSql).toContain('fee_receipt fr JOIN enrolment e');
    expect(out.kpis.lost).toBe(2);
    expect(out.kpis.closed).toBe(5);
    expect(out.kpis.active).toBe(5);
    expect(out.kpis.revenue_minor).toBe(750000);
  });

  it('an owner (Lead Counsellor) filter narrows BOTH the kpis and the revenue query', async () => {
    const { svc, sqls } = harness();
    await svc.summary({} as any, 1, [7]);
    const kpiSql = sqls.find((s) => /AS walkins/.test(s))!;
    const revSql = sqls.find((s) => /revenue_minor/.test(s))!;
    expect(kpiSql).toContain('l.owner_id = ANY(');
    expect(revSql).toContain('e.counsellor_id = ANY(');
  });

  it('no owner filter => no owner clause (scope-only cards)', async () => {
    const { svc, sqls } = harness();
    await svc.summary({} as any, 1);
    const kpiSql = sqls.find((s) => /AS walkins/.test(s))!;
    expect(kpiSql).not.toContain('l.owner_id = ANY(');
  });
});
