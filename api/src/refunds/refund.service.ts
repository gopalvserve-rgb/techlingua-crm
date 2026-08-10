import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { SettingsService } from '../common/settings.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotifierService } from '../notifications/notifier.service';
import { formatINR, rupeesToMinor } from '../common/money.util';
import { assertDateRange } from '../common/date.util';
import { Letterhead, refundVoucherPdf } from '../pdf/documents';

/**
 * REFUNDS (Phase 3 Batch 4) — a full or PARTIAL refund of fees already COLLECTED against
 * an enrolment, behind an approval hierarchy.
 *
 * =============================================================================
 * THE MODEL, IN ONE PARAGRAPH
 * =============================================================================
 * A refund is REQUESTED (status 'pending'); a permitted role APPROVES or REJECTS it.
 * This reuses the enrolment optional-approval PATTERN (Sprint 5): a configurable policy
 * in ONE app_setting row, the SAME NotifierService for the approver alert, the SAME
 * self-approval bar (`requested_by <> approver`), and the SAME ScopeResolver so an
 * approver only sees his branch's refunds. It does NOT reuse the enrolment approval_request
 * TABLE — refund state lives on the refund row itself, so the enrolment approval queue is
 * never polluted with refund rows.
 *
 * APPROVAL HIERARCHY BY AMOUNT (simple + configurable): approval is always required. A
 * refund at or below the high-value threshold needs `refund.approve`; ABOVE it needs the
 * senior `refund.approve_high`. Both are gated at the controller; the service is handed a
 * flag saying whether the caller holds the senior permission and refuses a high-value
 * approval a plain approver is not allowed to make.
 *
 * NET COLLECTED = receipts - APPROVED refunds. A refund can never exceed what is REFUNDABLE
 * = collected - (approved refunds + OTHER pending refunds): two clerks cannot each refund
 * the last rupee. The number is re-computed inside the approve transaction under a row lock.
 *
 * MONEY is BIGINT paise everywhere; no floats. A voucher number (REF-, per branch/vertical,
 * reset per Indian FY) is allocated ONLY on approval — an unapproved request never burns one.
 */

export const REFUND_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'rf.branch_id',
  vertical: 'rf.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const REFUND_MODES = ['cash', 'upi', 'card', 'cheque', 'online'] as const;
export const MODE_LABELS: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online transfer',
};
export const REFUND_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export interface RefundPolicy {
  require_approval: boolean;
  high_value_over_minor: number;
  roles: string[];
  high_roles: string[];
}
export const DEFAULT_REFUND_POLICY: RefundPolicy = {
  require_approval: true,
  high_value_over_minor: 2500000,   // Rs. 25,000
  roles: ['Branch Manager', 'Vertical Manager', 'Accountant'],
  high_roles: ['Branch Manager', 'Vertical Manager', 'Organization Admin'],
};

/** PURE — does this amount need the SENIOR approver? Strictly greater than the threshold. */
export function needsHighApproval(policy: RefundPolicy, amountMinor: number): boolean {
  const over = Number(policy?.high_value_over_minor ?? 0);
  return over > 0 && amountMinor > over;
}

