import { HierarchyService } from './hierarchy.service';

/**
 * UAT-R2 Batch D — #23 campaign managers + #24 per-agent pause.
 *
 * #23: managers are stored in campaign_manager and are DELIBERATELY NOT placed in
 *      distribution_config.agent_user_ids, so a manager receives no auto-assigned leads.
 * #24: pausing an agent upserts campaign_agent_pause (the flag the distribution engine
 *      reads to skip that agent).
 */

type Call = { sql: string; params: unknown[] };

function mkDb() {
  const calls: Call[] = [];
  const exec = (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/SELECT org_id, branch_id, vertical_id FROM pipeline/.test(s)) return [{ org_id: 1, branch_id: 2, vertical_id: 3 }];
    if (/SELECT id FROM "user"/.test(s)) {
      const list = params[0];
      return Array.isArray(list) ? (list as number[]).map((id) => ({ id })) : [{ id: params[0] }];
    }
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

describe('#23 — campaign managers are separate from the distribution agent pool', () => {
  it('createCampaign inserts managers into campaign_manager', async () => {
    const db = mkDb();
    await svc(db).createCampaign({ pipeline_id: 4, name: 'C', manager_user_ids: [7, 8] } as any, 9, scope);
    const mgr = db.calls.filter((c) => c.sql.startsWith('INSERT INTO campaign_manager'));
    expect(mgr).toHaveLength(2);
    expect(mgr.flatMap((c) => c.params)).toEqual(expect.arrayContaining([7, 8]));
  });

  it('managers are NOT written into the campaign row / distribution pool', async () => {
    const db = mkDb();
    await svc(db).createCampaign({ pipeline_id: 4, name: 'C', manager_user_ids: [7, 8] } as any, 9, scope);
    const campIns = db.calls.find((c) => c.sql.startsWith('INSERT INTO campaign'))!;
    // the manager ids never appear in the campaign INSERT params (which carry the
    // distribution_config); managers live only in campaign_manager.
    expect(campIns.params).not.toContain(7);
    expect(campIns.params).not.toContain(8);
    expect(JSON.stringify(campIns.params)).not.toContain('agent_user_ids');
  });

  it('updateCampaign replaces the manager set (delete + re-insert)', async () => {
    const db = mkDb();
    await svc(db).updateCampaign(5, { manager_user_ids: [3] } as any, 9, scope);
    expect(db.calls.some((c) => c.sql.startsWith('DELETE FROM campaign_manager'))).toBe(true);
    expect(db.calls.some((c) => c.sql.startsWith('INSERT INTO campaign_manager') && c.params.includes(3))).toBe(true);
  });
});

describe('#24 — setAgentPause upserts campaign_agent_pause', () => {
  it('pauses an agent (upsert with ON CONFLICT)', async () => {
    const db = mkDb();
    const r = await svc(db).setAgentPause(5, 12, true, 9, scope);
    expect(r).toEqual({ campaign_id: 5, user_id: 12, paused: true });
    const up = db.calls.find((c) => c.sql.startsWith('INSERT INTO campaign_agent_pause'))!;
    expect(up.sql).toContain('ON CONFLICT');
    expect(up.params).toEqual(expect.arrayContaining([5, 12, true, 9]));
  });

  it('resumes an agent (paused = false)', async () => {
    const db = mkDb();
    const r = await svc(db).setAgentPause(5, 12, false, 9, scope);
    expect(r.paused).toBe(false);
  });
});
