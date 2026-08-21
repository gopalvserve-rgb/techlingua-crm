import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { PLAN_SCOPE_COLS } from './plan.service';
import { MessagingService } from '../messaging/messaging.service';
import { SettingsService } from '../common/settings.service';
import { formatINR } from '../common/money.util';
import { DEFAULT_FEE_REMINDER, FeeReminderConfig } from './reminder.worker';

interface Me { id: number; name: string }

/**
 * FEE DUES & AGEING (Phase 3 Batch 2). Outstanding fee per student / enrolment /
 * installment, bucketed by how overdue it is — computed in IST from each due's date.
 *
 * TWO SOURCES OF A DUE, one honest view:
 *   1) INSTALLMENT dues  — a scheduled installment with outstanding > 0 (its own due date);
 *   2) UNPLANNED dues    — an active enrolment with an outstanding balance but no payment
 *                          plan yet (dated by its start date). Without this, an enrolment
 *                          the counsellor never put on a plan would silently owe nothing.
 *
 * AGEING IS IST. Buckets are computed against `(now() AT TIME ZONE 'Asia/Kolkata')::date`
 * so a due that flips overdue at IST midnight flips here too, not at UTC midnight (which
 * for India is 05:30 the previous evening — a whole day early on every ageing report).
 *
 * BUCKETS: not_due (due in the future) · 0–30 · 31–60 · 61–90 · 90+ days overdue.
 */

