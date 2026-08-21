/**
 * dev/122 — FINANCE SCOPE NARROWING. The top-bar Branch › Vertical scope folds into
 * every finance summary/KPI query as branch_ids / vertical_ids, ANDed on top of the
 * RBAC scope (it can only ever NARROW). This proves each summary emits the narrowing
 * predicate + binds the id arrays, so changing the scope actually changes the figures.
 */
import { InvoiceService } from '../invoices/invoice.service';
import { FeeService } from '../fees/fee.service';
import { PlanService } from '../paymentplans/plan.service';
import { RefundService } from '../refunds/refund.service';

const scope: any = { all: true, filters: [] };
const resolver: any = { buildScopeWhere: (_s: any, _c: any, _p: unknown[]) => '1=1' };

function recorder() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: any = {
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
  };
  return { calls, db };
}

const hasNarrow = (calls: Array<{ sql: string; params: unknown[] }>, col: string, arr: number[]) =>
  calls.some((c) => c.sql.includes(`${col} = ANY(`) && c.params.some((p) => JSON.stringify(p) === JSON.stringify(arr)));

describe('finance summaries narrow by branch_ids / vertical_ids', () => {
  it('invoice summary binds branch/vertical narrowing', async () => {
    const { calls, db } = recorder();
    const svc = new InvoiceService(db, resolver, {} as never);
    await svc.summary(scope, { branch_ids: [7], vertical_ids: [3] });
    expect(hasNarrow(calls, 'gi.branch_id', [7])).toBe(true);
    expect(hasNarrow(calls, 'gi.vertical_id', [3])).toBe(true);
  });

  it('invoice summary WITHOUT a scope emits no narrowing', async () => {
    const { calls, db } = recorder();
    const svc = new InvoiceService(db, resolver, {} as never);
    await svc.summary(scope, {});
    expect(calls.some((c) => c.sql.includes('branch_id = ANY('))).toBe(false);
  });

  it('fee (collection) summary narrows receipts AND outstanding', async () => {
    const { calls, db } = recorder();
    const svc = new FeeService(db, resolver, {} as never);
    await svc.summary(scope, { branch_ids: [7], vertical_ids: [3] });
    expect(hasNarrow(calls, 'fr.branch_id', [7])).toBe(true);   // receipt aggregates
    expect(hasNarrow(calls, 'e.branch_id', [7])).toBe(true);    // outstanding
  });

  it('payment-plan summary narrows by branch/vertical', async () => {
    const { calls, db } = recorder();
    const svc = new PlanService(db, resolver);
    await svc.summary(scope, { branch_ids: [7], vertical_ids: [3] });
    expect(hasNarrow(calls, 'e.branch_id', [7])).toBe(true);
    expect(hasNarrow(calls, 'e.vertical_id', [3])).toBe(true);
  });

  it('refund summary narrows by branch/vertical', async () => {
    const { calls, db } = recorder();
    const svc = new RefundService(db, resolver, {} as never, {} as never);
    await svc.summary(scope, { branch_ids: [7], vertical_ids: [3] });
    expect(hasNarrow(calls, 'rf.branch_id', [7])).toBe(true);
    expect(hasNarrow(calls, 'rf.vertical_id', [3])).toBe(true);
  });
});
