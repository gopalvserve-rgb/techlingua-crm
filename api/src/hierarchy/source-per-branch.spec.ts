import { HierarchyService } from './hierarchy.service';

/**
 * Client 12 Nov 2026 — "source name should be branch wise": Vikaspuri has "Meta", Janakpuri must
 * be able to add its own "Meta". A name is unique per Branch › Vertical › Pipeline only.
 */
function mkDb(existing: Array<{ id: number; name: string; branch_id: number | null; vertical_id: number | null; pipeline_id: number | null }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const exec = (sql: string, params: unknown[] = []): any[] => {
    calls.push({ sql, params });
    if (/lower\(s\.name\) = lower\(\$2\)/.test(sql)) {
      const [, name, b, v, p, except] = params as any[];
      return existing.filter((r) => r.name.toLowerCase() === String(name).toLowerCase() && r.branch_id === b && r.vertical_id === v
        && r.pipeline_id === p && r.id !== except).map((r) => ({ id: r.id, branch_name: `Branch ${r.branch_id}` }));
    }
    if (/FROM organisation/.test(sql)) return [{ id: 1 }];
    if (/FROM branch WHERE id/.test(sql)) return [{ id: params[0] }];
    if (/FROM m_source WHERE org_id/.test(sql)) return [{ id: 7 }];
    if (/INSERT INTO source/.test(sql)) return [{ id: 99, name: params[6] }];
    if (/UPDATE source SET/.test(sql)) return [{ id: 80 }];
    return [];
  };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => exec(sql, params)[0] ?? null,
  };
}
const svc = (db: any) => new HierarchyService(db, { buildScopeWhere: () => 'TRUE' } as any, {} as any);
const META_VKP = { id: 79, name: 'Meta', branch_id: 40, vertical_id: null, pipeline_id: null };

describe('Lead Source Master — one name per Branch › Vertical › Pipeline (12 Nov 2026)', () => {
  it('Janakpuri can add "Meta" while Vikaspuri already has one', async () => {
    const db = mkDb([META_VKP]);
    const row: any = await svc(db).createSource({ name: 'Meta', channel: 'meta', branch_id: 42 }, 1);
    expect(row.id).toBe(99);
    // both share the ONE canonical m_source row, so reports still add "Meta" up across branches
    const ins = db.calls.find((c) => /INSERT INTO source/.test(c.sql))!;
    expect(ins.params[5]).toBe(7);
    expect(ins.params[1]).toBe(42);
  });

  it('a second "meta" on the SAME branch is still refused', async () => {
    const db = mkDb([META_VKP]);
    await expect(svc(db).createSource({ name: 'meta', channel: 'meta', branch_id: 40 }, 1)).rejects.toThrow(/already in the Lead Source Master for Branch 40/);
  });

  it('an all-branches "Meta" and a branch "Meta" can live side by side, two all-branches ones cannot', async () => {
    const db = mkDb([{ ...META_VKP, branch_id: null }]);
    await expect(svc(db).createSource({ name: 'Meta', branch_id: 40 }, 1)).resolves.toBeTruthy();
    await expect(svc(db).createSource({ name: 'Meta' }, 1)).rejects.toThrow(/for all branches/);
  });

  it('renaming / moving a source checks the target path, excluding itself', async () => {
    const db = mkDb([META_VKP, { id: 80, name: 'JustDial', branch_id: 42, vertical_id: null, pipeline_id: null }]);
    // moving JustDial (Janakpuri) to "Meta" on Janakpuri is fine — Vikaspuri's Meta is elsewhere
    db.one = async (sql: string, params: unknown[] = []) => {
      if (/SELECT campaign_id, master_source_id, name, org_id/.test(sql)) return { campaign_id: null, master_source_id: 3, name: 'JustDial', org_id: 1, branch_id: 42, vertical_id: null, pipeline_id: null };
      if (/AS shared/.test(sql)) return { org_id: 1, campaign_id: null, master_source_id: 3, shared: false };
      return (await db.query(sql, params))[0] ?? null;
    };
    await expect(svc(db).updateSource(80, { name: 'Meta' })).resolves.toBeDefined();
    // …but moving it onto Vikaspuri, where "Meta" exists, is refused BEFORE anything is renamed
    const before = db.calls.length;
    await expect(svc(db).updateSource(80, { name: 'Meta', branch_id: 40 })).rejects.toThrow(/already in the Lead Source Master/);
    expect(db.calls.slice(before).some((c) => /UPDATE m_source/.test(c.sql))).toBe(false);
  });
});
