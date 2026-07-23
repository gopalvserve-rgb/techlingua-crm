import { HierarchyService } from './hierarchy.service';

/**
 * UAT-R3 — #19 list filters and #22 pipeline re-parent + path re-denormalisation.
 */
type Call = { sql: string; params: unknown[] };

function mkDb() {
  const calls: Call[] = [];
  const exec = (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/SELECT org_id, branch_id FROM vertical/.test(s)) return [{ org_id: 1, branch_id: 20 }];
    if (/SELECT id FROM pipeline WHERE id/.test(s)) return [{ id: 7 }];
    if (/^UPDATE pipeline/.test(s)) return [{ id: 7, branch_id: 20, vertical_id: 5 }];
    return [{ id: 5 }];
  };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => (exec(sql, params) as any[])[0] ?? null,
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string, params: unknown[] = []) => ({ rows: exec(sql, params) }) }),
  };
}

const enforcer = { assertRefInScope: async () => undefined } as any;
const svc = (db: any) => new HierarchyService(db as any, { buildScopeWhere: () => 'TRUE' } as any, enforcer);
const scope = {} as any;

describe('#19 — hierarchy list endpoints honour the new filter params', () => {
  it('listVerticals adds a name/code search on ?q', async () => {
    const db = mkDb();
    await svc(db).listVerticals(scope, undefined, false, 'iel');
    const q = db.calls.find((c) => /FROM vertical v/.test(c.sql))!;
    expect(q.sql).toMatch(/v\.name ILIKE/);
    expect(q.params).toContain('%iel%');
  });

  it('listPipelines filters by branch_id AND search', async () => {
    const db = mkDb();
    await svc(db).listPipelines(scope, undefined, false, 20, 'adm');
    const q = db.calls.find((c) => /FROM pipeline p/.test(c.sql))!;
    expect(q.sql).toMatch(/p\.branch_id = \$/);
    expect(q.sql).toMatch(/p\.name ILIKE/);
    expect(q.params).toEqual(expect.arrayContaining([20, '%adm%']));
  });

  it('listCampaigns filters by branch_id + vertical_id + search', async () => {
    const db = mkDb();
    await svc(db).listCampaigns(scope, undefined, false, 20, 5, 'meta');
    const q = db.calls.find((c) => /FROM campaign c/.test(c.sql))!;
    expect(q.sql).toMatch(/c\.branch_id = \$/);
    expect(q.sql).toMatch(/c\.vertical_id = \$/);
    expect(q.sql).toMatch(/c\.name ILIKE/);
    expect(q.params).toEqual(expect.arrayContaining([20, 5, '%meta%']));
  });

  it('listBranches searches name/code on ?q', async () => {
    const db = mkDb();
    await svc(db).listBranches(scope, false, 'vik');
    const q = db.calls.find((c) => /FROM branch b/.test(c.sql))!;
    expect(q.sql).toMatch(/b\.name ILIKE .* OR b\.code ILIKE/);
    expect(q.params).toContain('%vik%');
  });
});

describe('#22 — pipeline re-parent re-denormalises the whole descendant path', () => {
  it('changing vertical_id moves the pipeline AND its campaigns/sources/leads', async () => {
    const db = mkDb();
    // move pipeline 7 to vertical 5 (whose branch is 20, derived server-side)
    const out = await svc(db).updatePipeline(7, { vertical_id: 5, name: 'Renamed' }, 9, scope);
    expect(out).toEqual({ id: 7, branch_id: 20, vertical_id: 5 });
    const pipeUpd = db.calls.find((c) => /^UPDATE pipeline/.test(c.sql))!;
    expect(pipeUpd.params).toEqual(expect.arrayContaining([20, 5, 7])); // branch, vertical, id
    for (const child of ['campaign', 'source', 'lead']) {
      const u = db.calls.find((c) => new RegExp(`^UPDATE ${child} SET branch_id`).test(c.sql));
      expect(u).toBeTruthy();
      expect(u!.params).toEqual([20, 5, 7]); // new branch, new vertical, pipeline id filter
    }
  });

  it('a branch_id that contradicts the chosen vertical is rejected', async () => {
    const db = mkDb();
    // vertical 5 belongs to branch 20; sending branch 99 must 400
    await expect(svc(db).updatePipeline(7, { vertical_id: 5, branch_id: 99 }, 9, scope))
      .rejects.toThrow(/does not belong/);
  });

  it('a plain edit (no vertical_id) does NOT re-parent — genericUpdate path', async () => {
    const db = mkDb();
    await svc(db).updatePipeline(7, { name: 'Just a rename' }, 9, scope);
    expect(db.calls.some((c) => /^UPDATE campaign SET branch_id/.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => /^UPDATE pipeline SET/.test(c.sql))).toBe(true);
  });
});
