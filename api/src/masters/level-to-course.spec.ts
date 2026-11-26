/**
 * FB-2026-014 (client's 15 Nov feedback document, point 4) — "if we create any level from master by
 * selecting course then level should be shown in course management in same course."
 */
import { MastersService } from './masters.service';
import { DatabaseService } from '../database/database.service';

function fakeDb(saved: Record<string, unknown>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async () => ({ id: '1' }),
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/INSERT INTO m_level|UPDATE m_level/.test(sql)) return [{ id: 9, ...saved }];
      if (/INSERT INTO course_level/.test(sql)) return (params[0] as number[]).map((_, i) => ({ id: 100 + i }));
      return [];
    },
  } as unknown as DatabaseService;
  const levelInserts = () => calls.filter((c) => c.sql.includes('INSERT INTO course_level'));
  return { db, calls, levelInserts };
}

describe('a Level saved in Masters with courses picked appears in those courses (FB-2026-014)', () => {
  it('create: the level is added to every picked course, with its fee (in paise) and duration', async () => {
    const saved = { name: 'French C2', is_active: true, meta: { course_ids: [55, 58], fee: 31500, duration: '3 Months' } };
    const { db, levelInserts } = fakeDb(saved);
    await new MastersService(db).create('level', { name: 'French C2', meta: saved.meta } as any, 1);
    expect(levelInserts()).toHaveLength(1);
    expect(levelInserts()[0].params).toEqual([[55, 58], 'French C2', 3150000, '3 Months']);
  });

  it('never overwrites: a course that already has the level keeps its own row and fee', async () => {
    const saved = { name: 'French A1', is_active: true, meta: { course_ids: [55], fee: 10000 } };
    const { db, levelInserts } = fakeDb(saved);
    await new MastersService(db).create('level', { name: 'French A1', meta: saved.meta } as any, 1);
    expect(levelInserts()[0].sql).toContain('NOT EXISTS (SELECT 1 FROM course_level cl WHERE cl.course_id = c.id AND lower(cl.code) = lower($2))');
    expect(levelInserts()[0].sql).not.toMatch(/UPDATE course_level|DELETE FROM course_level/);
  });

  it('edit: picking a course on an existing level adds it there too (older single course_id also counts)', async () => {
    const saved = { name: 'Power BI', is_active: true, meta: { course_id: 58 } };
    const { db, levelInserts } = fakeDb(saved);
    await new MastersService(db).update('level', 40, { meta: saved.meta } as any);
    expect(levelInserts()[0].params).toEqual([[58], 'Power BI', 0, null]);
  });

  it('no course picked, an inactive level, or another master: nothing is added to any course', async () => {
    for (const [type, saved] of [
      ['level', { name: 'B1', is_active: true, meta: {} }],
      ['level', { name: 'B1', is_active: false, meta: { course_ids: [55] } }],
      ['course_type', { name: 'Diploma', is_active: true, meta: { course_ids: [55] } }],
    ] as const) {
      const { db, levelInserts } = fakeDb(saved as any);
      await new MastersService(db).create(type, { name: (saved as any).name, meta: (saved as any).meta } as any, 1);
      expect(levelInserts()).toHaveLength(0);
    }
  });
});
