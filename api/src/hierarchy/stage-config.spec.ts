import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';

/**
 * Pipeline Stage Configurator (client mockup, 2026-07-11):
 * insert-at-position reindexing, per-stage tags, single-default invariant,
 * guarded hard delete (409 while leads sit in the stage) and full reorder.
 * DB is mocked; each test asserts the exact SQL/param behaviour.
 */

type Call = { sql: string; params: unknown[] };

function mkDb() {
  const calls: Call[] = [];
  const handlers: Array<(sql: string, params: unknown[]) => unknown[] | null> = [];
  const exec = (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    for (const h of handlers) {
      const r = h(flat, params);
      if (r) return r;
    }
    return [] as unknown[];
  };
  return {
    calls,
    on: (h: (sql: string, params: unknown[]) => unknown[] | null) => handlers.push(h),
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => (exec(sql, params) as any[])[0] ?? null,
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string, params: unknown[] = []) => ({ rows: exec(sql, params) }) }),
  };
}

const mkSvc = () => {
  const db = mkDb();
  const svc = new HierarchyService(db as any, {} as any, {} as any);
  return { db, svc };
};

describe('stage configurator — insert at position', () => {
  it('inserts after a middle stage: later stages shift +1, new stage lands at after.sort_order+1', async () => {
    const { db, svc } = mkSvc();
    db.on((sql, p) => (sql.startsWith('SELECT pipeline_id, sort_order') && Number(p[0]) === 22
      ? [{ pipeline_id: '7', sort_order: 1 }] : null));
    db.on((sql) => (sql.startsWith('INSERT INTO pipeline_stage') ? [{ id: '99', sort_order: 2, name: 'Visited' }] : null));
    const row: any = await svc.createStage(7, { name: ' Visited ', after_stage_id: 22, tags: ['Warm'] }, 1);
    expect(row.id).toBe('99');
    const shift = db.calls.find((c) => c.sql.includes('sort_order = sort_order + 1'));
    expect(shift).toBeDefined();
    expect(shift!.params).toEqual([7, 2]); // pipeline 7, everything >= 2 shifts
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO pipeline_stage'));
    expect(ins!.params.slice(0, 3)).toEqual([7, 'Visited', 2]); // trimmed name at position 2
    expect(ins!.params[5]).toBe(JSON.stringify(['Warm']));
  });

  it('after_stage_id null inserts at the head (sort 0, all stages shift)', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('INSERT INTO pipeline_stage') ? [{ id: '100', sort_order: 0 }] : null));
    await svc.createStage(7, { name: 'Enquiry', after_stage_id: null }, 1);
    const shift = db.calls.find((c) => c.sql.includes('sort_order = sort_order + 1'));
    expect(shift!.params).toEqual([7, 0]);
  });

  it('after_stage_id from another pipeline -> 400, nothing written', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('SELECT pipeline_id, sort_order') ? [{ pipeline_id: '8', sort_order: 0 }] : null));
    await expect(svc.createStage(7, { name: 'X', after_stage_id: 5 }, 1)).rejects.toThrow(BadRequestException);
    expect(db.calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });

  it('without after_stage_id it appends (single INSERT via MAX+1 subquery, no shift)', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('INSERT INTO pipeline_stage') ? [{ id: '101' }] : null));
    await svc.createStage(7, { name: 'Demo Done' }, 1);
    expect(db.calls.some((c) => c.sql.includes('sort_order = sort_order + 1'))).toBe(false);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO pipeline_stage'));
    expect(ins!.sql).toContain('COALESCE(MAX(sort_order),-1)+1');
    expect(ins!.params[5]).toBe(JSON.stringify([])); // tags default []
  });
});

