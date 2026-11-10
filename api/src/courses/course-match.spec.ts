import { buildCourseKeyMap, courseAliases, lookupCourse, normCourseKey, rematchLeadCourses } from './course-match';

/** Client 10 Nov 2026 (point 2) — Facebook / import course text links to the Course master. */
describe('course matching', () => {
  const courses = [
    { id: 55, name: 'French Language', code: 'FR001', meta: { branch_id: 40, vertical_id: 38, aliases: ['french', 'Francais'] } },
    { id: 60, name: 'Russian Diploma', code: 'RU01', meta: { branch_id: 41, vertical_id: 39, aliases: 'russian, russian_language' } },
    { id: 70, name: 'BCA', code: 'BCA1', meta: {} }, // unpinned — eligible everywhere
    { id: 71, name: 'BCA', code: 'BCA-41', meta: { branch_id: 41, vertical_id: 39 } }, // pinned — wins in 41/39
  ];

  it('normalises separators and case', () => {
    expect(normCourseKey('French_Language?')).toBe('french language');
    expect(normCourseKey('  german-language ')).toBe('german language');
  });

  it('reads custom names from an array or a comma list', () => {
    expect(courseAliases({ aliases: ['a', ' b ', 'a', ''] })).toEqual(['a', 'b']);
    expect(courseAliases({ aliases: 'x, y\nz' })).toEqual(['x', 'y', 'z']);
    expect(courseAliases(null)).toEqual([]);
  });

  it('matches "french_language" to French Language without any custom name', () => {
    const m = buildCourseKeyMap(courses, 40, 38);
    expect(lookupCourse(m, 'french_language')).toBe(55);
    expect(lookupCourse(m, 'FR001')).toBe(55);
    expect(lookupCourse(m, 'Francais')).toBe(55); // custom name
  });

  it('respects branch / vertical pinning and prefers the pinned course', () => {
    expect(lookupCourse(buildCourseKeyMap(courses, 40, 38), 'russian')).toBeNull(); // pinned elsewhere
    expect(lookupCourse(buildCourseKeyMap(courses, 41, 39), 'russian_language')).toBe(60);
    expect(lookupCourse(buildCourseKeyMap(courses, 41, 39), 'bca')).toBe(71);
    expect(lookupCourse(buildCourseKeyMap(courses, 40, 38), 'bca')).toBe(70);
  });

  it('rematchLeadCourses links only unlinked leads it can match', async () => {
    const updates: unknown[][] = [];
    const db = {
      query: jest.fn(async (sql: string, p: unknown[] = []) => {
        if (sql.includes('FROM m_course')) return courses;
        if (sql.includes('FROM lead')) {
          return [
            { id: '1', branch_id: '41', vertical_id: '39', course_text: 'russian' },
            { id: '2', branch_id: '41', vertical_id: '39', course_text: 'japanese_language' },
            { id: '3', branch_id: '40', vertical_id: '38', course_text: 'french_language' },
          ];
        }
        if (sql.startsWith('UPDATE lead')) { updates.push(p); return []; }
        return [];
      }),
    };
    await expect(rematchLeadCourses(db)).resolves.toBe(2);
    expect(updates).toEqual([[60, 1], [55, 3]]);
    // never overwrites a course a user already picked
    expect(db.query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE lead'))![0]).toMatch(/course_id IS NULL/);
  });
});
