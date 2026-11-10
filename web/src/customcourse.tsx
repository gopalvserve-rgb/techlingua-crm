/**
 * CUSTOM COURSE (client 5 Nov, point 3 — "Course field should be custom also"). Every enrolment
 * course dropdown (Sale Closure / New enrolment, Enrol in another course, Edit enrolment) ends with
 * "+ Custom course (type a name)". Picking it shows a name box; the fee is typed in the usual fee
 * field. On save the API turns the name into a Courses-master row under the enrolment's
 * Branch › Vertical (or reuses the one with that name) — reports keep working off course_id.
 */
export const CUSTOM_COURSE = '__custom';

export const isCustomCourse = (courseId: string | number | null | undefined) => String(courseId ?? '') === CUSTOM_COURSE;

/** The `<option>` that ends every course dropdown. */
export function CustomCourseOption() {
  return <option value={CUSTOM_COURSE}>+ Custom course (type a name)…</option>;
}

/** The name box shown when "+ Custom course" is picked. */
export function CustomCourseName({ courseId, value, onChange, disabled, idPrefix = 'cc' }: {
  courseId: string; value: string; onChange: (v: string) => void; disabled?: boolean; idPrefix?: string;
}) {
  if (!isCustomCourse(courseId)) return null;
  return (
    <div className="fld" style={{ gridColumn: '1 / -1' }} data-testid={`${idPrefix}-custom-course`}>
      <label htmlFor={`${idPrefix}-custom-name`}>Custom course name <span className="star">*</span></label>
      <input id={`${idPrefix}-custom-name`} className="ainp" value={value} disabled={disabled} maxLength={120}
        onChange={(e) => onChange(e.target.value)} placeholder="e.g. Korean — Weekend Batch" data-testid={`${idPrefix}-custom-name`} />
      <span className="fhint">Not in the list? Type it here and enter its fee below. It is added to the Courses master under this Branch › Vertical (an existing course with the same name is reused).</span>
    </div>
  );
}

/** The course part of an enrolment request: an id, or a typed custom name. */
export function coursePayload(courseId: string, customName: string): { course_id?: number; custom_course_name?: string } {
  if (isCustomCourse(courseId)) return { custom_course_name: customName.trim() };
  return courseId ? { course_id: Number(courseId) } : {};
}

/** A course id safe to hand to things that look a course up (levels, caps, batches). */
export const realCourseId = (courseId: string) => (isCustomCourse(courseId) ? '' : courseId);

/**
 * Client 10 Nov 2026 — the course a Facebook form / import sent ("french_language") shown the way
 * a person would write it ("French Language"). Display only; the stored text is kept as sent.
 */
export function prettyCourse(raw?: string | null): string {
  const t = String(raw ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => sp + c.toUpperCase());
}