describe('stage configurator — tags', () => {
  it('normalizes tags: trims, drops empties, dedupes case-insensitively', () => {
    expect(HierarchyService.normalizeTags([' Hot ', 'hot', '', 'Warm'])).toEqual(['Hot', 'Warm']);
    expect(HierarchyService.normalizeTags(undefined)).toEqual([]);
  });

  it('rejects non-array / non-string / oversized tags', () => {
    expect(() => HierarchyService.normalizeTags('Hot' as any)).toThrow(BadRequestException);
    expect(() => HierarchyService.normalizeTags([1] as any)).toThrow(BadRequestException);
    expect(() => HierarchyService.normalizeTags(['x'.repeat(41)])).toThrow(BadRequestException);
    expect(() => HierarchyService.normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(BadRequestException);
  });

  it('PATCH roundtrips tags through the update (JSONB param)', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('UPDATE pipeline_stage SET tags') ? [{ id: '5', tags: ['Cold', 'Warm', 'Hot'] }] : null));
    const row: any = await svc.updateStage(5, { tags: ['Cold', 'Warm', 'Hot'] });
    expect(row.tags).toEqual(['Cold', 'Warm', 'Hot']);
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE pipeline_stage SET tags'));
    expect(upd!.params[0]).toBe(JSON.stringify(['Cold', 'Warm', 'Hot']));
  });

  it('PATCH with invalid stage_type -> 400', async () => {
    const { svc } = mkSvc();
    await expect(svc.updateStage(5, { stage_type: 'closed' })).rejects.toThrow(BadRequestException);
  });

  it('PATCH is_default=true clears the previous default of the same pipeline first', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('SELECT pipeline_id FROM pipeline_stage') ? [{ pipeline_id: '7' }] : null));
    db.on((sql) => (sql.startsWith('UPDATE pipeline_stage SET is_default') && sql.includes('name') === false && sql.includes('id <>')
      ? [] : null));
    db.on((sql) => (sql.includes('WHERE id = $') && sql.startsWith('UPDATE pipeline_stage SET is_default = $1')
      ? [{ id: '5', is_default: true }] : null));
    await svc.updateStage(5, { is_default: true });
    const clear = db.calls.find((c) => c.sql.includes('is_default = FALSE') && c.sql.includes('id <> $2'));
    expect(clear).toBeDefined();
    expect(clear!.params).toEqual([7, 5]);
  });
});

describe('stage configurator — delete guard + reorder', () => {
  it('delete blocked with 409 while leads reference the stage (clear message)', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('SELECT id, pipeline_id, name, sort_order') ? [{ id: '9', pipeline_id: '7', name: 'Visited', sort_order: 3 }] : null));
    db.on((sql) => (sql.includes('COUNT(*)::int AS ct FROM lead') ? [{ ct: 4 }] : null));
    await expect(svc.deleteStage(9)).rejects.toThrow(ConflictException);
    await expect(svc.deleteStage(9)).rejects.toThrow(/Visited.*4 lead\(s\).*Inactive instead/s);
    expect(db.calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
  });

  it('delete of an unreferenced stage deletes and compacts later sort_orders (-1)', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('SELECT id, pipeline_id, name, sort_order') ? [{ id: '9', pipeline_id: '7', name: 'Visited', sort_order: 3 }] : null));
    db.on((sql) => (sql.includes('COUNT(*)::int AS ct FROM lead') ? [{ ct: 0 }] : null));
    const out: any = await svc.deleteStage(9);
    expect(out).toEqual({ deleted: true, id: 9, name: 'Visited' });
    const del = db.calls.find((c) => c.sql.startsWith('DELETE FROM pipeline_stage'));
    expect(del!.params).toEqual([9]);
    const compact = db.calls.find((c) => c.sql.includes('sort_order = sort_order - 1'));
    expect(compact!.params).toEqual([7, 3]);
  });

  it('delete of a missing stage -> 404', async () => {
    const { svc } = mkSvc();
    await expect(svc.deleteStage(12345)).rejects.toThrow(NotFoundException);
  });

  it('reorder validates the permutation and rewrites sort_order by array index', async () => {
    const { db, svc } = mkSvc();
    db.on((sql) => (sql.startsWith('SELECT id FROM pipeline_stage') ? [{ id: '1' }, { id: '2' }, { id: '3' }] : null));
    db.on((sql) => (sql.startsWith('SELECT * FROM pipeline_stage') ? [{ id: '3' }, { id: '1' }, { id: '2' }] : null));
    await svc.reorderStages(7, [3, 1, 2]);
    const ups = db.calls.filter((c) => c.sql.includes('SET sort_order = $1'));
    expect(ups.map((c) => c.params)).toEqual([[0, 3], [1, 1], [2, 2]]);
    await expect(svc.reorderStages(7, [3, 1])).rejects.toThrow(BadRequestException);
    await expect(svc.reorderStages(7, 'nope')).rejects.toThrow(BadRequestException);
  });
});
