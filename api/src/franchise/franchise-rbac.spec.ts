import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { FranchiseTargetService } from './franchise-target.service';
import { FranchiseComplianceService } from './franchise-compliance.service';
import { FranchiseService } from './franchise.service';
import { DatabaseService } from '../database/database.service';

/* ===================================================================================
 * FRANCHISE-OWNER RBAC (Phase 4 Batch 3) — the enforcement point is buildScopeWhere:
 * a franchise owner's ResolvedScope carries franchiseBranchIds, and every branch-bearing
 * query is AND-narrowed to it. These tests prove the isolation guarantees required by the
 * batch: owner effective scope == their franchise branches; owner reads restricted to
 * those branches; owner cannot reach another franchise's branches; Super Admin unaffected;
 * a non-owner (franchiseBranchIds null) behaves EXACTLY as before (no regression).
 * ================================================================================= */

const svc = new ScopeResolverService();
const LEAD_COLS: ScopeColumnMap = {
  owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};
const MASTER_COLS: ScopeColumnMap = {}; // an org-level entity (no branch column)

const scope = (over: Partial<ResolvedScope> = {}): ResolvedScope => ({
  permissionKey: 'lead.read', allowed: true, all: true, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});

describe('buildScopeWhere — franchise-owner branch narrowing', () => {
  it("a franchise owner's effective scope == their franchise's branch_ids (all-grant narrowed)", () => {
    const params: unknown[] = [];
    const where = svc.buildScopeWhere(scope({ franchiseBranchIds: [10, 20] }), LEAD_COLS, params);
    expect(where).toBe('(l.branch_id = ANY($1::bigint[]))');
    expect(params).toEqual([[10, 20]]);
  });

  it('a franchise owner querying leads is restricted to those branch_ids (ANDed onto a branch grant)', () => {
    const params: unknown[] = [];
    const where = svc.buildScopeWhere(
      scope({ all: false, filters: [{ kind: 'branch', branchId: 10 }], franchiseBranchIds: [10, 20] }),
      LEAD_COLS, params,
    );
    // base branch filter AND franchise-branch restriction
    expect(where).toBe('((l.branch_id = $1) AND l.branch_id = ANY($2::bigint[]))');
    expect(params).toEqual([10, [10, 20]]);
  });

  it('a franchise owner whose franchise maps NO branches sees no rows (1=0)', () => {
    const params: unknown[] = [];
    expect(svc.buildScopeWhere(scope({ franchiseBranchIds: [] }), LEAD_COLS, params)).toBe('1=0');
  });

  it('a franchise owner CANNOT widen to another franchise: only their branch_ids are bound', () => {
    // Owner of branches [10,20]; a lead in branch 99 (another franchise) can never match.
    const params: unknown[] = [];
    const where = svc.buildScopeWhere(scope({ franchiseBranchIds: [10, 20] }), LEAD_COLS, params);
    expect(where).toContain('= ANY($1::bigint[])');
    expect(params[0]).toEqual([10, 20]);       // 99 is not in the bound set
  });

  it('Super Admin (no franchise link, franchiseBranchIds null) is UNAFFECTED — full access', () => {
    const params: unknown[] = [];
    expect(svc.buildScopeWhere(scope({ franchiseBranchIds: null }), LEAD_COLS, params)).toBe('1=1');
    expect(params).toEqual([]);
  });

  it('a non-owner scoped role (franchiseBranchIds undefined) behaves exactly as before — no regression', () => {
    const params: unknown[] = [];
    const before = svc.buildScopeWhere(
      scope({ all: false, filters: [{ kind: 'branch', branchId: 7 }] }), LEAD_COLS, params,
    );
    expect(before).toBe('(l.branch_id = $1)');
    expect(params).toEqual([7]);
  });

  it('a franchise owner still reads org-level (branch-less) config: masters are not narrowed', () => {
    const params: unknown[] = [];
    // org-level entity has no branch column -> franchise layer leaves the base verbatim
    expect(svc.buildScopeWhere(scope({ franchiseBranchIds: [10] }), MASTER_COLS, params)).toBe('1=1');
  });
});

