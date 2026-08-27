import 'reflect-metadata';
import { QuotationService } from './quotation.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * 27aug Batch C item 8 — the Quotation now carries a Payment plan (Branch>Vertical>Course>Level>
 * Payment plan, matching the Sales Closer). Asserts create() persists payment_plan.
 */
const scopeAll: ResolvedScope = { permissionKey: 'quotation.create', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;
const numbering = { allocate: async () => 'QUO-2026-27/0001' } as any;

function make() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const lead = { id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4, campaign_id: 5, owner_id: 6, team_id: null, full_name: 'Riya' };
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM lead/.test(sql)) return lead;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 90 }] }; } }),
  } as any;
  return { svc: new QuotationService(db, resolver, numbering), issued };
}

describe('QuotationService.create — payment plan (item 8)', () => {
  it('persists the payment_plan on the quotation', async () => {
    const { svc, issued } = make();
    await svc.create({
      lead_id: 1, payment_plan: 'emi_3',
      items: [{ course_id: 7, description: 'IELTS', qty: 1, unit_price: '20000', discount_type: 'amount', discount_value: '0', tax_pct: '0' }],
    }, { id: 6 }, scopeAll);
    const ins = issued.find((q) => /INSERT INTO quotation /.test(q.sql))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/payment_plan/);
    expect(ins.params).toContain('emi_3');
  });
});
