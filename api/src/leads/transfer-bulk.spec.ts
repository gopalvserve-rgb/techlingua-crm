import { LeadsService } from './leads.service';

/**
 * Lead transfer + bulk actions (client request, Jul 2026).
 *
 * transfer(): re-parents a lead onto a target campaign's derived path (branch/vertical/
 * pipeline/campaign/source), keeps or distributes the owner, writes a 'transfer' activity +
 * audit row. bulkTransfer/bulkReassign/bulkSetPaused run per-lead over the caller's scoped
 * subset, report counts + skips, and are idempotent.
 *
 * The DB is a content-aware double: it answers each query by matching the SQL text, so the
 * tests do not depend on call ORDER (which the real orchestration is free to change).
 */

const CAMP = { id: '5', org_id: '1', branch_id: '2', vertical_id: '3', pipeline_id: '4',
  distribution_config: { mode: 'equal', agent_user_ids: [12] }, name: 'Meta Jul' };

function leadBefore(over: any = {}) {
  return { id: '101', org_id: '1', branch_id: '9', vertical_id: '8', pipeline_id: '7',
    campaign_id: '6', source_id: '55', stage_id: '10', owner_id: '11',
    course_id: null, city_id: null, state_id: null, budget_id: null, temperature: 'warm', priority: 'med', ...over };
}

function answer(sql: string, params: any[], ctx: any) {
  ctx.calls.push({ sql, params });
  if (/FROM campaign WHERE id = \$1 AND is_active/.test(sql)) return ctx.camp;             // resolveTransferTarget
  if (/SELECT b\.name AS b, v\.name AS v, c\.name AS c/.test(sql)) return { b: 'B', v: 'V', c: 'C' }; // pathLabel
  if (/SELECT id FROM source WHERE id = \$1 AND campaign_id/.test(sql)) return ctx.explicitSource; // explicit source
  if (/SELECT id FROM source WHERE campaign_id = \$1 AND deleted_at IS NULL AND is_active/.test(sql)) return ctx.existingSource;
  if (/INSERT INTO source/.test(sql)) return { id: '77' };                                  // created source
  if (/FROM pipeline_stage WHERE pipeline_id = \$1 AND is_active/.test(sql)) return { id: '70' }; // entry stage
  if (/SELECT \* FROM lead WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) return ctx.before;
  if (/UPDATE lead SET branch_id/.test(sql)) return { rows: [{ id: params[params.length - 1] }] };  // transfer UPDATE RETURNING *
  if (/UPDATE lead SET paused/.test(sql)) return { rows: [{ id: params[0] }] };             // pause UPDATE RETURNING id
  if (/UPDATE lead SET deleted_at = now\(\)/.test(sql)) return { rows: ctx.noDelete ? [] : [{ id: params[0] }] };  // bulk soft-delete RETURNING id
  if (/SELECT COUNT\(\*\)::int FROM follow_up f WHERE f\.lead_id = ANY/.test(sql)) return { f: 3, a: 5 };  // bulkDeleteImpact
  if (/SELECT l\.id, l\.org_id, l\.branch_id, l\.owner_id, l\.paused/.test(sql)) return ctx.scoped; // scopedLeadRows
  if (/INSERT INTO lead_activity/.test(sql)) return { rows: [] };
  if (/INSERT INTO audit_log/.test(sql)) return { rows: [] };
  if (/FROM lead l WHERE .* ORDER BY l\.id LIMIT/.test(sql)) return ctx.selectIds ?? [];
  return { rows: [] };
}

function make(ctx: any) {
  ctx.calls = [];
  const q = (sql: string, params: any[] = []) => Promise.resolve(answer(sql, params, ctx));
  const client = { query: (sql: string, params: any[] = []) => Promise.resolve(answer(sql, params, ctx)) };
  const db = {
    query: (sql: string, params: any[] = []) => q(sql, params).then((r: any) => Array.isArray(r) ? r : (r?.rows ?? (r ? [r] : []))),
    one: (sql: string, params: any[] = []) => q(sql, params).then((r: any) => (Array.isArray(r) ? (r[0] ?? null) : r)),
    tx: (fn: any) => fn(client),
  } as any;
  const resolver = { buildScopeWhere: jest.fn().mockReturnValue('TRUE') } as any;
  const enforcer = { assertRefInScope: jest.fn().mockResolvedValue(undefined) } as any;
  const ingestion = {
    resolvePool: jest.fn().mockResolvedValue({ pool: [12], note: 'auto-assigned: equal round-robin' }),
    pickOwner: jest.fn().mockResolvedValue(12),
  } as any;
  const scoring = { safeRescore: jest.fn().mockResolvedValue(undefined) } as any;
  const sla = { safe: jest.fn().mockResolvedValue(undefined), onStageChanged: jest.fn() } as any;
  const svc = new LeadsService(db, resolver, enforcer, ingestion, scoring, sla);
  jest.spyOn(svc, 'get').mockResolvedValue({ id: 101 } as any);
  return { svc, db, resolver, enforcer, ingestion, scoring, sla, ctx };
}

