import { LeadsService } from './leads.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * Leads list pagination (client Aug 2026, #1): list() returns a total count and honours
 * limit/offset so the front-end pager can show "X of N" and walk pages. A single query
 * capture asserts the SELECT receives the right LIMIT/OFFSET params, and that an oversized
 * limit is capped (500) and a negative offset floored (0).
 */
const allScope: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true,
  filters: [], allowedFields: null, deniedFields: [],
};

function makeSvc(rows: any[], total: number) {
  const captured: { sql: string; params: unknown[] }[] = [];
  const db: any = {
    one: async (sql: string, params: unknown[]) => { captured.push({ sql, params }); return { n: total }; },
    query: async (sql: string, params: unknown[]) => { captured.push({ sql, params }); return rows; },
  };
  const svc = new LeadsService(db, new ScopeResolverService(), {} as any, {} as any, {} as any, {} as any);
  const sel = () => captured.find((c) => /ORDER BY/.test(c.sql))!;
  return { svc, sel };
}

describe('LeadsService.list() pagination', () => {
  it('returns the total count and page-1 slice (limit 50, offset 0)', async () => {
    const { svc, sel } = makeSvc([{ id: 1 }, { id: 2 }], 120);
    const res = await svc.list(allScope, { limit: 50, offset: 0 } as any);
    expect(res.total).toBe(120);
    expect(res.rows).toHaveLength(2);
    expect(sel().params.slice(-2)).toEqual([50, 0]);
  });

  it('page 2 advances the offset to the next slice', async () => {
    const { svc, sel } = makeSvc([{ id: 51 }], 120);
    const res = await svc.list(allScope, { limit: 50, offset: 50 } as any);
    expect(res.total).toBe(120);
    expect(sel().params.slice(-2)).toEqual([50, 50]);
  });

  it('caps an oversized limit at 500 and floors a negative offset at 0', async () => {
    const { svc, sel } = makeSvc([], 0);
    await svc.list(allScope, { limit: 99999, offset: -5 } as any);
    expect(sel().params.slice(-2)).toEqual([500, 0]);
  });
});