@Injectable()
export class RefundService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly settings: SettingsService,
    private readonly numbering: NumberingService,
    private readonly notifier?: NotifierService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async policy(): Promise<RefundPolicy> {
    return this.settings.get('refund_approvals', DEFAULT_REFUND_POLICY as unknown as Record<string, unknown>) as unknown as Promise<RefundPolicy>;
  }

  async setPolicy(dto: any, actorId: number): Promise<RefundPolicy> {
    const cur = await this.policy();
    const next: RefundPolicy = {
      require_approval: dto?.require_approval === undefined ? cur.require_approval : !!dto.require_approval,
      high_value_over_minor: dto?.high_value_over_minor === undefined
        ? cur.high_value_over_minor : Math.max(0, Math.trunc(Number(dto.high_value_over_minor))),
      roles: Array.isArray(dto?.roles) ? dto.roles.map(String) : cur.roles,
      high_roles: Array.isArray(dto?.high_roles) ? dto.high_roles.map(String) : cur.high_roles,
    };
    if (!Number.isFinite(next.high_value_over_minor) || next.high_value_over_minor < 0) {
      throw new BadRequestException('The high-value threshold must be zero or a positive amount.');
    }
    await this.settings.set('refund_approvals', next as unknown as Record<string, unknown>, actorId);
    return next;
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string[]; enrolment_id?: number; q?: string; from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[]; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`rf.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, REFUND_SCOPE_COLS, params)];
    if (f.status?.length) { params.push(f.status); where.push(`rf.status = ANY($${params.length}::varchar[])`); }
    if (f.enrolment_id) { params.push(Number(f.enrolment_id)); where.push(`rf.enrolment_id = $${params.length}::bigint`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`rf.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`rf.vertical_id = ANY($${params.length}::bigint[])`); }
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`rf.requested_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`rf.requested_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(rf.refund_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length} OR e.enrolment_no ILIKE $${params.length} OR rf.reason ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT rf.id, rf.refund_no, rf.amount_minor, rf.mode, rf.reference, rf.reason, rf.status,
              rf.requires_high, rf.requested_at, rf.decided_at, rf.refunded_at, rf.decide_note,
              rf.enrolment_id, rf.fee_receipt_id, e.enrolment_no, e.net_fee_minor,
              l.full_name AS student_name, c.name AS course_name,
              b.name AS branch_name, v.name AS vertical_name,
              ru.name AS requested_by_name, au.name AS approver_name, fr.receipt_no
         FROM refund rf
         JOIN enrolment e ON e.id = rf.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = rf.branch_id
         JOIN vertical v ON v.id = rf.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" ru ON ru.id = rf.requested_by
         LEFT JOIN "user" au ON au.id = rf.approver_id
         LEFT JOIN fee_receipt fr ON fr.id = rf.fee_receipt_id
        WHERE ${where.join(' AND ')}
        ORDER BY rf.requested_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, REFUND_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT COALESCE(sum(rf.amount_minor) FILTER (WHERE rf.status = 'approved'), 0) AS refunded_minor,
              count(*) FILTER (WHERE rf.status = 'pending') AS pending_n,
              count(*) FILTER (WHERE rf.status = 'approved') AS approved_n,
              count(*) FILTER (WHERE rf.status = 'rejected') AS rejected_n,
              COALESCE(sum(rf.amount_minor) FILTER (WHERE rf.status = 'pending'), 0) AS pending_minor
         FROM refund rf JOIN enrolment e ON e.id = rf.enrolment_id
        WHERE rf.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      refunded_minor: Number(r?.refunded_minor ?? 0),
      pending_minor: Number(r?.pending_minor ?? 0),
      pending_n: Number(r?.pending_n ?? 0),
      approved_n: Number(r?.approved_n ?? 0),
      rejected_n: Number(r?.rejected_n ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, REFUND_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT rf.*, e.enrolment_no, e.net_fee_minor, e.lead_id,
              l.full_name AS student_name, l.phone AS student_phone,
              c.name AS course_name, ru.name AS requested_by_name, au.name AS approver_name,
              b.name AS branch_name, b.address AS branch_address, b.contact_number AS branch_phone,
              b.email AS branch_email, v.name AS vertical_name,
              o.name AS org_name, o.gst_no AS org_gst, fr.receipt_no,
              COALESCE((SELECT sum(x.amount_minor) FROM fee_receipt x WHERE x.enrolment_id = rf.enrolment_id AND x.deleted_at IS NULL), 0) AS collected_minor,
              COALESCE((SELECT sum(x.amount_minor) FROM refund x WHERE x.enrolment_id = rf.enrolment_id AND x.status = 'approved' AND x.deleted_at IS NULL), 0) AS approved_refunds_minor
         FROM refund rf
         JOIN enrolment e ON e.id = rf.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = rf.branch_id
         JOIN vertical v ON v.id = rf.vertical_id
         JOIN organisation o ON o.id = rf.org_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" ru ON ru.id = rf.requested_by
         LEFT JOIN "user" au ON au.id = rf.approver_id
         LEFT JOIN fee_receipt fr ON fr.id = rf.fee_receipt_id
        WHERE rf.id = $1::bigint AND rf.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!r) throw new NotFoundException('Refund not found');
    return r;
  }

  /** Refundable amount for an enrolment: collected - (approved + pending) refunds. */
  async refundable(enrolmentId: number): Promise<{ collected: number; approved: number; pending: number; refundable: number }> {
    const r = await this.db.one<any>(
      `SELECT
         COALESCE((SELECT sum(x.amount_minor) FROM fee_receipt x WHERE x.enrolment_id = $1::bigint AND x.deleted_at IS NULL), 0) AS collected,
         COALESCE((SELECT sum(x.amount_minor) FROM refund x WHERE x.enrolment_id = $1::bigint AND x.status = 'approved' AND x.deleted_at IS NULL), 0) AS approved,
         COALESCE((SELECT sum(x.amount_minor) FROM refund x WHERE x.enrolment_id = $1::bigint AND x.status = 'pending' AND x.deleted_at IS NULL), 0) AS pending`,
      [enrolmentId],
    );
    const collected = Number(r?.collected ?? 0);
    const approved = Number(r?.approved ?? 0);
    const pending = Number(r?.pending ?? 0);
    return { collected, approved, pending, refundable: collected - approved - pending };
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * REQUEST a refund. Validates the enrolment is in scope, the amount is > 0 and <= what is
   * refundable, and records a PENDING refund. Never allocates a voucher number.
   */
  async request(dto: any, me: { id: number }, scope: ResolvedScope) {
    const enrolmentId = Number(dto?.enrolment_id);
    if (!enrolmentId) throw new BadRequestException('Choose the enrolment to refund against.');

    let amount_minor: number;
    try {
      amount_minor = dto?.amount_minor !== undefined && dto?.amount_minor !== null
        ? Math.trunc(Number(dto.amount_minor))
        : rupeesToMinor(dto?.amount);
    } catch (e) { throw new BadRequestException(`Amount: ${(e as Error).message}`); }
    if (!Number.isFinite(amount_minor) || amount_minor <= 0) throw new BadRequestException('The refund amount must be more than zero.');

    const mode = String(dto?.mode ?? '');
    if (!(REFUND_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`Choose a refund mode: ${REFUND_MODES.map((m) => MODE_LABELS[m]).join(', ')}.`);
    }
    const reason = String(dto?.reason ?? '').trim();
    if (!reason) throw new BadRequestException('A refund needs a reason.');
    const reference = dto?.reference ? String(dto.reference).trim().slice(0, 64) : null;

    // scope-check the enrolment
    const eParams: unknown[] = [enrolmentId];
    const ew = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, eParams);
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.branch_id, e.vertical_id, e.lead_id
         FROM enrolment e WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${ew}`,
      eParams,
    );
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');

    // optional cited receipt must belong to this enrolment
    let feeReceiptId: number | null = null;
    if (dto?.fee_receipt_id) {
      const fr = await this.db.one<any>(
        `SELECT id FROM fee_receipt WHERE id = $1::bigint AND enrolment_id = $2::bigint AND deleted_at IS NULL`,
        [Number(dto.fee_receipt_id), enrolmentId],
      );
      if (!fr) throw new BadRequestException('That receipt is not against this enrolment.');
      feeReceiptId = Number(fr.id);
    }

    const bal = await this.refundable(enrolmentId);
    if (bal.collected <= 0) throw new BadRequestException(`${e.enrolment_no} has no collected fee to refund.`);
    if (amount_minor > bal.refundable) {
      throw new BadRequestException(
        `That is more than can be refunded. Collected ${formatINR(bal.collected)}, `
        + `already refunded ${formatINR(bal.approved)}${bal.pending ? `, ${formatINR(bal.pending)} awaiting approval` : ''}. `
        + `You can refund up to ${formatINR(bal.refundable)}.`,
      );
    }

    const policy = await this.policy();
    const requiresHigh = needsHighApproval(policy, amount_minor);
    const orgId = await this.orgId();

    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO refund (org_id, enrolment_id, fee_receipt_id, lead_id, branch_id, vertical_id,
                           amount_minor, reason, mode, reference, status, requires_high,
                           requested_by, note)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
               $7::bigint, $8, $9::varchar, $10, 'pending', $11::boolean, $12::bigint, $13)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [orgId, enrolmentId, feeReceiptId, e.lead_id, e.branch_id, e.vertical_id,
        amount_minor, reason, mode, reference, requiresHigh, me.id, dto?.note ?? null],
    );
    if (!rows.length) throw new BadRequestException('An identical refund request is already pending for this enrolment.');
    const id = Number(rows[0].id);

    await this.db.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
       SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint FROM lead l WHERE l.id = $1::bigint`,
      [e.lead_id, `Refund requested ${formatINR(amount_minor)} (${MODE_LABELS[mode]}) — ${reason}`, me.id],
    );
    await this.notifyApprovers(e.enrolment_no, Number(e.branch_id), Number(e.lead_id), amount_minor, requiresHigh, policy);
    return { id, status: 'pending', requires_high: requiresHigh, amount_minor };
  }

  /** Tell the approvers — through the SAME NotifierService the enrolment approvals use. */
  private async notifyApprovers(enrolmentNo: string, branchId: number, leadId: number, amountMinor: number, requiresHigh: boolean, policy: RefundPolicy) {
    if (!this.notifier) return;
    const roles = [...new Set(requiresHigh ? (policy.high_roles ?? []) : (policy.roles ?? []))];
    if (!roles.length) return;
    const approvers = await this.db.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM "user" u
         JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
         JOIN role r ON r.id = ua.role_id
        WHERE r.name = ANY($1::text[]) AND u.is_active AND u.deleted_at IS NULL
          AND (ua.branch_id IS NULL OR ua.branch_id = $2::bigint)`,
      [roles, branchId],
    );
    try {
      await this.notifier.notifyMany(approvers.map((a) => Number(a.id)), {
        type: 'approval', severity: 'warn',
        title: `Refund of ${formatINR(amountMinor)} on ${enrolmentNo} needs approval`,
        body: requiresHigh ? 'High-value refund — a senior approver is required.' : 'A refund is awaiting approval.',
        link: { type: 'lead', id: leadId },
        meta: { enrolment_no: enrolmentNo, amount_minor: amountMinor, requires_high: requiresHigh },
      });
    } catch { /* a notification is not the refund */ }
  }

  /**
   * DECIDE — approve or reject. `canHigh` says whether the caller holds refund.approve_high
   * (the controller resolves it). Nobody approves their own request. On APPROVE we lock the
   * enrolment, re-check refundability (so a race cannot over-refund), allocate the voucher
   * number, and stamp the refund — inside ONE transaction.
   */
  async decide(id: number, approve: boolean, note: string | null, me: { id: number }, scope: ResolvedScope, canHigh: boolean) {
    const rf = await this.get(id, scope);
    if (rf.status !== 'pending') throw new BadRequestException(`This refund was already ${rf.status}.`);
    if (Number(rf.requested_by) === Number(me.id)) {
      throw new BadRequestException('You cannot approve your own refund request. Ask another approver.');
    }
    if (approve && rf.requires_high && !canHigh) {
      throw new ForbiddenException('This is a high-value refund — it needs a senior approver (refund.approve_high).');
    }

    if (!approve) {
      await this.db.query(
        `UPDATE refund SET status = 'rejected', approver_id = $2::bigint, decided_at = now(), decide_note = $3
          WHERE id = $1::bigint AND status = 'pending'`,
        [id, me.id, note],
      );
      await this.db.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
         SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint FROM lead l WHERE l.id = $1::bigint`,
        [rf.lead_id, `Refund of ${formatINR(Number(rf.amount_minor))} REJECTED${note ? ` — ${note}` : ''}`, me.id],
      );
      await this.notifyOutcome(rf, false);
      return { id, status: 'rejected' };
    }

    const out = await this.db.tx(async (c) => {
      // LOCK the enrolment; re-check refundability under the lock.
      await c.query(`SELECT id FROM enrolment WHERE id = $1::bigint FOR UPDATE`, [rf.enrolment_id]);
      const bal = await c.query<any>(
        `SELECT
           COALESCE((SELECT sum(x.amount_minor) FROM fee_receipt x WHERE x.enrolment_id = $1::bigint AND x.deleted_at IS NULL), 0) AS collected,
           COALESCE((SELECT sum(x.amount_minor) FROM refund x WHERE x.enrolment_id = $1::bigint AND x.status = 'approved' AND x.deleted_at IS NULL), 0) AS approved`,
        [rf.enrolment_id],
      );
      const collected = Number(bal.rows[0].collected);
      const approved = Number(bal.rows[0].approved);
      const amount = Number(rf.amount_minor);
      if (approved + amount > collected) {
        throw new BadRequestException(
          `Cannot approve: it would refund more than was collected. Collected ${formatINR(collected)}, already refunded ${formatINR(approved)}.`,
        );
      }
      const refundNo = await this.numbering.allocate(
        'refund', { branch_id: Number(rf.branch_id), vertical_id: Number(rf.vertical_id) }, c,
      );
      const upd = await c.query(
        `UPDATE refund SET status = 'approved', refund_no = $2::varchar, approver_id = $3::bigint,
                decided_at = now(), refunded_at = now(), decide_note = $4
          WHERE id = $1::bigint AND status = 'pending'
          RETURNING id`,
        [id, refundNo, me.id, note],
      );
      if (!upd.rows.length) throw new BadRequestException('This refund was already decided.');
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
         SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint FROM lead l WHERE l.id = $1::bigint`,
        [rf.lead_id, `Refund ${refundNo} APPROVED — ${formatINR(amount)} (${MODE_LABELS[rf.mode] ?? rf.mode})`, me.id],
      );
      return { refund_no: refundNo, net_collected_minor: collected - approved - amount };
    });
    await this.notifyOutcome({ ...rf, refund_no: out.refund_no }, true);
    return { id, status: 'approved', refund_no: out.refund_no, net_collected_minor: out.net_collected_minor };
  }

  /** Refund Initiated / Completed events — notify the requester (student-facing email/SMS
   *  ties into the events catalog, task 107). Best-effort, never blocks the decision. */
  private async notifyOutcome(rf: any, approved: boolean) {
    if (!this.notifier || !rf.requested_by) return;
    try {
      await this.notifier.notifyMany([Number(rf.requested_by)], {
        type: 'system', severity: approved ? 'info' : 'warn',
        title: approved
          ? `Refund ${rf.refund_no} completed — ${formatINR(Number(rf.amount_minor))}`
          : `Refund of ${formatINR(Number(rf.amount_minor))} on ${rf.enrolment_no} was rejected`,
        body: approved ? `Refunded via ${MODE_LABELS[rf.mode] ?? rf.mode} to ${rf.student_name}.` : (rf.decide_note || ''),
        link: { type: 'lead', id: Number(rf.lead_id) },
        meta: { refund_id: Number(rf.id), enrolment_no: rf.enrolment_no },
      });
    } catch { /* notification is a courtesy */ }
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const r = await this.get(id, scope);
    if (r.status !== 'approved' || !r.refund_no) throw new BadRequestException('Only an approved refund has a voucher.');
    const lh: Letterhead = {
      org_name: r.org_name, org_gst: r.org_gst, vertical_name: r.vertical_name,
      branch_name: r.branch_name, branch_address: r.branch_address,
      branch_phone: r.branch_phone, branch_email: r.branch_email,
    };
    const collected = Number(r.collected_minor);
    const approvedRefunds = Number(r.approved_refunds_minor);
    return {
      buffer: refundVoucherPdf({
        refund_no: r.refund_no, refunded_at: r.refunded_at,
        amount_minor: Number(r.amount_minor), mode: r.mode, reference: r.reference, reason: r.reason,
        student_name: r.student_name, student_phone: r.student_phone,
        enrolment_no: r.enrolment_no, course_name: r.course_name,
        collected_minor: collected,
        net_collected_minor: collected - approvedRefunds,
        approved_by_name: r.approver_name, requested_by_name: r.requested_by_name,
      }, lh),
      filename: `${String(r.refund_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`,
    };
  }

  /** SOFT-DELETE a refund request — never an approved one (that is the record of money
   *  released; reverse it with a fresh receipt, not a delete). */
  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const r = await this.get(id, scope);
    if (r.status === 'approved') throw new BadRequestException('An approved refund cannot be deleted — it is the record of money released.');
    await this.db.query(`UPDATE refund SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deletable: [], blocked: [], count: 0 };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, REFUND_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT rf.id, rf.status, e.enrolment_no FROM refund rf JOIN enrolment e ON e.id = rf.enrolment_id
        WHERE rf.id = ANY($1::bigint[]) AND rf.deleted_at IS NULL AND ${w}`, params);
    const deletable: number[] = []; const blocked: Array<{ id: number; reason: string }> = [];
    for (const r of rows) {
      if (r.status === 'approved') blocked.push({ id: Number(r.id), reason: `${r.enrolment_no} — approved refunds are the record of money released` });
      else deletable.push(Number(r.id));
    }
    return { deletable, blocked, count: deletable.length };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const { deletable } = await this.bulkDeleteImpact(ids, scope);
    if (!deletable.length) return { deleted: 0 };
    await this.db.query(`UPDATE refund SET deleted_at = now(), deleted_by = $2::bigint WHERE id = ANY($1::bigint[])`, [deletable, me.id]);
    return { deleted: deletable.length };
  }
}
