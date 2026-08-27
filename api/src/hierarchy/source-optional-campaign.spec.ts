import 'reflect-metadata';
import { HierarchyService } from './hierarchy.service';

/**
 * 27aug Batch C item 1 — a Lead Source no longer REQUIRES a campaign, and the two "source" masters
 * are reconciled onto the ONE canonical m_source catalogue (find-or-create by name).
 */
function make(opts: { existingMaster?: any } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM m_source WHERE org_id/.test(sql)) return opts.existingMaster ?? null; // find canonical
      if (/INSERT INTO m_source/.test(sql)) return { id: 77 };                        // create canonical
      if (/FROM campaign WHERE id/.test(sql)) return { org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return [{ id: 10, name: params[6] }]; },
  } as any;
  return { svc: new HierarchyService(db, {} as any, {} as any), issued };
}

describe('HierarchyService.createSource — campaign optional + canonical m_source (item 1)', () => {
  it('creates an ORG-LEVEL source with NO campaign and find-or-creates its canonical m_source', async () => {
    const { svc, issued } = make();
    const row = await svc.createSource({ name: 'Walk-in' } as any, 5);
    expect(row).toBeDefined();
    const ins = issued.find((q) => /INSERT INTO source /.test(q.sql))!;
    // campaign_id / branch / vertical / pipeline are all NULL for an org-level source
    expect(ins.params.slice(1, 5)).toEqual([null, null, null, null]);
    // master_source_id was resolved (newly created m_source id 77)
    expect(ins.params[5]).toBe(77);
    expect(issued.some((q) => /INSERT INTO m_source/.test(q.sql))).toBe(true);
  });

  it('reuses an existing canonical m_source when the name already exists', async () => {
    const { svc, issued } = make({ existingMaster: { id: 42 } });
    await svc.createSource({ name: 'Facebook' } as any, 5);
    const ins = issued.find((q) => /INSERT INTO source /.test(q.sql))!;
    expect(ins.params[5]).toBe(42);
    expect(issued.some((q) => /INSERT INTO m_source/.test(q.sql))).toBe(false);
  });

  it('still derives the full path from a campaign when one IS given', async () => {
    const { svc, issued } = make();
    await svc.createSource({ name: 'Meta', campaign_id: 9 } as any, 5);
    const ins = issued.find((q) => /INSERT INTO source /.test(q.sql))!;
    expect(ins.params.slice(1, 5)).toEqual([2, 3, 4, 9]); // branch, vertical, pipeline, campaign
  });

  it('rejects a source with no name', async () => {
    const { svc } = make();
    await expect(svc.createSource({} as any, 5)).rejects.toThrow(/name is required/i);
  });
});
