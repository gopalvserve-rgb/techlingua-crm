/**
 * MY TASK module (crm18aug-v2 Batch 2) — the "Related To" entity link + Task Status helpers.
 *
 * A task (a follow_up row) may be linked to a record of one of 13 TYPES. The type list is a
 * FIXED ENUM (not a user-managed master) on purpose: every type maps to a concrete table +
 * label + search expression, so a free-form master entry would have no backing record picker.
 * The `/follow-ups/entity-search` endpoint and the read-time `entity_label` CASE both derive
 * from ENTITY_SOURCES, so type↔table mapping lives in exactly one place.
 */
import { BadRequestException } from '@nestjs/common';

/** The 13 sanctioned Related-To types (stored on follow_up.entity_type). */
export const TASK_ENTITY_TYPES = [
  'lead', 'student', 'admission', 'enrollment', 'course', 'batch', 'payment',
  'invoice', 'followup', 'employer', 'placement', 'trainer', 'staff',
] as const;
export type TaskEntityType = (typeof TASK_ENTITY_TYPES)[number];

/** Human labels (for API help / docs). Order matches TASK_ENTITY_TYPES. */
export const TASK_ENTITY_LABELS: Record<TaskEntityType, string> = {
  lead: 'Lead', student: 'Student', admission: 'Admission', enrollment: 'Enrollment',
  course: 'Course', batch: 'Batch', payment: 'Payment', invoice: 'Invoice',
  followup: 'Follow-up', employer: 'Employer', placement: 'Placement',
  trainer: 'Trainer', staff: 'Staff',
};

export interface EntitySource {
  /** FROM clause, aliased `x` (may include a join for label context). */
  from: string;
  /** SQL expression producing the display label (references alias x / joins). */
  label: string;
  /** SQL expression searched with ILIKE (references alias x / joins). */
  search: string;
  /** live-rows predicate (references alias x / joins). */
  where: string;
}

/**
 * type -> table/label/search/where. Every referenced column was verified against the
 * migrations. `deleted_at` exists on all these tables; user rows use status='active'.
 */
export const ENTITY_SOURCES: Record<TaskEntityType, EntitySource> = {
  lead: {
    from: 'lead x',
    label: 'x.full_name',
    search: "x.full_name || ' ' || COALESCE(x.phone,'')",
    where: 'x.is_active AND x.deleted_at IS NULL',
  },
  student: {
    from: 'student x',
    label: 'x.full_name',
    search: "x.full_name || ' ' || COALESCE(x.student_no,'')",
    where: 'x.deleted_at IS NULL',
  },
  admission: {
    from: 'admission x',
    label: "x.full_name || COALESCE(' — ' || x.admission_no,'')",
    search: "x.full_name || ' ' || COALESCE(x.admission_no,'')",
    where: 'x.deleted_at IS NULL',
  },
  enrollment: {
    from: 'enrolment x LEFT JOIN m_course c ON c.id = x.course_id',
    label: "x.enrolment_no || COALESCE(' — ' || c.name,'')",
    search: "x.enrolment_no || ' ' || COALESCE(c.name,'')",
    where: 'x.deleted_at IS NULL',
  },
  course: {
    from: 'm_course x',
    label: "x.name || COALESCE(' (' || x.code || ')','')",
    search: "x.name || ' ' || COALESCE(x.code,'')",
    where: 'x.is_active AND x.deleted_at IS NULL',
  },
  batch: {
    from: 'batch x',
    label: "x.name || COALESCE(' (' || x.batch_code || ')','')",
    search: "x.name || ' ' || COALESCE(x.batch_code,'')",
    where: 'x.deleted_at IS NULL',
  },
  payment: {
    from: 'payment x',
    label: "'Payment #' || x.id || ' — ₹' || (x.amount_minor/100)::text",
    search: "x.id::text",
    where: 'x.deleted_at IS NULL',
  },
  invoice: {
    from: 'gst_invoice x',
    label: "COALESCE(x.invoice_no, 'Invoice #' || x.id)",
    search: "COALESCE(x.invoice_no,'') || ' ' || x.id::text",
    where: 'x.deleted_at IS NULL',
  },
  followup: {
    from: 'follow_up x',
    label: "COALESCE(NULLIF(x.notes,''), 'Task #' || x.id)",
    search: "COALESCE(x.notes,'') || ' ' || x.id::text",
    where: 'x.deleted_at IS NULL AND x.is_active',
  },
  employer: {
    from: 'job_opening x',
    label: "COALESCE(x.employer,'—') || ' — ' || x.title",
    search: "COALESCE(x.employer,'') || ' ' || x.title",
    where: 'x.deleted_at IS NULL',
  },
  placement: {
    from: 'placement_application x JOIN student s ON s.id = x.student_id JOIN job_opening j ON j.id = x.job_opening_id',
    label: "s.full_name || ' → ' || j.title",
    search: "s.full_name || ' ' || j.title",
    where: 'x.deleted_at IS NULL',
  },
  trainer: {
    from: '"user" x',
    label: 'x.name',
    search: "x.name || ' ' || COALESCE(x.email,'')",
    where: "x.status = 'active' AND x.deleted_at IS NULL AND EXISTS "
      + "(SELECT 1 FROM user_assignment ua JOIN role r ON r.id = ua.role_id "
      + "WHERE ua.user_id = x.id AND ua.is_active AND r.name ILIKE '%trainer%')",
  },
  staff: {
    from: '"user" x',
    label: 'x.name',
    search: "x.name || ' ' || COALESCE(x.email,'')",
    where: "x.status = 'active' AND x.deleted_at IS NULL",
  },
};

