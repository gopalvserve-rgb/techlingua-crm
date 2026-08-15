import 'reflect-metadata';
import { BatchService, normaliseDeliveryMode, BATCH_DELIVERY_MODES } from './batch.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * BATCH DELIVERY MODE + DESCRIPTION (migration 083) + the 8-filter batch list (client feedback #10/#11).
 * Verifies create/update persist delivery_mode + description, and that each new list filter
 * (course / trainer / owner / batch_type / delivery_mode) genuinely narrows the query.
 */

const scopeAll: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

function make() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM vertical/.test(sql)) return { id: 4 };
      if (/FROM m_course/.test(sql)) return { id: 5 };
      if (/FROM organisation/.test(sql)) return { id: 1 };
      // update() calls get() first -> return a current row
      if (/FROM batch bt/.test(sql)) return { id: 55, branch_id: 3, vertical_id: 4, course_id: 5, frequency: 'custom', class_days: [] };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 55 }] }; },
    }),
  } as any;
  return { svc: new BatchService(db, resolver), issued };
}

const me = { id: 9 };
const dto = (over: any = {}) => ({ branch_id: 3, vertical_id: 4, course_id: 5, name: 'ZZTEST', ...over });
const listSel = (issued: Array<{ sql: string; params: unknown[] }>) =>
  issued.find((i) => /FROM batch bt/.test(i.sql) && /ORDER BY/.test(i.sql))!;

describe('normaliseDeliveryMode', () => {
  it('keeps a valid value, falls back to Offline otherwise', () => {
    expect(normaliseDeliveryMode('Online')).toBe('Online');
    expect(normaliseDeliveryMode('Hybrid')).toBe('Hybrid');
    expect(normaliseDeliveryMode('banana')).toBe('Offline');
    expect(normaliseDeliveryMode(undefined)).toBe('Offline');
    expect(BATCH_DELIVERY_MODES.length).toBe(3);
  });
});

describe('BatchService.create — persists delivery_mode + description', () => {
  it('stores an explicit Hybrid delivery mode + description', async () => {
    const { svc, issued } = make();
    await svc.create(dto({ delivery_mode: 'Hybrid', description: '  weekend crash  ' }), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql))!;
    expect(ins.sql).toMatch(/delivery_mode, description/);
    expect(ins.params).toEqual(expect.arrayContaining(['Hybrid', 'weekend crash']));
  });
  it('an online batch_type with no explicit delivery mode defaults to Online', async () => {
    const { svc, issued } = make();
    await svc.create(dto({ batch_type: 'online' }), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql))!;
    expect(ins.params).toEqual(expect.arrayContaining(['Online']));
  });
  it('default delivery mode is Offline, description null', async () => {
    const { svc, issued } = make();
    await svc.create(dto(), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql))!;
    expect(ins.params).toEqual(expect.arrayContaining(['Offline', null]));
  });
});

describe('BatchService.update — persists delivery_mode + description', () => {
  it('sets delivery_mode + description on the UPDATE', async () => {
    const { svc, issued } = make();
    await svc.update(55, { delivery_mode: 'Online', description: 'note' }, me, scopeAll);
    const upd = issued.find((i) => /UPDATE batch SET/.test(i.sql) && /delivery_mode/.test(i.sql))!;
    expect(upd).toBeTruthy();
    expect(upd.params).toEqual(expect.arrayContaining(['Online', 'note']));
  });
});

describe('BatchService.list — the 8 filters each narrow', () => {
  it('course_id → bt.course_id = ANY', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { course_id: '5,7' });
    expect(listSel(issued).sql).toMatch(/bt\.course_id = ANY\(\$\d+::bigint\[\]\)/);
  });
  it('trainer_id → bt.trainer_id = ANY', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { trainer_id: '12' });
    expect(listSel(issued).sql).toMatch(/bt\.trainer_id = ANY\(\$\d+::bigint\[\]\)/);
  });
  it('owner_id → bt.created_by = ANY', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { owner_id: '9' });
    expect(listSel(issued).sql).toMatch(/bt\.created_by = ANY\(\$\d+::bigint\[\]\)/);
  });
  it('batch_type → bt.batch_type = ANY (only valid codes; banana dropped)', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { batch_type: 'weekend,online,banana' });
    const sel = listSel(issued);
    expect(sel.sql).toMatch(/bt\.batch_type = ANY\(\$\d+::varchar\[\]\)/);
    expect(sel.params.some((p) => Array.isArray(p) && (p as string[]).length === 2
      && (p as string[]).includes('weekend') && (p as string[]).includes('online'))).toBe(true);
  });
  it('delivery_mode → bt.delivery_mode = ANY (only Offline/Online/Hybrid)', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { delivery_mode: 'Online,Hybrid,banana' });
    const sel = listSel(issued);
    expect(sel.sql).toMatch(/bt\.delivery_mode = ANY\(\$\d+::varchar\[\]\)/);
    expect(sel.params.some((p) => Array.isArray(p) && (p as string[]).length === 2
      && (p as string[]).includes('Online') && (p as string[]).includes('Hybrid'))).toBe(true);
  });
  it('no filters → none of the new predicates are added', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, {});
    const sql = listSel(issued).sql;
    expect(sql).not.toMatch(/bt\.trainer_id = ANY/);
    expect(sql).not.toMatch(/bt\.batch_type = ANY/);
    expect(sql).not.toMatch(/bt\.delivery_mode = ANY/);
  });
  it('list SELECT returns delivery_mode, description + owner_name', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, {});
    const sql = listSel(issued).sql;
    expect(sql).toMatch(/bt\.delivery_mode/);
    expect(sql).toMatch(/bt\.description/);
    expect(sql).toMatch(/cu\.name AS owner_name/);
  });
});
