import * as fs from 'fs';
import * as path from 'path';
import { MastersService, MASTER_TYPES } from './masters.service';
import { DatabaseService } from '../database/database.service';

/**
 * dev/106 — Course Type is a self-manageable generic master (m_course_type). These tests pin:
 *  1. it's registered in the shared masters framework (so /api/masters/course_type + MastersAdmin work),
 *  2. POST /api/masters/course_type inserts into m_course_type and the value then appears in the list,
 *  3. migration 095 seeds the original 6 catalog values (nothing lost),
 *  4. a course saved with a (custom) course_type persists it in meta and the Course list filters on it.
 */

// A tiny fake db that records rows per table so create->list round-trips through m_course_type.
function fakeDb() {
  const store: Record<string, any[]> = {};
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let seq = 1;
  const db = {
    one: async () => ({ id: '1' }),
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      const mIns = s.match(/INSERT INTO (\w+)/);
      if (mIns) {
        const table = mIns[1];
        const row = { id: seq++, name: params[1], code: params[2], sort_order: params[3] ?? 0, is_active: true, meta: {} };
        (store[table] ||= []).push(row);
        return [row];
      }
      const mSel = s.match(/FROM (\w+) m/);
      if (mSel) return store[mSel[1]] ?? [];
      if (s.includes('organisation')) return [{ id: '1' }];
      return [];
    },
  } as unknown as DatabaseService;
  return { db, calls, store };
}

describe('Course Type master (dev/106)', () => {
  it('is registered in the shared masters framework -> m_course_type', () => {
    expect(MASTER_TYPES.course_type).toBeDefined();
    expect(MASTER_TYPES.course_type.table).toBe('m_course_type');
    // types() drives the MastersAdmin sidebar — Course Type must be selectable there.
    const svc = new MastersService(fakeDb().db);
    expect(svc.types().some((t) => t.type === 'course_type' && t.label === 'Course Types')).toBe(true);
  });

  it('POST create then list round-trips through m_course_type', async () => {
    const { db } = fakeDb();
    const svc = new MastersService(db);
    const created = await svc.create('course_type', { name: 'ZZTEST Advanced Cert', code: 'ZZADV' }, 1);
    expect(created.name).toBe('ZZTEST Advanced Cert');
    const list = await svc.list('course_type', false);
    expect(list.map((r: any) => r.name)).toContain('ZZTEST Advanced Cert');
  });

  it('migration 095 seeds the original 6 catalog values (nothing lost)', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/095_course_type_master.sql'), 'utf8');
    for (const v of ['Diploma', 'Certificate', 'Foundation', 'Crash Course', 'Advanced Diploma', 'Workshop']) {
      expect(sql).toContain(`'${v}'`);
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS m_course_type');
  });

  it('a course saved with a custom course_type persists it in meta and the list filters on it', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return sql.includes('organisation') ? [{ id: '1' }] : [{ id: 1 }]; },
      one: async () => ({ id: '1' }),
    } as unknown as DatabaseService;
    const svc = new MastersService(db);
    // persist
    await svc.create('course', { name: 'ZZ Course', code: 'ZZC', meta: { course_type: 'ZZTEST Advanced Cert' } }, 1);
    const ins = calls.find((c) => c.sql.includes('INSERT INTO'))!;
    const metaJson = ins.params.find((x) => typeof x === 'string' && x.includes('course_type')) as string;
    expect(JSON.parse(metaJson)).toMatchObject({ course_type: 'ZZTEST Advanced Cert' });
    // filter
    calls.length = 0;
    await svc.list('course', false, { courseTypes: ['ZZTEST Advanced Cert'] });
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain("m.meta->>'course_type' IN (");
    expect(calls[0].params).toContain('ZZTEST Advanced Cert');
  });
});
