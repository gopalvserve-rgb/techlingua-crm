import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { rupeesToMinor } from '../common/money.util';
import { ApprovalService, requiredSteps } from './approval.service';
import { requireDateString, assertDateRange } from '../common/date.util';
import { FinanceSettingsService } from '../finance/finance-settings.service';
import { DiscountMasterService } from '../finance/discount-master.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { PlanService } from '../paymentplans/plan.service';
import { stageOrdinal } from './admission-journey.util';
import { computeEnrolmentDiscount, EnrolmentDiscountType } from './discount.util';

/**
 * OVER-CAP DISCOUNT APPROVAL (dev/103) — the applied discount vs the requested discount.
 *   status 'none'     — within cap (or no cap): the full requested discount is applied.
 *   status 'pending'  — over cap by a counsellor: only UP TO THE CAP is applied now; the
 *                       excess is held until an authorized user (discount.approve) approves.
 *   status 'approved' — the full requested discount is applied (inline by an authorized user,
 *                       or after an approval decision).
 *   status 'rejected' — the over-cap request was declined; the discount stays at the cap.
 */
export type DiscountApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';
/** The discount actually applied given the request, the cap and where the request stands. */
export function appliedDiscountMinor(status: DiscountApprovalStatus, requestedMinor: number, capMinor: number | null): number {
  if ((status === 'pending' || status === 'rejected') && capMinor != null) return Math.min(requestedMinor, capMinor);
  return requestedMinor;
}

/**
 * ENROLMENT — the SALE CLOSURE record. "Sale closure = enrolment" (§5).
 *
 * =============================================================================
 * THE SEAMS — read these before extending anything here
 * =============================================================================
 * PHASE 2 (student profile & academics): `enrolment.student_profile_id` is the seam.
 *   Phase 2 creates `student_profile` and POINTS THIS COLUMN AT IT. The enrolment is
 *   not re-created, not copied and not migrated: it already carries everything Phase 2
 *   needs about the sale (course, fee, discount, plan intent, start date, branch,
 *   vertical, counsellor, and the lead it came from). `batch_id` is the same seam for
 *   batches. NOTHING in Phase 1 writes either column and no screen shows them — an
 *   empty column is a seam; a half-populated one is a migration nobody planned.
 *
 * PHASE 3 (accounts): `payment_plan` + `first_payment_minor` are INTENT — what was
 *   agreed at the desk. Phase 3 turns them into an installment SCHEDULE with dues,
 *   ageing and reminders. We deliberately generate NO schedule now: a half-built
 *   schedule that nothing maintains is worse than none, and the client would build
 *   process around it. `quotation_id` is the link Phase 3 raises the GST invoice from.
 *
 * A LEAD ENROLS ONCE — enforced by the partial UNIQUE index `uq_enrolment_lead`, not by
 * a check-then-insert. Double-clicking "Enrol" cannot create two admissions (and two
 * revenue rows in the client's month). A cancelled/rejected enrolment frees the lead.
 *
 * WINNING THE LEAD: closing a sale moves the lead to its pipeline's WON stage — because
 * "sale closure = enrolment" means the two cannot disagree. If the pipeline has no won
 * stage the enrolment still happens (a stage taxonomy is not allowed to block revenue).
 */

export const ENROLMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const PAYMENT_PLANS = ['full', 'emi_3', 'emi_6', 'custom'] as const;
export const PLAN_LABELS: Record<string, string> = {
  full: 'Full payment', emi_3: '3 installments', emi_6: '6 installments', custom: 'Custom',
};

