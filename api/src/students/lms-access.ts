/**
 * STUDENT LMS ACCESS — the SINGLE source of truth mapping a lifecycle status code to the
 * student's LMS access level, and the two gates that consume it. Enforced (not cosmetic) at
 * the student-facing seams: starting/continuing an assessment ATTEMPT and reading PUBLISHED
 * study material / course content / syllabus for that student. The catalog table
 * (student_status_def.lms_access) mirrors this map for the UI; this helper is authoritative
 * for enforcement so there is ONE code path.
 *
 *   full    — Active                     → everything
 *   limited — On Hold, Inactive          → VIEW published material, but NO new attempts
 *   alumni  — Completed                  → VIEW published material, but NO new attempts
 *   none    — Suspended, Withdrawn,       → blocked from BOTH material and attempts
 *             Dropped Out, Cancelled,
 *             Failed, Course Expired
 *   depends — Transferred                → treated as FULL (the branch-transfer flow moves them)
 */
export type LmsAccess = 'full' | 'limited' | 'none' | 'alumni' | 'depends';

export const STATUS_LMS_ACCESS: Record<string, LmsAccess> = {
  active: 'full',
  on_hold: 'limited',
  inactive: 'limited',
  suspended: 'none',
  withdrawn: 'none',
  dropped_out: 'none',
  transferred: 'depends',
  completed: 'alumni',
  cancelled: 'none',
  failed: 'none',
  course_expired: 'none',
};

/** The SENSITIVE statuses — require reason + last_attendance + effective date + outstanding
 *  snapshot + an approver, AND are gated by the student.status_manage permission. */
export const SENSITIVE_STATUSES = new Set(['on_hold', 'suspended', 'withdrawn', 'dropped_out', 'cancelled']);

/** Statuses whose enrolment should STOP counting toward booked revenue / targets. */
export const REVENUE_CANCELLING_STATUSES = new Set(['cancelled', 'withdrawn', 'dropped_out']);

export function studentLmsAccess(statusCode?: string | null): LmsAccess {
  return STATUS_LMS_ACCESS[String(statusCode ?? 'active')] ?? 'full';
}

/** May the student VIEW published study material / course content / syllabus? */
export function canViewMaterial(access: LmsAccess): boolean {
  return access !== 'none';
}

/** May the student START a new assessment attempt (or continue/autosave/submit one)? */
export function canAttempt(access: LmsAccess): boolean {
  return access === 'full' || access === 'depends';
}

/** A clear, human message for a blocked seam. */
export function lmsBlockedMessage(statusCode: string, label: string, access: LmsAccess, seam: 'attempt' | 'material'): string {
  const what = seam === 'attempt' ? 'start or continue an assessment attempt' : 'view published study material';
  return `LMS access ${access.toUpperCase()} for status "${label || statusCode}" — the student cannot ${what}.`;
}

/* =============================================================================
 * PER-ENROLMENT (per-course) STATUS — shares the SAME catalog/taxonomy as the student
 * lifecycle above (one taxonomy), but applies to a single course enrolment. The set is a
 * subset: no 'inactive'/'suspended' (those are student-level concepts), plus the academic
 * outcomes a course can reach.
 * ============================================================================= */

/** The statuses a single course enrolment may hold (subset of the shared catalog). */
export const ENROLMENT_STATUSES = new Set([
  'active', 'on_hold', 'completed', 'withdrawn', 'dropped_out', 'cancelled', 'failed', 'course_expired', 'transferred',
]);

/** The enrolment's own LMS access from its course_status — reuses the shared status map. */
export function enrolmentLmsAccess(courseStatus?: string | null): LmsAccess {
  return studentLmsAccess(courseStatus);
}

/**
 * COMBINE the overall-student LMS access with a single enrolment's LMS access and return the
 * MORE RESTRICTIVE of the two (effective access for that course's content). Ordering, most to
 * least restrictive: none < limited < alumni < full (depends is normalised to full — the
 * transfer flow moves the learner). So a cancelled enrolment (none) blocks that course's
 * content even for an overall-active student; a completed enrolment under an active student
 * yields alumni (view-only); active+active yields full.
 */
export function combineAccess(a: LmsAccess, b: LmsAccess): LmsAccess {
  const rank = (x: LmsAccess): number =>
    x === 'none' ? 0 : x === 'limited' ? 1 : x === 'alumni' ? 2 : 3; // full/depends = 3
  const lo = rank(a) <= rank(b) ? a : b;
  return lo === 'depends' ? 'full' : lo;
}