const scope = {} as any;

describe('LeadsService.transfer (single)', () => {
  const base = () => ({ camp: { ...CAMP }, before: leadBefore(), existingSource: { id: '55' }, explicitSource: null });

  it('re-parents the path onto the target campaign and writes a transfer activity + audit (owner kept)', async () => {
    const { svc, ctx, enforcer } = make(base());
    await svc.transfer(101, { campaign_id: 5 }, 9, scope);
    // RBAC: the target campaign was scope-checked
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith(scope, 'campaign', 5, 9);
    const upd = ctx.calls.find((c: any) => /UPDATE lead SET branch_id/.test(c.sql));
    expect(upd).toBeTruthy();
    // branch=2, vertical=3, pipeline=4, campaign=5, source=55 (existing), owner kept = 11
    expect(upd.params.slice(0, 7)).toEqual([2, 3, 4, 5, 55, 70, 11]);
    const act = ctx.calls.find((c: any) => /INSERT INTO lead_activity/.test(c.sql) && /'transfer'/.test(c.sql));
    expect(act).toBeTruthy();
    const audit = ctx.calls.find((c: any) => /INSERT INTO audit_log/.test(c.sql) && /'transfer'/.test(c.sql));
    expect(audit).toBeTruthy();
  });

  it('distribute owner_mode reassigns via the target campaign pool and logs an assign', async () => {
    const { svc, ctx, ingestion } = make(base());
    await svc.transfer(101, { campaign_id: 5, owner_mode: 'distribute' }, 9, scope);
    expect(ingestion.resolvePool).toHaveBeenCalled();
    expect(ingestion.pickOwner).toHaveBeenCalled();
    const upd = ctx.calls.find((c: any) => /UPDATE lead SET branch_id/.test(c.sql));
    expect(upd.params[6]).toBe(12); // owner reassigned to the round-robin pick
    const assign = ctx.calls.find((c: any) => /INSERT INTO lead_activity/.test(c.sql) && /'assign'/.test(c.sql));
    expect(assign).toBeTruthy();
  });

  it('rejects a body branch that does not match the target campaign', async () => {
    const { svc } = make(base());
    await expect(svc.transfer(101, { campaign_id: 5, branch_id: 999 }, 9, scope)).rejects.toThrow(/do not match the target campaign/);
  });

  it('rejects an out-of-scope target campaign (RBAC)', async () => {
    const { svc, enforcer } = make(base());
    enforcer.assertRefInScope.mockRejectedValueOnce(new Error('Not Found'));
    await expect(svc.transfer(101, { campaign_id: 5 }, 9, scope)).rejects.toThrow(/Not Found/);
  });

  it('creates a manual source when the target campaign has none', async () => {
    const { svc, ctx } = make({ camp: { ...CAMP }, before: leadBefore(), existingSource: null, explicitSource: null });
    await svc.transfer(101, { campaign_id: 5 }, 9, scope);
    const ins = ctx.calls.find((c: any) => /INSERT INTO source/.test(c.sql));
    expect(ins).toBeTruthy();
    const upd = ctx.calls.find((c: any) => /UPDATE lead SET branch_id/.test(c.sql));
    expect(upd.params[4]).toBe(77); // the freshly-created source
  });
});