@Injectable()
export class EnrolmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly finance?: FinanceSettingsService,
    private readonly discountMaster?: DiscountMasterService,
    private readonly rbac?: RbacDataService,
    private readonly plans?: PlanService,
  ) {}

  /** Does the user hold a permission that lets them apply an OVER-CAP discount outright
   *  (discount.approve — the client's approvers — or the legacy finance.override)? */
  private async canApproveDiscount(userId: number): Promise<boolean> {
    if (!this.rbac) return false;
    try {
      const grants = await this.rbac.loadUserGrants(userId);
      return grants.rolePermissions.some((p: any) => p.permissionKey === 'discount.approve' || p.permissionKey === 'finance.override');
    } catch { return false; }
  }

  /**
   * Resolve the applicable Discount Master cap for a (branch, vertical, course) and decide
   * how a requested discount is treated: applied in full (within cap / authorized) or held
   * at the cap with the excess pending an authorized approval.
   */
  private async decideDiscount(
    ctx: { branch_id?: number | null; vertical_id?: number | null; course_id?: number | null },
    fee_minor: number, requestedMinor: number, userId: number,
  ): Promise<{ applied: number; status: DiscountApprovalStatus; capMinor: number | null; authorized: boolean }> {
    if (!this.discountMaster || requestedMinor <= 0) {
      return { applied: requestedMinor, status: 'none', capMinor: null, authorized: true };
    }
    const { capMinor } = await this.discountMaster.resolve(ctx, fee_minor);
    if (capMinor == null || requestedMinor <= capMinor) {
      return { applied: requestedMinor, status: 'none', capMinor, authorized: true };
    }
    const authorized = await this.canApproveDiscount(userId);
    if (authorized) return { applied: requestedMinor, status: 'approved', capMinor, authorized: true };
    return { applied: capMinor, status: 'pending', capMinor, authorized: false };
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string; q?: string; from?: string; to?: string; limit?: number; lead_id?: number; origin?: string; trainer_ids?: number[] } = {}) {
    const params: unknown[] = [];
    const where = [`e.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params)];
    if (f.status) { params.push(f.status); where.push(`e.status = $${params.length}::varchar`); }
    // client 30-Aug (bug): record-payment inside a student profile must be scoped to THAT student.
    if (f.lead_id) { params.push(f.lead_id); where.push(`e.lead_id = $${params.length}::bigint`); }
    // client Sep-1 (Admissions & Enrolment tabs): ONLINE = the enrolment's student came from an
    // approved online admission; DIRECT = converted from a lead / added in Student Management.
    const ADM_EXISTS = `EXISTS (SELECT 1 FROM admission a WHERE a.student_id = e.student_profile_id AND a.deleted_at IS NULL)`;
    if (f.origin === 'online') where.push(ADM_EXISTS);
    else if (f.origin === 'direct') where.push(`NOT ${ADM_EXISTS}`);
    // client Sep-1: ERP Trainer filter — the trainer of the enrolment's batch.
    if (f.trainer_ids?.length) { params.push(f.trainer_ids); where.push(`bt.trainer_id = ANY($${params.length}::bigint[])`); }
    // DEF-DR-02: one strict validator — malformed date -> 400, not a 500 at the ::date cast.
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`e.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`e.created_at < ($${params.length}::date + 1)`); }
    // Search by enrolment number / student name / phone (dev/140 items 2 & 6 — Fee Invoice + Record Fee).
    // dev/143 (client 28aug, item 3 REDO) — Record-payment search MUST find by enrolment no,
    // student name OR phone. The previous phone match used a plain ILIKE on the stored value, so a
    // number stored formatted ("+91 98765 43210") never matched a plain-digit query ("9876543210").
    // Match phone on DIGITS-ONLY on BOTH sides so any formatting matches; keep ILIKE for no/name.
    if (f.q) {
      params.push(`%${f.q}%`);
      const like = params.length;
      const digits = String(f.q).replace(/\D+/g, '');
      if (digits) {
        params.push(`%${digits}%`);
        const dpos = params.length;
        where.push(`(e.enrolment_no ILIKE $${like} OR l.full_name ILIKE $${like} OR sp.full_name ILIKE $${like} OR regexp_replace(COALESCE(l.phone, sp.phone,''),'\\D','','g') ILIKE $${dpos})`);
      } else {
        where.push(`(e.enrolment_no ILIKE $${like} OR l.full_name ILIKE $${like} OR sp.full_name ILIKE $${like} OR l.phone ILIKE $${like})`);
      }
    }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.start_date, e.payment_plan,
              e.fee_minor, e.discount_minor, e.net_fee_minor, e.first_payment_minor,
              e.created_at, e.lead_id, e.quotation_id, e.course_id, e.course_type, e.student_profile_id, e.branch_id, e.vertical_id,
              EXISTS (SELECT 1 FROM admission a WHERE a.student_id = e.student_profile_id AND a.deleted_at IS NULL) AS from_admission,
              COALESCE(l.full_name, sp.full_name) AS lead_name, COALESCE(l.phone, sp.phone) AS lead_phone,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              e.counsellor_id, u.name AS counsellor_name, q.quote_no,
              e.batch_id, bt.name AS batch_name, bt.trainer_id, tr.name AS trainer_name,
              COALESCE(p.paid_minor, 0) AS paid_minor,
              COALESCE(e.exam_fee_minor, 0) AS exam_fee_minor,
              (e.net_fee_minor + COALESCE(e.exam_fee_minor, 0)) AS total_payable_minor,
              (e.net_fee_minor + COALESCE(e.exam_fee_minor, 0)) - COALESCE(p.paid_minor, 0) AS balance_minor
         FROM enrolment e
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN student sp ON sp.id = e.student_profile_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
         LEFT JOIN quotation q ON q.id = e.quotation_id
         LEFT JOIN batch bt ON bt.id = e.batch_id
         LEFT JOIN "user" tr ON tr.id = bt.trainer_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(fr.amount_minor), 0) AS paid_minor
             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL
         ) p ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    // "MTD" = this calendar month, in the org's timezone. date_trunc on the DB clock is
    // the same clock the targets use, so the dashboard and this card cannot disagree.
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE e.status = 'active'
                               AND e.created_at >= date_trunc('month', now())) AS mtd_count,
              COALESCE(sum(e.net_fee_minor) FILTER (WHERE e.status = 'active'
                               AND e.created_at >= date_trunc('month', now())), 0) AS mtd_revenue_minor,
              count(*) FILTER (WHERE e.status = 'pending_approval') AS pending_approval,
              COALESCE(round(avg(CASE WHEN e.status = 'active' AND e.fee_minor > 0
                                      THEN e.discount_minor::numeric * 100 / e.fee_minor END), 1), 0) AS avg_discount_pct
         FROM enrolment e
        WHERE e.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      mtd_count: Number(r?.mtd_count ?? 0),
      mtd_revenue_minor: Number(r?.mtd_revenue_minor ?? 0),
      pending_approval: Number(r?.pending_approval ?? 0),
      avg_discount_pct: Number(r?.avg_discount_pct ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.*, COALESCE(l.full_name, sp.full_name) AS lead_name, COALESCE(l.phone, sp.phone) AS lead_phone, COALESCE(l.email, sp.email) AS lead_email,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              e.counsellor_id, u.name AS counsellor_name, q.quote_no,
              COALESCE(p.paid_minor, 0) AS paid_minor,
              COALESCE(e.exam_fee_minor, 0) AS exam_fee_minor,
              (e.net_fee_minor + COALESCE(e.exam_fee_minor, 0)) AS total_payable_minor,
              (e.net_fee_minor + COALESCE(e.exam_fee_minor, 0)) - COALESCE(p.paid_minor, 0) AS balance_minor
         FROM enrolment e
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN student sp ON sp.id = e.student_profile_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
         LEFT JOIN quotation q ON q.id = e.quotation_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(fr.amount_minor), 0) AS paid_minor
             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL
         ) p ON TRUE
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!e) throw new NotFoundException('Enrolment not found');
    const receipts = await this.db.query<any>(
      `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at,
              u.name AS received_by_name
         FROM fee_receipt fr LEFT JOIN "user" u ON u.id = fr.received_by
        WHERE fr.enrolment_id = $1::bigint AND fr.deleted_at IS NULL
        ORDER BY fr.received_at DESC`,
      [id],
    );
    const approvals = await this.approvals.forEntity('enrolment', id);
    return { ...e, receipts, approvals };
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * CLOSE THE SALE.
   *
   * Order matters and is deliberate:
   *   1. the lead must be in the caller's scope (a counsellor cannot enrol someone
   *      else's lead — 404, not a sale);
   *   2. the money is normalised to exact paise and CROSS-CHECKED (net = fee - discount,
   *      recomputed here; the client never gets to post a net that disagrees);
   *   3. the approval policy decides the STATUS before anything is written, so an
   *      enrolment is never briefly `active` and then demoted;
   *   4. number, row, approval requests and the lead's WON stage all commit TOGETHER.
   */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    if (!leadId) throw new BadRequestException('Choose the lead being enrolled.');

    const lead = await this.leadInScope(leadId, scope);
    const money = this.normaliseMoney(dto);
    const courseIdForCap = dto?.course_id ? Number(dto.course_id) : null;
    // OVER-CAP APPROVAL (dev/103) — the requested discount is `money.discount_amount_minor`.
    // The Discount Master cap decides whether it applies in full or is held at the cap with
    // the excess pending an authorized approval.
    const requestedDiscountMinor = money.discount_amount_minor;
    const dd = await this.decideDiscount(
      { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id), course_id: courseIdForCap },
      money.fee_minor, requestedDiscountMinor, me.id,
    );
    const appliedDiscount = dd.applied;
    const netAfterApplied = money.fee_minor - appliedDiscount;
    const plan = String(dto?.payment_plan ?? 'full');
    if (!(PAYMENT_PLANS as readonly string[]).includes(plan)) throw new BadRequestException('Choose a valid payment plan.');
    // First payment may cover the exam fee too (exam fee is collectible on top of Net) — dev/140 item 3.
    if (money.first_payment_minor > netAfterApplied + money.exam_fee_minor) {
      throw new BadRequestException('The first payment cannot be more than the total payable.');
    }
    const startDate = this.date(dto?.start_date);
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    const counsellorId = dto?.counsellor_id ? Number(dto.counsellor_id) : (lead.owner_id ? Number(lead.owner_id) : me.id);
    const quotationId = dto?.quotation_id ? Number(dto.quotation_id) : null;
    if (quotationId) await this.assertQuotationUsable(quotationId, leadId);

    const policy = await this.approvals.policy();
    const steps = requiredSteps(policy, money);
    const status = steps.length ? 'pending_approval' : 'active';
    const orgId = await this.orgId();
    // Enrolment No — <COURSE_CODE>-<YEAR>-<NNN> (client ID re-model), sequence per course+year.
    let courseCode = 'CRS';
    let courseTypeFromMaster: string | null = null;
    if (courseId) {
      const cc = await this.db.one<{ code: string; meta: any }>(`SELECT code, meta FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
      courseCode = String(cc?.code ?? '').trim() || 'CRS';
      courseTypeFromMaster = ((cc?.meta as any)?.course_type ?? null);
    }
    // dev/143 (item 6) — course type on the enrolment: form's explicit choice else the master's.
    const courseType = (dto?.course_type != null && String(dto.course_type).trim() !== '')
      ? String(dto.course_type).trim() : courseTypeFromMaster;

    const out = await this.db.tx(async (c) => {
      const enrolmentNo = await this.numbering.allocateCoded('enrolment', courseCode, c);
      let id: number;
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO enrolment (org_id, enrolment_no, lead_id, quotation_id, branch_id, vertical_id,
                                  pipeline_id, campaign_id, counsellor_id, team_id, course_id,
                                  fee_minor, discount_minor, net_fee_minor, payment_plan,
                                  first_payment_minor, plan_note, start_date, status, remarks, created_by,
                                  gross_fee_minor, discount_type, discount_value, discount_amount_minor,
                                  discount_approval_status, discount_requested_minor, discount_cap_minor,
                                  discount_requested_by, discount_approved_by, exam_fee_minor, course_type, discount_approved_at)
           VALUES ($1::bigint, $2::varchar, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
                   $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint,
                   $12::bigint, $13::bigint, $14::bigint, $15::varchar,
                   $16::bigint, $17, $18::date, $19::varchar, $20, $21::bigint,
                   $22::bigint, $23::varchar, $24::numeric, $25::bigint,
                   $26::varchar, $27::bigint, $28::bigint, $29::bigint, $30::bigint, $31::bigint, $32::varchar,
                   CASE WHEN $26::varchar = 'approved' THEN now() ELSE NULL END)
           RETURNING id`,
          [orgId, enrolmentNo, leadId, quotationId, lead.branch_id, lead.vertical_id,
            lead.pipeline_id ?? null, lead.campaign_id ?? null, counsellorId, lead.team_id ?? null, courseId,
            money.fee_minor, appliedDiscount, netAfterApplied, plan,
            money.first_payment_minor, dto?.plan_note ?? null, startDate, status, dto?.remarks ?? null, me.id,
            money.gross_fee_minor, money.discount_type, money.discount_value, appliedDiscount,
            dd.status, requestedDiscountMinor, dd.capMinor,
            dd.status === 'pending' ? me.id : null,
            dd.status === 'approved' ? me.id : null, money.exam_fee_minor, courseType],
        );
        id = Number(r.rows[0].id);
      } catch (e) {
        // uq_enrolment_lead — a lead enrols ONCE. This is the double-click, and it is a
        // 409 with a sentence a human understands, not a raw constraint name.
        if ((e as { code?: string })?.code === '23505' && String((e as Error).message).includes('uq_enrolment_lead')) {
          throw new ConflictException(`${lead.full_name} is already enrolled. Cancel the existing enrolment first if this is a genuine re-admission.`);
        }
        throw e;
      }

      if (steps.length) {
        await this.approvals.open(c, {
          orgId, entityType: 'enrolment', entityId: id,
          branchId: Number(lead.branch_id), verticalId: Number(lead.vertical_id), requestedBy: me.id,
        }, steps);
      } else {
        await this.winLead(c, lead, me.id, enrolmentNo);
      }
      await this.activity(c, leadId, me.id,
        steps.length
          ? `Enrolment ${enrolmentNo} submitted for approval (${steps.map((s) => s.label).join(', ')})`
          : `Enrolled — ${enrolmentNo}`);
      if (dd.status === 'pending') {
        await this.activity(c, leadId, me.id,
          `Discount above cap on ${enrolmentNo} — over-cap portion held for approval (applied up to the cap ₹${((dd.capMinor ?? 0) / 100).toFixed(2)}).`);
      }
      return { id, enrolment_no: enrolmentNo };
    });

    // outside the transaction, on purpose — see notifyApprovers()
    if (steps.length) {
      await this.approvals.notifyApprovers(out.id, out.enrolment_no, Number(lead.branch_id), leadId, steps);
    }
    return {
      ...out, status, pending_steps: steps.map((s) => s.label),
      discount_approval_status: dd.status,
      discount_over_cap: dd.status === 'pending',
      discount_cap_minor: dd.capMinor,
    };
  }

  /**
   * SETTLE an enrolment after an approval decision. Called by the controller once
   * ApprovalService has recorded the vote.
   *   approved + nothing else pending -> active, and the lead is WON.
   *   rejected                        -> rejected (which frees the lead to enrol again).
   */
  async settleApproval(enrolmentId: number, approved: boolean, actorId: number) {
    // DEF-S5-01 (found by the LIVE smoke): this used to select `e.*` and hand the
    // ENROLMENT row to winLead(), which reads `lead.id` / `lead.stage_id`. So it ran
    //     UPDATE lead SET stage_id = <won> WHERE id = <the ENROLMENT's id>
    // — the WRONG ROW. It silently did nothing here only because no lead happened to
    // share an id with the enrolment; on the client's data it would eventually mark a
    // completely unrelated customer as Enrolled. The lead is now selected explicitly,
    // aliased, and its columns are named — see winLead()'s signature.
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.lead_id,
              l.id AS l_id, l.pipeline_id AS l_pipeline_id, l.stage_id AS l_stage_id, l.full_name
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL`,
      [enrolmentId],
    );
    if (!e) throw new NotFoundException('Enrolment not found');
    const lead = { id: Number(e.l_id), pipeline_id: e.l_pipeline_id, stage_id: e.l_stage_id };

    if (!approved) {
      await this.db.tx(async (c) => {
        await c.query(`UPDATE enrolment SET status = 'rejected', updated_at = now() WHERE id = $1::bigint`, [enrolmentId]);
        await this.activity(c, Number(e.lead_id), actorId, `Enrolment ${e.enrolment_no} rejected`);
      });
      return { id: enrolmentId, status: 'rejected' };
    }
    if (!await this.approvals.allCleared('enrolment', enrolmentId)) {
      // a multi-step policy: approved this step, still waiting on another
      return { id: enrolmentId, status: e.status, still_pending: true };
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET status = 'active', updated_at = now()
          WHERE id = $1::bigint AND status = 'pending_approval'`,
        [enrolmentId],
      );
      await this.winLead(c, lead, actorId, e.enrolment_no);
      await this.activity(c, Number(e.lead_id), actorId, `Enrolment ${e.enrolment_no} approved — active`);
    });
    return { id: enrolmentId, status: 'active' };
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.status === 'cancelled' || cur.status === 'rejected') {
      throw new BadRequestException(`${cur.enrolment_no} is ${cur.status} and cannot be edited.`);
    }
    const money = this.normaliseMoney({
      fee: dto?.fee, fee_minor: dto?.fee_minor ?? (dto?.fee === undefined ? cur.fee_minor : undefined),
      discount: dto?.discount,
      discount_minor: dto?.discount_minor ?? (dto?.discount === undefined ? cur.discount_minor : undefined),
      // carry the discount ENTRY MODE through an edit (a % discount re-saved stays a %),
      // defaulting to whatever the enrolment currently holds when the form omits it.
      discount_type: dto?.discount_type ?? (dto?.discount === undefined && dto?.discount_minor === undefined && dto?.discount_value === undefined ? cur.discount_type : undefined),
      discount_value: dto?.discount_value ?? (dto?.discount_type === undefined && dto?.discount === undefined && dto?.discount_minor === undefined ? cur.discount_value : undefined),
      first_payment: dto?.first_payment,
      first_payment_minor: dto?.first_payment_minor ?? (dto?.first_payment === undefined ? cur.first_payment_minor : undefined),
      // EXAM FEE (dev/140 item 3) — carry the enrolment's current exam fee through an edit that
      // does not touch it, so a fee/discount edit never silently wipes the exam fee.
      exam_fee_minor: dto?.exam_fee_minor ?? (dto?.exam_fee === undefined ? cur.exam_fee_minor : undefined),
      exam_fee: dto?.exam_fee,
    });
    // OVER-CAP APPROVAL (dev/103). The full requested discount is money.discount_amount_minor.
    const requestedFull = money.discount_amount_minor;
    const discountChanged = dto?.discount !== undefined || dto?.discount_minor !== undefined
      || dto?.discount_value !== undefined || dto?.discount_type !== undefined;
    const capCtx = {
      branch_id: cur.branch_id != null ? Number(cur.branch_id) : null,
      vertical_id: cur.vertical_id != null ? Number(cur.vertical_id) : null,
      course_id: (dto?.course_id === undefined ? cur.course_id : dto.course_id) != null
        ? Number(dto?.course_id === undefined ? cur.course_id : dto.course_id) : null,
    };
    let appliedDiscount: number;
    let appStatus: DiscountApprovalStatus;
    let capMinorVal: number | null;
    let requestedBy: number | null;
    let approvedBy: number | null;
    if (discountChanged) {
      // A fresh discount entry is re-checked against the cap from scratch.
      const dd = await this.decideDiscount(capCtx, money.fee_minor, requestedFull, me.id);
      appliedDiscount = dd.applied; appStatus = dd.status; capMinorVal = dd.capMinor;
      requestedBy = dd.status === 'pending' ? me.id : null;
      approvedBy = dd.status === 'approved' ? me.id : null;
    } else {
      // Discount entry unchanged (e.g. a fee/date edit): keep the standing approval state,
      // re-resolving the cap in case the fee (and hence a %-cap) moved.
      const { capMinor: cm } = this.discountMaster
        ? await this.discountMaster.resolve(capCtx, money.fee_minor)
        : { capMinor: cur.discount_cap_minor != null ? Number(cur.discount_cap_minor) : null };
      capMinorVal = cm;
      appStatus = (cur.discount_approval_status as DiscountApprovalStatus) ?? 'none';
      appliedDiscount = appliedDiscountMinor(appStatus, requestedFull, capMinorVal);
      requestedBy = cur.discount_requested_by != null ? Number(cur.discount_requested_by) : null;
      approvedBy = cur.discount_approved_by != null ? Number(cur.discount_approved_by) : null;
    }
    const netAfterApplied = money.fee_minor - appliedDiscount;
    // MONEY ALREADY COLLECTED IS A FACT. Lowering the net fee below what the customer
    // has already paid would silently create a refund liability we have no Phase-1
    // machinery for (refunds are Phase 3) — so it is refused, loudly.
    if (netAfterApplied + money.exam_fee_minor < Number(cur.paid_minor)) {
      throw new BadRequestException(
        `${cur.lead_name} has already paid ${(Number(cur.paid_minor) / 100).toFixed(2)}. `
        + 'The total payable cannot be set below what has been collected — refunds arrive in Phase 3.',
      );
    }
    const plan = dto?.payment_plan ?? cur.payment_plan;
    if (!(PAYMENT_PLANS as readonly string[]).includes(String(plan))) throw new BadRequestException('Choose a valid payment plan.');

    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment
            SET course_id = $2::bigint, fee_minor = $3::bigint, discount_minor = $4::bigint,
                net_fee_minor = $5::bigint, payment_plan = $6::varchar, first_payment_minor = $7::bigint,
                plan_note = $8, start_date = $9::date, counsellor_id = $10::bigint,
                remarks = $11,
                gross_fee_minor = $12::bigint, discount_type = $13::varchar,
                discount_value = $14::numeric, discount_amount_minor = $15::bigint,
                discount_approval_status = $16::varchar, discount_requested_minor = $17::bigint,
                discount_cap_minor = $18::bigint, discount_requested_by = $19::bigint,
                discount_approved_by = $20::bigint, exam_fee_minor = $21::bigint,
                discount_approved_at = CASE WHEN $16::varchar = 'approved' THEN COALESCE(discount_approved_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $1::bigint`,
        [id, dto?.course_id === undefined ? cur.course_id : (dto.course_id || null),
          money.fee_minor, appliedDiscount, netAfterApplied, plan, money.first_payment_minor,
          dto?.plan_note === undefined ? cur.plan_note : dto.plan_note,
          dto?.start_date === undefined ? cur.start_date : this.date(dto.start_date),
          dto?.counsellor_id === undefined ? cur.counsellor_id : (dto.counsellor_id || null),
          dto?.remarks === undefined ? cur.remarks : dto.remarks,
          money.gross_fee_minor, money.discount_type, money.discount_value, appliedDiscount,
          appStatus, requestedFull, capMinorVal, requestedBy, approvedBy, money.exam_fee_minor],
      );
      // Net moved → reconcile any unpaid payment-plan schedule to the new net (Due is
      // computed live everywhere as net − paid, so it reconciles regardless).
      if (this.plans && Number(cur.net_fee_minor) !== netAfterApplied) {
        try { await this.plans.reconcileToNet(c, id); } catch { /* plan reconcile is best-effort */ }
      }
      await this.activity(c, Number(cur.lead_id), me.id, `Enrolment ${cur.enrolment_no} updated`);
      if (discountChanged && appStatus === 'pending') {
        await this.activity(c, Number(cur.lead_id), me.id,
          `Discount above cap on ${cur.enrolment_no} — over-cap portion held for approval.`);
      }
    });
    return { id, ok: true, discount_approval_status: appStatus, discount_over_cap: appStatus === 'pending' };
  }

  /* ============================ OVER-CAP DISCOUNT APPROVAL (dev/103) ============================ */

  /** The pending over-cap discount queue — scoped (an approver sees their branch/vertical). */
  async pendingDiscountApprovals(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    return this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.fee_minor, e.discount_minor, e.net_fee_minor,
              e.discount_requested_minor, e.discount_cap_minor, e.discount_approval_status,
              e.created_at, l.full_name AS lead_name, l.phone AS lead_phone,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              ru.name AS requested_by_name
         FROM enrolment e
         LEFT JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" ru ON ru.id = e.discount_requested_by
        WHERE e.deleted_at IS NULL AND e.discount_approval_status = 'pending' AND ${w}
        ORDER BY e.created_at ASC
        LIMIT 200`,
      params,
    );
  }

  /** APPROVE the over-cap discount — discount.approve holder only (route-guarded). Applies the
   *  FULL requested discount, recomputes Net/Due and reconciles the plan. */
  async approveDiscount(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.discount_approval_status !== 'pending') {
      throw new BadRequestException(`${cur.enrolment_no} has no over-cap discount awaiting approval.`);
    }
    if (cur.discount_requested_by != null && Number(cur.discount_requested_by) === Number(me.id)) {
      throw new BadRequestException('You cannot approve your own discount request. Ask another authorized user.');
    }
    const requested = Number(cur.discount_requested_minor);
    const fee = Number(cur.fee_minor);
    const applied = Math.min(requested, fee);
    const net = fee - applied;
    if (net < Number(cur.paid_minor)) {
      throw new BadRequestException('Approving would set the net below what has already been collected.');
    }
    const remarks = dto?.remarks ?? dto?.note ?? null;
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET discount_minor = $2::bigint, discount_amount_minor = $2::bigint,
                net_fee_minor = $3::bigint, discount_approval_status = 'approved',
                discount_approved_by = $4::bigint, discount_approved_at = now(),
                discount_approval_remarks = $5, updated_at = now()
          WHERE id = $1::bigint`, [id, applied, net, me.id, remarks]);
      if (this.plans) { try { await this.plans.reconcileToNet(c, id); } catch { /* best-effort */ } }
      await this.activity(c, Number(cur.lead_id), me.id,
        `Over-cap discount on ${cur.enrolment_no} approved — full discount ₹${(applied / 100).toFixed(2)} applied.`);
    });
    return { id, discount_approval_status: 'approved', discount_minor: applied, net_fee_minor: net };
  }

  /** REJECT the over-cap discount — discount.approve holder only. The discount stays at the cap. */
  async rejectDiscount(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.discount_approval_status !== 'pending') {
      throw new BadRequestException(`${cur.enrolment_no} has no over-cap discount awaiting approval.`);
    }
    const remarks = String(dto?.remarks ?? dto?.reason ?? dto?.note ?? '').trim();
    if (!remarks) throw new BadRequestException('A reason (remarks) is required to reject a discount request.');
    await this.db.query(
      `UPDATE enrolment SET discount_approval_status = 'rejected', discount_approved_by = $2::bigint,
              discount_approved_at = now(), discount_approval_remarks = $3, updated_at = now()
        WHERE id = $1::bigint`, [id, me.id, remarks]);
    await this.db.tx(async (c) => {
      await this.activity(c, Number(cur.lead_id), me.id,
        `Over-cap discount on ${cur.enrolment_no} rejected — discount stays at the cap. ${remarks}`);
    });
    return { id, discount_approval_status: 'rejected', discount_minor: Number(cur.discount_minor) };
  }

  /** CANCEL — the reversible end state. It frees the lead to enrol again (the partial
   *  unique index), which is what a genuine re-admission needs. */
  async cancel(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (Number(cur.paid_minor) > 0) {
      throw new BadRequestException(
        `${cur.enrolment_no} has ${(Number(cur.paid_minor) / 100).toFixed(2)} collected against it. `
        + 'Cancelling would leave money with no enrolment — refunds are Phase 3. Delete the receipts first if they were entered in error.',
      );
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET status = 'cancelled', remarks = COALESCE($2, remarks), updated_at = now()
          WHERE id = $1::bigint`,
        [id, dto?.reason ?? null],
      );
      await c.query(
        `UPDATE approval_request SET status = 'rejected', decided_at = now(), note = 'Enrolment cancelled'
          WHERE entity_type = 'enrolment' AND entity_id = $1::bigint AND status = 'pending'`,
        [id],
      );
      await this.activity(c, Number(cur.lead_id), me.id, `Enrolment ${cur.enrolment_no} cancelled`);
    });
    return { id, status: 'cancelled' };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (Number(cur.paid_minor) > 0) {
      throw new BadRequestException(`${cur.enrolment_no} has receipts against it and cannot be deleted.`);
    }
    await this.db.query(`UPDATE enrolment SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Money in, exactly. `net = fee - discount` is RECOMPUTED here — the client may send a
   * net, and we ignore it. A net that disagrees with its own fee and discount is the
   * kind of thing that is only discovered by an accountant, in April.
   */
  normaliseMoney(dto: any): { fee_minor: number; discount_minor: number; net_fee_minor: number; first_payment_minor: number;
      discount_type: EnrolmentDiscountType; discount_value: number; gross_fee_minor: number; discount_amount_minor: number;
      exam_fee_minor: number } {
    const m = (rup: unknown, minor: unknown, label: string): number => {
      try {
        const v = minor !== undefined && minor !== null ? Math.trunc(Number(minor)) : rupeesToMinor(rup);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${label} cannot be negative`);
        return v;
      } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
    };
    const fee_minor = m(dto?.fee, dto?.fee_minor, 'Total fee');

    // ITEM 4 — a discount is EITHER an amount (₹) OR a percentage (%), on the gross fee. The
    // discount AMOUNT + NET are recomputed here (the client never dictates the net). Legacy
    // callers that send only `discount`/`discount_minor` are read as an amount discount.
    const rawType = String(dto?.discount_type ?? '').trim().toLowerCase();
    let discount: ReturnType<typeof computeEnrolmentDiscount>;
    if (rawType === 'percent') {
      const pct = Number(dto?.discount_value ?? dto?.discount_pct ?? 0);
      try { discount = computeEnrolmentDiscount(fee_minor, 'percent', pct); }
      catch (e) { throw new BadRequestException((e as Error).message); }
    } else if (rawType === 'amount') {
      const amt = dto?.discount_value != null && String(dto.discount_value).trim() !== ''
        ? m(undefined, dto.discount_value, 'Discount') : m(dto?.discount, dto?.discount_minor, 'Discount');
      if (amt > fee_minor) throw new BadRequestException('The discount cannot be more than the total fee.');
      discount = computeEnrolmentDiscount(fee_minor, 'amount', amt);
    } else if (rawType === 'none') {
      discount = computeEnrolmentDiscount(fee_minor, 'none', 0);
    } else {
      // no explicit type — infer from the legacy amount field.
      const amt = m(dto?.discount, dto?.discount_minor, 'Discount');
      if (amt > fee_minor) throw new BadRequestException('The discount cannot be more than the total fee.');
      discount = computeEnrolmentDiscount(fee_minor, amt > 0 ? 'amount' : 'none', amt);
    }
    const first_payment_minor = m(dto?.first_payment, dto?.first_payment_minor, 'First payment');
    // EXAM FEE (dev/140 item 3) — an add-on collected ON TOP of Net. It is NEVER discounted and
    // NEVER part of the instalment plan; it only raises Total payable and the collectible Balance.
    const exam_fee_minor = dto?.exam_fee_minor != null && String(dto.exam_fee_minor).trim() !== ''
      ? Math.max(0, Math.trunc(Number(dto.exam_fee_minor)))
      : (dto?.exam_fee != null && String(dto.exam_fee).trim() !== '' ? Math.max(0, m(dto.exam_fee, undefined, 'Exam fee')) : 0);
    return {
      fee_minor, discount_minor: discount.discount_amount_minor, net_fee_minor: discount.net_fee_minor,
      first_payment_minor,
      discount_type: discount.discount_type, discount_value: discount.discount_value,
      gross_fee_minor: discount.gross_fee_minor, discount_amount_minor: discount.discount_amount_minor,
      exam_fee_minor,
    };
  }

  /** DEF-S16-02's sibling: identical shape, one call away from the identical bug. */
  private date(v: unknown): string | null {
    return requireDateString(v, () => {
      throw new BadRequestException('The start date must be a date.');
    });
  }

  private async assertQuotationUsable(quotationId: number, leadId: number) {
    const q = await this.db.one<any>(
      `SELECT id, lead_id, status, quote_no FROM quotation WHERE id = $1::bigint AND deleted_at IS NULL`,
      [quotationId],
    );
    if (!q) throw new NotFoundException('Quotation not found');
    if (Number(q.lead_id) !== leadId) throw new BadRequestException(`${q.quote_no} belongs to a different lead.`);
    if (q.status !== 'accepted') throw new BadRequestException(`${q.quote_no} is ${q.status} — only an accepted quotation converts to an enrolment.`);
  }

  private async leadInScope(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const lw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const lead = await this.db.one<any>(
      `SELECT l.id, l.org_id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id,
              l.owner_id, l.team_id, l.full_name, l.stage_id
         FROM lead l
        WHERE l.id = $1::bigint AND l.deleted_at IS NULL AND ${lw}`,
      params,
    );
    if (!lead) throw new NotFoundException('Lead not found (or outside your access)');
    return lead;
  }

  /**
   * "Sale closure = enrolment" means the LEAD must show as won. The won stage is found
   * from the pipeline's OWN stage set by its `stage_type` tag (migration 011) — not by a
   * hard-coded name, because the client edits his stages in the Stage Configurator.
   * If the pipeline has no won stage we do NOT invent one and we do NOT fail: a stage
   * taxonomy must never block revenue.
   */
  private async winLead(
    c: any,
    /** THE LEAD — explicitly typed, because the alternative was DEF-S5-01: an `any` let
     *  settleApproval() hand this the ENROLMENT row and update the wrong lead. */
    lead: { id: number; pipeline_id: number | string | null; stage_id: number | string | null },
    actorId: number,
    enrolmentNo: string,
  ) {
    if (!lead.id) throw new Error('winLead: no lead id — refusing to update an unknown row');
    if (!lead.pipeline_id) return;
    const st = await c.query(
      `SELECT id, name FROM pipeline_stage
        WHERE pipeline_id = $1::bigint AND stage_type = 'won' AND is_active
        ORDER BY sort_order LIMIT 1`,
      [lead.pipeline_id],
    );
    const stage = st.rows[0];
    if (!stage) return;
    // dev/95 item 2 — winning a lead auto-sets its Lead Status to WON, keyed on the status
    // master CODE (not a configurable name), idempotent. Runs even when the lead is already on
    // the won stage but its status had drifted, so a converted lead always ends up status Won.
    await c.query(
      `UPDATE lead SET status_id = ms.id, updated_at = now()
         FROM m_status ms
        WHERE lead.id = $1::bigint AND ms.org_id = lead.org_id AND ms.code = 'WON'
          AND lead.status_id IS DISTINCT FROM ms.id`,
      [lead.id],
    );
    if (Number(lead.stage_id) === Number(stage.id)) return;
    await c.query(`UPDATE lead SET stage_id = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [lead.id, stage.id]);
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id, to_value)
       SELECT l.id, l.org_id, l.branch_id, 'stage_change', $2, $3::bigint, $4::jsonb
         FROM lead l WHERE l.id = $1::bigint`,
      [lead.id, `Won — enrolled (${enrolmentNo})`, actorId, JSON.stringify({ stage_id: Number(stage.id), stage: stage.name })],
    );
  }

  /** See QuotationService.activity — org_id/branch_id are NOT NULL and come from the lead. */
  private async activity(c: any, leadId: number, actorId: number, note: string) {
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
       SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
         FROM lead l WHERE l.id = $1::bigint`,
      [leadId, note, actorId],
    );
  }

  /* ======================================================================= */
  /* ADMISSION JOURNEY (migration 075) — the intake funnel + approval gates.  */
  /* The stage timeline is assembled by the shared admission-journey.util; the */
  /* transition endpoints below persist the workflow stages (approved onward)  */
  /* and write an admission_event each. Scope is enforced on load.             */
  /* ======================================================================= */

  /** A scoped, lightweight load of the columns the admission workflow needs (404 if out of scope). */
  private async admissionRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.org_id, e.branch_id, e.vertical_id, e.lead_id,
              e.student_profile_id AS student_id, e.admission_stage, e.status
         FROM enrolment e
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');
    return e;
  }

  private async hasPaymentAndInvoice(id: number): Promise<{ payment: boolean; invoice: boolean }> {
    const p = await this.db.one<any>(
      `SELECT count(*)::int AS n FROM fee_receipt WHERE enrolment_id = $1::bigint AND deleted_at IS NULL`, [id]);
    const i = await this.db.one<any>(
      `SELECT count(*)::int AS n FROM gst_invoice
        WHERE enrolment_id = $1::bigint AND deleted_at IS NULL AND status IN ('issued','paid') AND invoice_no IS NOT NULL`, [id]);
    return { payment: Number(p?.n ?? 0) > 0, invoice: Number(i?.n ?? 0) > 0 };
  }

  private async logAdmissionEvent(c: any, e: any, stage: string, note: string | null, actorId: number) {
    await c.query(
      `INSERT INTO admission_event (org_id, branch_id, vertical_id, enrolment_id, student_id, stage, note, changed_by)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::varchar, $7, $8::bigint)`,
      [e.org_id, e.branch_id ?? null, e.vertical_id ?? null, e.id, e.student_id ?? null, stage, note, actorId],
    );
  }

  /** APPROVE — only an admission.approve holder (route-guarded). Requires payment + invoice. */
  async approveAdmission(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const e = await this.admissionRow(id, scope);
    if (e.admission_stage === 'rejected') throw new BadRequestException(`${e.enrolment_no} was rejected and cannot be approved.`);
    if (stageOrdinal(e.admission_stage) >= stageOrdinal('approved')) {
      throw new BadRequestException(`${e.enrolment_no} is already past approval (${e.admission_stage}).`);
    }
    const { payment, invoice } = await this.hasPaymentAndInvoice(id);
    if (!payment || !invoice) {
      throw new BadRequestException('A payment and an invoice/receipt are required before approval.');
    }
    const remarks = dto?.remarks ?? dto?.note ?? null;
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET admission_stage = 'approved', admission_approved_by = $2::bigint,
                admission_approved_at = now(), admission_approval_remarks = $3, updated_at = now()
          WHERE id = $1::bigint`, [id, me.id, remarks]);
      await this.logAdmissionEvent(c, e, 'approved', remarks ? `Approved — ${remarks}` : 'Admission & payment approved', me.id);
    });
    return { id, admission_stage: 'approved' };
  }

  /** CONFIRM — capture the student's confirmation. Only from `approved`. */
  async confirmAdmission(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const e = await this.admissionRow(id, scope);
    if (e.admission_stage !== 'approved') {
      throw new BadRequestException(`Student confirmation is only recorded after approval. ${e.enrolment_no} is ${e.admission_stage}.`);
    }
    const via = String(dto?.student_confirmed_via ?? dto?.via ?? '').trim();
    if (!via) throw new BadRequestException('The confirmation method (student_confirmed_via) is required.');
    const note = dto?.note ?? dto?.student_confirmation_note ?? null;
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET admission_stage = 'student_confirmed', student_confirmed_at = now(),
                student_confirmed_via = $2::varchar, student_confirmation_note = $3,
                confirmation_captured_by = $4::bigint, updated_at = now()
          WHERE id = $1::bigint`, [id, via, note, me.id]);
      await this.logAdmissionEvent(c, e, 'student_confirmed', `Student confirmed via ${via}${note ? ` — ${note}` : ''}`, me.id);
    });
    return { id, admission_stage: 'student_confirmed' };
  }

  /** ADMIT — convert to admission. Only from `student_confirmed`. */
  async admitAdmission(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const e = await this.admissionRow(id, scope);
    if (e.admission_stage !== 'student_confirmed') {
      throw new BadRequestException(`Convert-to-admission is only allowed after student confirmation. ${e.enrolment_no} is ${e.admission_stage}.`);
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET admission_stage = 'admitted', admitted_at = now(), admitted_by = $2::bigint, updated_at = now()
          WHERE id = $1::bigint`, [id, me.id]);
      await this.logAdmissionEvent(c, e, 'admitted', dto?.note ?? 'Converted to admission', me.id);
    });
    return { id, admission_stage: 'admitted' };
  }

  /** REJECT — an admission.approve holder rejects with remarks (required). */
  async rejectAdmission(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const e = await this.admissionRow(id, scope);
    if (e.admission_stage === 'admitted') throw new BadRequestException(`${e.enrolment_no} is already admitted and cannot be rejected.`);
    if (e.admission_stage === 'rejected') throw new BadRequestException(`${e.enrolment_no} is already rejected.`);
    const remarks = String(dto?.remarks ?? dto?.reason ?? dto?.note ?? '').trim();
    if (!remarks) throw new BadRequestException('A reason (remarks) is required to reject an admission.');
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET admission_stage = 'rejected', admission_rejected_reason = $2,
                admission_rejected_by = $3::bigint, admission_rejected_at = now(), updated_at = now()
          WHERE id = $1::bigint`, [id, remarks, me.id]);
      await this.logAdmissionEvent(c, e, 'rejected', `Rejected — ${remarks}`, me.id);
    });
    return { id, admission_stage: 'rejected' };
  }

}
