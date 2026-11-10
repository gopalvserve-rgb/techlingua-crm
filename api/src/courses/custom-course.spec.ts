import { resolveCustomCourse } from './custom-course';

/** client 5 Nov (3) — "Course field should be custom also". */
describe('resolveCustomCourse', () => {
  const makeDb = (existing: Array<{ id: number; name: string; b: string; v: string }> = []) => {
    const inserted: any[] = [];
    const db = {
      one: async (sql: string, p: any[] = []) => {
        if (/FROM organisation/.test(sql)) return { id: '1' };
        if (/SELECT id FROM m_course/.test(sql)) {
          const hit = existing.find((c) => c.name.toLowerCase() === String(p[1]).toLowerCase() && c.b === p[2] && c.v === p[3]);
          return hit ? { id: String(hit.id) } : null;
        }
        if (/INSERT INTO m_course/.test(sql)) { inserted.push({ org: p[0], name: p[1], meta: JSON.parse(p[2]), by: p[3] }); return { id: '900' }; }
        throw new Error('unexpected ' + sql);
      },
    };
    return { db, inserted };
  };
  const ctx = { org_id: 1, branch_id: 40, vertical_id: 38, fee_minor: 1550000, actor_id: 7 };

  it('a chosen course id wins — nothing is created', async () => {
    const { db, inserted } = makeDb();
    expect(await resolveCustomCourse(db, { course_id: 55, custom_course_name: 'X' }, ctx)).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('a typed name becomes a Courses-master row under the Branch › Vertical with its fee', async () => {
    const { db, inserted } = makeDb();
    expect(await resolveCustomCourse(db, { course_id: '__custom', custom_course_name: '  Korean   Weekend Batch ' }, ctx)).toBe(900);
    expect(inserted).toEqual([{ org: 1, name: 'Korean Weekend Batch', meta: { branch_id: 40, vertical_id: 38, fee: '15500', custom: true }, by: 7 }]);
  });

  it('the same name in the same vertical reuses the course (case-insensitive), never a twin', async () => {
    const { db, inserted } = makeDb([{ id: 61, name: 'Korean Weekend Batch', b: '40', v: '38' }]);
    expect(await resolveCustomCourse(db, { custom_course_name: 'korean weekend batch' }, ctx)).toBe(61);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a one-letter or over-long name, and needs the vertical', async () => {
    const { db } = makeDb();
    await expect(resolveCustomCourse(db, { custom_course_name: 'K' }, ctx)).rejects.toThrow(/Type the custom course name/);
    await expect(resolveCustomCourse(db, { custom_course_name: 'x'.repeat(121) }, ctx)).rejects.toThrow(/too long/);
    await expect(resolveCustomCourse(db, { custom_course_name: 'Korean' }, { ...ctx, vertical_id: null })).rejects.toThrow(/vertical/);
  });

  it('no name and no id: nothing to do', async () => {
    const { db } = makeDb();
    expect(await resolveCustomCourse(db, {}, ctx)).toBeNull();
  });
});