/** Validate an incoming entity type (or undefined/null -> undefined = "no link"). */
export function assertEntityType(value: unknown): TaskEntityType | undefined {
  if (value == null || value === '') return undefined;
  if (!TASK_ENTITY_TYPES.includes(value as TaskEntityType)) {
    throw new BadRequestException(`invalid entity_type — expected one of: ${TASK_ENTITY_TYPES.join(', ')}`);
  }
  return value as TaskEntityType;
}

/**
 * Read-time `entity_label` — a single CASE over ENTITY_SOURCES that resolves the linked
 * record's display name via a scalar subquery per type (only the matching branch runs).
 * `col` is the entity_type column ref, `idCol` the entity_id column ref.
 */
export function entityLabelCaseSql(col: string, idCol: string): string {
  const branches = TASK_ENTITY_TYPES.map((t) => {
    const s = ENTITY_SOURCES[t];
    return `WHEN '${t}' THEN (SELECT ${s.label} FROM ${s.from} WHERE x.id = ${idCol} LIMIT 1)`;
  });
  return `CASE ${col} ${branches.join(' ')} ELSE NULL END`;
}

/**
 * Task Status vocabulary. in_progress / on_hold / completed are USER-SET; overdue is DERIVED
 * (a pending task past its due date). The read exposes an EFFECTIVE status that folds the
 * derivation in, but the stored column only ever holds the three user-set values.
 */
export const TASK_STATUSES = ['in_progress', 'on_hold', 'completed', 'overdue'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const USER_SET_TASK_STATUSES = ['in_progress', 'on_hold', 'completed'] as const;

/** Validate a user-SET task_status (rejects 'overdue' — it can't be set, only derived). */
export function assertTaskStatus(value: unknown): 'in_progress' | 'on_hold' | 'completed' {
  if (!USER_SET_TASK_STATUSES.includes(value as any)) {
    throw new BadRequestException(`invalid task_status — expected one of: ${USER_SET_TASK_STATUSES.join(', ')}`);
  }
  return value as 'in_progress' | 'on_hold' | 'completed';
}

/**
 * Pure derivation of the EFFECTIVE task status from a row's stored fields — the single source
 * of truth reused by the SQL (below) and unit tests. A completed task stays completed; an
 * otherwise-open task whose due date is past "today" reads as overdue.
 */
export function deriveTaskStatus(
  row: { task_status?: string | null; status?: string | null; scheduled_at?: string | Date | null },
  now: Date = new Date(),
): TaskStatus {
  if (row.task_status === 'completed' || row.status === 'done') return 'completed';
  if (row.scheduled_at != null && (row.status == null || row.status === 'pending')) {
    const due = new Date(row.scheduled_at as any);
    if (!Number.isNaN(due.getTime())) {
      const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
      if (day(due) < day(now)) return 'overdue';
    }
  }
  return (row.task_status as TaskStatus) ?? 'in_progress';
}

/** SQL for the effective task status (IST day compare), matching deriveTaskStatus. */
export const TASK_STATUS_EFF_SQL = `
  CASE
    WHEN f.task_status = 'completed' OR f.status = 'done' THEN 'completed'
    WHEN f.status = 'pending'
         AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date
      THEN 'overdue'
    ELSE f.task_status
  END`;

/** The 6 My-Tasks cards (client docx). Each maps to a SQL predicate over follow_up f. */
export const TASK_CARDS = ['open', 'due_today', 'overdue', 'in_progress', 'completed', 'next7'] as const;
export type TaskCard = (typeof TASK_CARDS)[number];

/** SQL predicate for a card (literal IST windows; no bind params). Assumes alias f. */
export function taskCardSql(card: string): string | null {
  const ist = (c: string) => `(${c} AT TIME ZONE 'Asia/Kolkata')::date`;
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
  const notDone = `f.task_status <> 'completed' AND f.status <> 'done'`;
  switch (card) {
    case 'open': return notDone;
    case 'due_today': return `f.status = 'pending' AND ${ist('f.scheduled_at')} = ${today}`;
    case 'overdue': return `f.status = 'pending' AND ${ist('f.scheduled_at')} < ${today}`;
    case 'in_progress': return `f.task_status = 'in_progress' AND ${notDone}`;
    case 'completed': return `(f.task_status = 'completed' OR f.status = 'done')`;
    case 'next7': return `f.status = 'pending' AND ${ist('f.scheduled_at')} BETWEEN ${today} AND ${today} + 7`;
    default: return null;
  }
}
