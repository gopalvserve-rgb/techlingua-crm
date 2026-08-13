import { DatabaseService } from '../database/database.service';

/**
 * ADMISSION JOURNEY — the intake funnel assembler (migration 075).
 *
 * An enrolment (a student's course admission) moves through:
 *   lead -> course_selected -> payment_received -> invoiced -> approved ->
 *   student_confirmed -> admitted   (plus `rejected`, with remarks).
 *
 * DERIVED vs PERSISTED — read this before touching stage logic:
 *   The EARLY stages (lead / course_selected / payment_received / invoiced) are COMPUTED here
 *   from existing linked data (the originating lead, the enrolment's course, fee_receipt rows,
 *   a gst_invoice) — they are NOT persisted and nothing auto-advances them, so there is no
 *   risky wiring into the payment/invoice create paths. Only the WORKFLOW stages from `approved`
 *   onward are persisted on `enrolment.admission_stage` by the transition endpoints. So a fresh
 *   enrolment sits at `course_selected` until an authorized approval bumps it to `approved`;
 *   grandfathered enrolments (075 backfill) sit at `admitted`.
 *
 * This is a pure function taking a DatabaseService so BOTH the enrolments controller
 * (per-enrolment) and the students controller (per-student) reuse ONE implementation without a
 * cross-module dependency (mirrors how the two modules already share scope-column maps). Scope
 * is enforced by the CALLER (it loads the enrolment/student in scope first).
 */

export const ADMISSION_STAGES = [
  'lead', 'course_selected', 'payment_received', 'invoiced', 'approved', 'student_confirmed', 'admitted',
] as const;

export const ADMISSION_STAGE_LABEL: Record<string, string> = {
  lead: 'Lead', course_selected: 'Course Selected', payment_received: 'Payment Received',
  invoiced: 'Invoice / Receipt', approved: 'Approved', student_confirmed: 'Student Confirmation',
  admitted: 'Admitted', rejected: 'Rejected',
};

const ORDINAL: Record<string, number> = {
  lead: 0, course_selected: 1, payment_received: 2, invoiced: 3, approved: 4, student_confirmed: 5, admitted: 6,
};
export function stageOrdinal(s: string): number { return ORDINAL[s] ?? 1; }

/** The persisted workflow stages — anything from `approved` onward (plus rejected). */
export function isWorkflowStage(s: string): boolean {
  return s === 'approved' || s === 'student_confirmed' || s === 'admitted' || s === 'rejected';
}

export interface JourneyStage {
  stage: string; label: string;
  status: 'done' | 'current' | 'pending' | 'blocked';
  at: string | null; by: string | null; detail: string | null;
}
export interface AdmissionJourney {
  enrolment_id: number; enrolment_no: string;
  course_id: number | null; course_name: string | null;
  lead_id: number | null; student_id: number | null;
  admission_stage: string; current_stage: string; current_ordinal: number;
  is_rejected: boolean; is_admitted: boolean;
  rejected: { reason: string | null; by: string | null; at: string | null } | null;
  stages: JourneyStage[];
  next: { action: 'approve' | 'confirm' | 'admit' | null; label: string | null; can: boolean; reason: string | null };
  can_approve: boolean; can_update: boolean;
  events?: any[];
}