/* =============================== franchise targets =============================== */
function fakeDb(handlers: { query?: (sql: string, p: any[]) => any[]; one?: (sql: string, p: any[]) => any }): DatabaseService {
  return {
    query: async (sql: string, p: any[] = []) => (handlers.query ? handlers.query(sql, p) : []),
    one: async (sql: string, p: any[] = []) => (handlers.one ? handlers.one(sql, p) : null),
  } as unknown as DatabaseService;
}

describe('FranchiseTargetService.performance — target vs actual', () => {
  it('computes actuals from the franchise branches and per-metric achievement %', async () => {
    const db = fakeDb({
      query: (sql) => {
        if (/FROM franchise_branch/.test(sql)) return [{ branch_id: '5' }];
        return [];
      },
      one: (sql) => {
        if (/FROM franchise_target t JOIN franchise/.test(sql)) return {
          id: '1', franchise_id: '9', franchise_name: 'Pune', name: 'Aug', period_type: 'monthly',
          period_start: '2026-08-01', period_end: '2026-08-31',
          admissions_target: '10', enrolments_target: '10', revenue_target_minor: '20000000', collection_target_minor: '16000000',
        };
        if (/count\(DISTINCT lead_id\)/.test(sql)) return { enrolments: '6', admissions: '5' };
        if (/AS gross/.test(sql)) return { gross: '10000000', receipts: '4' };
        if (/AS refunds/.test(sql)) return { refunds: '2000000' };
        return null;
      },
    });
    const franchises = new FranchiseService(db);
    const svc = new FranchiseTargetService(db, franchises);
    const perf = await svc.performance(1);
    expect(perf.actuals.admissions).toBe(5);
    expect(perf.actuals.enrolments).toBe(6);
    expect(perf.actuals.revenue_collected_minor).toBe(10000000);
    expect(perf.actuals.collection_minor).toBe(8000000);       // gross 100k - refunds 20k
    const rev = perf.metrics.find((m) => m.key === 'revenue')!;
    expect(rev.pct).toBe(50);                                   // 10000000 / 20000000
    const adm = perf.metrics.find((m) => m.key === 'admissions')!;
    expect(adm.pct).toBe(50);                                   // 5 / 10
    expect(perf.overall_pct).toBeGreaterThan(0);
  });
});

/* ============================= franchise compliance ============================= */
describe('FranchiseComplianceService.list — progress % and overdue', () => {
  it('materialises none (already present), computes compliant/applicable % and overdue count', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const db = fakeDb({
      one: (sql) => {
        if (/FROM franchise WHERE id/.test(sql)) return { id: '9' };
        if (/count\(\*\) AS n FROM franchise_compliance_item/.test(sql)) return { n: '4' }; // already materialised
        if (/FROM organisation/.test(sql)) return { id: '1' };
        return null;
      },
      query: (sql) => {
        if (/FROM franchise_compliance_item i/.test(sql)) return [
          { id: '1', title: 'A', category: 'legal', status: 'compliant', due_date: null, sort_order: '1' },
          { id: '2', title: 'B', category: 'legal', status: 'pending', due_date: yesterday, sort_order: '2' },
          { id: '3', title: 'C', category: 'finance', status: 'na', due_date: null, sort_order: '3' },
          { id: '4', title: 'D', category: 'brand', status: 'non_compliant', due_date: null, sort_order: '4' },
        ];
        return [];
      },
    });
    const storage = { presignGet: async () => 'https://x' } as any;
    const svc = new FranchiseComplianceService(db, storage);
    const res = await svc.list(9);
    // applicable = 3 (excludes the 'na'); compliant = 1 -> 33.3%
    expect(res.summary.applicable).toBe(3);
    expect(res.summary.compliant).toBe(1);
    expect(res.summary.progress_pct).toBe(33.3);
    expect(res.summary.overdue).toBe(1);   // item B is pending + past due
  });
});
