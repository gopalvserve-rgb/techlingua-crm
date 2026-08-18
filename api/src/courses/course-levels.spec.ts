import { CourseLevelsService, normaliseLevels } from './course-levels.service';
import { DatabaseService } from '../database/database.service';
import { BadRequestException } from '@nestjs/common';

/**
 * COURSE LEVELS (enrollment re-model, batch 1). Proves:
 *   - creating a course with 3 levels persists all with their per-level fees (paise);
 *   - updating replaces the set (add/remove a level);
 *   - a course with NO levels stores nothing (keeps its Standard Fee, meta.fee);
 *   - levels read back per course in order;
 *   - validation: non-empty + unique codes, fee >= 0; rupees→paise conversion.
 */

/** A fake db that records INSERTed level rows against a course, backing list()/replace(). */
function build() {
  const store = new Map<number, any[]>(); // course_id -> rows
  let seq = 1;
  const run = async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id FROM m_course')) return { rows: [{ id: params[0] }] };
    if (s.startsWith('SELECT id FROM organisation')) return { rows: [{ id: 1 }] };
    if (s.startsWith('DELETE FROM course_level')) { store.set(Number(params[0]), []); return { rows: [] }; }
    if (s.startsWith('INSERT INTO course_level')) {
      const [, course_id, code, label, fee_minor, duration, ordering] = params;
      const row = { id: seq++, course_id, code, label, fee_minor, duration, ordering, is_active: true };
      const arr = store.get(Number(course_id)) ?? []; arr.push(row); store.set(Number(course_id), arr);
      return { rows: [row] };
    }
    if (s.startsWith('SELECT id, course_id, code, label, fee_minor')) {
      const arr = (store.get(Number(params[0])) ?? []).slice().sort((a, b) => a.ordering - b.ordering);
      return { rows: arr };
    }
    return { rows: [] };
  };
  const db = {
    query: async (sql: string, params: any[] = []) => (await run(sql, params)).rows,
    one: async (sql: string, params: any[] = []) => (await run(sql, params)).rows[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => fn({ query: run }),
  } as unknown as DatabaseService;
  return { svc: new CourseLevelsService(db), store };
}

describe('normaliseLevels', () => {
  it('accepts rupee fees and converts to paise, defaults label to code', () => {
    const out = normaliseLevels([{ code: 'A1', fee: 10000 }, { code: 'A2', fee: '12000' }]);
    expect(out).toEqual([
      { code: 'A1', label: 'A1', fee_minor: 1000000, duration: null, ordering: 0 },
      { code: 'A2', label: 'A2', fee_minor: 1200000, duration: null, ordering: 1 },
    ]);
  });
  it('accepts fee_minor directly', () => {
    expect(normaliseLevels([{ code: 'B1', fee_minor: 1500000 }])[0].fee_minor).toBe(1500000);
  });
  it('rejects empty codes', () => {
    expect(() => normaliseLevels([{ code: '  ', fee: 10 }])).toThrow(BadRequestException);
  });
  it('rejects duplicate codes (case-insensitive)', () => {
    expect(() => normaliseLevels([{ code: 'A1', fee: 1 }, { code: 'a1', fee: 2 }])).toThrow(BadRequestException);
  });
  it('rejects negative fees', () => {
    expect(() => normaliseLevels([{ code: 'A1', fee_minor: -5 }])).toThrow(BadRequestException);
  });
  it('empty / null input → no levels (no-level course keeps its Standard Fee)', () => {
    expect(normaliseLevels(null)).toEqual([]);
    expect(normaliseLevels([])).toEqual([]);
  });
});

describe('CourseLevelsService', () => {
  it('creating a course with 3 levels persists all with per-level fees, readable in order', async () => {
    const { svc } = build();
    await svc.replace(7, [
      { code: 'A1', fee: 10000, ordering: 0 },
      { code: 'A2', fee: 12000, ordering: 1 },
      { code: 'B1', fee: 15000, ordering: 2 },
    ]);
    const rows = await svc.list(7);
    expect(rows.map((r: any) => [r.code, r.fee_minor])).toEqual([
      ['A1', 1000000], ['A2', 1200000], ['B1', 1500000],
    ]);
  });

  it('updating replaces the set — add one, remove one', async () => {
    const { svc } = build();
    await svc.replace(7, [{ code: 'A1', fee: 10000 }, { code: 'A2', fee: 12000 }]);
    await svc.replace(7, [{ code: 'A2', fee: 12000 }, { code: 'B1', fee: 15000 }]);
    const rows = await svc.list(7);
    expect(rows.map((r: any) => r.code)).toEqual(['A2', 'B1']);
  });

  it('a no-level course stores zero levels', async () => {
    const { svc } = build();
    await svc.replace(9, []);
    expect(await svc.list(9)).toEqual([]);
  });
});
