import * as fs from 'fs';
import * as path from 'path';
import { MastersService, MASTER_TYPES } from './masters.service';
import { CoursesService } from '../courses/courses.service';
import { DatabaseService } from '../database/database.service';

/**
 * dev/114 — Level is a self-manageable generic master (m_level). These tests pin:
 *  1. it's registered in the shared masters framework (so /api/masters/level + MastersAdmin work),
 *  2. POST /api/masters/level inserts into m_level and the value then appears in the list,
 *  3. GET /courses/level-catalog is now a back-compat alias reading the m_level master,
 *  4. migration 097 seeds the original catalog values (A1..C2 + the generic ladder) — nothing lost.
 */

// A tiny fake db that records rows per table so create->list round-trips through m_level.
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

describe('Level master (dev/114)', () => {
  it('is registered in the shared masters framework -> m_level', () => {
    expect(MASTER_TYPES.level).toBeDefined();
    expect(MASTER_TYPES.level.table).toBe('m_level');
    // types() drives the MastersAdmin sidebar — Level must be selectable there.
    const svc = new MastersService(fakeDb().db);
    expect(svc.types().some((t) => t.type === 'level' && t.label === 'Levels')).toBe(true);
  });

  it('POST create then list round-trips through m_level', async () => {
    const { db } = fakeDb();
    const svc = new MastersService(db);
    const created = await svc.create('level', { name: 'ZZTEST Level', code: 'ZZLV' }, 1);
    expect(created.name).toBe('ZZTEST Level');
    const list = await svc.list('level', false);
    expect(list.map((r: any) => r.name)).toContain('ZZTEST Level');
  });

  it('level-catalog is a back-compat alias reading the m_level master', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql.replace(/\s+/g, ' ').trim());
        return [{ code: 'A1', label: 'A1', ordering: 10 }, { code: 'A2', label: 'A2', ordering: 20 }];
      },
    } as unknown as DatabaseService;
    const out = await new CoursesService(db).levelCatalog();
    expect(calls[0]).toContain('FROM m_level');
    expect(out.map((r: any) => r.code)).toEqual(['A1', 'A2']);
  });

  it('migration 097 seeds the original catalog values (nothing lost)', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/097_level_master.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS m_level');
    // seeds by selecting from the course_level_def catalog (A1..C2 + the generic ladder)
    expect(sql).toContain('FROM course_level_def');
    // name == code == label kept for course_level.code / meta->>'level' back-compat
    expect(sql).toContain("meta->>'level'");
  });
});