describe('LeadsService bulk actions', () => {
  it('bulkTransfer moves exactly the in-scope subset and reports skips', async () => {
    const ctx = { camp: { ...CAMP }, existingSource: { id: '55' }, explicitSource: null,
      scoped: [leadBefore({ id: '101' }), leadBefore({ id: '102' })], before: null };
    const { svc } = make(ctx);
    // transferOneLead reads `before` per lead — make answer() serve it by id
    const orig = ctx.scoped;
    (ctx as any).beforeById = Object.fromEntries(orig.map((r: any) => [String(r.id), r]));
    // patch answer via before: easiest is to spy transferOneLead
    const spy = jest.spyOn(svc as any, 'transferOneLead').mockResolvedValue({ id: 1 });
    const out = await svc.bulkTransfer([101, 102, 999], { campaign_id: 5 }, 9, scope);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ transferred: 2, skipped: 1, requested: 3, owner_mode: 'keep', campaign_id: 5 });
  });

  it('bulkReassign reuses update(), skips leads already owned by the target, counts correctly', async () => {
    const ctx: any = { scoped: [
      { id: '101', org_id: '1', owner_id: '11' },
      { id: '102', org_id: '1', owner_id: '12' }, // already owned by target 12 -> skip
      { id: '103', org_id: '1', owner_id: '11' },
    ] };
    const { svc, enforcer } = make(ctx);
    jest.spyOn(svc as any, 'update').mockResolvedValue({ id: 1 });
    // assertActiveUser hits db.one for the user row -> our matcher default returns {rows:[]} -> null.
    // Provide the active user row via a targeted answer:
    (ctx as any).activeUser = { id: '12' };
    jest.spyOn(svc as any, 'update');
    // stub assertActiveUser by making the "user" lookup succeed
    const dbOne = (svc as any).db.one;
    (svc as any).db.one = (sql: string, p: any[]) =>
      /FROM "user"/.test(sql) ? Promise.resolve({ id: '12', status: 'active', deleted_at: null }) : dbOne(sql, p);
    const out = await svc.bulkReassign([101, 102, 103, 900], 12, 9, scope);
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith(scope, 'user', 12, 9);
    expect(out).toMatchObject({ reassigned: 2, already: 1, skipped: 1, requested: 4, to_user_id: 12 });
  });

  it('bulkSetPaused pauses only leads not already paused, writes activity+audit, is idempotent', async () => {
    const ctx: any = { scoped: [
      { id: '101', org_id: '1', branch_id: '9', paused: false },
      { id: '102', org_id: '1', branch_id: '9', paused: true }, // already paused -> skip
    ] };
    const { svc } = make(ctx);
    const out = await svc.bulkSetPaused([101, 102, 900], true, 9, scope);
    expect(out).toMatchObject({ paused: 1, already: 1, skipped: 1, requested: 3 });
    const pauseAct = ctx.calls.find((c: any) => /INSERT INTO lead_activity/.test(c.sql) && c.params.includes('pause'));
    expect(pauseAct).toBeTruthy();
    const audit = ctx.calls.find((c: any) => /INSERT INTO audit_log/.test(c.sql));
    expect(audit).toBeTruthy();
  });

  it('bulkSetPaused(resume) writes resume activity', async () => {
    const ctx: any = { scoped: [{ id: '101', org_id: '1', branch_id: '9', paused: true }] };
    const { svc } = make(ctx);
    const out = await svc.bulkSetPaused([101], false, 9, scope);
    expect(out).toMatchObject({ resumed: 1 });
    const act = ctx.calls.find((c: any) => /INSERT INTO lead_activity/.test(c.sql) && c.params.includes('resume'));
    expect(act).toBeTruthy();
  });

  it('rejects an empty selection and a too-large one', async () => {
    const { svc } = make({ scoped: [] });
    await expect(svc.bulkSetPaused([], true, 9, scope)).rejects.toThrow(/non-empty array/);
    const big = Array.from({ length: 2001 }, (_, i) => i + 1);
    await expect(svc.bulkSetPaused(big, true, 9, scope)).rejects.toThrow(/too many leads/);
  });
});

describe('LeadsService.bulkDelete + bulkDeleteImpact', () => {
  const scoped = [
    { id: '101', org_id: '1', branch_id: '2', owner_id: '11', paused: false },
    { id: '102', org_id: '1', branch_id: '2', owner_id: '11', paused: true },
  ];

  it('soft-deletes ONLY the in-scope selected leads, writes a per-record delete audit, reports skips', async () => {
    const { svc, ctx } = make({ scoped }); // 3 requested, only 2 in scope
    const res = await svc.bulkDelete([101, 102, 999], 9, scope);
    expect(res).toMatchObject({ deleted: 2, skipped: 1, requested: 3 });
    expect(res.deleted_ids.sort()).toEqual([101, 102]);
    const dels = ctx.calls.filter((c: any) => /UPDATE lead SET deleted_at = now\(\)/.test(c.sql));
    expect(dels).toHaveLength(2);
    const audits = ctx.calls.filter((c: any) => /INSERT INTO audit_log/.test(c.sql) && /'delete'/.test(c.sql));
    expect(audits).toHaveLength(2);
  });

  it('a paused lead can still be bulk-deleted', async () => {
    const { svc } = make({ scoped: [scoped[1]] });
    const res = await svc.bulkDelete([102], 9, scope);
    expect(res.deleted).toBe(1);
  });

  it('is idempotent — an already-deleted lead (no row updated) is skipped, never fatal', async () => {
    const { svc } = make({ scoped, noDelete: true });
    const res = await svc.bulkDelete([101, 102], 9, scope);
    expect(res.deleted).toBe(0);
    expect(res.skipped).toBe(2);
  });

  it('impact preview aggregates child counts over the in-scope selection', async () => {
    const { svc } = make({ scoped });
    const rep = await svc.bulkDeleteImpact([101, 102, 999], 9, scope);
    expect(rep).toMatchObject({ requested: 3, in_scope: 2, out_of_scope: 1, total_associations: 8 });
    expect(rep.impact.find((i: any) => i.key === 'follow_ups')?.count).toBe(3);
    expect(rep.impact.find((i: any) => i.key === 'activities')?.count).toBe(5);
  });

  it('empty selection -> 400', async () => {
    const { svc } = make({ scoped: [] });
    await expect(svc.bulkDelete([], 9, scope)).rejects.toThrow(/non-empty/);
  });
});
