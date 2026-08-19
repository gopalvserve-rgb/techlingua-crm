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

/**
 * A fake db backing list()/replace(). The service now UPSERTS by (course_id, lower(code))
 * instead of delete-all-then-insert (DEF-1, dev/104), so this double models a flat course_level
 * table plus a set of `referenced` course_level ids — the enrolment_level FK — to prove a
 * referenced level is soft-removed (is_active=false) rather than hard-deleted (which would raise
 * the 23503 the client hit). `referenced` seeds the enrolment_level FK for a given level id.
 */
function build(referenced: Set<number> = new Set()) {
  const rows: any[] = []; // flat course_level rows across courses
  let seq = 1;
  const run = async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id FROM m_course')) return { rows: [{ id: params[0] }] };
    if (s.startsWith('SELECT id FROM organisation')) return { rows: [{ id: 1 }] };
    // existing rows (active + inactive) keyed by lower(code) for the upsert match
    if (s.startsWith('SELECT id, lower(code) AS lc FROM course_level')) {
      return { rows: rows.filter((r) => Number(r.course_id) === Number(params[0]))
        .map((r) => ({ id: r.id, lc: String(r.code).toLowerCase() })) };
    }
    if (s.startsWith('UPDATE course_level SET code =')) {
      const [id, code, label, fee_minor, duration, ordering] = params;
      const row = rows.find((r) => r.id === Number(id));
      Object.assign(row, { code, label, fee_minor, duration, ordering, is_active: true });
      return { rows: [{ ...row }] };
    }
    if (s.startsWith('INSERT INTO course_level')) {
      const [, course_id, code, label, fee_minor, duration, ordering] = params;
      const row = { id: seq++, course_id, code, label, fee_minor, duration, ordering, is_active: true };
      rows.push(row);
      return { rows: [row] };
    }
    if (s.startsWith('SELECT 1 FROM enrolment_level WHERE course_level_id')) {
      return { rows: referenced.has(Number(params[0])) ? [{ '?column?': 1 }] : [], rowCount: referenced.has(Number(params[0])) ? 1 : 0 };
    }
    if (s.startsWith('UPDATE course_level SET is_active = FALSE')) {
      const row = rows.find((r) => r.id === Number(params[0])); if (row) row.is_active = false; return { rows: [] };
    }
    if (s.startsWith('DELETE FROM course_level WHERE id')) {
      const i = rows.findIndex((r) => r.id === Number(params[0])); if (i >= 0) rows.splice(i, 1); return { rows: [] };
    }
    if (s.startsWith('SELECT id, course_id, code, label, fee_minor')) {
      const arr = rows.filter((r) => Number(r.course_id) === Number(params[0]) && r.is_active)
        .slice().sort((a, b) => a.ordering - b.ordering);
      return { rows: arr };
    }
    return { rows: [] };
  };
  const wrap = async (fn: (c: any) => Promise<any>) => fn({ query: async (sql: string, params: any[] = []) => run(sql, params) });
  const db = {
    query: async (sql: string, params: any[] = []) => (await run(sql, params)).rows,
    one: async (sql: string, params: any[] = []) => (await run(sql, params)).rows[0] ?? null,
    tx: wrap,
  } as unknown as DatabaseService;
  return { svc: new CourseLevelsService(db), rows };
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

  // DEF-1 (dev/104): editing a course that already has levels must NOT delete-all — matched codes
  // are UPDATED in place (id preserved so the enrolment_level FK stays valid) and new codes added.
  it('editing an existing 3-level course keeps ids stable and adds B2 (upsert, not delete-all)', async () => {
    const { svc, rows } = build();
    await svc.replace(4, [{ code: 'A1', fee: 10000 }, { code: 'A2', fee: 12000 }, { code: 'B1', fee: 15000 }]);
    const idBefore = new Map(rows.map((r: any) => [r.code, r.id]));
    // add B2 while keeping the original three — the very edit that used to 400
    const saved = await svc.replace(4, [
      { code: 'A1', fee: 10000 }, { code: 'A2', fee: 12000 }, { code: 'B1', fee: 15000 }, { code: 'B2', fee: 18000 },
    ]);
    const list = await svc.list(4);
    expect(list.map((r: any) => r.code)).toEqual(['A1', 'A2', 'B1', 'B2']);
    // the three originals kept their ids (no delete+reinsert → the enrolment_level FK survives)
    for (const code of ['A1', 'A2', 'B1']) {
      expect(list.find((r: any) => r.code === code)!.id).toBe(idBefore.get(code));
    }
    expect(saved.find((r: any) => r.code === 'B2').fee_minor).toBe(1800000);
  });

  // A level that an enrolment already references is SOFT-removed (is_active=false), never hard-
  // deleted — so the DB never raises the foreign-key violation the client saw as HTTP 400.
  it('a referenced level removed from the form is soft-removed, not hard-deleted', async () => {
    const referenced = new Set<number>();
    const { svc, rows } = build(referenced);
    await svc.replace(5, [{ code: 'A1', fee: 10000 }, { code: 'A2', fee: 12000 }]);
    const a1 = rows.find((r: any) => r.code === 'A1');
    referenced.add(a1.id); // an enrolment now uses A1
    // drop A1 from the form → it must survive (inactive), not error, and A2 stays active
    await svc.replace(5, [{ code: 'A2', fee: 12000 }]);
    expect((await svc.list(5)).map((r: any) => r.code)).toEqual(['A2']); // list shows active only
    expect(rows.find((r: any) => r.id === a1.id).is_active).toBe(false); // row + its FK preserved
  });
});
