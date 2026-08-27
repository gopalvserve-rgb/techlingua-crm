import 'reflect-metadata';
import { BatchService, BATCH_STATUS_CODES, BATCH_MANUAL_STATUSES } from './batch.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * 27aug Batch C item 2 (On Hold) + item 3 (optional Course Level on a batch).
 */
const scopeAll: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

function make(opts: { batchRow?: any } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM vertical WHERE id/.test(sql)) return { id: 3 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 4 };
      if (/FROM batch_status_def WHERE code/.test(sql)) {
        const code = String(params[0]);
        return BATCH_STATUS_CODES.includes(code as any)
          ? { code, label: code, meaning: 'x', is_manual: BATCH_MANUAL_STATUSES.has(code), is_terminal: false } : null;
      }
      if (/FROM batch bt/.test(sql)) return opts.batchRow ?? null;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 55 }] }; } }),
  } as any;
  return { svc: new BatchService(db, resolver, { queue: async () => ({}) } as any), issued };
}

describe('Batch "On Hold" (item 2)', () => {
  it('on_hold is a known, MANUAL lifecycle code', () => {
    expect((BATCH_STATUS_CODES as readonly string[]).includes('on_hold')).toBe(true);
    expect(BATCH_MANUAL_STATUSES.has('on_hold')).toBe(true);
  });

  it('changeStatus to on_hold pins it as manual', async () => {
    const { svc } = make({ batchRow: { id: 55, status: 'active', status_is_manual: false, start_date: null, end_date: null, branch_id: 2, vertical_id: 3 } });
    const res: any = await svc.changeStatus(55, { to_status: 'on_hold' }, { id: 9 }, scopeAll);
    expect(res.status).toBe('on_hold');
    expect(res.status_is_manual).toBe(true);
  });

  it('the list status filter accepts on_hold', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { status: 'on_hold' });
    const listSql = issued.filter((q) => /FROM batch bt/.test(q.sql)).pop()!;
    expect(listSql.params).toContainEqual(['on_hold']);
  });
});

describe('Batch course levels (item 3)', () => {
  it('create with level_ids writes batch_level rows', async () => {
    const { svc, issued } = make();
    await svc.create({ branch_id: 2, vertical_id: 3, course_id: 4, name: 'IELTS A1', level_ids: [55] }, { id: 9 }, scopeAll);
    expect(issued.some((q) => /INSERT INTO batch_level/.test(q.sql))).toBe(true);
  });
});
