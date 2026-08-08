import { HierarchyService } from './hierarchy.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

const ALL: ResolvedScope = {
  permissionKey: 'pipeline.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

function build() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  const enforcer = { assertRefInScope: async () => undefined } as any;
  const svc = new HierarchyService(db, new ScopeResolverService(), enforcer);
  return { svc, calls };
}

describe('GET /stages — all in-scope pipeline stages (Leads STAGE filter)', () => {
  it('selects stages joined to their pipeline, scoped, with pipeline_id + name', async () => {
    const { svc, calls } = build();
    await svc.listAllStages(ALL);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM pipeline_stage st JOIN pipeline p ON p.id = st.pipeline_id');
    expect(sql).toContain('st.pipeline_id');
    expect(sql).toContain('p.name AS pipeline_name');
  });
});

describe('listSources — the Edit form prefills the full path', () => {
  it('selects branch_name / vertical_name / pipeline_name for the source', async () => {
    const { svc, calls } = build();
    await svc.listSources(ALL);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('b.name AS branch_name');
    expect(sql).toContain('v.name AS vertical_name');
    expect(sql).toContain('p.name AS pipeline_name');
  });
});
