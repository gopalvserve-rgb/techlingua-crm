import { NotFoundException } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * Source RE-PARENT (client Aug 2026): the Source Edit form's Branch>Vertical>Pipeline>Campaign
 * became editable. `updateSource` accepts a new `campaign_id` and RE-DERIVES the source's full
 * denormalised path from the target campaign (exactly like the pipeline re-parent / lead
 * transfer), RBAC-checking both the source and the target campaign against the actor's scope.
 * Existing leads keep their own captured path — the source move affects the source record and
 * future captures only.
 */

const ALL: ResolvedScope = {
  permissionKey: 'source.update', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
} as any;

type Call = { sql: string; params: unknown[] };
function mkDb() {
  const calls: Call[] = [];
  const rec = (sql: string, params: unknown[] = []) => calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  return {
    calls,
    one: async (sql: string, params: unknown[] = []) => {
      rec(sql, params);
      // 27aug Batch C item 1 — a rename now syncs the canonical m_source (find-or-create).
      if (/INSERT INTO m_source/i.test(sql)) return { id: '77' };
      if (/FROM m_source/i.test(sql)) return null;
      if (/FROM source/i.test(sql)) return { id: '4', org_id: '1', campaign_id: '5' };
      if (/FROM campaign/i.test(sql)) return { org_id: '1', branch_id: '9', vertical_id: '3', pipeline_id: '7' };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { rec(sql, params); return [{ id: 4, branch_id: 9 }]; },
  };
}

describe('updateSource — re-parent re-denormalises the path', () => {
  it('a new campaign_id re-derives branch/vertical/pipeline/campaign from the target campaign', async () => {
    const db = mkDb();
    const enforcer = { assertRefInScope: jest.fn(async () => undefined) } as any;
    const svc = new HierarchyService(db as any, {} as any, enforcer);
    await svc.updateSource(4, { campaign_id: 12, name: 'Meta Ads' }, ALL, 99);

    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE source'))!;
    expect(upd).toBeDefined();
    for (const col of ['org_id', 'branch_id', 'vertical_id', 'pipeline_id', 'campaign_id', 'name']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
    // path values come from the TARGET campaign (org 1 / branch 9 / vertical 3 / pipeline 7 / campaign 12)
    expect(upd.params.slice(0, 5)).toEqual([1, 9, 3, 7, 12]);
    // both the source and the target campaign were scope-checked
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith(ALL, 'source', 4, 99);
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith(ALL, 'campaign', 12, 99);
  });

  it('without campaign_id it is a plain scalar update (no path columns touched)', async () => {
    const db = mkDb();
    const svc = new HierarchyService(db as any, {} as any, { assertRefInScope: async () => undefined } as any);
    await svc.updateSource(4, { name: 'Renamed', cost_per_lead: 250 });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE source'))!;
    expect(upd.sql).toContain('name = $');
    expect(upd.sql).toContain('cost_per_lead = $');
    expect(upd.sql).not.toContain('branch_id = $');
    expect(upd.sql).not.toContain('campaign_id = $');
  });

  it('RBAC: an out-of-scope target campaign is refused (404), no UPDATE runs', async () => {
    const db = mkDb();
    const enforcer = {
      assertRefInScope: jest.fn(async (_s: unknown, kind: string) => {
        if (kind === 'campaign') throw new NotFoundException('campaign');
      }),
    } as any;
    const svc = new HierarchyService(db as any, {} as any, enforcer);
    await expect(svc.updateSource(4, { campaign_id: 12 }, ALL, 99)).rejects.toThrow(NotFoundException);
    expect(db.calls.find((c) => c.sql.startsWith('UPDATE source'))).toBeUndefined();
  });
});