export const BUCKETS = ['not_due', 'b_0_30', 'b_31_60', 'b_61_90', 'b_90_plus'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABEL: Record<Bucket, string> = {
  not_due: 'Not due', b_0_30: '0–30 days', b_31_60: '31–60 days', b_61_90: '61–90 days', b_90_plus: '90+ days',
};

/** The overdue-days -> bucket CASE, shared by list + summary so they cannot disagree. */
const BUCKET_CASE = `CASE
    WHEN d.days_overdue < 0 THEN 'not_due'
    WHEN d.days_overdue <= 30 THEN 'b_0_30'
    WHEN d.days_overdue <= 60 THEN 'b_31_60'
    WHEN d.days_overdue <= 90 THEN 'b_61_90'
    ELSE 'b_90_plus' END`;

@Injectable()
export class DuesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
  ) {}

  /** The CTE of every outstanding due (installment + unplanned), scoped, in IST. */
  private duesCte(scope: ResolvedScope, params: unknown[]): string {
    const w1 = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const w2 = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    return `WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
    due AS (
      -- 1) installment dues
      SELECT 'inst:' || i.id::text AS due_id, 'installment'::text AS source,
             e.id AS enrolment_id, e.enrolment_no, i.plan_id, i.seq_no,
             COALESCE(l.full_name, sp.full_name) AS student_name,
             COALESCE(l.phone, sp.phone) AS student_phone,
             COALESCE(l.email, sp.email) AS student_email,
             e.course_id, c.name AS course_name,
             e.branch_id, b.name AS branch_name, e.vertical_id, v.name AS vertical_name,
             e.counsellor_id AS owner_id, u.name AS owner_name,
             e.batch_id, bt.name AS batch_name, bt.trainer_id, tr.name AS trainer_name,
             e.course_status, ssd.label AS course_status_label,
             svi.student_vertical_no AS roll_no,
             (SELECT string_agg(el.code, ', ' ORDER BY el.ordering, el.id)
                FROM enrolment_level el WHERE el.enrolment_id = e.id) AS level_summary,
             COALESCE(NULLIF(e.gross_fee_minor, 0), e.fee_minor) AS total_fee_minor,
             e.net_fee_minor AS net_fee_minor, e.payment_plan AS fee_plan,
             i.due_date, i.amount_minor, i.paid_minor,
             (i.amount_minor - i.paid_minor) AS outstanding_minor,
             -- enrolment-level Balance (Net − everything receipted on the enrolment), so the
             -- Fee Management "Balance" column is the true outstanding, not just this installment's.
             COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                        WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS enrolment_paid_minor,
             (e.net_fee_minor - COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                        WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0)) AS balance_minor,
             ((SELECT d FROM today) - i.due_date) AS days_overdue
        FROM installment i
        JOIN payment_plan pp ON pp.id = i.plan_id AND pp.status = 'active' AND pp.deleted_at IS NULL
        JOIN enrolment e ON e.id = i.enrolment_id
        LEFT JOIN lead l ON l.id = e.lead_id
        LEFT JOIN student sp ON sp.id = e.student_profile_id AND sp.deleted_at IS NULL
        JOIN branch b ON b.id = e.branch_id
        JOIN vertical v ON v.id = e.vertical_id
        LEFT JOIN m_course c ON c.id = e.course_id
        LEFT JOIN "user" u ON u.id = e.counsellor_id
        LEFT JOIN batch bt ON bt.id = e.batch_id
        LEFT JOIN "user" tr ON tr.id = bt.trainer_id
        LEFT JOIN student_status_def ssd ON ssd.code = e.course_status
        LEFT JOIN student_vertical_id svi ON svi.student_id = e.student_profile_id AND svi.vertical_id = e.vertical_id
       WHERE e.deleted_at IS NULL AND e.status = 'active'
         AND i.status <> 'waived' AND (i.amount_minor - i.paid_minor) > 0 AND ${w1}
      UNION ALL
      -- 2) unplanned enrolment balances (no active plan)
      SELECT 'enr:' || e.id::text AS due_id, 'unplanned'::text AS source,
             e.id AS enrolment_id, e.enrolment_no, NULL::bigint AS plan_id, 1 AS seq_no,
             COALESCE(l.full_name, sp.full_name) AS student_name,
             COALESCE(l.phone, sp.phone) AS student_phone,
             COALESCE(l.email, sp.email) AS student_email,
             e.course_id, c.name AS course_name,
             e.branch_id, b.name AS branch_name, e.vertical_id, v.name AS vertical_name,
             e.counsellor_id AS owner_id, u.name AS owner_name,
             e.batch_id, bt.name AS batch_name, bt.trainer_id, tr.name AS trainer_name,
             e.course_status, ssd.label AS course_status_label,
             svi.student_vertical_no AS roll_no,
             (SELECT string_agg(el.code, ', ' ORDER BY el.ordering, el.id)
                FROM enrolment_level el WHERE el.enrolment_id = e.id) AS level_summary,
             COALESCE(NULLIF(e.gross_fee_minor, 0), e.fee_minor) AS total_fee_minor,
             e.net_fee_minor AS net_fee_minor, e.payment_plan AS fee_plan,
             COALESCE(e.start_date, e.created_at::date) AS due_date,
             e.net_fee_minor AS amount_minor,
             COALESCE(pr.paid_minor, 0) AS paid_minor,
             (e.net_fee_minor - COALESCE(pr.paid_minor, 0)) AS outstanding_minor,
             COALESCE(pr.paid_minor, 0) AS enrolment_paid_minor,
             (e.net_fee_minor - COALESCE(pr.paid_minor, 0)) AS balance_minor,
             ((SELECT d FROM today) - COALESCE(e.start_date, e.created_at::date)) AS days_overdue
        FROM enrolment e
        LEFT JOIN lead l ON l.id = e.lead_id
        LEFT JOIN student sp ON sp.id = e.student_profile_id AND sp.deleted_at IS NULL
        JOIN branch b ON b.id = e.branch_id
        JOIN vertical v ON v.id = e.vertical_id
        LEFT JOIN m_course c ON c.id = e.course_id
        LEFT JOIN "user" u ON u.id = e.counsellor_id
        LEFT JOIN batch bt ON bt.id = e.batch_id
        LEFT JOIN "user" tr ON tr.id = bt.trainer_id
        LEFT JOIN student_status_def ssd ON ssd.code = e.course_status
        LEFT JOIN student_vertical_id svi ON svi.student_id = e.student_profile_id AND svi.vertical_id = e.vertical_id
        LEFT JOIN LATERAL (SELECT COALESCE(sum(fr.amount_minor),0) AS paid_minor
                             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL) pr ON TRUE
       WHERE e.deleted_at IS NULL AND e.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM payment_plan pp
                          WHERE pp.enrolment_id = e.id AND pp.status = 'active' AND pp.deleted_at IS NULL)
         AND (e.net_fee_minor - COALESCE(pr.paid_minor, 0)) > 0 AND ${w2}
    )`;
  }

  async list(scope: ResolvedScope, f: { bucket?: string[]; branch_ids?: number[]; vertical_ids?: number[]; course_ids?: number[]; owner_ids?: number[]; trainer_ids?: number[]; course_status?: string[]; source?: string[]; q?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const cte = this.duesCte(scope, params);
    const conds: string[] = [];
    if (f.bucket?.length) { params.push(f.bucket); conds.push(`(${BUCKET_CASE}) = ANY($${params.length}::varchar[])`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); conds.push(`d.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); conds.push(`d.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.course_ids?.length) { params.push(f.course_ids); conds.push(`d.course_id = ANY($${params.length}::bigint[])`); }
    if (f.owner_ids?.length) { params.push(f.owner_ids); conds.push(`d.owner_id = ANY($${params.length}::bigint[])`); }
    // TRAINER = the trainer of the student's batch (dev/81 Trainer-role user) on this due's enrolment.
    if (f.trainer_ids?.length) { params.push(f.trainer_ids); conds.push(`d.trainer_id = ANY($${params.length}::bigint[])`); }
    // STATUS = the per-course enrolment status (dev/72 course_status: active/completed/on-hold/…).
    if (f.course_status?.length) { params.push(f.course_status); conds.push(`d.course_status = ANY($${params.length}::varchar[])`); }
    if (f.source?.length) { params.push(f.source); conds.push(`d.source = ANY($${params.length}::varchar[])`); }
    if (f.q) { params.push(`%${f.q}%`); conds.push(`(d.enrolment_no ILIKE $${params.length} OR d.student_name ILIKE $${params.length})`); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `${cte}
       SELECT d.*, ${BUCKET_CASE} AS bucket, GREATEST(d.days_overdue, 0) AS overdue_days
         FROM due d${where}
        ORDER BY d.days_overdue DESC, d.outstanding_minor DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  /** Totals: overall outstanding, by ageing bucket, by branch, by vertical. */
  async summary(scope: ResolvedScope, f: { branch_ids?: number[]; vertical_ids?: number[] } = {}) {
    const params: unknown[] = [];
    const cte = this.duesCte(scope, params);
    const conds: string[] = [];
    if (f.branch_ids?.length) { params.push(f.branch_ids); conds.push(`d.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); conds.push(`d.vertical_id = ANY($${params.length}::bigint[])`); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';

    const totals = await this.db.one<any>(
      `${cte}
       SELECT COALESCE(sum(d.outstanding_minor),0) AS outstanding_minor,
              count(*) AS due_count,
              count(DISTINCT d.enrolment_id) AS enrolments_with_dues,
              count(*) FILTER (WHERE d.days_overdue > 0) AS overdue_count,
              count(DISTINCT d.enrolment_id) FILTER (WHERE d.days_overdue > 30) AS defaulters,
              COALESCE(sum(d.outstanding_minor) FILTER (WHERE d.days_overdue > 30),0) AS overdue_30_minor
         FROM due d${where}`, params);

    const byBucket = await this.db.query<any>(
      `${cte}
       SELECT ${BUCKET_CASE} AS bucket, COALESCE(sum(d.outstanding_minor),0) AS total_minor, count(*) AS n
         FROM due d${where} GROUP BY 1`, params);
    const bMap = new Map(byBucket.map((r) => [r.bucket, r]));

    const byBranch = await this.db.query<any>(
      `${cte}
       SELECT d.branch_name AS label, COALESCE(sum(d.outstanding_minor),0) AS total_minor
         FROM due d${where} GROUP BY d.branch_name ORDER BY 2 DESC LIMIT 12`, params);
    const byVertical = await this.db.query<any>(
      `${cte}
       SELECT d.vertical_name AS label, COALESCE(sum(d.outstanding_minor),0) AS total_minor
         FROM due d${where} GROUP BY d.vertical_name ORDER BY 2 DESC LIMIT 12`, params);

    return {
      outstanding_minor: Number(totals?.outstanding_minor ?? 0),
      due_count: Number(totals?.due_count ?? 0),
      enrolments_with_dues: Number(totals?.enrolments_with_dues ?? 0),
      overdue_count: Number(totals?.overdue_count ?? 0),
      defaulters: Number(totals?.defaulters ?? 0),
      overdue_30_minor: Number(totals?.overdue_30_minor ?? 0),
      by_bucket: BUCKETS.map((b) => ({
        bucket: b, label: BUCKET_LABEL[b],
        total_minor: Number(bMap.get(b)?.total_minor ?? 0), n: Number(bMap.get(b)?.n ?? 0),
      })),
      by_branch: byBranch.map((r) => ({ label: r.label, total_minor: Number(r.total_minor) })),
      by_vertical: byVertical.map((r) => ({ label: r.label, total_minor: Number(r.total_minor) })),
    };
  }
  /**
   * MANUAL FEE REMINDER (client feedback item 5) — the "Reminder" action icon on the Fee
   * Management (dues) list. Fires the SAME channel-agnostic reminder the automatic sweep
   * uses (WhatsApp / SMS / Email via MessagingService.queue, guarded → honours opt-out &
   * business hours, degrades cleanly to a failed/not_configured log row when a channel has
   * no credentials — never throws). Scope-enforced (the enrolment must be in the caller's
   * scope) and IDEMPOTENT: at most one manual reminder per enrolment per IST day
   * (fee_manual_reminder, migration 077) so repeated clicks never spam the student.
   */
  async remind(scope: ResolvedScope, enrolmentId: number, me: Me): Promise<{ sent: number; already: boolean; skipped?: string; channels: string[] }> {
    if (!Number.isInteger(enrolmentId) || enrolmentId <= 0) throw new BadRequestException('enrolment_id is required');
    const params: unknown[] = [enrolmentId];
    const scopeWhere = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.net_fee_minor, e.branch_id, e.vertical_id, e.lead_id,
              COALESCE(l.full_name, sp.full_name) AS student_name,
             COALESCE(l.phone, sp.phone) AS student_phone,
             COALESCE(l.email, sp.email) AS student_email,
              c.name AS course_name,
              COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                         WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
         LEFT JOIN m_course c ON c.id = e.course_id
        WHERE e.id = $1 AND e.deleted_at IS NULL AND ${scopeWhere}
        LIMIT 1`,
      params,
    );
    const e = rows[0];
    if (!e) throw new NotFoundException('Enrolment not found');
    const outstanding = Number(e.net_fee_minor) - Number(e.paid_minor);
    if (outstanding <= 0) return { sent: 0, already: false, skipped: 'no_outstanding', channels: [] };

    const cfg = await this.settings.get('fee_reminder_config', DEFAULT_FEE_REMINDER as unknown as Record<string, unknown>) as unknown as FeeReminderConfig;
    const channels = (Array.isArray(cfg?.channels) ? cfg.channels : DEFAULT_FEE_REMINDER.channels)
      .filter((x) => ['whatsapp', 'sms', 'email'].includes(x));

    return this.db.tx(async (client) => {
      // THE CLAIM — exactly one manual reminder per (enrolment, IST day).
      const claim = await client.query(
        `INSERT INTO fee_manual_reminder (enrolment_id, ymd, created_by)
         VALUES ($1, (now() AT TIME ZONE 'Asia/Kolkata')::date, $2)
         ON CONFLICT (enrolment_id, ymd) DO NOTHING RETURNING id`,
        [enrolmentId, me?.id ?? null],
      );
      if (!claim.rowCount) return { sent: 0, already: true, channels: [] };
      const rid = Number(claim.rows[0].id);

      const amount = formatINR(outstanding);
      const course = e.course_name ? ` for ${e.course_name}` : '';
      const body = `Dear ${e.student_name}, this is a reminder that a fee amount of ${amount}${course} (${e.enrolment_no}) is outstanding on your account. Kindly arrange the payment at the earliest. Thank you.`;

      let firstLogId: number | null = null;
      const used: string[] = [];
      for (const ch of channels) {
        const to = ch === 'email' ? e.student_email : e.student_phone;
        if (!to) continue; // not reachable on this channel — skip, not an error
        const res = await this.messaging.queue({
          channel: ch as 'whatsapp' | 'sms' | 'email',
          to: String(to),
          subject: ch === 'email' ? `Fee reminder — ${e.enrolment_no}` : null,
          body: ch === 'email' ? `<p>${body}</p>` : body,
          lead_id: Number(e.lead_id), vertical_id: Number(e.vertical_id), branch_id: Number(e.branch_id),
          guarded: true,
        });
        used.push(ch);
        if (firstLogId == null && res?.id) firstLogId = Number(res.id);
      }
      await client.query(`UPDATE fee_manual_reminder SET channels = $2, message_log_id = $3 WHERE id = $1`, [rid, used, firstLogId]);
      return { sent: used.length, already: false, channels: used };
    });
  }
}