/** Money helper — paise -> "₹1,234.50". */
function inr(minor: number | null | undefined): string {
  const v = Number(minor ?? 0) / 100;
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function assembleAdmissionJourney(
  db: DatabaseService,
  enrolmentId: number,
  opts: { canApprove: boolean; canUpdate: boolean; withEvents?: boolean },
): Promise<AdmissionJourney | null> {
  const e = await db.one<any>(
    `SELECT e.id, e.enrolment_no, e.course_id, e.lead_id, e.student_profile_id, e.created_at, e.start_date,
            e.admission_stage, e.admission_approved_at, e.admission_approval_remarks,
            e.student_confirmed_at, e.student_confirmed_via, e.student_confirmation_note,
            e.admitted_at, e.admission_rejected_reason, e.admission_rejected_at,
            co.name AS course_name,
            l.full_name AS lead_name, l.created_at AS lead_at, src.name AS lead_source,
            lu.name AS lead_owner_name,
            au.name AS approved_by_name, cu.name AS confirmed_by_name, du.name AS admitted_by_name,
            ru.name AS rejected_by_name
       FROM enrolment e
       LEFT JOIN m_course co ON co.id = e.course_id
       LEFT JOIN lead l ON l.id = e.lead_id
       LEFT JOIN source src ON src.id = l.source_id
       LEFT JOIN "user" lu ON lu.id = l.owner_id
       LEFT JOIN "user" au ON au.id = e.admission_approved_by
       LEFT JOIN "user" cu ON cu.id = e.confirmation_captured_by
       LEFT JOIN "user" du ON du.id = e.admitted_by
       LEFT JOIN "user" ru ON ru.id = e.admission_rejected_by
      WHERE e.id = $1::bigint AND e.deleted_at IS NULL`,
    [enrolmentId],
  );
  if (!e) return null;

  const pay = await db.one<any>(
    `SELECT count(*)::int AS n, min(fr.received_at) AS first_at, max(fr.received_at) AS last_at,
            COALESCE(sum(fr.amount_minor), 0) AS total_minor,
            (SELECT u.name FROM fee_receipt f2 LEFT JOIN "user" u ON u.id = f2.received_by
               WHERE f2.enrolment_id = $1::bigint AND f2.deleted_at IS NULL
               ORDER BY f2.received_at ASC LIMIT 1) AS first_by
       FROM fee_receipt fr WHERE fr.enrolment_id = $1::bigint AND fr.deleted_at IS NULL`,
    [enrolmentId],
  );
  const inv = await db.one<any>(
    `SELECT gi.invoice_no, gi.invoice_date, gi.issued_at, gi.total_minor, u.name AS issued_by
       FROM gst_invoice gi LEFT JOIN "user" u ON u.id = COALESCE(gi.issued_by, gi.created_by)
      WHERE gi.enrolment_id = $1::bigint AND gi.deleted_at IS NULL
        AND gi.status IN ('issued', 'paid') AND gi.invoice_no IS NOT NULL
      ORDER BY gi.issued_at ASC NULLS LAST, gi.id ASC LIMIT 1`,
    [enrolmentId],
  );

  const persisted = String(e.admission_stage ?? 'course_selected');
  const rejected = persisted === 'rejected';
  const hasPayment = Number(pay?.n ?? 0) > 0;
  const hasInvoice = !!inv;

  // current display stage: a persisted workflow stage wins; otherwise derive from data.
  let current = persisted;
  if (!isWorkflowStage(persisted)) {
    let derived = 'course_selected';
    if (hasPayment) derived = 'payment_received';
    if (hasInvoice) derived = 'invoiced';
    current = stageOrdinal(derived) > stageOrdinal(persisted) ? derived : persisted;
  }
  const currentOrd = rejected ? stageOrdinal('approved') : stageOrdinal(current);
  const admitted = persisted === 'admitted';

  const dmy = (v: any) => (v ? String(v) : null);

  const stageRows: Array<{ key: string; at: string | null; by: string | null; detail: string | null; done: boolean }> = [
    {
      key: 'lead', at: dmy(e.lead_at), by: e.lead_owner_name ?? null,
      detail: e.lead_id ? `${e.lead_name ?? 'Lead'}${e.lead_source ? ` · ${e.lead_source}` : ''}` : 'Direct admission (no originating lead)',
      done: true,
    },
    {
      key: 'course_selected', at: dmy(e.start_date ?? e.created_at), by: null,
      detail: `${e.course_name ?? 'Course'} · ${e.enrolment_no}`, done: true,
    },
    {
      key: 'payment_received', at: dmy(pay?.first_at), by: pay?.first_by ?? null,
      detail: hasPayment ? `${inr(pay?.total_minor)} received (${pay?.n} receipt${Number(pay?.n) === 1 ? '' : 's'})` : 'No payment recorded yet',
      done: hasPayment,
    },
    {
      key: 'invoiced', at: dmy(inv?.invoice_date ?? inv?.issued_at), by: inv?.issued_by ?? null,
      detail: hasInvoice ? `Invoice ${inv.invoice_no} · ${inr(inv.total_minor)}` : 'No invoice generated yet',
      done: hasInvoice,
    },
    {
      key: 'approved', at: dmy(e.admission_approved_at), by: e.approved_by_name ?? null,
      detail: e.admission_approved_at ? (e.admission_approval_remarks ? `Approved — ${e.admission_approval_remarks}` : 'Admission & payment approved') : 'Awaiting authorized approval',
      done: stageOrdinal(persisted) >= stageOrdinal('approved') && !rejected,
    },
    {
      key: 'student_confirmed', at: dmy(e.student_confirmed_at), by: e.confirmed_by_name ?? null,
      detail: e.student_confirmed_at ? `Confirmed via ${e.student_confirmed_via ?? '—'}${e.student_confirmation_note ? ` · ${e.student_confirmation_note}` : ''}` : 'Awaiting student confirmation',
      done: stageOrdinal(persisted) >= stageOrdinal('student_confirmed') && !rejected,
    },
    {
      key: 'admitted', at: dmy(e.admitted_at), by: e.admitted_by_name ?? null,
      detail: admitted ? 'Converted to admission' : 'Not yet admitted',
      done: admitted,
    },
  ];

  // The CURRENT stage = the first one that is not yet done (it carries the pending action);
  // everything before it is done, everything after is pending. A rejected admission freezes at
  // the approval gate (the reached stages stay done, `approved` shows blocked).
  const firstPending = stageRows.findIndex((s) => !s.done);
  const stages: JourneyStage[] = stageRows.map((s, i) => {
    let status: JourneyStage['status'];
    if (rejected) {
      status = s.done ? 'done' : s.key === 'approved' ? 'blocked' : 'pending';
    } else if (s.done) {
      status = 'done';
    } else if (i === firstPending) {
      status = 'current';
    } else {
      status = 'pending';
    }
    return { stage: s.key, label: ADMISSION_STAGE_LABEL[s.key], status, at: s.at, by: s.by, detail: s.detail };
  });
  const displayCurrent = rejected ? 'rejected' : (firstPending === -1 ? 'admitted' : stageRows[firstPending].key);

  // next action + whether the caller may perform it
  let next: AdmissionJourney['next'] = { action: null, label: null, can: false, reason: null };
  if (!rejected && !admitted) {
    if (stageOrdinal(persisted) < stageOrdinal('approved')) {
      const ready = hasPayment && hasInvoice;
      next = {
        action: 'approve', label: 'Approve admission & payment',
        can: opts.canApprove && ready,
        reason: !opts.canApprove ? 'Requires an authorized approver (admission.approve)'
          : !ready ? 'A payment and an invoice are required before approval' : null,
      };
    } else if (persisted === 'approved') {
      next = { action: 'confirm', label: 'Record student confirmation', can: opts.canUpdate, reason: opts.canUpdate ? null : 'Requires student.update' };
    } else if (persisted === 'student_confirmed') {
      next = { action: 'admit', label: 'Convert to admission', can: opts.canUpdate, reason: opts.canUpdate ? null : 'Requires student.update' };
    }
  }

  let events: any[] | undefined;
  if (opts.withEvents) {
    events = await db.query<any>(
      `SELECT ev.id, ev.stage, ev.note, ev.created_at, u.name AS changed_by_name
         FROM admission_event ev LEFT JOIN "user" u ON u.id = ev.changed_by
        WHERE ev.enrolment_id = $1::bigint
        ORDER BY ev.created_at DESC, ev.id DESC`,
      [enrolmentId],
    );
  }

  return {
    enrolment_id: Number(e.id), enrolment_no: e.enrolment_no,
    course_id: e.course_id ? Number(e.course_id) : null, course_name: e.course_name ?? null,
    lead_id: e.lead_id ? Number(e.lead_id) : null, student_id: e.student_profile_id ? Number(e.student_profile_id) : null,
    admission_stage: persisted, current_stage: displayCurrent, current_ordinal: currentOrd,
    is_rejected: rejected, is_admitted: admitted,
    rejected: rejected ? { reason: e.admission_rejected_reason ?? null, by: e.rejected_by_name ?? null, at: dmy(e.admission_rejected_at) } : null,
    stages, next, can_approve: opts.canApprove, can_update: opts.canUpdate, events,
  };
}
