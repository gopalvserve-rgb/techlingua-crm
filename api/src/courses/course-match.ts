/**
 * Course matching for inbound leads (client 10 Nov 2026, point 2).
 *
 * A Facebook form or an import sends the course as free text ("french_language", "French",
 * "FR001"). It links to a Course master row when, after normalising both sides, it equals the
 * course NAME, its CODE, or one of its CUSTOM NAMES (m_course.meta.aliases, edited in Course
 * Management). Normalising lower-cases and turns _ - . / into spaces, so "french_language"
 * matches "French Language" without any custom name at all.
 *
 * Scope follows the Add-Lead course dropdown (UAT #27): a course pinned to another Branch /
 * Vertical is not eligible; where the same key exists in several places the course pinned to
 * the lead's own Branch + Vertical wins over an unpinned one.
 */

export interface CourseRow {
  id: string | number;
  name: string;
  code?: string | null;
  meta?: Record<string, unknown> | null;
  /** optional pre-extracted meta.branch_id / meta.vertical_id */
  branch_id?: string | number | null;
  vertical_id?: string | number | null;
}

/** "French_Language?" -> "french language" */
export function normCourseKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[_\-./\\|,:;?!()[\]{}"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** meta.aliases may be an array or a comma / newline separated string. */
export function courseAliases(meta: Record<string, unknown> | null | undefined): string[] {
  const a = meta?.aliases;
  const list = Array.isArray(a) ? a : typeof a === 'string' ? a.split(/[,\n]/) : [];
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

function pinned(r: CourseRow, k: 'branch_id' | 'vertical_id'): number | null {
  const v = r[k] ?? r.meta?.[k];
  return v == null || v === '' ? null : Number(v);
}

/**
 * key -> course id for one Branch › Vertical. Keys: the literal lower-cased name / code (what the
 * importer always accepted) plus the normalised name, code and every custom name.
 */
export function buildCourseKeyMap(rows: CourseRow[], branchId: number, verticalId: number): Map<string, number> {
  const rank = (r: CourseRow): number => {
    const b = pinned(r, 'branch_id');
    const v = pinned(r, 'vertical_id');
    if ((b != null && b !== branchId) || (v != null && v !== verticalId)) return -1;
    return (b != null ? 1 : 0) + (v != null ? 1 : 0);
  };
  const eligible = rows.map((r) => ({ r, rk: rank(r) })).filter((x) => x.rk >= 0).sort((a, b) => a.rk - b.rk);
  const map = new Map<string, number>();
  const put = (k: string, id: number) => { if (k) map.set(k, id); };
  // weakest first: custom names, then codes, then names — so a better-scoped course overwrites an
  // unscoped one, and a literal name always resolves to its own course.
  for (const { r } of eligible) for (const a of courseAliases(r.meta)) put(normCourseKey(a), Number(r.id));
  for (const { r } of eligible) {
    const code = String(r.code ?? '').trim();
    put(code.toLowerCase(), Number(r.id));
    put(normCourseKey(code), Number(r.id));
  }
  for (const { r } of eligible) {
    put(String(r.name).trim().toLowerCase(), Number(r.id));
    put(normCourseKey(r.name), Number(r.id));
  }
  return map;
}

/** Look a raw course value up in a key map (literal first, then normalised). */
export function lookupCourse(map: Map<string, number>, raw: unknown): number | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  return map.get(v.toLowerCase()) ?? map.get(normCourseKey(v)) ?? null;
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

/**
 * Link every lead that still has no course but kept the source's course text to the Course master
 * row it now matches (after a course or one of its custom names was added). Returns how many leads
 * were linked. Never overwrites a course a user already picked.
 */
export async function rematchLeadCourses(db: Db): Promise<number> {
  const courses = await db.query(
    `SELECT id, name, code, meta FROM m_course WHERE deleted_at IS NULL AND is_active`,
  ) as CourseRow[];
  if (!courses.length) return 0;
  const leads = await db.query(
    `SELECT id, branch_id, vertical_id, course_text FROM lead
      WHERE course_id IS NULL AND course_text IS NOT NULL AND deleted_at IS NULL`,
  ) as Array<{ id: string; branch_id: string; vertical_id: string; course_text: string }>;
  const maps = new Map<string, Map<string, number>>();
  let linked = 0;
  for (const l of leads) {
    const k = `${l.branch_id}:${l.vertical_id}`;
    if (!maps.has(k)) maps.set(k, buildCourseKeyMap(courses, Number(l.branch_id), Number(l.vertical_id)));
    const id = lookupCourse(maps.get(k)!, l.course_text);
    if (id == null) continue;
    await db.query(
      `UPDATE lead SET course_id = $1, updated_at = now() WHERE id = $2 AND course_id IS NULL`,
      [id, Number(l.id)],
    );
    linked++;
  }
  return linked;
}
