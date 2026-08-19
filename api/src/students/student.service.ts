import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString, toDateString } from '../common/date.util';
import { normalizePhone } from '../common/phone.util';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationEventService } from '../notificationevents/notification-event.service';
import { StorageService } from '../storage/storage.service';
import { PdfAssetService } from '../storage/pdf-asset.service';
import { studentIdCardPdf, StudentIdCardDoc, Letterhead } from '../pdf/documents';
import { RbacDataService } from '../rbac/rbac-data.service';
import { studentLmsAccess, canViewMaterial, canAttempt, SENSITIVE_STATUSES, REVENUE_CANCELLING_STATUSES, lmsBlockedMessage, combineAccess, ENROLMENT_STATUSES } from './lms-access';
import { assembleAdmissionJourney } from '../enrolments/admission-journey.util';
import { computeEnrolmentDiscount, EnrolmentDiscountType } from '../enrolments/discount.util';
import { DiscountScope, MasterLevel, ResolvedLevel, resolveLevels, sumLevelDiscounts, sumLevelFees } from '../enrolments/level.util';
import { Frequency, PlanType, generateSchedule } from '../paymentplans/schedule.util';
import { FinanceSettingsService } from '../finance/finance-settings.service';
import { DiscountMasterService } from '../finance/discount-master.service';
import { DiscountApprovalStatus } from '../enrolments/enrolment.service';

/**
 * STUDENT — the PHASE-2 student profile. A student is born TWO ways:
 *   (a) CONVERT a won lead (§5 lead→student) — carries the lead's name/phones/email/scope/
 *       course/owner and links the enrolment seam; or
 *   (b) ADD directly (the Admission form) — a lead-less student the desk types in full.
 *
 * Either way the profile is the SAME wide row (migration 046): Identity / Contact /
 * Guardian / Address / ID Proofs / Education. Student ID and Enrollment No are minted from
 * the numbering series (kinds 'student' / 'enrollment'), inside the create transaction, so a
 * rolled-back create never burns a number (the enrolment-number rule, mirrored).
 *
 * =============================================================================
 * HOW A STUDENT RELATES TO AN ENROLMENT — the seam Sprint 5 left (029 §"THE SEAMS")
 * =============================================================================
 * Sprint 5's `enrolment` is the SALE CLOSURE and carries two empty seam columns:
 * `student_profile_id` and `batch_id`. A CONVERT fills student_profile_id both ways.
 *
 * ONE LEAD -> ONE LIVE STUDENT (`uq_student_lead`), so Convert is idempotent. A directly-
 * added student has lead_id NULL (046 dropped the NOT NULL); NULLs are distinct in the
 * partial unique index, so any number of lead-less students coexist.
 *
 * SENSITIVE FIELDS (aadhaar / pan / passport) are stored as-is and NEVER logged — this
 * service echoes them only in the row it returns to the authorised caller.
 */

export const STUDENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id',
  vertical: 's.vertical_id', pipeline: 's.pipeline_id', campaign: 's.campaign_id',
};

/** Enrolment scope columns — a per-course enrolment is scoped on its OWN branch/vertical/
 *  counsellor (mirrors EnrolmentService), so the per-enrolment status endpoints enforce the
 *  same boundary as the enrolment module. */
export const ENROLMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

/** The Guardian Relation and ID Proof and Gender option sets the form offers. Kept lax
 *  (stored as-is) — the client may add options — but the known set documents intent. */
const GENDERS = ['Male', 'Female', 'Other'];

@Injectable()
export class StudentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    /** Notification Events — fires `lead_converted` + `enrollment_created`. Optional. */
    private readonly notifEvents?: NotificationEventService,
    private readonly storage?: StorageService,
    /** RBAC grants — to check the SECONDARY `student.status_manage` permission for sensitive
     *  status changes (the route guard is student.update; the sensitive gate is here). */
    private readonly rbacData?: RbacDataService,
    /** Finance caps — enforce the discount capping (%/₹) on enrolment discounts (item 4). */
    private readonly finance?: FinanceSettingsService,
    /** Generated PDFs to R2 (+ generated_document index) — powers the printable ID card. */
    private readonly pdfAssets?: PdfAssetService,
    /** Discount Master (dev/103) — resolves the over-cap approval decision on the SAVE path
     *  (convert / add-enrolment / edit), so an over-cap discount is capped + held pending
     *  instead of being silently applied in full (DEF-4, dev/104). */
    private readonly discountMaster?: DiscountMasterService,
  ) {}

  /* ------------------------------------ over-cap discount decision (dev/103, DEF-4) */

  /** Does the user hold a permission that lets them apply an OVER-CAP discount outright
   *  (discount.approve — the client's approvers — or the legacy finance.override)?
   *  Mirrors EnrolmentService.canApproveDiscount so convert/add behave like the enrolment path. */
  private async canApproveDiscount(userId: number): Promise<boolean> {
    if (!this.rbacData) return false;
    try {
      const grants = await this.rbacData.loadUserGrants(userId);
      return grants.rolePermissions.some((p: any) => p.permissionKey === 'discount.approve' || p.permissionKey === 'finance.override');
    } catch { return false; }
  }

  /**
   * Resolve the Discount Master cap for a (branch, vertical, course) and decide how a requested
   * discount is treated on SAVE — applied in full (within cap / authorised) or held at the cap
   * with the excess pending an authorised approval. Identical semantics to
   * EnrolmentService.decideDiscount so convert / add-enrolment enforce the SAME cap the edit
   * (PATCH /enrolments/:id) path already does.
   */
  private async decideMasterDiscount(
    ctx: { branch_id?: number | null; vertical_id?: number | null; course_id?: number | null },
    feeMinor: number, requestedMinor: number, userId: number,
  ): Promise<{ applied: number; status: DiscountApprovalStatus; capMinor: number | null;
      requestedBy: number | null; approvedBy: number | null }> {
    if (!this.discountMaster || requestedMinor <= 0) {
      return { applied: requestedMinor, status: 'none', capMinor: null, requestedBy: null, approvedBy: null };
    }
    const { capMinor } = await this.discountMaster.resolve(ctx, feeMinor);
    if (capMinor == null || requestedMinor <= capMinor) {
      return { applied: requestedMinor, status: 'none', capMinor, requestedBy: null, approvedBy: null };
    }
    const authorized = await this.canApproveDiscount(userId);
    if (authorized) return { applied: requestedMinor, status: 'approved', capMinor, requestedBy: null, approvedBy: userId };
    return { applied: capMinor, status: 'pending', capMinor, requestedBy: userId, approvedBy: null };
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** The FIXED org/centre code that prefixes every Student ID (`<CENTRE_CODE>-<YEAR>-<NNN>`).
   *  Set once in Settings › Student ID centre code (`app_setting.student_centre_code`), NOT
   *  derived per branch. Defaults to VP001 so a fresh DB never fails to mint a Student ID. */
  private async centreCode(): Promise<string> {
    const row = await this.db.one<{ value: any }>(`SELECT value FROM app_setting WHERE key = 'student_centre_code'`);
    const raw: any = row?.value;
    const v = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.code ?? raw.value ?? '') : '');
    return String(v || 'VP001').trim().toUpperCase() || 'VP001';
  }

  /** ITEM 4 — resolve an enrolment's discount from the form. A discount is EITHER an amount
   *  (₹, paise) OR a percentage (%) on the gross fee; the discount AMOUNT + NET are computed
   *  here (never trust a client net). Legacy payloads (only discount_minor) read as an amount.
   *  Then enforce the finance discount cap (%/₹) — over-cap throws 400. `skipCap` bypasses that
   *  legacy hard-throw on the paths where the Discount Master over-cap decision governs instead
   *  (convert / add-enrolment), so an over-cap discount is capped + held pending, not rejected
   *  (DEF-4, dev/104). */
  private async resolveDiscount(feeMinor: number, dto: any, verticalId: number | null, actorId: number, skipCap = false) {
    const rawType = String(dto?.discount_type ?? '').trim().toLowerCase();
    let type: EnrolmentDiscountType; let value: number;
    if (rawType === 'percent') { type = 'percent'; value = Number(dto?.discount_value ?? 0); }
    else if (rawType === 'amount') {
      type = 'amount';
      value = dto?.discount_value != null && String(dto.discount_value).trim() !== ''
        ? Math.trunc(Number(dto.discount_value)) : Math.trunc(Number(dto?.discount_minor ?? 0));
    } else if (rawType === 'none') { type = 'none'; value = 0; }
    else { const amt = Math.trunc(Number(dto?.discount_minor ?? 0)); type = amt > 0 ? 'amount' : 'none'; value = amt; }
    let d;
    try { d = computeEnrolmentDiscount(feeMinor, type, value); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    if (this.finance && !skipCap) {
      await this.finance.assertAllowed({
        verticalId, userId: actorId, kind: 'discount',
        base: d.gross_fee_minor, discount: d.discount_amount_minor, label: 'Enrolment discount',
      });
    }
    return d;
  }

  /* ------------------------------------------------ level line-items (batch 2) */

  /** Load a course's master levels (code + fee snapshot source) for resolving a selection. */
  private async fetchMasterLevels(courseId: number): Promise<MasterLevel[]> {
    const rows = await this.db.query<any>(
      `SELECT id, code, label, fee_minor FROM course_level
        WHERE course_id = $1::bigint AND is_active ORDER BY ordering, id`, [courseId]);
    return rows.map((r) => ({ id: Number(r.id), code: String(r.code), label: r.label ?? null, fee_minor: Number(r.fee_minor ?? 0) }));
  }

  /**
   * ENROLLMENT LEVEL RE-MODEL (batch 2). Given a course + the selected `levels[]`, resolve the
   * line-items (snapshot each level's fee), compute the COMBINED Total = Σ level fees, apply the
   * discount OVERALL (on the total, via the item-4 discount path) or LEVEL-wise (Σ per-line
   * discounts), and return Net = Total − Discount. Reuses the finance cap check. Returns null
   * when no levels were selected (the caller then falls back to the single-course fee — the
   * unchanged, back-compatible path for a course without levels).
   */
  private async resolveLevelMoney(
    courseId: number, levelsInput: unknown, dto: any, verticalId: number | null, actorId: number, skipCap = false,
  ): Promise<null | {
    levels: ResolvedLevel[]; scope: DiscountScope; total_fee_minor: number; discount_minor: number; net_fee_minor: number;
    discount_type: EnrolmentDiscountType; discount_value: number;
  }> {
    if (!Array.isArray(levelsInput) || levelsInput.length === 0) return null;
    const master = await this.fetchMasterLevels(courseId);
    if (!master.length) throw new BadRequestException('This course has no levels configured — enrol it on its Standard Fee instead.');
    const scope: DiscountScope = String(dto?.discount_scope ?? '').trim().toLowerCase() === 'level' ? 'level' : 'overall';
    let levels: ResolvedLevel[];
    try { levels = resolveLevels(master, levelsInput, scope); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    if (!levels.length) return null;
    const total = sumLevelFees(levels);

    if (scope === 'level') {
      const discount = sumLevelDiscounts(levels);
      if (discount > total) throw new BadRequestException('The level discounts cannot exceed the total fee.');
      if (this.finance && !skipCap) {
        await this.finance.assertAllowed({
          verticalId, userId: actorId, kind: 'discount', base: total, discount, label: 'Enrolment discount',
        });
      }
      return { levels, scope, total_fee_minor: total, discount_minor: discount, net_fee_minor: total - discount,
        discount_type: discount > 0 ? 'amount' : 'none', discount_value: discount };
    }
    // OVERALL — one discount on the summed total (the item-4 amount/percent path).
    const d = await this.resolveDiscount(total, dto, verticalId, actorId, skipCap);
    return { levels, scope, total_fee_minor: total, discount_minor: d.discount_amount_minor, net_fee_minor: d.net_fee_minor,
      discount_type: d.discount_type, discount_value: d.discount_value };
  }

  /** Insert an enrolment's level line-items (one row per selected level). Same client `c`. */
  private async insertEnrolmentLevels(c: any, orgId: number, enrolmentId: number, levels: ResolvedLevel[]) {
    for (const l of levels) {
      await c.query(
        `INSERT INTO enrolment_level (org_id, enrolment_id, course_level_id, code, label, fee_minor, discount_minor, ordering)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4::varchar,$5,$6::bigint,$7::bigint,$8::int)`,
        [orgId, enrolmentId, l.course_level_id, l.code, l.label, l.fee_minor, l.discount_minor, l.ordering]);
    }
  }

  /** The level line-items of a set of enrolments, grouped by enrolment_id (for reads). */
  private async levelsByEnrolment(enrolmentIds: number[]): Promise<Map<number, any[]>> {
    const map = new Map<number, any[]>();
    if (!enrolmentIds.length) return map;
    const rows = await this.db.query<any>(
      `SELECT enrolment_id, course_level_id, code, label, fee_minor, discount_minor, ordering
         FROM enrolment_level WHERE enrolment_id = ANY($1::bigint[]) ORDER BY enrolment_id, ordering, id`,
      [enrolmentIds]);
    for (const r of rows) {
      const eid = Number(r.enrolment_id);
      if (!map.has(eid)) map.set(eid, []);
      map.get(eid)!.push({
        course_level_id: r.course_level_id != null ? Number(r.course_level_id) : null,
        code: r.code, label: r.label ?? r.code,
        fee_minor: Number(r.fee_minor ?? 0), discount_minor: Number(r.discount_minor ?? 0), ordering: Number(r.ordering ?? 0),
      });
    }
    return map;
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: {
    branch_id?: string; vertical_id?: string; course_id?: string; owner_id?: string;
    status?: string; q?: string; from?: string; to?: string; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const where = [`s.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params)];

    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('s.branch_id', f.branch_id);
    multi('s.vertical_id', f.vertical_id);
    multi('s.course_id', f.course_id);
    multi('s.owner_id', f.owner_id);
    // Multi-select STATUS filter (lifecycle codes, comma-joined). Genuinely narrows the list.
    const statusCodes = String(f.status ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (statusCodes.length) { params.push(statusCodes); where.push(`s.status = ANY($${params.length}::varchar[])`); }

    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`s.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`s.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.student_no ILIKE $${params.length} OR s.customer_no ILIKE $${params.length} OR s.enrollment_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));

    return this.db.query<any>(
      `SELECT s.id, s.student_no, s.customer_no, s.enrollment_no, s.full_name, s.phone, s.email, s.status,
              sd.label AS status_label, sd.lms_access, s.status_changed_at,
              s.branch_id, s.vertical_id, s.course_id, s.batch_id, s.owner_id,
              s.enrolment_id, s.created_at, s.lead_id,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              u.name AS owner_name, bt.name AS batch_name, e.enrolment_no,
              -- Item 7 (client feedback): the Course column must show the CONVERTED course(s) —
              -- every course the student is actually enrolled in (created at convert time + any
              -- added later), across verticals — NOT the stale lead/course_id. Names (comma-
              -- joined, de-duped) so the column is readable AND exportable.
              (SELECT string_agg(DISTINCT co.name, ', ' ORDER BY co.name)
                 FROM enrolment en JOIN m_course co ON co.id = en.course_id
                WHERE en.deleted_at IS NULL AND co.name IS NOT NULL
                  AND (en.student_profile_id = s.id OR en.id = s.enrolment_id)) AS courses
         FROM student s
         LEFT JOIN student_status_def sd ON sd.code = s.status
         LEFT JOIN branch  b  ON b.id = s.branch_id
         LEFT JOIN vertical v ON v.id = s.vertical_id
         LEFT JOIN m_course c ON c.id = s.course_id
         LEFT JOIN "user"  u  ON u.id = s.owner_id
         LEFT JOIN batch   bt ON bt.id = s.batch_id
         LEFT JOIN enrolment e ON e.id = s.enrolment_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT s.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              u.name AS owner_name, bt.name AS batch_name, e.enrolment_no, e.net_fee_minor,
              l.full_name AS lead_name, st.name AS state_name, ci.name AS city_name,
              sd.label AS status_label, sd.lms_access, sd.meaning AS status_meaning,
              sd.is_terminal AS status_is_terminal,
              apu.name AS status_approved_by_name, chu.name AS status_changed_by_name
         FROM student s
         LEFT JOIN student_status_def sd ON sd.code = s.status
         LEFT JOIN "user" apu ON apu.id = s.status_approved_by
         LEFT JOIN "user" chu ON chu.id = s.status_changed_by
         LEFT JOIN branch  b  ON b.id = s.branch_id
         LEFT JOIN vertical v ON v.id = s.vertical_id
         LEFT JOIN m_course c ON c.id = s.course_id
         LEFT JOIN "user"  u  ON u.id = s.owner_id
         LEFT JOIN batch   bt ON bt.id = s.batch_id
         LEFT JOIN enrolment e ON e.id = s.enrolment_id
         LEFT JOIN lead l ON l.id = s.lead_id
         LEFT JOIN state st ON st.id = s.state_id
         LEFT JOIN city  ci ON ci.id = s.city_id
        WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!row) throw new NotFoundException('Student not found (or outside your access)');
    return row;
  }

  /* ------------------------------------------------------ family / siblings */
  /**
   * FAMILY / SIBLINGS (ERP Batch 3). Students of one family share a `family_group_id`; the
   * siblings of a student are simply the OTHER members of that group — symmetric, so they are
   * discoverable from either student, and ready for the Phase-3 sibling discount. Every read is
   * scope-filtered like the directory; linking/unlinking reuses student.update.
   */
  async siblings(id: number, scope: ResolvedScope) {
    const me = await this.get(id, scope);              // scope + existence
    if (!me.family_group_id) return [];
    const params: unknown[] = [Number(me.family_group_id), id];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    return this.db.query<any>(
      `SELECT s.id, s.full_name, s.student_no, s.status, s.phone,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM student s
         LEFT JOIN branch  b ON b.id = s.branch_id
         LEFT JOIN vertical v ON v.id = s.vertical_id
         LEFT JOIN m_course c ON c.id = s.course_id
        WHERE s.family_group_id = $1::bigint AND s.id <> $2::bigint AND s.deleted_at IS NULL AND ${w}
        ORDER BY s.full_name`, params);
  }

  async linkSibling(id: number, siblingId: unknown, me: { id: number }, scope: ResolvedScope) {
    const sid = Number(siblingId);
    if (!Number.isFinite(sid) || sid <= 0) throw new BadRequestException('Choose a student to link as a sibling.');
    const a = await this.get(id, scope);
    const b = await this.get(sid, scope);
    if (Number(a.id) === Number(b.id)) throw new BadRequestException('A student cannot be their own sibling.');
    const ga = a.family_group_id ? Number(a.family_group_id) : null;
    const gb = b.family_group_id ? Number(b.family_group_id) : null;
    return this.db.tx(async (c) => {
      if (ga && gb) {
        if (ga === gb) return { linked: true, family_group_id: ga };
        await c.query(`UPDATE student SET family_group_id = $1::bigint WHERE family_group_id = $2::bigint`, [ga, gb]);
        return { linked: true, family_group_id: ga };
      }
      if (ga) { await c.query(`UPDATE student SET family_group_id = $1::bigint WHERE id = $2::bigint`, [ga, b.id]); return { linked: true, family_group_id: ga }; }
      if (gb) { await c.query(`UPDATE student SET family_group_id = $1::bigint WHERE id = $2::bigint`, [gb, a.id]); return { linked: true, family_group_id: gb }; }
      const orgId = await this.orgId();
      const g = await c.query<{ id: string }>(`INSERT INTO family_group (org_id, created_by) VALUES ($1::bigint, $2::bigint) RETURNING id`, [orgId, me.id]);
      const group = Number(g.rows[0].id);
      await c.query(`UPDATE student SET family_group_id = $1::bigint WHERE id = ANY($2::bigint[])`, [group, [a.id, b.id]]);
      return { linked: true, family_group_id: group };
    });
  }

  async unlinkSibling(id: number, _me: { id: number }, scope: ResolvedScope) {
    const a = await this.get(id, scope);
    if (!a.family_group_id) return { unlinked: true };
    const group = Number(a.family_group_id);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE student SET family_group_id = NULL WHERE id = $1::bigint`, [id]);
      const rest = await c.query<{ id: string }>(`SELECT id FROM student WHERE family_group_id = $1::bigint AND deleted_at IS NULL`, [group]);
      if (rest.rows.length <= 1) await c.query(`UPDATE student SET family_group_id = NULL WHERE family_group_id = $1::bigint`, [group]);
    });
    return { unlinked: true };
  }

  /**
   * THE STUDENT PROFILE AGGREGATE — the client's exact ask: "open any student -> show the
   * complete profile in tab format, each and everything." ONE scoped read returns every
   * section the tabbed detail view renders, each pulled from the module that owns it:
   *   identity/contact/family/address/id/education  -> the student row (this.get, scoped)
   *   siblings                                       -> family_group linkage (this.siblings)
   *   academics.batch (current + transfer history + waitlist), attendance (summary + records),
   *   tests & scores, assignments & submissions      -> the ERP Batch-1 academics tables
   *   certificates, report cards                     -> the ERP Batch-2 learning tables
   *   fees (enrolment + receipts + collection summary) -> the Sprint-5 fees tables
   *
   * The student is scope-validated FIRST (this.get throws 404 outside the caller's access);
   * every child row belongs to that student, so it inherits the same scope — a counsellor can
   * never open another branch's student, and therefore never see its academics or fees.
   * Sensitive ID fields (aadhaar/pan/passport) ride along in the student row as elsewhere and
   * are NEVER logged (the audit interceptor redacts them).
   */
  async profile(id: number, scope: ResolvedScope) {
    const student = await this.get(id, scope);           // scope + existence (throws 404)
    const sid = Number(student.id);
    const siblings = await this.siblings(id, scope);

    // --- Academics: batch history + live waitlist -----------------------------
    const transfers = await this.db.query<any>(
      `SELECT bt.id, bt.from_batch_id, bt.to_batch_id, bt.reason, bt.created_at,
              fb.name AS from_batch_name, tb.name AS to_batch_name, u.name AS transferred_by_name
         FROM batch_transfer bt
         LEFT JOIN batch fb ON fb.id = bt.from_batch_id
         LEFT JOIN batch tb ON tb.id = bt.to_batch_id
         LEFT JOIN "user" u ON u.id = bt.transferred_by
        WHERE bt.student_id = $1::bigint
        ORDER BY bt.created_at DESC`, [sid]);
    const waitlist = await this.db.query<any>(
      `SELECT w.id, w.batch_id, w.status, w.position, w.created_at, b.name AS batch_name
         FROM batch_waitlist w LEFT JOIN batch b ON b.id = w.batch_id
        WHERE w.student_id = $1::bigint AND w.status = 'waiting'
        ORDER BY w.position ASC`, [sid]);

    // --- BRANCH transfers (student moved between branches/verticals) -----------
    const branch_transfers = await this.db.query<any>(
      `SELECT t.id, t.from_branch_id, t.to_branch_id, t.from_vertical_id, t.to_vertical_id,
              t.from_batch_id, t.to_batch_id, t.reason, t.created_at,
              fb.name AS from_branch_name, tb.name AS to_branch_name,
              fv.name AS from_vertical_name, tv.name AS to_vertical_name,
              fbt.name AS from_batch_name, tbt.name AS to_batch_name, u.name AS transferred_by_name
         FROM student_transfer t
         LEFT JOIN branch  fb  ON fb.id = t.from_branch_id
         LEFT JOIN branch  tb  ON tb.id = t.to_branch_id
         LEFT JOIN vertical fv ON fv.id = t.from_vertical_id
         LEFT JOIN vertical tv ON tv.id = t.to_vertical_id
         LEFT JOIN batch   fbt ON fbt.id = t.from_batch_id
         LEFT JOIN batch   tbt ON tbt.id = t.to_batch_id
         LEFT JOIN "user"  u   ON u.id = t.transferred_by
        WHERE t.student_id = $1::bigint
        ORDER BY t.created_at DESC`, [sid]);

    // --- Profile photo (R2) — the student's uploaded 'photo' document, presigned (5 min). --
    let photo_url: string | null = null;
    try {
      const ph = await this.db.one<any>(
        `SELECT id, r2_key, file_name FROM student_document
          WHERE student_id = $1::bigint AND doc_type = 'photo' AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`, [sid]);
      if (ph?.r2_key && this.storage) {
        photo_url = await this.storage.presignGet(String(ph.r2_key), 300, String(ph.file_name ?? 'photo'));
      }
    } catch { /* avatar falls back to initials */ }

    // --- Attendance: summary + recent records ---------------------------------
    const attKpi = await this.db.one<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'present')::int AS present,
              count(*) FILTER (WHERE status = 'absent')::int  AS absent,
              count(*) FILTER (WHERE status = 'late')::int    AS late,
              count(*) FILTER (WHERE status = 'excused')::int AS excused,
              count(*) FILTER (WHERE status = 'half_day')::int AS half_day
         FROM attendance WHERE student_id = $1::bigint AND deleted_at IS NULL`, [sid]);
    const attTotal = Number(attKpi?.total ?? 0);
    const attPresent = Number(attKpi?.present ?? 0);
    const attendance_records = await this.db.query<any>(
      `SELECT a.id, a.session_date, a.status, a.mode, a.remarks, b.name AS batch_name
         FROM attendance a LEFT JOIN batch b ON b.id = a.batch_id
        WHERE a.student_id = $1::bigint AND a.deleted_at IS NULL
        ORDER BY a.session_date DESC LIMIT 100`, [sid]);

    // --- Tests & scores -------------------------------------------------------
    const tests = await this.db.query<any>(
      `SELECT sc.id, t.name AS test_name, t.test_type, t.test_date, t.max_marks, t.pass_marks,
              sc.marks_obtained, sc.grade, sc.remarks, b.name AS batch_name
         FROM assessment_score sc
         JOIN assessment_test t ON t.id = sc.test_id
         LEFT JOIN batch b ON b.id = t.batch_id
        WHERE sc.student_id = $1::bigint AND sc.deleted_at IS NULL AND t.deleted_at IS NULL
        ORDER BY t.test_date DESC NULLS LAST, t.id DESC LIMIT 200`, [sid]);

    // --- Assignments & submissions --------------------------------------------
    const assignments = await this.db.query<any>(
      `SELECT su.id, a.title, a.due_date, a.max_marks, su.status, su.submission_url,
              su.submitted_at, su.marks, su.feedback, b.name AS batch_name
         FROM coursework_submission su
         JOIN coursework_assignment a ON a.id = su.assignment_id
         LEFT JOIN batch b ON b.id = a.batch_id
        WHERE su.student_id = $1::bigint AND su.deleted_at IS NULL AND a.deleted_at IS NULL
        ORDER BY a.due_date DESC NULLS LAST, a.id DESC LIMIT 200`, [sid]);

    // --- Certificates ---------------------------------------------------------
    const certificates = await this.db.query<any>(
      `SELECT c.id, c.serial_no, c.cert_type, c.title, c.issue_date, c.status, c.remarks,
              co.name AS course_name, b.name AS batch_name
         FROM certificate c
         LEFT JOIN m_course co ON co.id = c.course_id
         LEFT JOIN batch b ON b.id = c.batch_id
        WHERE c.student_id = $1::bigint AND c.deleted_at IS NULL
        ORDER BY c.issue_date DESC, c.id DESC`, [sid]);

    // --- Report cards ---------------------------------------------------------
    const report_cards = await this.db.query<any>(
      `SELECT r.id, r.term, r.period_from, r.period_to, r.attendance_pct, r.test_avg_pct,
              r.assignment_avg_pct, r.overall_pct, r.overall_grade, r.status, r.share_token,
              co.name AS course_name, b.name AS batch_name
         FROM report_card r
         LEFT JOIN m_course co ON co.id = r.course_id
         LEFT JOIN batch b ON b.id = r.batch_id
        WHERE r.student_id = $1::bigint AND r.deleted_at IS NULL
        ORDER BY r.created_at DESC, r.id DESC`, [sid]);

    // --- Fees: enrolment(s) + receipts + collection summary -------------------
    const enrolmentsRaw = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.net_fee_minor, e.fee_minor, e.discount_minor,
              e.gross_fee_minor, e.discount_type, e.discount_value, e.discount_amount_minor,
              e.payment_plan, e.start_date, e.created_at, e.course_id, e.batch_id,
              e.branch_id, e.vertical_id,
              e.course_status, e.course_status_reason, e.course_status_effective_date,
              e.course_status_changed_at, e.admission_stage, co.name AS course_name, bt.name AS batch_name,
              br.name AS branch_name, vt.name AS vertical_name, svi.student_vertical_no,
              sd.label AS course_status_label, sd.lms_access AS course_lms_access,
              pp.id AS plan_id,
              COALESCE(NULLIF(e.gross_fee_minor, 0), e.fee_minor) AS total_fee_minor,
              (SELECT string_agg(el.code, ', ' ORDER BY el.ordering, el.id)
                 FROM enrolment_level el WHERE el.enrolment_id = e.id) AS level_summary
         FROM enrolment e
         LEFT JOIN m_course co ON co.id = e.course_id
         LEFT JOIN batch bt ON bt.id = e.batch_id
         LEFT JOIN branch br ON br.id = e.branch_id
         LEFT JOIN vertical vt ON vt.id = e.vertical_id
         LEFT JOIN student_vertical_id svi ON svi.student_id = $1::bigint AND svi.vertical_id = e.vertical_id
         LEFT JOIN payment_plan pp ON pp.enrolment_id = e.id AND pp.status = 'active' AND pp.deleted_at IS NULL
         LEFT JOIN student_status_def sd ON sd.code = e.course_status
        WHERE e.deleted_at IS NULL
          AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
        ORDER BY e.created_at DESC`, [sid, student.enrolment_id ? Number(student.enrolment_id) : 0]);
    // Attach a Branch > Vertical > Course breadcrumb per enrolment (client feedback).
    const enrolments = enrolmentsRaw.map((e: any) => ({
      ...e,
      path: [e.branch_name, e.vertical_name, e.course_name].filter(Boolean).join(' \u203a '),
    }));
    // Distinct vertical-wise Student IDs (one per vertical) for this student.
    const vmap = new Map<number, any>();
    for (const e of enrolments) {
      const vid = e.vertical_id != null ? Number(e.vertical_id) : null;
      if (vid == null || vmap.has(vid)) continue;
      vmap.set(vid, {
        vertical_id: vid, vertical_name: e.vertical_name ?? null,
        branch_id: e.branch_id != null ? Number(e.branch_id) : null, branch_name: e.branch_name ?? null,
        student_vertical_no: e.student_vertical_no ?? null,
      });
    }
    const vertical_ids = Array.from(vmap.values());
    const enrolmentIds = enrolments.map((e: any) => Number(e.id));
    let receipts: any[] = [];
    if (enrolmentIds.length) {
      // dev/80 — carry Branch > Vertical > Course + the enrolment/student name so the profile
      // Fees tab can print the breadcrumb and the reused ReceiptViewModal has everything it needs.
      receipts = await this.db.query<any>(
        `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at,
                fr.note, u.name AS received_by_name, e.enrolment_no,
                br.name AS branch_name, vt.name AS vertical_name, co.name AS course_name
           FROM fee_receipt fr
           LEFT JOIN "user" u ON u.id = fr.received_by
           LEFT JOIN enrolment e ON e.id = fr.enrolment_id
           LEFT JOIN branch br ON br.id = e.branch_id
           LEFT JOIN vertical vt ON vt.id = e.vertical_id
           LEFT JOIN m_course co ON co.id = e.course_id
          WHERE fr.enrolment_id = ANY($1::bigint[]) AND fr.deleted_at IS NULL
          ORDER BY fr.received_at DESC`, [enrolmentIds]);
      receipts = receipts.map((r: any) => ({ ...r, lead_name: student.full_name ?? null }));
    }
    const netFee = enrolments.reduce((s: number, e: any) => s + Number(e.net_fee_minor ?? 0), 0);
    const collected = receipts.reduce((s: number, r: any) => s + Number(r.amount_minor ?? 0), 0);

    return {
      student,
      photo_url,
      siblings,
      academics: {
        current_batch: student.batch_id
          ? { id: Number(student.batch_id), name: student.batch_name ?? null }
          : null,
        transfers,
        branch_transfers,
        waitlist,
        attendance: {
          summary: {
            total: attTotal, present: attPresent,
            absent: Number(attKpi?.absent ?? 0), late: Number(attKpi?.late ?? 0),
            excused: Number(attKpi?.excused ?? 0), half_day: Number(attKpi?.half_day ?? 0),
            present_pct: attTotal ? Math.round((attPresent / attTotal) * 1000) / 10 : null,
          },
          records: attendance_records,
        },
        tests,
        assignments,
      },
      certificates,
      report_cards,
      vertical_ids,
      fees: {
        enrolments,
        receipts,
        vertical_ids,
        summary: {
          net_fee_minor: netFee,
          collected_minor: collected,
          balance_minor: Math.max(netFee - collected, 0),
          receipt_count: receipts.length,
        },
      },
    };
  }

  /* -------------------------------------------------- BRANCH transfer ------ */
  /**
   * TRANSFER A STUDENT to another BRANCH (and Vertical, optional Batch).
   *
   * A re-parent: the student's branch_id/vertical_id are moved to the target, the old batch
   * (which lived in the OLD branch) is cleared, and — if a target batch is given — the student
   * is placed into it (respecting capacity; a full batch queues them on batch_waitlist, exactly
   * like create/transfer elsewhere). The move is RECORDED in student_transfer (from/to
   * branch+vertical+batch, who, why) and audited by the interceptor.
   *
   * RBAC: the caller must reach BOTH ends — the student is loaded through the scoped this.get
   * (source in-scope), and the target branch/vertical are validated against the same scope, so
   * a counsellor cannot push a student into, or pull one out of, a branch they cannot see.
   * IDEMPOTENT: moving to the branch+vertical the student already occupies (with no batch
   * change) is refused with a clear message rather than writing a no-op history row.
   */
  async branchTransfer(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const student = await this.get(id, scope);                 // source in-scope (throws 404)
    const toBranchId = Number(dto?.to_branch_id);
    const toVerticalId = Number(dto?.to_vertical_id);
    if (!toBranchId) throw new BadRequestException('Choose a target branch.');
    if (!toVerticalId) throw new BadRequestException('Choose a target vertical.');

    // Target branch must be in the caller's scope.
    const bp: unknown[] = [toBranchId];
    const bw = this.resolver.buildScopeWhere(scope, { branch: 'b.id' }, bp);
    const tBranch = await this.db.one<any>(
      `SELECT b.id, b.name FROM branch b WHERE b.id = $1::bigint AND b.deleted_at IS NULL AND ${bw}`, bp);
    if (!tBranch) throw new NotFoundException('Target branch not found (or outside your access).');

    // Target vertical must belong to the target branch AND be in scope.
    const vp: unknown[] = [toVerticalId, toBranchId];
    const vw = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, vp);
    const tVertical = await this.db.one<any>(
      `SELECT v.id, v.name FROM vertical v
        WHERE v.id = $1::bigint AND v.branch_id = $2::bigint AND v.deleted_at IS NULL AND ${vw}`, vp);
    if (!tVertical) throw new BadRequestException('That vertical does not belong to the chosen branch (or is outside your access).');

    // Optional target batch — must live in the target branch+vertical.
    const rawBatch = dto?.to_batch_id;
    const wantsBatch = rawBatch !== undefined && rawBatch !== null && String(rawBatch).trim() !== '';
    const toBatchId = wantsBatch ? Number(rawBatch) : null;
    let tBatch: any = null;
    if (wantsBatch) {
      if (!Number.isFinite(toBatchId) || (toBatchId as number) <= 0) throw new BadRequestException('Invalid target batch.');
      tBatch = await this.db.one<any>(
        `SELECT id, name, capacity, course_id FROM batch
          WHERE id = $1::bigint AND deleted_at IS NULL AND branch_id = $2::bigint AND vertical_id = $3::bigint`,
        [toBatchId, toBranchId, toVerticalId]);
      if (!tBatch) throw new BadRequestException('That batch is not in the chosen branch and vertical.');
    }

    const fromBranchId = student.branch_id ? Number(student.branch_id) : null;
    const fromVerticalId = student.vertical_id ? Number(student.vertical_id) : null;
    const fromBatchId = student.batch_id ? Number(student.batch_id) : null;

    // IDEMPOTENT: same branch + vertical and no batch move is a no-op.
    const sameBatch = wantsBatch ? Number(toBatchId) === fromBatchId : fromBatchId == null;
    if (fromBranchId === toBranchId && fromVerticalId === toVerticalId && sameBatch) {
      throw new BadRequestException('The student is already in that branch and vertical.');
    }

    const orgId = await this.orgId();
    const out = await this.db.tx(async (c) => {
      // Capacity check for a chosen target batch — a full one waitlists (batch_id stays NULL).
      let assignedBatchId: number | null = null;
      let waitlisted = false;
      let waitlistPosition: number | null = null;
      if (wantsBatch && tBatch) {
        const capacity = Number(tBatch.capacity ?? 0);
        const filledR = await c.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM student WHERE batch_id = $1::bigint AND deleted_at IS NULL`, [toBatchId]);
        const filled = Number(filledR.rows[0]?.n ?? 0);
        if (capacity > 0 && filled >= capacity) {
          const posR = await c.query<{ n: string }>(
            `SELECT COALESCE(max(position), 0) + 1 AS n FROM batch_waitlist WHERE batch_id = $1::bigint AND status = 'waiting'`, [toBatchId]);
          waitlistPosition = Number(posR.rows[0]?.n ?? 1);
        } else {
          assignedBatchId = Number(toBatchId);
        }
      }

      // Re-parent. Old batch belonged to the old branch, so it is cleared unless a new one is set.
      await c.query(
        `UPDATE student SET branch_id = $2::bigint, vertical_id = $3::bigint, batch_id = $4::bigint,
                            course_id = COALESCE($5::bigint, course_id), updated_at = now()
          WHERE id = $1::bigint`,
        [id, toBranchId, toVerticalId, assignedBatchId, tBatch?.course_id ?? null]);

      // History (branch level).
      const th = await c.query<{ id: string }>(
        `INSERT INTO student_transfer (org_id, student_id, from_branch_id, to_branch_id,
                                       from_vertical_id, to_vertical_id, from_batch_id, to_batch_id,
                                       reason, transferred_by)
         VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6::bigint,$7,$8,$9,$10::bigint) RETURNING id`,
        [orgId, id, fromBranchId, toBranchId, fromVerticalId, toVerticalId, fromBatchId, toBatchId, dto?.reason ?? null, me.id]);

      if (assignedBatchId != null) {
        // A concrete batch move also lands a batch_transfer row (keeps the batch history whole).
        await c.query(
          `INSERT INTO batch_transfer (org_id, student_id, from_batch_id, to_batch_id, reason, transferred_by)
           VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6::bigint)`,
          [orgId, id, fromBatchId, assignedBatchId, dto?.reason ?? 'Branch transfer', me.id]);
      } else if (waitlisted === false && wantsBatch && waitlistPosition != null) {
        await c.query(
          `INSERT INTO batch_waitlist (org_id, batch_id, student_id, position, note, created_by)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4::int,$5,$6::bigint)`,
          [orgId, toBatchId, id, waitlistPosition, 'Waitlisted on branch transfer (batch full)', me.id]);
        waitlisted = true;
      }

      return {
        id, transfer_id: Number(th.rows[0].id), transferred: true,
        from_branch_id: fromBranchId, to_branch_id: toBranchId,
        from_vertical_id: fromVerticalId, to_vertical_id: toVerticalId,
        batch_id: assignedBatchId, waitlisted, waitlist_position: waitlistPosition,
      };
    });

    // Best-effort notification (no-ops if the event is not configured).
    await this.notifEvents?.safeFire('student_transferred', {
      student_id: id, vertical_id: toVerticalId, dedupe: `transfer:${out.transfer_id}`,
      vars: { from_branch: student.branch_name ?? '', to_branch: tBranch.name, to_vertical: tVertical.name },
    });
    return out;
  }

  /* --------------------------------------------------------- documents ------ */
  /** Metadata for every document on the student (NO bytes) — powers the ID & Documents tab. */
  async listDocuments(id: number, scope: ResolvedScope) {
    await this.get(id, scope); // scope + existence (throws 404 outside access)
    return this.db.query<any>(
      `SELECT id, doc_type, file_name, mime, size_bytes, created_at,
              (r2_key IS NOT NULL) AS in_r2
         FROM student_document
        WHERE student_id=$1::bigint AND deleted_at IS NULL
        ORDER BY id ASC`, [id]);
  }

  /** One document's bytes for authenticated, in-scope download (never public). */
  async downloadDocument(id: number, docId: number, scope: ResolvedScope) {
    await this.get(id, scope);
    const row = await this.db.one<any>(
      `SELECT file_name, mime, content, r2_key FROM student_document
        WHERE id=$1::bigint AND student_id=$2::bigint AND deleted_at IS NULL`, [docId, id]);
    if (!row) throw new NotFoundException('Document not found.');
    if (row.r2_key && this.storage) {
      const obj = await this.storage.getObject(String(row.r2_key));
      return { file_name: String(row.file_name), mime: String(row.mime), content: obj.body };
    }
    return { file_name: String(row.file_name), mime: String(row.mime), content: row.content as Buffer };
  }

  /** A short-lived PRESIGNED R2 URL for an in-scope, R2-backed sensitive document (never public). */
  async downloadDocumentUrl(id: number, docId: number, scope: ResolvedScope) {
    await this.get(id, scope);
    const row = await this.db.one<any>(
      `SELECT file_name, r2_key FROM student_document
        WHERE id=$1::bigint AND student_id=$2::bigint AND deleted_at IS NULL`, [docId, id]);
    if (!row) throw new NotFoundException('Document not found.');
    if (!row.r2_key || !this.storage) throw new BadRequestException('This document predates R2 storage — use the direct download.');
    const url = await this.storage.presignGet(String(row.r2_key), 300, String(row.file_name));
    return { url, expires_in: 300 };
  }

  /* ------------------------------------------------- photo (profile avatar) */
  private static IMG_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

  /** Presigned PUT for the student's profile photo. Returns the R2 key the client PUTs the
   *  bytes to, then POSTs back to /photo to attach. Image types only; R2-only (no DB blob). */
  async photoUploadUrl(id: number, dto: { file_name?: string; content_type?: string }, scope: ResolvedScope) {
    await this.get(id, scope);
    if (!this.storage) throw new BadRequestException('File storage is not configured.');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !StudentService.IMG_MIME.has(ct)) throw new BadRequestException('The photo must be a JPG, PNG or WEBP image.');
    const key = this.storage.studentPhotoKey(id, String(dto?.file_name ?? 'photo.jpg'));
    const url = await this.storage.presignPut(key, ct || 'image/jpeg', 300);
    return { url, r2_key: key, expires_in: 300 };
  }

  /** Attach an uploaded photo: supersedes any prior 'photo' document with the new R2 key and
   *  returns a fresh presigned photo_url (the FB-style header avatar reads profile.photo_url). */
  async attachPhoto(id: number, dto: { r2_key?: string; file_name?: string; mime?: string; size_bytes?: number }, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const key = String(dto?.r2_key ?? '').trim();
    if (!key || !key.startsWith(`students/${id}/photo/`)) throw new BadRequestException('Upload the photo first (missing or invalid r2_key).');
    const ct = String(dto?.mime ?? '').toLowerCase();
    if (ct && !StudentService.IMG_MIME.has(ct)) throw new BadRequestException('The photo must be a JPG, PNG or WEBP image.');
    const orgId = await this.orgId();
    await this.db.query(
      `UPDATE student_document SET deleted_at = now(), deleted_by = $2::bigint
        WHERE student_id = $1::bigint AND doc_type = 'photo' AND deleted_at IS NULL`, [id, me.id]);
    const r = await this.db.one<any>(
      `INSERT INTO student_document (org_id, student_id, doc_type, file_name, mime, size_bytes, content, r2_key, uploaded_by)
       VALUES ($1::bigint,$2::bigint,'photo',$3,$4,$5,NULL,$6,$7::bigint) RETURNING id`,
      [orgId, id, String(dto?.file_name ?? 'photo.jpg'), ct || 'image/jpeg', Number(dto?.size_bytes ?? 0), key, me.id]);
    let photo_url: string | null = null;
    try { if (this.storage) photo_url = await this.storage.presignGet(key, 300, String(dto?.file_name ?? 'photo')); } catch { /* avatar falls back to initials */ }
    return { id: Number(r.id), photo_url };
  }

  /* -------------------------------------------- documents (upload / delete) */
  private static DOC_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
  private static DOC_TYPES = new Set(['photo', 'aadhaar', 'pan', 'qualification', 'education', 'kyc', 'address_proof', 'other', 'misc']);

  /** Presigned PUT for a KYC / education / misc document (R2-only; the row stores just the key). */
  async documentUploadUrl(id: number, dto: { file_name?: string; content_type?: string }, scope: ResolvedScope) {
    await this.get(id, scope);
    if (!this.storage) throw new BadRequestException('File storage is not configured.');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !StudentService.DOC_MIME.has(ct)) throw new BadRequestException('The document must be a PDF, JPG or PNG.');
    const key = this.storage.studentDocKey({ studentId: id, fileName: String(dto?.file_name ?? 'document') });
    const url = await this.storage.presignPut(key, ct || 'application/octet-stream', 300);
    return { url, r2_key: key, expires_in: 300 };
  }

  /** Attach an uploaded document (metadata + r2_key only; the bytes stay in R2). */
  async attachDocument(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const key = String(dto?.r2_key ?? '').trim();
    if (!key || !key.startsWith(`students/${id}/docs/`)) throw new BadRequestException('Upload the file first (missing or invalid r2_key).');
    const docType = String(dto?.doc_type ?? 'other').toLowerCase();
    const finalType = StudentService.DOC_TYPES.has(docType) ? docType : 'other';
    const ct = String(dto?.mime ?? '').toLowerCase();
    if (ct && !StudentService.DOC_MIME.has(ct)) throw new BadRequestException('The document must be a PDF, JPG or PNG.');
    const orgId = await this.orgId();
    const r = await this.db.one<any>(
      `INSERT INTO student_document (org_id, student_id, doc_type, file_name, mime, size_bytes, content, r2_key, uploaded_by)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5,$6,NULL,$7,$8::bigint) RETURNING id`,
      [orgId, id, finalType, String(dto?.file_name ?? 'document'), ct || 'application/octet-stream', Number(dto?.size_bytes ?? 0), key, me.id]);
    return { id: Number(r.id), doc_type: finalType };
  }

  /** Delete a document by PK — soft-delete the row + purge the R2 object (no orphans). */
  async removeDocument(id: number, docId: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const row = await this.db.one<any>(
      `SELECT id, r2_key FROM student_document WHERE id=$1::bigint AND student_id=$2::bigint AND deleted_at IS NULL`, [docId, id]);
    if (!row) throw new NotFoundException('Document not found.');
    await this.db.query(`UPDATE student_document SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [docId, me.id]);
    if (row.r2_key && this.storage) { try { await this.storage.deleteObject(String(row.r2_key)); } catch { /* orphan-free is best-effort */ } }
    return { id: Number(docId), deleted: true };
  }

  /* ----------------------------------------------------- STUDENT ID CARD --- */
  /**
   * VERTICAL-WISE ID CARD (client feedback). Resolve WHICH vertical the card is for, ensure a
   * vertical-wise Student ID exists for it (mint on demand), and gather the courses enrolled in
   * THAT vertical + its Branch > Vertical. A student enrolled in two verticals => two distinct cards.
   *
   *  verticalId rules: REQUIRED when the student has enrolments in >1 vertical; defaults to the
   *  single/primary vertical otherwise (falls back to the student's own vertical if no enrolments).
   */
  private async resolveIdCardVertical(id: number, scope: ResolvedScope, verticalId?: number | null): Promise<{
    student: any; verticalId: number; branchId: number | null; branchName: string | null; verticalName: string | null;
    courses: string[]; studentVerticalNo: string; svidId: number;
  }> {
    const st = await this.get(id, scope);
    const sid = Number(st.id);
    const vrows = await this.db.query<any>(
      `SELECT e.vertical_id, MIN(e.branch_id) AS branch_id,
              MAX(vt.name) AS vertical_name, MAX(br.name) AS branch_name
         FROM enrolment e
         LEFT JOIN vertical vt ON vt.id = e.vertical_id
         LEFT JOIN branch br ON br.id = e.branch_id
        WHERE e.deleted_at IS NULL AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
          AND e.vertical_id IS NOT NULL
        GROUP BY e.vertical_id
        ORDER BY MIN(e.created_at) ASC`, [sid, st.enrolment_id ? Number(st.enrolment_id) : 0]);
    let target: any = null;
    if (verticalId != null) {
      target = vrows.find((r: any) => Number(r.vertical_id) === Number(verticalId)) || null;
      if (!target) {
        // allow the student's OWN vertical even with no enrolments (single-vertical fallback)
        if (st.vertical_id != null && Number(st.vertical_id) === Number(verticalId)) {
          target = { vertical_id: Number(st.vertical_id), branch_id: st.branch_id ?? null, vertical_name: st.vertical_name ?? null, branch_name: st.branch_name ?? null };
        } else {
          throw new BadRequestException('This student has no enrolment in the chosen vertical.');
        }
      }
    } else if (vrows.length === 1) {
      target = vrows[0];
    } else if (vrows.length === 0) {
      if (st.vertical_id == null) throw new BadRequestException('This student is not attached to any vertical yet.');
      target = { vertical_id: Number(st.vertical_id), branch_id: st.branch_id ?? null, vertical_name: st.vertical_name ?? null, branch_name: st.branch_name ?? null };
    } else {
      throw new BadRequestException('This student is enrolled across multiple verticals — choose a vertical (vertical_id) for the ID card.');
    }
    const tVid = Number(target.vertical_id);
    const tBid = target.branch_id != null ? Number(target.branch_id) : (st.branch_id != null ? Number(st.branch_id) : null);
    // ensure (mint on demand) the vertical-wise Student ID for this vertical
    const svid = await this.db.tx(async (c) => this.ensureVerticalId(c, sid, tBid, tVid, null));
    // courses enrolled in THIS vertical (non-cancelled)
    const courses = await this.db.query<any>(
      `SELECT DISTINCT co.name FROM enrolment e LEFT JOIN m_course co ON co.id = e.course_id
        WHERE e.deleted_at IS NULL AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
          AND e.vertical_id = $3::bigint
          AND (e.course_status IS NULL OR e.course_status NOT IN ('cancelled','withdrawn','dropped_out'))`,
      [sid, st.enrolment_id ? Number(st.enrolment_id) : 0, tVid]);
    const courseNames = Array.from(new Set(courses.map((r: any) => String(r.name ?? '').trim()).filter(Boolean)));
    if (!courseNames.length && st.course_name) courseNames.push(String(st.course_name));
    return {
      student: st, verticalId: tVid, branchId: tBid,
      branchName: target.branch_name ?? st.branch_name ?? null,
      verticalName: target.vertical_name ?? st.vertical_name ?? null,
      courses: courseNames, studentVerticalNo: svid.student_vertical_no, svidId: svid.id,
    };
  }

  private async idCardData(id: number, scope: ResolvedScope, verticalId?: number | null): Promise<{ doc: StudentIdCardDoc; lh: Letterhead; orgId: number; refId: number; docNo: string }> {
    const r = await this.resolveIdCardVertical(id, scope, verticalId);
    const st = r.student;
    const org = await this.db.one<any>(`SELECT id, name FROM organisation ORDER BY id LIMIT 1`);
    const br = await this.db.one<any>(`SELECT address FROM branch WHERE id = $1::bigint`, [r.branchId]).catch(() => null);
    let photo: Buffer | null = null;
    try {
      const ph = await this.db.one<any>(
        `SELECT r2_key FROM student_document WHERE student_id=$1::bigint AND doc_type='photo' AND deleted_at IS NULL AND r2_key IS NOT NULL ORDER BY id DESC LIMIT 1`, [id]);
      if (ph?.r2_key && this.storage) { const obj = await this.storage.getObject(String(ph.r2_key)); photo = obj.body; }
    } catch { /* placeholder initials when no/failed photo */ }
    const today = new Date();
    const validUntil = new Date(today.getTime()); validUntil.setFullYear(validUntil.getFullYear() + 1);
    const doc: StudentIdCardDoc = {
      // Client ID re-model: the card shows the STUDENT ID (customer id, one per student) and the
      // ROLL NUMBER (the vertical-wise id for THIS vertical). Falls back to the roll number for the
      // Student ID only if a legacy row has no customer id yet.
      student_name: st.full_name, student_no: st.customer_no ?? r.studentVerticalNo, roll_no: r.studentVerticalNo,
      courses: r.courses, batch_name: st.batch_name, branch_name: r.branchName, vertical_name: r.verticalName,
      dob: st.dob, phone: st.phone,
      issue_date: today.toISOString(), valid_until: validUntil.toISOString(), photo,
    };
    const lh: Letterhead = {
      org_name: org?.name || 'Tech Lingua LLP', vertical_name: r.verticalName, branch_name: r.branchName,
      branch_address: br?.address ?? null, branch_email: null, branch_phone: null,
    };
    return { doc, lh, orgId: Number(org?.id ?? 0), refId: r.svidId, docNo: r.studentVerticalNo };
  }

  /** Generate the per-vertical ID-card PDF, persist to R2 (kind `student_id_card`, keyed by the
   *  vertical-wise Student ID so the two verticals' cards never overwrite each other). */
  async idCard(id: number, scope: ResolvedScope, verticalId?: number | null): Promise<{ buffer: Buffer; filename: string; r2_key: string | null }> {
    const { doc, lh, orgId, refId, docNo } = await this.idCardData(id, scope, verticalId);
    const buffer = studentIdCardPdf(doc, lh);
    let key: string | null = null;
    try { key = (await this.pdfAssets?.persist('student_id_card', refId, docNo, buffer, orgId)) ?? null; } catch { /* R2 off — stream anyway */ }
    return { buffer, filename: `id-card-${String(docNo ?? id).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`, r2_key: key };
  }

  /** A short-lived presigned R2 URL for the per-vertical ID card (generates + persists if needed). */
  async idCardUrl(id: number, scope: ResolvedScope, verticalId?: number | null): Promise<{ url: string | null; vertical_id?: number; student_vertical_no?: string }> {
    const r = await this.resolveIdCardVertical(id, scope, verticalId);
    const name = `id-card-${String(r.studentVerticalNo ?? id).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
    let url = this.pdfAssets ? await this.pdfAssets.presignedUrl('student_id_card', r.svidId, name) : null;
    if (!url) { try { await this.idCard(id, scope, verticalId); } catch { /* R2 off */ } url = this.pdfAssets ? await this.pdfAssets.presignedUrl('student_id_card', r.svidId, name) : null; }
    return { url, vertical_id: r.verticalId, student_vertical_no: r.studentVerticalNo };
  }

  /** LIST the vertical-wise Student IDs for a student (one per vertical) — the ID-card picker. */
  async verticalIds(id: number, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const sid = Number(student.id);
    const rows = await this.db.query<any>(
      `SELECT e.vertical_id, MIN(e.branch_id) AS branch_id,
              MAX(vt.name) AS vertical_name, MAX(br.name) AS branch_name,
              MAX(svi.student_vertical_no) AS student_vertical_no,
              array_remove(array_agg(DISTINCT co.name) FILTER (
                WHERE e.course_status IS NULL OR e.course_status NOT IN ('cancelled','withdrawn','dropped_out')), NULL) AS courses
         FROM enrolment e
         LEFT JOIN vertical vt ON vt.id = e.vertical_id
         LEFT JOIN branch br ON br.id = e.branch_id
         LEFT JOIN m_course co ON co.id = e.course_id
         LEFT JOIN student_vertical_id svi ON svi.student_id = $1::bigint AND svi.vertical_id = e.vertical_id
        WHERE e.deleted_at IS NULL AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
          AND e.vertical_id IS NOT NULL
        GROUP BY e.vertical_id
        ORDER BY MIN(e.created_at) ASC`, [sid, student.enrolment_id ? Number(student.enrolment_id) : 0]);
    return {
      student_id: sid, student_name: student.full_name, student_no: student.student_no,
      verticals: rows.map((r: any) => ({
        vertical_id: Number(r.vertical_id), vertical_name: r.vertical_name ?? null,
        branch_id: r.branch_id != null ? Number(r.branch_id) : null, branch_name: r.branch_name ?? null,
        student_vertical_no: r.student_vertical_no ?? null,
        path: [r.branch_name, r.vertical_name].filter(Boolean).join(' \u203a '),
        courses: (r.courses ?? []).filter(Boolean),
      })),
    };
  }

  /** Has THIS lead already been converted? Drives the leadsheet button state (idempotency). */
  async byLead(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT s.id, s.student_no, s.full_name, s.status
         FROM student s
        WHERE s.lead_id = $1::bigint AND s.deleted_at IS NULL AND ${w}`,
      params,
    );
    return { student: row ?? null };
  }

  /**
   * THE STUDENT DASHBOARD — real numbers from the students/enrolments/fees that exist.
   */
  async summary(scope: ResolvedScope, f: {
    branch_id?: string; vertical_id?: string; from?: string; to?: string;
  } = {}) {
    const params: unknown[] = [];
    const where = [`s.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('s.branch_id', f.branch_id);
    multi('s.vertical_id', f.vertical_id);
    const _dr = assertDateRange(f.from, f.to);
    let rangeFrom: string | null = null; let rangeTo: string | null = null;
    if (_dr.from) { params.push(_dr.from); rangeFrom = `$${params.length}`; }
    if (_dr.to) { params.push(_dr.to); rangeTo = `$${params.length}`; }
    const w = where.join(' AND ');
    const newInRange = rangeFrom || rangeTo
      ? `count(*) FILTER (WHERE ${rangeFrom ? `s.created_at >= ${rangeFrom}::timestamptz` : 'TRUE'}
                            AND ${rangeTo ? `s.created_at < (${rangeTo}::date + 1)` : 'TRUE'})`
      : `count(*) FILTER (WHERE s.created_at >= date_trunc('month', now()))`;

    const kpi = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE s.status = 'active')   AS active,
              count(*) FILTER (WHERE s.status = 'inactive') AS inactive,
              ${newInRange} AS new_in_range,
              count(*) FILTER (WHERE s.batch_id IS NOT NULL) AS in_batch,
              count(*) FILTER (WHERE s.enrolment_id IS NOT NULL) AS with_enrolment
         FROM student s WHERE ${w}`,
      params,
    );

    const byBranch = await this.db.query<any>(
      `SELECT b.name AS label, count(*)::int AS value
         FROM student s JOIN branch b ON b.id = s.branch_id
        WHERE ${w} GROUP BY b.name ORDER BY value DESC LIMIT 12`, params);
    const byVertical = await this.db.query<any>(
      `SELECT v.name AS label, count(*)::int AS value
         FROM student s JOIN vertical v ON v.id = s.vertical_id
        WHERE ${w} GROUP BY v.name ORDER BY value DESC LIMIT 12`, params);
    const byCourse = await this.db.query<any>(
      `SELECT COALESCE(c.name, 'Course TBD') AS label, count(*)::int AS value
         FROM student s LEFT JOIN m_course c ON c.id = s.course_id
        WHERE ${w} GROUP BY c.name ORDER BY value DESC LIMIT 12`, params);

    const recent = await this.db.query<any>(
      `SELECT s.id, s.student_no, s.customer_no, s.full_name, s.created_at,
              b.name AS branch_name, c.name AS course_name
         FROM student s
         LEFT JOIN branch b ON b.id = s.branch_id
         LEFT JOIN m_course c ON c.id = s.course_id
        WHERE ${w} ORDER BY s.created_at DESC, s.id DESC LIMIT 8`, params);

    const fees = await this.db.one<any>(
      `SELECT COALESCE(sum(fr.amount_minor), 0) AS collected_minor,
              count(DISTINCT fr.enrolment_id) AS paying_students
         FROM student s
         JOIN enrolment e ON e.id = s.enrolment_id
         JOIN fee_receipt fr ON fr.enrolment_id = e.id AND fr.deleted_at IS NULL
        WHERE ${w}`, params);

    return {
      kpis: {
        total: Number(kpi?.total ?? 0),
        active: Number(kpi?.active ?? 0),
        inactive: Number(kpi?.inactive ?? 0),
        new_in_range: Number(kpi?.new_in_range ?? 0),
        in_batch: Number(kpi?.in_batch ?? 0),
        with_enrolment: Number(kpi?.with_enrolment ?? 0),
      },
      by_branch: byBranch,
      by_vertical: byVertical,
      by_course: byCourse,
      recent,
      fees: {
        collected_minor: Number(fees?.collected_minor ?? 0),
        paying_students: Number(fees?.paying_students ?? 0),
      },
    };
  }

  /* --------------------------------------------------------- profile mapping */

  /**
   * The ONE place that maps a form DTO -> student columns, shared by create and update.
   * Returns [column, value] pairs ONLY for keys the caller actually sent (`!== undefined`),
   * so a partial PATCH (e.g. the detail modal's `{ status }`) touches nothing else.
   *
   * Phones -> E.164 via the shared normaliser (leads' rule). Dates -> validated string or a
   * clean 400. Sensitive fields (aadhaar/pan/passport) pass through untouched and unlogged.
   */
  private profilePairs(dto: any): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [];
    const has = (k: string) => dto && dto[k] !== undefined;
    const clean = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());

    const str = (col: string, k: string, max = 400) => { if (has(k)) { const v = clean(dto[k]); out.push([col, v == null ? null : String(v).slice(0, max)]); } };
    const phone = (col: string, k: string) => { if (has(k)) { const v = clean(dto[k]); out.push([col, v == null ? null : (normalizePhone(String(v)) ?? String(v))]); } };
    const date = (col: string, k: string, label: string) => {
      if (!has(k)) return;
      const raw = dto[k];
      if (raw == null || String(raw).trim() === '') { out.push([col, null]); return; }
      const d = requireDateString(raw, () => { throw new BadRequestException(`${label} is not a valid date.`); });
      out.push([col, d]);
    };
    const fk = (col: string, k: string) => { if (has(k)) { const n = Number(dto[k]); out.push([col, dto[k] == null || dto[k] === '' || !Number.isFinite(n) ? null : n]); } };

    // Identity
    str('full_name', 'full_name', 160);
    date('dob', 'dob', 'Date of Birth');
    if (has('gender')) { const g = clean(dto.gender); out.push(['gender', g && GENDERS.includes(g) ? g : (g || null)]); }
    str('nationality', 'nationality', 64);
    date('registration_date', 'registration_date', 'Registration Date');
    date('admission_date', 'admission_date', 'Admission Date');
    // Contact
    phone('phone', 'phone');
    phone('whatsapp_phone', 'whatsapp_phone');
    phone('alt_phone', 'alt_phone');
    str('email', 'email', 160);
    // Family / Guardian
    str('father_name', 'father_name', 160);
    phone('father_mobile', 'father_mobile');
    str('guardian_name', 'guardian_name', 160);
    phone('guardian_mobile', 'guardian_mobile');
    str('guardian_email', 'guardian_email', 160);
    str('guardian_relation', 'guardian_relation', 24);
    // Address
    str('address_line1', 'address_line1', 200);
    str('address_line2', 'address_line2', 200);
    str('landmark', 'landmark', 160);
    str('country', 'country', 80);
    fk('state_id', 'state_id');
    fk('city_id', 'city_id');
    str('district', 'district', 120);
    str('pincode', 'pincode', 12);
    str('permanent_address', 'permanent_address', 4000);
    str('current_address', 'current_address', 4000);
    // ID Proofs (sensitive — pass through, do not transform beyond trim)
    str('id_proof_type', 'id_proof_type', 32);
    str('id_proof_number', 'id_proof_number', 80);
    if (has('aadhaar')) { const v = clean(dto.aadhaar); out.push(['aadhaar', v == null ? null : String(v).replace(/\s+/g, '')]); }
    if (has('pan')) { const v = clean(dto.pan); out.push(['pan', v == null ? null : String(v).toUpperCase()]); }
    str('passport', 'passport', 40);
    // Education
    str('qualification', 'qualification', 160);
    str('institution', 'institution', 200);
    str('board_university', 'board_university', 200);
    if (has('passing_year')) { const n = parseInt(String(dto.passing_year), 10); out.push(['passing_year', dto.passing_year == null || dto.passing_year === '' || !Number.isFinite(n) ? null : n]); }
    str('previous_institution', 'previous_institution', 200);

    // Custom fields (client, Aug 2026) — the admin-defined student fields (entity='student')
    // persist into student.custom_fields, exactly as leads persist into lead.custom_fields
    // (migration 068 added the column). One storage, one code path. A non-object is coerced to {}.
    if (has('custom_fields')) {
      const cf = dto.custom_fields;
      const obj = cf && typeof cf === 'object' && !Array.isArray(cf) ? cf : {};
      out.push(['custom_fields', JSON.stringify(obj)]);
    }

    return out;
  }

  /** Cross-field validation the column mapper cannot express on its own. HARD 400s for the
   *  two the client named (future DOB, India pincode); aadhaar/pan are SOFT (stored as-is). */
  private validateProfile(pairs: Array<[string, unknown]>) {
    const get = (c: string) => pairs.find(([col]) => col === c)?.[1];
    const dob = get('dob');
    if (dob) {
      const t = Date.parse(`${dob}T00:00:00Z`);
      if (Number.isFinite(t) && t > Date.now()) throw new BadRequestException('Date of Birth cannot be in the future.');
    }
    const country = get('country');
    const pincode = get('pincode');
    const isIndia = country == null || /india/i.test(String(country));
    if (isIndia && pincode != null && !/^\d{6}$/.test(String(pincode))) {
      throw new BadRequestException('An Indian pincode must be exactly 6 digits.');
    }
    const py = get('passing_year');
    if (py != null) {
      const n = Number(py);
      if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear() + 10) {
        throw new BadRequestException('Passing Year must be a valid year.');
      }
    }
  }

  /* --------------------------------------------------------------- mutations */

  /** Vertical must belong to the branch; course (if any) must be active. */
  private async assertScopeHierarchy(branchId: number, verticalId: number, courseId: number | null) {
    if (!branchId) throw new BadRequestException('Choose a branch.');
    if (!verticalId) throw new BadRequestException('Choose a vertical.');
    const v = await this.db.one<any>(
      `SELECT id FROM vertical WHERE id = $1::bigint AND branch_id = $2::bigint AND deleted_at IS NULL`,
      [verticalId, branchId],
    );
    if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    if (courseId) {
      const c = await this.db.one<any>(`SELECT id FROM m_course WHERE id = $1::bigint AND is_active`, [courseId]);
      if (!c) throw new BadRequestException('Choose an active course.');
    }
  }

  /**
   * ADD a student directly (the Admission form) — lead-less. Requires Branch + Vertical and a
   * name; mints Student ID + Enrollment No from the numbering series inside the transaction
   * (a rolled-back insert burns no number). Enrollment No may be provided (manual) — then it
   * is used as-is; blank -> auto.
   */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const branchId = Number(dto?.branch_id);
    const verticalId = Number(dto?.vertical_id);
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    await this.assertScopeHierarchy(branchId, verticalId, courseId);

    const pairs = this.profilePairs(dto);
    const nameFromPairs = pairs.find(([c]) => c === 'full_name')?.[1];
    if (!nameFromPairs) throw new BadRequestException('Student Full Name is required.');
    this.validateProfile(pairs);

    const orgId = await this.orgId();
    const ownerId = dto?.owner_id ? Number(dto.owner_id) : me.id;
    const manualEnrollment = dto?.enrollment_no != null && String(dto.enrollment_no).trim() !== ''
      ? String(dto.enrollment_no).trim() : null;

    // Fixed columns every student carries, then the profile columns present in the DTO.
    // The profile pairs already include full_name/phone/email etc.; strip owner-managed
    // duplicates so we set each column exactly once.
    const managed = new Set(['owner_id', 'branch_id', 'vertical_id', 'course_id', 'enrollment_no', 'student_no', 'status']);
    const profile = pairs.filter(([c]) => !managed.has(c));

    const cols: string[] = ['org_id', 'branch_id', 'vertical_id', 'pipeline_id', 'campaign_id',
      'course_id', 'owner_id', 'status', 'created_by'];
    const vals: unknown[] = [orgId, branchId, verticalId,
      dto?.pipeline_id ? Number(dto.pipeline_id) : null, dto?.campaign_id ? Number(dto.campaign_id) : null,
      courseId, ownerId, 'active', me.id];
    for (const [c, v] of profile) { cols.push(c); vals.push(v); }

    // OBS-1 (docs/qa/27): a create payload MAY carry batch_id. Previously it was silently
    // dropped; now we HONOUR it — assigning the new student to the batch inside the same
    // transaction, respecting the batch's branch/vertical and its capacity/waitlist (mirroring
    // the transfer flow): a full batch queues the student on batch_waitlist instead of moving.
    const rawBatch = dto?.batch_id;
    const wantsBatch = rawBatch !== undefined && rawBatch !== null && String(rawBatch).trim() !== '';
    const batchId = wantsBatch ? Number(rawBatch) : null;
    if (wantsBatch && (!Number.isFinite(batchId) || (batchId as number) <= 0)) {
      throw new BadRequestException('Invalid batch.');
    }

    const centreCode = await this.centreCode();
    const out = await this.db.tx(async (c) => {
      const studentNo = await this.numbering.allocate('student', { branch_id: branchId, vertical_id: verticalId }, c);
      const enrollmentNo = manualEnrollment
        ?? await this.numbering.allocate('enrollment', { branch_id: branchId, vertical_id: verticalId }, c);
      // Student ID (customer id) — <CENTRE_CODE>-<YEAR>-<NNN>, one per student (client ID re-model).
      const customerNo = await this.numbering.allocateCoded('student', centreCode, c);
      const allCols = [...cols, 'student_no', 'enrollment_no', 'customer_no'];
      const allVals = [...vals, studentNo, enrollmentNo, customerNo];
      const ph = allCols.map((_, i) => `$${i + 1}`).join(', ');
      const ins = await c.query<{ id: string }>(
        `INSERT INTO student (${allCols.join(', ')}) VALUES (${ph}) RETURNING id`, allVals as any[],
      );
      const studentId = Number(ins.rows[0].id);

      let assignedBatchId: number | null = null;
      let waitlisted = false;
      let waitlistPosition: number | null = null;
      if (batchId != null) {
        const b = await c.query<{ id: string; capacity: string }>(
          `SELECT id, capacity FROM batch
            WHERE id = $1::bigint AND deleted_at IS NULL AND branch_id = $2::bigint AND vertical_id = $3::bigint`,
          [batchId, branchId, verticalId]);
        if (!b.rows[0]) throw new BadRequestException('That batch is not in this student\'s branch and vertical.');
        const capacity = Number(b.rows[0].capacity ?? 0);
        const filledR = await c.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM student WHERE batch_id = $1::bigint AND deleted_at IS NULL`, [batchId]);
        const filled = Number(filledR.rows[0]?.n ?? 0);
        if (capacity > 0 && filled >= capacity) {
          // FULL — queue on the waitlist (ordered) instead of moving; batch_id stays NULL.
          const posR = await c.query<{ n: string }>(
            `SELECT COALESCE(max(position), 0) + 1 AS n FROM batch_waitlist
              WHERE batch_id = $1::bigint AND status = 'waiting'`, [batchId]);
          waitlistPosition = Number(posR.rows[0]?.n ?? 1);
          await c.query(
            `INSERT INTO batch_waitlist (org_id, batch_id, student_id, position, note, created_by)
             VALUES ($1::bigint, $2::bigint, $3::bigint, $4::int, $5, $6::bigint)`,
            [orgId, batchId, studentId, waitlistPosition, 'Assigned on student create (batch full)', me.id]);
          waitlisted = true;
        } else {
          await c.query(`UPDATE student SET batch_id = $2::bigint WHERE id = $1::bigint`, [studentId, batchId]);
          await c.query(
            `INSERT INTO batch_transfer (org_id, student_id, from_batch_id, to_batch_id, reason, transferred_by)
             VALUES ($1::bigint, $2::bigint, NULL, $3::bigint, $4, $5::bigint)`,
            [orgId, studentId, batchId, 'Assigned on student create', me.id]);
          assignedBatchId = batchId;
        }
      }

      return {
        id: studentId, student_no: studentNo, customer_no: customerNo, enrollment_no: enrollmentNo,
        batch_id: assignedBatchId, waitlisted, waitlist_position: waitlistPosition,
      };
    });
    // Notification Events — a student record was created directly (admission desk). Best-effort.
    await this.notifEvents?.safeFire('student_welcome', {
      student_id: Number(out.id), vertical_id: verticalId, dedupe: `welcome:${out.id}`,
      vars: { student_no: out.student_no, enrollment_no: out.enrollment_no },
    });
    if (out.batch_id) {
      await this.notifEvents?.safeFire('batch_assigned', {
        student_id: Number(out.id), vertical_id: verticalId, dedupe: `batch:${out.id}:${out.batch_id}`,
      });
    }
    return out;
  }

  private async leadInScope(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const lw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const lead = await this.db.one<any>(
      `SELECT l.id, l.org_id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id,
              l.owner_id, l.team_id, l.full_name, l.phone, l.email, l.alt_phone, l.whatsapp_phone,
              l.course_id, l.stage_id
         FROM lead l
        WHERE l.id = $1::bigint AND l.deleted_at IS NULL AND ${lw}`,
      params,
    );
    if (!lead) throw new NotFoundException('Lead not found (or outside your access)');
    return lead;
  }

  /**
   * CONVERT a lead to a student. Idempotent, RBAC-gated by the controller.
   *   1. lead must be in scope;
   *   2. if already converted -> return the existing student ({ already: true });
   *   3. else create the student, CARRYING the lead's name/primary mobile/whatsapp/alt mobile/
   *      email/branch/vertical/course/owner (the user completes the rest on Edit), minting
   *      Student ID + Enrollment No, linking the live enrolment if one exists (both directions);
   *   4. WIN the lead; 5. write the activity. All in ONE transaction.
   */
  async convert(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    if (!leadId) throw new BadRequestException('Choose the lead to convert.');
    const lead = await this.leadInScope(leadId, scope);

    const existing = await this.db.one<any>(
      `SELECT id, student_no, full_name, status FROM student WHERE lead_id = $1::bigint AND deleted_at IS NULL`,
      [leadId],
    );
    if (existing) return { ...existing, already: true, lead_id: leadId };

    const enrolment = await this.db.one<any>(
      `SELECT id, course_id FROM enrolment
        WHERE lead_id = $1::bigint AND deleted_at IS NULL AND status NOT IN ('cancelled', 'rejected')
        ORDER BY id DESC LIMIT 1`,
      [leadId],
    );
    const orgId = await this.orgId();
    const courseId = (enrolment?.course_id ?? lead.course_id) ? Number(enrolment?.course_id ?? lead.course_id) : null;
    const ownerId = lead.owner_id ? Number(lead.owner_id) : me.id;
    const centreCode = await this.centreCode();

    try {
      const out = await this.db.tx(async (c) => {
        const studentNo = await this.numbering.allocate('student', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c);
        const enrollmentNo = await this.numbering.allocate('enrollment', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c);
        // Student ID (customer id) — <CENTRE_CODE>-<YEAR>-<NNN>, one per student (client ID re-model).
        const customerNo = await this.numbering.allocateCoded('student', centreCode, c);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO student (org_id, lead_id, enrolment_id, student_no, enrollment_no, customer_no, full_name,
                                phone, whatsapp_phone, alt_phone, email,
                                branch_id, vertical_id, pipeline_id, campaign_id, course_id,
                                owner_id, team_id, status, created_by)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6, $7,
                   $8, $9, $10, $11,
                   $12::bigint, $13::bigint, $14::bigint, $15::bigint, $16::bigint,
                   $17::bigint, $18::bigint, 'active', $19::bigint)
           RETURNING id`,
          [orgId, leadId, enrolment?.id ?? null, studentNo, enrollmentNo, customerNo, lead.full_name,
            lead.phone ?? null, lead.whatsapp_phone ?? null, lead.alt_phone ?? null, lead.email ?? null,
            lead.branch_id, lead.vertical_id, lead.pipeline_id ?? null, lead.campaign_id ?? null, courseId,
            ownerId, lead.team_id ?? null, me.id],
        );
        const id = Number(ins.rows[0].id);

        if (enrolment?.id) {
          await c.query(
            `UPDATE enrolment SET student_profile_id = $2::bigint, updated_at = now()
              WHERE id = $1::bigint AND student_profile_id IS NULL`,
            [enrolment.id, id],
          );
        }

        await this.winLead(c, lead, me.id, studentNo);
        await this.activity(c, leadId, me.id, `Converted to student ${studentNo}`);
        return { id, student_no: studentNo, enrollment_no: enrollmentNo };
      });
      // Notification Events — the lead just became a student (with its enrolment).
      await this.notifEvents?.safeFire('lead_converted', { lead_id: leadId });
      await this.notifEvents?.safeFire('enrollment_created', { lead_id: leadId, vertical_id: Number(lead.vertical_id) });
      // The lead now exists as a student — welcome them (student-facing).
      await this.notifEvents?.safeFire('student_welcome', {
        student_id: Number(out.id), vertical_id: Number(lead.vertical_id), dedupe: `welcome:${out.id}`,
        vars: { student_no: out.student_no, enrollment_no: out.enrollment_no },
      });
      // Item 1 — MULTI-COURSE / MULTI-VERTICAL CONVERT. If the caller sent a `courses[]`
      // array (each row a {vertical_id, course_id, batch_id?, fee_minor?} selection), create
      // ONE enrolment per selected course for the fresh student, each linked to the lead
      // (so the Admission Journey's Lead stage resolves) and each starting at an EARLY
      // admission_stage (course_selected — NOT admitted; it must still go through payment →
      // invoice → approval → confirmation → admit). Fees auto-fetched from the Course master
      // (editable). Back-compat: no `courses[]` => the classic single-course convert.
      const courseRows: any[] = Array.isArray(dto?.courses) ? dto.courses : [];
      const createdEnrolments = courseRows.length
        ? await this.createConvertEnrolments(Number(out.id), leadId, lead, courseRows, me)
        : [];
      return { ...out, already: false, lead_id: leadId, enrolments: createdEnrolments };
    } catch (e) {
      if ((e as { code?: string })?.code === '23505' && String((e as Error).message).includes('uq_student_lead')) {
        const s = await this.db.one<any>(
          `SELECT id, student_no, full_name, status FROM student WHERE lead_id = $1::bigint AND deleted_at IS NULL`,
          [leadId],
        );
        if (s) return { ...s, already: true, lead_id: leadId };
      }
      throw e;
    }
  }

  /**
   * UPDATE — the Edit Student form. Accepts the full profile (any subset), plus status and
   * batch assignment. Every profile column the form sends is persisted; status/batch keep
   * their existing guards.
   */
  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    // Full profile fields (identity/contact/guardian/address/id/education).
    const pairs = this.profilePairs(dto);
    this.validateProfile(pairs);
    for (const [col, val] of pairs) set(col, val);

    // Enrollment No — editable (auto or manual); blank clears to NULL (index tolerates it).
    if (dto?.enrollment_no !== undefined) {
      const v = dto.enrollment_no == null || String(dto.enrollment_no).trim() === '' ? null : String(dto.enrollment_no).trim();
      set('enrollment_no', v);
    }

    // Scope moves (branch/vertical/course/owner) — allowed on edit, validated as a cascade.
    if (dto?.branch_id !== undefined || dto?.vertical_id !== undefined) {
      const branchId = Number(dto.branch_id ?? cur.branch_id);
      const verticalId = Number(dto.vertical_id ?? cur.vertical_id);
      const courseId = dto?.course_id !== undefined ? (dto.course_id ? Number(dto.course_id) : null) : (cur.course_id ? Number(cur.course_id) : null);
      await this.assertScopeHierarchy(branchId, verticalId, courseId);
      set('branch_id', branchId); set('vertical_id', verticalId);
    }
    if (dto?.course_id !== undefined) set('course_id', dto.course_id ? Number(dto.course_id) : null);
    if (dto?.owner_id !== undefined) set('owner_id', dto.owner_id ? Number(dto.owner_id) : null);

    if (dto?.status !== undefined) {
      const st = String(dto.status);
      const def = await this.db.one<any>(`SELECT code FROM student_status_def WHERE code = $1`, [st]);
      if (!def) throw new BadRequestException('Unknown status.');
      // Sensitive statuses MUST go through the gated Change-Status endpoint (reason + approver
      // + outstanding snapshot + student.status_manage). A plain PATCH cannot set them.
      if (SENSITIVE_STATUSES.has(st)) throw new BadRequestException('Use the Change Status action for this status (it needs a reason, dates and an approver).');
      set('status', st);
    }
    if (dto?.batch_id !== undefined) {
      const bid = dto.batch_id === null || dto.batch_id === '' ? null : Number(dto.batch_id);
      if (bid != null) {
        const targetBranch = sets.some((s) => s.startsWith('branch_id')) ? Number(dto.branch_id) : cur.branch_id;
        const targetVertical = sets.some((s) => s.startsWith('vertical_id')) ? Number(dto.vertical_id) : cur.vertical_id;
        const b = await this.db.one<any>(
          `SELECT id FROM batch WHERE id = $1::bigint AND deleted_at IS NULL
             AND branch_id = $2::bigint AND vertical_id = $3::bigint`,
          [bid, targetBranch, targetVertical],
        );
        if (!b) throw new BadRequestException('That batch is not in this student\'s branch and vertical.');
      }
      set('batch_id', bid);
    }
    if (dto?.remarks !== undefined) set('remarks', dto.remarks ?? null);

    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE student SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE student SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id, me.id],
    );
    return { id, deleted: true };
  }

  /* ---------------------------------------------------------- bulk delete (OBS-2) */

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }

  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT s.id FROM student s WHERE s.id = ANY($1::bigint[]) AND s.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }

  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw);
    const ok = await this.inScopeIds(req, scope);
    return {
      entity: 'student', label: 'Student', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [],
    };
  }

  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }

  /**
   * ITEM 1 — create N enrolments for a freshly-converted student, one per selected
   * {vertical_id, course_id, batch_id?, fee/discount?} row. REUSES the per-enrolment create
   * shape from `addEnrolment` (dev/72): each enrolment carries the originating `lead_id`
   * (so the Admission Journey Lead stage resolves to the real lead + date), `student_profile_id`
   * (so it is exempt from `uq_enrolment_lead` and a student may hold MANY course enrolments),
   * and the migration-075 default `admission_stage='course_selected'` (an EARLY stage — the
   * enrolment is NOT auto-admitted). Fee is taken from the row, else auto-fetched from the
   * Course master (`m_course.meta.fee`, rupees -> paise). All rows are validated FIRST, then
   * inserted in ONE transaction (atomic — a bad row rejects the whole set with a 400).
   */
  async createConvertEnrolments(studentId: number, leadId: number, lead: any, rows: any[], me: { id: number }) {
    const orgId = await this.orgId();
    type R = { courseId: number; courseName: string; courseCode: string; branchId: number; verticalId: number;
      batchId: number | null; feeMinor: number; disc: number; net: number; plan: string; startDate: string | null;
      discount_type: string; discount_value: number; discountScope: DiscountScope; levels: ResolvedLevel[];
      discRequested: number; appStatus: DiscountApprovalStatus; capMinor: number | null;
      requestedBy: number | null; approvedBy: number | null };
    const resolved: R[] = [];
    for (const row of rows) {
      const courseId = row?.course_id ? Number(row.course_id) : null;
      if (!courseId) throw new BadRequestException('Each selected course row must name a course.');
      const course = await this.db.one<any>(`SELECT id, name, code, meta FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
      if (!course) throw new BadRequestException('Unknown course in the selection.');
      const verticalId = row?.vertical_id ? Number(row.vertical_id) : Number(lead.vertical_id);
      const branchId = row?.branch_id ? Number(row.branch_id) : Number(lead.branch_id);
      const batchId = row?.batch_id != null && String(row.batch_id).trim() !== '' ? Number(row.batch_id) : null;
      if (batchId != null) {
        const b = await this.db.one<any>(
          `SELECT id FROM batch WHERE id = $1::bigint AND deleted_at IS NULL AND vertical_id = $2::bigint`,
          [batchId, verticalId]);
        if (!b) throw new BadRequestException(`The chosen batch is not in the "${course.name}" vertical.`);
      }
      // ENROLLMENT LEVEL RE-MODEL (batch 2): if the row selects course levels, Total = Σ level
      // fees, discount overall/level, Net = Total − discount, and the levels become line-items on
      // the ONE enrolment. Otherwise (no levels) the classic single-course fee path is unchanged.
      const lm = await this.resolveLevelMoney(courseId, row?.levels, row, verticalId, me.id, true);
      let feeMinor: number; let disc: number; let net: number;
      let discount_type: EnrolmentDiscountType; let discount_value: number;
      let discountScope: DiscountScope = 'overall'; let levels: ResolvedLevel[] = [];
      if (lm) {
        feeMinor = lm.total_fee_minor; disc = lm.discount_minor; net = lm.net_fee_minor;
        discount_type = lm.discount_type; discount_value = lm.discount_value; discountScope = lm.scope; levels = lm.levels;
      } else {
        if (row?.fee_minor != null && String(row.fee_minor).trim() !== '') {
          feeMinor = Number(row.fee_minor);
        } else {
          const masterFee = Number((course.meta as any)?.fee ?? 0);
          feeMinor = Math.round((Number.isFinite(masterFee) ? masterFee : 0) * 100);
        }
        if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new BadRequestException('Fee must be a non-negative amount.');
        const dsc = await this.resolveDiscount(feeMinor, row, verticalId, me.id, true);
        disc = dsc.discount_amount_minor; net = dsc.net_fee_minor;
        discount_type = dsc.discount_type; discount_value = dsc.discount_value;
      }
      const plan = String(row?.payment_plan ?? 'full');
      if (!['full', 'emi_3', 'emi_6', 'custom'].includes(plan)) throw new BadRequestException('Choose a valid payment plan.');
      const startDate = row?.start_date != null && String(row.start_date).trim() !== ''
        ? requireDateString(String(row.start_date), () => { throw new BadRequestException('Invalid start date.'); }) : null;
      // OVER-CAP APPROVAL (dev/103, DEF-4) — `disc` is the FULL requested discount. Run it through
      // the Discount Master cap: within cap / authorised → applied in full; over cap by a
      // non-authorised user → only the cap applies now, the excess held pending.
      const discRequested = disc;
      const dd = await this.decideMasterDiscount(
        { branch_id: branchId, vertical_id: verticalId, course_id: courseId }, feeMinor, discRequested, me.id);
      disc = dd.applied; net = feeMinor - disc;
      resolved.push({ courseId, courseName: course.name, courseCode: String(course.code ?? '').trim() || 'CRS', branchId, verticalId, batchId, feeMinor, disc, net, plan, startDate,
        discount_type, discount_value, discountScope, levels,
        discRequested, appStatus: dd.status, capMinor: dd.capMinor, requestedBy: dd.requestedBy, approvedBy: dd.approvedBy });
    }
    const out: any[] = [];
    await this.db.tx(async (c) => {
      for (const r of resolved) {
        const enrolmentNo = await this.numbering.allocateCoded('enrolment', r.courseCode, c);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO enrolment (org_id, enrolment_no, lead_id, branch_id, vertical_id, counsellor_id,
                                  course_id, batch_id, student_profile_id, fee_minor, discount_minor,
                                  net_fee_minor, payment_plan, start_date, status, course_status, remarks, created_by,
                                  gross_fee_minor, discount_type, discount_value, discount_amount_minor, discount_scope,
                                  discount_approval_status, discount_requested_minor, discount_cap_minor,
                                  discount_requested_by, discount_approved_by, discount_approved_at)
           VALUES ($1::bigint,$2::varchar,$3::bigint,$4::bigint,$5::bigint,$6::bigint,
                   $7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,
                   $12::bigint,$13::varchar,$14::date,'active','active',$15,$16::bigint,
                   $17::bigint,$18::varchar,$19::numeric,$20::bigint,$21::varchar,
                   $22::varchar,$23::bigint,$24::bigint,$25::bigint,$26::bigint,
                   CASE WHEN $22::varchar = 'approved' THEN now() ELSE NULL END)
           RETURNING id`,
          [orgId, enrolmentNo, leadId, r.branchId, r.verticalId, lead.owner_id ?? me.id,
            r.courseId, r.batchId, studentId, r.feeMinor, r.disc, r.net, r.plan, r.startDate,
            `Enrolled in ${r.courseName} on conversion`, me.id,
            r.feeMinor, r.discount_type, r.discount_value, r.disc, r.discountScope,
            r.appStatus, r.discRequested, r.capMinor, r.requestedBy, r.approvedBy]);
        const eid = Number(ins.rows[0].id);
        if (r.levels.length) await this.insertEnrolmentLevels(c, orgId, eid, r.levels);
        await c.query(
          `INSERT INTO enrolment_status_history (org_id, branch_id, vertical_id, enrolment_id, student_id, course_id,
               from_status, to_status, reason, effective_date, outstanding_minor, changed_by)
           VALUES ($1::bigint,$2,$3,$4::bigint,$5::bigint,$6::bigint,NULL,'active',$7,$8::date,$9::bigint,$10::bigint)`,
          [orgId, r.branchId, r.verticalId, eid, studentId, r.courseId,
            `Enrolled in ${r.courseName}`, r.startDate, r.net, me.id]);
        // VERTICAL-WISE STUDENT ID — mint (or reuse) the per-vertical display ID for THIS enrolment's vertical.
        const svid = await this.ensureVerticalId(c, studentId, r.branchId, r.verticalId, me.id);
        out.push({ id: eid, enrolment_no: enrolmentNo, course_id: r.courseId, course_name: r.courseName,
          vertical_id: r.verticalId, branch_id: r.branchId, net_fee_minor: r.net, admission_stage: 'course_selected',
          student_vertical_no: svid.student_vertical_no,
          total_fee_minor: r.feeMinor, gross_fee_minor: r.feeMinor, discount_type: r.discount_type, discount_value: r.discount_value,
          discount_amount_minor: r.disc, discount_scope: r.discountScope,
          discount_approval_status: r.appStatus, discount_over_cap: r.appStatus === 'pending',
          discount_requested_minor: r.discRequested, discount_cap_minor: r.capMinor,
          levels: r.levels.map((l) => ({ course_level_id: l.course_level_id, code: l.code, label: l.label, fee_minor: l.fee_minor, discount_minor: l.discount_minor })) });
      }
    });
    return out;
  }

  /* -------------------------------------------------- bulk convert (leads -> students) */

  /**
   * BULK CONVERT leads -> students. REUSES the single-lead `convert()` per lead — same
   * mapping, dedupe, scope enforcement, lead-win and side effects — inside its OWN
   * transaction, so one bad lead never rolls back the others. Idempotent: a lead already
   * converted is SKIPPED ("already converted") with no duplicate student; an id outside the
   * caller's scope (or missing) is reported under `failed`. Returns a structured per-lead
   * report + counts. Guarded by student.create (the exact key the single Convert uses).
   */
  async bulkConvert(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ids = this.idList(raw);
    const converted: Array<{ lead_id: number; student_id: number; student_no: string }> = [];
    const skipped: Array<{ lead_id: number; reason: string; student_id?: number }> = [];
    const failed: Array<{ lead_id: number; error: string }> = [];
    // de-dupe the incoming ids so the same lead isn't attempted twice in one call
    for (const id of Array.from(new Set(ids))) {
      try {
        const r: any = await this.convert({ lead_id: id }, me, scope);
        if (r?.already) {
          skipped.push({ lead_id: id, reason: 'already converted', student_id: Number(r.id) });
        } else {
          converted.push({ lead_id: id, student_id: Number(r.id), student_no: r.student_no });
        }
      } catch (e) {
        failed.push({ lead_id: id, error: (e as Error)?.message ?? 'Conversion failed' });
      }
    }
    return {
      converted, skipped, failed,
      counts: {
        requested: ids.length,
        converted: converted.length,
        skipped: skipped.length,
        failed: failed.length,
      },
    };
  }

  /* ------------------------------------------------------------------ helpers */

  private async winLead(
    c: any,
    lead: { id: number; pipeline_id: number | string | null; stage_id: number | string | null },
    actorId: number,
    studentNo: string,
  ) {
    if (!lead.id) throw new Error('winLead: no lead id');
    if (!lead.pipeline_id) return;
    const st = await c.query(
      `SELECT id, name FROM pipeline_stage
        WHERE pipeline_id = $1::bigint AND stage_type = 'won' AND is_active
        ORDER BY sort_order LIMIT 1`,
      [lead.pipeline_id],
    );
    const stage = st.rows[0];
    if (!stage) return;
    if (Number(lead.stage_id) === Number(stage.id)) return;
    await c.query(`UPDATE lead SET stage_id = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [lead.id, stage.id]);
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id, to_value)
       SELECT l.id, l.org_id, l.branch_id, 'stage_change', $2, $3::bigint, $4::jsonb
         FROM lead l WHERE l.id = $1::bigint`,
      [lead.id, `Won — converted to student (${studentNo})`, actorId, JSON.stringify({ stage_id: Number(stage.id), stage: stage.name })],
    );
  }

  private async activity(c: any, leadId: number, actorId: number, note: string) {
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
       SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
         FROM lead l WHERE l.id = $1::bigint`,
      [leadId, note, actorId],
    );
  }
  /* ------------------------------------------------------ status lifecycle */

  /** The 11-status catalog (self-manageable master) — powers the Change-Status UI + labels. */
  async statusCatalog() {
    return this.db.query<any>(
      `SELECT code, label, meaning, lms_access, requires_reason, requires_approval, is_terminal, ordering
         FROM student_status_def ORDER BY ordering, code`);
  }

  /** The student's CURRENT outstanding dues (paise) — net fee of their enrolment minus
   *  receipts, floored at 0 (the same net_fee/receipts basis the Fee Dues service uses). A
   *  student with no enrolment has nothing outstanding. */
  async studentOutstandingMinor(studentId: number): Promise<number> {
    const r = await this.db.one<{ outstanding_minor: string }>(
      `SELECT GREATEST(0, e.net_fee_minor - COALESCE(sum(fr.amount_minor), 0))::bigint AS outstanding_minor
         FROM student s
         JOIN enrolment e ON e.id = s.enrolment_id AND e.deleted_at IS NULL
         LEFT JOIN fee_receipt fr ON fr.enrolment_id = e.id AND fr.deleted_at IS NULL
        WHERE s.id = $1::bigint
        GROUP BY e.net_fee_minor`, [studentId]);
    return Number(r?.outstanding_minor ?? 0);
  }

  /**
   * CHANGE STATUS — the lifecycle transition. The route is guarded by student.update; the
   * SENSITIVE statuses (On Hold / Suspended / Withdrawn / Dropped Out / Cancelled) are ALSO
   * gated by student.status_manage and require reason + last_attendance_date + effective date
   * + an Approved-By user, and snapshot the student's outstanding fee. Every transition writes
   * student_status_history. A Cancelled/Withdrawn/Dropped-Out student's enrolment is cancelled
   * so it stops counting toward booked revenue/targets (delivering enrolment cancellation).
   * Scope-enforced (the student is loaded through the scoped get()). Idempotent (same status → no-op).
   */
  async changeStatus(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const to = String(dto?.to_status ?? '').trim();
    if (!to) throw new BadRequestException('Choose a status.');
    const def = await this.db.one<any>(`SELECT * FROM student_status_def WHERE code = $1`, [to]);
    if (!def) throw new BadRequestException('Unknown status.');
    const from = String(student.status ?? 'active');
    const sensitive = SENSITIVE_STATUSES.has(to);

    if (sensitive) {
      const grants = this.rbacData ? await this.rbacData.loadUserGrants(me.id) : null;
      const allowed = grants ? this.resolver.resolve(grants, 'student.status_manage').allowed : false;
      if (!allowed) {
        throw new ForbiddenException('You need the "Manage student status" permission to set a sensitive status (On Hold / Suspended / Withdrawn / Dropped Out / Cancelled).');
      }
    }

    const clean = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
    const asDate = (v: unknown, label: string): string | null => {
      const c = clean(v);
      if (c == null) return null;
      return requireDateString(c, () => { throw new BadRequestException(`${label} is not a valid date.`); });
    };
    const reason = clean(dto?.reason);
    const lastAtt = asDate(dto?.last_attendance_date, 'Last Attendance Date');
    const effective = asDate(dto?.effective_date, to === 'on_hold' ? 'Hold Start Date' : 'Effective date');
    let approvedBy: number | null = dto?.approved_by != null && dto.approved_by !== '' ? Number(dto.approved_by) : null;

    if (sensitive) {
      const effLabel = to === 'on_hold' ? 'Hold Start Date' : 'Dropout Date';
      if (!reason) throw new BadRequestException(`Reason is required for status "${def.label}".`);
      if (!lastAtt) throw new BadRequestException(`Last Attendance Date is required for status "${def.label}".`);
      if (!effective) throw new BadRequestException(`${effLabel} is required for status "${def.label}".`);
      if (approvedBy == null) throw new BadRequestException('Approved By is required.');
      const appr = await this.db.one<any>(`SELECT id FROM "user" WHERE id = $1::bigint`, [approvedBy]);
      if (!appr) throw new BadRequestException('Approved By must be a valid user.');
    }

    const outstanding = await this.studentOutstandingMinor(id);

    if (from === to) return { id, status: to, unchanged: true, outstanding_minor: outstanding };

    const orgId = await this.orgId();
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE student SET status = $2, status_reason = $3, status_last_attendance_date = $4,
                            status_effective_date = $5, status_outstanding_minor = $6,
                            status_approved_by = $7, status_changed_by = $8, status_changed_at = now(),
                            updated_at = now()
          WHERE id = $1::bigint`,
        [id, to, reason, lastAtt, effective, outstanding, approvedBy, me.id]);

      await c.query(
        `INSERT INTO student_status_history (org_id, branch_id, vertical_id, student_id, from_status, to_status,
             reason, last_attendance_date, effective_date, outstanding_minor, approved_by, changed_by)
         VALUES ($1::bigint,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12::bigint)`,
        [orgId, student.branch_id ?? null, student.vertical_id ?? null, id, from, to,
          reason, lastAtt, effective, outstanding, approvedBy, me.id]);

      if (REVENUE_CANCELLING_STATUSES.has(to) && student.enrolment_id) {
        await c.query(
          `UPDATE enrolment SET status = 'cancelled', updated_at = now()
            WHERE id = $1::bigint AND deleted_at IS NULL AND status IN ('active','pending_approval')`,
          [Number(student.enrolment_id)]);
      }
    });

    await this.notifEvents?.safeFire('student_status_changed', {
      student_id: id, vertical_id: student.vertical_id ?? undefined, dedupe: `status:${id}:${to}:${Date.now()}`,
      vars: { from_status: from, to_status: to, status_label: def.label, reason: reason ?? '' },
    });

    return {
      id, from_status: from, to_status: to, lms_access: def.lms_access,
      outstanding_minor: outstanding, approved_by: approvedBy,
      enrolment_cancelled: REVENUE_CANCELLING_STATUSES.has(to) && !!student.enrolment_id,
    };
  }

  /** The transition trail — who / when / reason / approver. Scope-enforced via get(). */
  async statusHistory(id: number, scope: ResolvedScope) {
    await this.get(id, scope);
    return this.db.query<any>(
      `SELECT h.id, h.from_status, h.to_status, h.reason, h.last_attendance_date, h.effective_date,
              h.outstanding_minor, h.approved_by, h.changed_by, h.changed_at,
              df.label AS from_label, dt.label AS to_label,
              ap.name AS approved_by_name, ch.name AS changed_by_name
         FROM student_status_history h
         LEFT JOIN student_status_def df ON df.code = h.from_status
         LEFT JOIN student_status_def dt ON dt.code = h.to_status
         LEFT JOIN "user" ap ON ap.id = h.approved_by
         LEFT JOIN "user" ch ON ch.id = h.changed_by
        WHERE h.student_id = $1::bigint
        ORDER BY h.changed_at DESC, h.id DESC`, [id]);
  }

  /**
   * STUDENT-FACING LMS READ — the published study material / course content / syllabus the
   * student may consume, WITH the LMS-access gate enforced by their lifecycle status. A NONE
   * status is blocked with a clear 403; LIMITED (On Hold/Inactive) and ALUMNI (Completed) may
   * view material but cannot start attempts. Staff/admin management reads are unaffected.
   */
  async lmsContent(id: number, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const access = studentLmsAccess(student.status);
    const label = student.status_label ?? student.status;
    if (!canViewMaterial(access)) {
      throw new ForbiddenException(lmsBlockedMessage(String(student.status), String(label), access, 'material'));
    }
    const material = await this.db.query<any>(
      `SELECT m.id, m.title, m.description, m.material_type, m.url, m.external_url, m.access_level, m.created_at,
              c.name AS course_name, bt.name AS batch_name
         FROM study_material m
         LEFT JOIN m_course c ON c.id = m.course_id
         LEFT JOIN batch bt ON bt.id = m.batch_id
        WHERE m.deleted_at IS NULL AND m.visibility = 'published'
          AND ( (m.access_level = 'batch' AND m.batch_id = $1::bigint)
             OR (m.access_level = 'course' AND m.course_id = $2::bigint)
             OR (m.access_level = 'vertical' AND m.vertical_id = $3::bigint) )
        ORDER BY m.created_at DESC`,
      [student.batch_id ?? null, student.course_id ?? null, student.vertical_id ?? null]);
    const courseContent = await this.db.query<any>(
      `SELECT id, title, module_no, description, created_at FROM course_content
        WHERE deleted_at IS NULL AND workflow_status = 'published' AND course_id = $1::bigint
        ORDER BY module_no, id`, [student.course_id ?? null]);
    const syllabus = await this.db.query<any>(
      `SELECT id, title, version, body, created_at FROM syllabus
        WHERE deleted_at IS NULL AND workflow_status = 'published' AND course_id = $1::bigint
        ORDER BY version, id`, [student.course_id ?? null]);
    return {
      student_id: id, status: student.status, status_label: label, lms_access: access,
      can_attempt: canAttempt(access), can_view_material: canViewMaterial(access),
      material, course_content: courseContent, syllabus,
    };
  }

  /* ============================================================================
   * PER-ENROLMENT (per-course) STATUS — mirrors the student-status lifecycle at the
   * enrolment level, reusing the SAME student_status_def catalog. A student can be Active
   * overall yet have one course Completed and another Active; completing/cancelling ONE
   * enrolment never touches the others or the overall student status. The SENSITIVE
   * enrolment statuses reuse the student.status_manage permission.
   * ============================================================================ */

  /** The enrolment status catalog (the shared catalog filtered to the enrolment subset). */
  async enrolmentStatusCatalog() {
    return this.db.query<any>(
      `SELECT code, label, meaning, lms_access, requires_reason, requires_approval, is_terminal, ordering
         FROM student_status_def WHERE code = ANY($1::text[]) ORDER BY ordering, code`,
      [Array.from(ENROLMENT_STATUSES)]);
  }

  /** Outstanding dues (paise) for a SINGLE enrolment — net fee minus this enrolment's receipts. */
  async enrolmentOutstandingMinor(enrolmentId: number): Promise<number> {
    const r = await this.db.one<{ outstanding_minor: string }>(
      `SELECT GREATEST(0, e.net_fee_minor - COALESCE(sum(fr.amount_minor), 0))::bigint AS outstanding_minor
         FROM enrolment e
         LEFT JOIN fee_receipt fr ON fr.enrolment_id = e.id AND fr.deleted_at IS NULL
        WHERE e.id = $1::bigint
        GROUP BY e.net_fee_minor`, [enrolmentId]);
    return Number(r?.outstanding_minor ?? 0);
  }

  /** Load ONE enrolment inside the caller's scope (lead-optional). 404 if out of scope. */
  private async enrolmentInScope(enrolmentId: number, scope: ResolvedScope) {
    const params: unknown[] = [enrolmentId];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT e.*, co.name AS course_name, bt.name AS batch_name,
              sd.label AS course_status_label, sd.lms_access AS course_lms_access,
              COALESCE(e.student_profile_id,
                (SELECT s.id FROM student s WHERE s.enrolment_id = e.id AND s.deleted_at IS NULL LIMIT 1)) AS linked_student_id
         FROM enrolment e
         LEFT JOIN m_course co ON co.id = e.course_id
         LEFT JOIN batch bt ON bt.id = e.batch_id
         LEFT JOIN student_status_def sd ON sd.code = e.course_status
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}
        LIMIT 1`, params);
    if (!row) throw new NotFoundException('Enrolment not found (or outside your access)');
    return row;
  }

  /**
   * VERTICAL-WISE STUDENT ID (client feedback). Ensure a `student_vertical_id` row exists for
   * this (student, vertical) — the display Student ID minted PER vertical, from the numbering
   * series scoped to that branch+vertical (MOST-SPECIFIC-WINS, Indian-FY aware, prefix SID-).
   * Minted the FIRST time; REUSED (idempotent) for every further enrolment in the same vertical.
   * MUST run inside the caller's transaction so the number rolls back with the enrolment.
   * Does NOT touch `student.student_no` (STU-) — that stays the master record identifier.
   */
  private async ensureVerticalId(
    c: any, studentId: number, branchId: number | null, verticalId: number, actorId: number | null,
  ): Promise<{ id: number; student_vertical_no: string; created: boolean }> {
    if (!verticalId) throw new BadRequestException('A vertical is required to mint a vertical-wise Student ID.');
    const existing = await c.query(
      `SELECT id, student_vertical_no FROM student_vertical_id
        WHERE student_id = $1::bigint AND vertical_id = $2::bigint LIMIT 1`, [studentId, verticalId]);
    if (existing.rows[0]) {
      return { id: Number(existing.rows[0].id), student_vertical_no: String(existing.rows[0].student_vertical_no), created: false };
    }
    const orgId = await this.orgId();
    // Roll Number — <VERTICAL_CODE>-<YEAR>-<NNN> (client ID re-model). Vertical-wise: the code is
    // the vertical's own Code (set on the vertical), so two verticals mint distinct roll numbers.
    const vc = await c.query(`SELECT code FROM vertical WHERE id = $1::bigint`, [verticalId]);
    const verticalCode = String(vc.rows[0]?.code ?? '').trim().toUpperCase() || 'V';
    const no = await this.numbering.allocateCoded('roll', verticalCode, c);
    const ins = await c.query(
      `INSERT INTO student_vertical_id (org_id, student_id, branch_id, vertical_id, student_vertical_no, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::varchar,$6::bigint)
       ON CONFLICT (student_id, vertical_id) DO NOTHING
       RETURNING id, student_vertical_no`,
      [orgId, studentId, branchId ?? null, verticalId, no, actorId ?? null]);
    if (ins.rows[0]) {
      return { id: Number(ins.rows[0].id), student_vertical_no: String(ins.rows[0].student_vertical_no), created: true };
    }
    // lost a race — the row was inserted concurrently; the number we allocated is unused (rare).
    const again = await c.query(
      `SELECT id, student_vertical_no FROM student_vertical_id
        WHERE student_id = $1::bigint AND vertical_id = $2::bigint LIMIT 1`, [studentId, verticalId]);
    return { id: Number(again.rows[0].id), student_vertical_no: String(again.rows[0].student_vertical_no), created: false };
  }

  /** LIST a student's course enrolments, each with its OWN status + combined (overall+course)
   *  effective LMS access + last-change metadata. Scope-enforced via get(). */
  async listEnrolments(id: number, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const sid = Number(student.id);
    const rows = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.course_id, e.batch_id, e.net_fee_minor, e.fee_minor,
              e.discount_minor, e.gross_fee_minor, e.discount_type, e.discount_value, e.discount_amount_minor,
              e.payment_plan, e.start_date, e.created_at,
              e.branch_id, e.vertical_id,
              e.course_status, e.course_status_reason, e.course_status_last_attendance_date,
              e.course_status_effective_date, e.course_status_outstanding_minor,
              e.course_status_approved_by, e.course_status_changed_by, e.course_status_changed_at,
              e.admission_stage,
              -- dev/100 (client): surface the per-enrolment Balance / Due Fee = net_fee - fees paid.
              COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                          WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor,
              co.name AS course_name, bt.name AS batch_name,
              br.name AS branch_name, vt.name AS vertical_name,
              svi.student_vertical_no,
              sd.label AS course_status_label, sd.is_terminal AS course_status_is_terminal,
              ap.name AS course_status_approved_by_name, ch.name AS course_status_changed_by_name
         FROM enrolment e
         LEFT JOIN m_course co ON co.id = e.course_id
         LEFT JOIN batch bt ON bt.id = e.batch_id
         LEFT JOIN branch br ON br.id = e.branch_id
         LEFT JOIN vertical vt ON vt.id = e.vertical_id
         LEFT JOIN student_vertical_id svi ON svi.student_id = $1::bigint AND svi.vertical_id = e.vertical_id
         LEFT JOIN student_status_def sd ON sd.code = e.course_status
         LEFT JOIN "user" ap ON ap.id = e.course_status_approved_by
         LEFT JOIN "user" ch ON ch.id = e.course_status_changed_by
        WHERE e.deleted_at IS NULL AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
        ORDER BY e.created_at DESC, e.id DESC`,
      [sid, student.enrolment_id ? Number(student.enrolment_id) : 0]);
    const overall = studentLmsAccess(student.status);
    const enrolments = rows.map((e: any) => {
      const courseAccess = studentLmsAccess(e.course_status);
      const effective = combineAccess(overall, courseAccess);
      // dev/100 (client): Balance / Due Fee = net fee - fees paid (never negative). Surfaced as a
      // column in the Course Enrollment section; the standalone Fee Management screen already shows it.
      const paidMinor = Number(e.paid_minor ?? 0);
      const netMinor = Number(e.net_fee_minor ?? 0);
      const outstandingMinor = Math.max(0, netMinor - paidMinor);
      return {
        ...e,
        paid_minor: paidMinor,
        outstanding_minor: outstandingMinor,
        // Branch > Vertical > Course breadcrumb for THIS enrolment (client feedback).
        path: [e.branch_name, e.vertical_name, e.course_name].filter(Boolean).join(' \u203a '),
        course_lms_access: courseAccess,
        effective_lms_access: effective,
        effective_can_view: canViewMaterial(effective),
        effective_can_attempt: canAttempt(effective),
      };
    });
    // ENROLLMENT LEVEL RE-MODEL (batch 2): attach each enrolment's level line-items + a compact
    // summary string ("A1, A2, B1") for the Course Enrollment tab / Fee Management "Level" column.
    // Total Fee = summed level fees (== fee_minor when levels exist) else the single course fee.
    const lvlMap = await this.levelsByEnrolment(enrolments.map((e: any) => Number(e.id)));
    for (const e of enrolments) {
      const ls = lvlMap.get(Number(e.id)) ?? [];
      e.levels = ls;
      e.level_summary = ls.map((l: any) => l.code).join(', ');
      e.total_fee_minor = Number(e.gross_fee_minor ?? e.fee_minor ?? 0);
    }
    // The distinct vertical-wise Student IDs across this student's enrolments (one per vertical).
    const vseen = new Map<number, any>();
    for (const e of enrolments) {
      const vid = e.vertical_id != null ? Number(e.vertical_id) : null;
      if (vid == null || vseen.has(vid)) continue;
      vseen.set(vid, {
        vertical_id: vid, vertical_name: e.vertical_name ?? null,
        branch_id: e.branch_id != null ? Number(e.branch_id) : null, branch_name: e.branch_name ?? null,
        student_vertical_no: e.student_vertical_no ?? null,
      });
    }
    return {
      student_id: sid,
      overall_status: student.status,
      overall_status_label: student.status_label ?? student.status,
      overall_lms_access: overall,
      vertical_ids: Array.from(vseen.values()),
      enrolments,
    };
  }

  /** ADD an enrolment to an existing student (enrol into ANOTHER course). Creates a fresh
   *  enrolment (status active / course_status active), linked via student_profile_id, in the
   *  student's own branch/vertical; scope-enforced through get(). This is what makes "2
   *  courses" possible from the Course Enrollment section. */
  /** ADMISSION JOURNEY for a student — the intake funnel per enrolment (migration 075). Loads the
   *  student in scope, then assembles each of its enrolments' stage timeline. `caps` are the
   *  caller's admission capabilities (feed the next-action flags; the API still enforces). */
  async studentAdmissionJourney(id: number, scope: ResolvedScope, caps: { canApprove: boolean; canUpdate: boolean }) {
    const student = await this.get(id, scope);   // scope + existence (404)
    const sid = Number(student.id);
    const rows = await this.db.query<any>(
      `SELECT e.id FROM enrolment e
        WHERE e.deleted_at IS NULL AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
        ORDER BY e.created_at DESC, e.id DESC`,
      [sid, student.enrolment_id ? Number(student.enrolment_id) : 0]);
    const enrolments = [];
    for (const r of rows) {
      const j = await assembleAdmissionJourney(this.db, Number(r.id), { canApprove: caps.canApprove, canUpdate: caps.canUpdate, withEvents: true });
      if (j) enrolments.push(j);
    }
    return { student_id: sid, student_name: student.full_name, enrolments };
  }

  async addEnrolment(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    if (!courseId) throw new BadRequestException('Choose a course to enrol into.');
    const course = await this.db.one<any>(`SELECT id, name, code FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
    if (!course) throw new BadRequestException('Unknown course.');
    // A student may be enrolled into ANOTHER vertical (the Branch>Vertical>Course cascade). Default
    // to the student's own branch/vertical; honour an explicit vertical_id/branch_id when given.
    let enrolVerticalId = student.vertical_id != null ? Number(student.vertical_id) : null;
    let enrolBranchId = student.branch_id != null ? Number(student.branch_id) : null;
    if (dto?.vertical_id != null && String(dto.vertical_id).trim() !== '') {
      const vv = await this.db.one<any>(`SELECT id, branch_id FROM vertical WHERE id = $1::bigint AND deleted_at IS NULL`, [Number(dto.vertical_id)]);
      if (!vv) throw new BadRequestException('Unknown vertical for this enrolment.');
      enrolVerticalId = Number(vv.id);
      enrolBranchId = dto?.branch_id != null && String(dto.branch_id).trim() !== '' ? Number(dto.branch_id) : Number(vv.branch_id);
    } else if (dto?.branch_id != null && String(dto.branch_id).trim() !== '') {
      enrolBranchId = Number(dto.branch_id);
    }
    if (enrolVerticalId == null) throw new BadRequestException('A vertical is required for this enrolment.');
    const batchId = dto?.batch_id != null && String(dto.batch_id).trim() !== '' ? Number(dto.batch_id) : null;
    if (batchId != null) {
      const b = await this.db.one<any>(
        `SELECT id FROM batch WHERE id = $1::bigint AND deleted_at IS NULL AND vertical_id = $2::bigint`,
        [batchId, enrolVerticalId]);
      if (!b) throw new BadRequestException("That batch is not in this enrolment's vertical.");
    }
    // ENROLLMENT LEVEL RE-MODEL (batch 2): if levels are selected, Total = Σ level fees and the
    // levels become line-items on this ONE enrolment; else the classic single-fee path (unchanged).
    const lm = await this.resolveLevelMoney(courseId, dto?.levels, dto, enrolVerticalId, me.id, true);
    let fee: number; let disc: number; let net: number;
    let discountType: EnrolmentDiscountType; let discountValue: number;
    let discountScope: DiscountScope = 'overall'; let levels: ResolvedLevel[] = [];
    if (lm) {
      fee = lm.total_fee_minor; disc = lm.discount_minor; net = lm.net_fee_minor;
      discountType = lm.discount_type; discountValue = lm.discount_value; discountScope = lm.scope; levels = lm.levels;
    } else {
      fee = Number(dto?.fee_minor ?? 0);
      if (!Number.isFinite(fee) || fee < 0) throw new BadRequestException('Fee must be a non-negative amount.');
      const dsc = await this.resolveDiscount(fee, dto, enrolVerticalId, me.id, true);
      disc = dsc.discount_amount_minor; net = dsc.net_fee_minor;
      discountType = dsc.discount_type; discountValue = dsc.discount_value;
    }
    const plan = String(dto?.payment_plan ?? 'full');
    if (!['full', 'emi_3', 'emi_6', 'custom'].includes(plan)) throw new BadRequestException('Choose a valid payment plan.');
    const startDate = dto?.start_date != null && String(dto.start_date).trim() !== ''
      ? requireDateString(String(dto.start_date), () => { throw new BadRequestException('Invalid start date.'); }) : null;
    // OVER-CAP APPROVAL (dev/103, DEF-4) — `disc` is the FULL requested discount. The Discount
    // Master cap decides applied-in-full vs held-at-cap with the excess pending an authorised nod.
    const discRequested = disc;
    const dd = await this.decideMasterDiscount(
      { branch_id: enrolBranchId, vertical_id: enrolVerticalId, course_id: courseId }, fee, discRequested, me.id);
    disc = dd.applied; net = fee - disc;
    const orgId = await this.orgId();

    const out = await this.db.tx(async (c) => {
      // Enrolment No — <COURSE_CODE>-<YEAR>-<NNN> (client ID re-model), sequence per course+year.
      const enrolmentNo = await this.numbering.allocateCoded(
        'enrolment', String(course.code ?? '').trim() || 'CRS', c);
      const r = await c.query<{ id: string }>(
        `INSERT INTO enrolment (org_id, enrolment_no, lead_id, branch_id, vertical_id, counsellor_id,
                                course_id, batch_id, student_profile_id, fee_minor, discount_minor,
                                net_fee_minor, payment_plan, start_date, status, course_status, remarks, created_by,
                                gross_fee_minor, discount_type, discount_value, discount_amount_minor, discount_scope,
                                discount_approval_status, discount_requested_minor, discount_cap_minor,
                                discount_requested_by, discount_approved_by, discount_approved_at)
         VALUES ($1::bigint,$2::varchar,$3::bigint,$4::bigint,$5::bigint,$6::bigint,
                 $7::bigint,$8::bigint,$9::bigint,$10::bigint,$11::bigint,
                 $12::bigint,$13::varchar,$14::date,'active','active',$15,$16::bigint,
                 $17::bigint,$18::varchar,$19::numeric,$20::bigint,$21::varchar,
                 $22::varchar,$23::bigint,$24::bigint,$25::bigint,$26::bigint,
                 CASE WHEN $22::varchar = 'approved' THEN now() ELSE NULL END)
         RETURNING id`,
        [orgId, enrolmentNo, student.lead_id ?? null, enrolBranchId, enrolVerticalId,
          student.owner_id ?? me.id, courseId, batchId, id, fee, disc, net, plan, startDate,
          dto?.remarks ?? null, me.id,
          fee, discountType, discountValue, disc, discountScope,
          dd.status, discRequested, dd.capMinor, dd.requestedBy, dd.approvedBy]);
      const eid = Number(r.rows[0].id);
      if (levels.length) await this.insertEnrolmentLevels(c, orgId, eid, levels);
      await c.query(
        `INSERT INTO enrolment_status_history (org_id, branch_id, vertical_id, enrolment_id, student_id, course_id,
             from_status, to_status, reason, effective_date, outstanding_minor, changed_by)
         VALUES ($1::bigint,$2,$3,$4::bigint,$5::bigint,$6::bigint,NULL,'active',$7,$8::date,$9::bigint,$10::bigint)`,
        [orgId, enrolBranchId, enrolVerticalId, eid, id, courseId,
          `Enrolled in ${course.name}`, startDate, net, me.id]);
      // VERTICAL-WISE STUDENT ID — mint (or reuse) the per-vertical display ID for this enrolment's vertical.
      const svid = await this.ensureVerticalId(c, id, enrolBranchId, enrolVerticalId, me.id);
      return { id: eid, enrolment_no: enrolmentNo, student_vertical_no: svid.student_vertical_no };
    });
    return { ...out, course_id: courseId, course_name: course.name, status: 'active', course_status: 'active',
      vertical_id: enrolVerticalId, branch_id: enrolBranchId,
      total_fee_minor: fee, gross_fee_minor: fee, discount_type: discountType, discount_value: discountValue,
      discount_amount_minor: disc, net_fee_minor: net, discount_scope: discountScope,
      discount_approval_status: dd.status, discount_over_cap: dd.status === 'pending',
      discount_requested_minor: discRequested, discount_cap_minor: dd.capMinor,
      levels: levels.map((l) => ({ course_level_id: l.course_level_id, code: l.code, label: l.label, fee_minor: l.fee_minor, discount_minor: l.discount_minor })) };
  }

  /**
   * EDIT an existing course-enrolment (client feedback item 6 — the Edit action on a Course
   * Enrollment row). Course (within its vertical) / fee / discount (amount or %) / payment plan
   * intent / start date. Scope-enforced through enrolmentInScope (lead-OPTIONAL — a directly
   * added student's enrolment has no lead, so the old PATCH /enrolments/:id path 404'd on its
   * lead inner-join: DEF-2, dev/104). The discount runs through the SAME Discount Master cap the
   * convert/add paths now do (DEF-4): within cap / authorised → applied in full; over cap by a
   * non-authorised user → only the cap applies now, the excess held pending in the over-cap
   * approvals queue. Net moved below what is already collected is refused (refunds are Phase 3).
   * Guarded by student.update at the controller; when expectStudentId is given the enrolment must
   * belong to that student.
   */
  async updateEnrolment(enrolmentId: number, dto: any, me: { id: number }, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    if (['cancelled', 'rejected'].includes(String(enr.status))) {
      throw new BadRequestException(`${enr.enrolment_no} is ${enr.status} and cannot be edited.`);
    }

    // Course — stays within the enrolment's own vertical (a vertical/branch move is Course Transfer).
    let courseId = enr.course_id != null ? Number(enr.course_id) : null;
    if (dto?.course_id !== undefined && dto.course_id !== null && String(dto.course_id).trim() !== '') {
      const cid = Number(dto.course_id);
      const course = await this.db.one<any>(`SELECT id FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [cid]);
      if (!course) throw new BadRequestException('Unknown course.');
      courseId = cid;
    }

    // Gross fee — the FE sends fee_minor (paise); fall back to the enrolment's current gross.
    let feeMinor = enr.gross_fee_minor != null ? Number(enr.gross_fee_minor) : Number(enr.fee_minor ?? 0);
    if (dto?.fee_minor !== undefined && dto.fee_minor !== null && String(dto.fee_minor).trim() !== '') {
      feeMinor = Math.trunc(Number(dto.fee_minor));
    }
    if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new BadRequestException('Fee must be a non-negative amount.');

    // REQUESTED discount (amount ₹/paise or percent), from the form or carried from the enrolment.
    const rawType = String(dto?.discount_type ?? enr.discount_type ?? '').trim().toLowerCase();
    let dType: EnrolmentDiscountType; let dValue: number;
    if (rawType === 'percent') { dType = 'percent'; dValue = Number(dto?.discount_value ?? enr.discount_value ?? 0); }
    else if (rawType === 'amount') {
      dType = 'amount';
      dValue = dto?.discount_value != null && String(dto.discount_value).trim() !== ''
        ? Math.trunc(Number(dto.discount_value)) : Math.trunc(Number(enr.discount_amount_minor ?? enr.discount_minor ?? 0));
    } else if (rawType === 'none') { dType = 'none'; dValue = 0; }
    else {
      const amt = Math.trunc(Number(dto?.discount_minor ?? enr.discount_amount_minor ?? enr.discount_minor ?? 0));
      dType = amt > 0 ? 'amount' : 'none'; dValue = amt;
    }
    let d;
    try { d = computeEnrolmentDiscount(feeMinor, dType, dValue); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    const requested = d.discount_amount_minor;

    // OVER-CAP APPROVAL (dev/103, DEF-4) — Discount Master decides applied vs held-pending.
    const dd = await this.decideMasterDiscount(
      { branch_id: enr.branch_id != null ? Number(enr.branch_id) : null,
        vertical_id: enr.vertical_id != null ? Number(enr.vertical_id) : null, course_id: courseId },
      feeMinor, requested, me.id);
    const applied = dd.applied;
    const net = feeMinor - applied;

    const paid = await this.db.one<{ paid: string }>(
      `SELECT COALESCE(sum(amount_minor), 0)::bigint AS paid FROM fee_receipt
        WHERE enrolment_id = $1::bigint AND deleted_at IS NULL`, [enrolmentId]);
    const paidMinor = Number(paid?.paid ?? 0);
    if (net < paidMinor) {
      throw new BadRequestException(
        `${(paidMinor / 100).toFixed(2)} has already been collected on ${enr.enrolment_no}. `
        + 'The net fee cannot be set below what has been paid — refunds arrive in Phase 3.');
    }

    const plan = String(dto?.payment_plan ?? enr.payment_plan ?? 'full');
    if (!['full', 'emi_3', 'emi_6', 'custom'].includes(plan)) throw new BadRequestException('Choose a valid payment plan.');
    const startDate = dto?.start_date !== undefined
      ? (dto.start_date == null || String(dto.start_date).trim() === '' ? null
          : requireDateString(String(dto.start_date), () => { throw new BadRequestException('Invalid start date.'); }))
      : (enr.start_date ?? null);

    const oldNetForPlan = Number(enr.net_fee_minor ?? 0);
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment
            SET course_id = $2::bigint, fee_minor = $3::bigint, gross_fee_minor = $3::bigint,
                discount_minor = $4::bigint, discount_amount_minor = $4::bigint, net_fee_minor = $5::bigint,
                discount_type = $6::varchar, discount_value = $7::numeric, payment_plan = $8::varchar,
                start_date = $9::date,
                discount_approval_status = $10::varchar, discount_requested_minor = $11::bigint,
                discount_cap_minor = $12::bigint, discount_requested_by = $13::bigint,
                discount_approved_by = $14::bigint,
                discount_approved_at = CASE WHEN $10::varchar = 'approved' THEN COALESCE(discount_approved_at, now()) ELSE NULL END,
                updated_at = now()
          WHERE id = $1::bigint`,
        [enrolmentId, courseId, feeMinor, applied, net, d.discount_type, d.discount_value, plan, startDate,
          dd.status, requested, dd.capMinor, dd.requestedBy, dd.approvedBy]);
      // OBS-1 — the net moved (e.g. a discount edit): rebuild any UNPAID plan schedule so Due
      // (Σ outstanding) always equals Net − Paid. A plan with money applied keeps its schedule.
      if (net !== oldNetForPlan) await this.rebuildUnpaidPlanToNet(c, enrolmentId);
    });

    return {
      id: enrolmentId, ok: true, enrolment_no: enr.enrolment_no,
      total_fee_minor: feeMinor, gross_fee_minor: feeMinor, discount_type: d.discount_type, discount_value: d.discount_value,
      discount_amount_minor: applied, net_fee_minor: net,
      discount_approval_status: dd.status, discount_over_cap: dd.status === 'pending',
      discount_requested_minor: requested, discount_cap_minor: dd.capMinor,
    };
  }

  /**
   * UPGRADE — add another LEVEL to an EXISTING course-enrolment (e.g. A1 → add A2), NOT a
   * second enrolment. Inserts new enrolment_level line-item(s), increases Total (Σ level fees)
   * + Net, recomputes the discount in the enrolment's own scope (overall % re-applies on the new
   * total; overall amount is preserved; level-wise adds the per-level discount), and RECONCILES
   * the active installment plan so future installments cover the added amount — already-paid
   * money is untouched, Due recomputes. Scope-enforced; the level must belong to the enrolment's
   * course and must not already be present.
   */
  async addEnrolmentLevel(enrolmentId: number, dto: any, me: { id: number }, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    if (String(enr.status) !== 'active') {
      throw new BadRequestException(`${enr.enrolment_no} is ${enr.status}; a level can only be added to an active enrolment.`);
    }
    const courseId = enr.course_id ? Number(enr.course_id) : null;
    if (!courseId) throw new BadRequestException('This enrolment has no course, so it has no levels to add.');
    const master = await this.fetchMasterLevels(courseId);
    if (!master.length) throw new BadRequestException('This course has no levels configured.');
    const scopeD: DiscountScope = String(enr.discount_scope ?? 'overall') === 'level' ? 'level' : 'overall';
    const input = Array.isArray(dto?.levels) ? dto.levels
      : (dto?.course_level_id != null || dto?.code != null ? [dto] : []);
    if (!input.length) throw new BadRequestException('Choose a level to add.');
    let newLevels: ResolvedLevel[];
    try { newLevels = resolveLevels(master, input, scopeD); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    // must not already be part of this enrolment (the unique index would 23505 anyway)
    const existing = await this.db.query<any>(`SELECT lower(code) AS code FROM enrolment_level WHERE enrolment_id = $1::bigint`, [enrolmentId]);
    const existingCodes = new Set(existing.map((r) => String(r.code)));
    const existingCount = existing.length;
    for (const l of newLevels) {
      if (existingCodes.has(l.code.toLowerCase())) throw new BadRequestException(`Level ${l.code} is already part of this enrolment.`);
    }
    newLevels.forEach((l, i) => { l.ordering = existingCount + i; });

    const addedFee = sumLevelFees(newLevels);
    const oldTotal = Number(enr.fee_minor ?? 0);
    const oldDiscount = Number(enr.discount_amount_minor ?? enr.discount_minor ?? 0);
    const oldNet = Number(enr.net_fee_minor ?? 0);
    const newTotal = oldTotal + addedFee;

    let newDiscount: number; let discType: EnrolmentDiscountType; let discValue: number;
    if (scopeD === 'level') {
      newDiscount = Math.min(oldDiscount + sumLevelDiscounts(newLevels), newTotal);
      discType = newDiscount > 0 ? 'amount' : 'none'; discValue = newDiscount;
    } else if (String(enr.discount_type) === 'percent') {
      const d = computeEnrolmentDiscount(newTotal, 'percent', Number(enr.discount_value ?? 0));
      newDiscount = d.discount_amount_minor; discType = 'percent'; discValue = Number(enr.discount_value ?? 0);
    } else if (String(enr.discount_type) === 'amount') {
      newDiscount = Math.min(oldDiscount, newTotal); discType = 'amount'; discValue = newDiscount;
    } else { newDiscount = 0; discType = 'none'; discValue = 0; }
    const newNet = newTotal - newDiscount;
    if (this.finance) {
      await this.finance.assertAllowed({
        verticalId: Number(enr.vertical_id), userId: me.id, kind: 'discount',
        base: newTotal, discount: newDiscount, label: 'Enrolment discount',
      });
    }
    const orgId = Number(enr.org_id);
    const deltaNet = newNet - oldNet;
    await this.db.tx(async (c) => {
      await this.insertEnrolmentLevels(c, orgId, enrolmentId, newLevels);
      await c.query(
        `UPDATE enrolment SET fee_minor = $2::bigint, gross_fee_minor = $2::bigint,
                discount_minor = $3::bigint, discount_amount_minor = $3::bigint, net_fee_minor = $4::bigint,
                discount_type = $5::varchar, discount_value = $6::numeric, updated_at = now()
          WHERE id = $1::bigint`,
        [enrolmentId, newTotal, newDiscount, newNet, discType, discValue]);
      await this.reconcilePlanIncrease(c, enrolmentId, deltaNet);
    });
    return {
      id: enrolmentId, enrolment_no: enr.enrolment_no, discount_scope: scopeD,
      total_fee_minor: newTotal, gross_fee_minor: newTotal, discount_amount_minor: newDiscount,
      discount_type: discType, discount_value: discValue, net_fee_minor: newNet,
      added_levels: newLevels.map((l) => ({ course_level_id: l.course_level_id, code: l.code, label: l.label, fee_minor: l.fee_minor, discount_minor: l.discount_minor })),
    };
  }

  /**
   * Reconcile an active installment plan when an enrolment's Net rises by `deltaMinor` (a level
   * upgrade). Bumps the plan total and pushes the extra onto the LAST still-open installment (or
   * appends a fresh installment if every existing one is already paid) — future collection covers
   * the new amount, paid money is never disturbed. No-op when there is no active plan (an
   * unplanned enrolment's outstanding recomputes straight from net_fee_minor in the dues view).
   */
  /** Rebuild every UNPAID active installment plan on an enrolment to its CURRENT Net fee, so the
   *  schedule (and hence Due = Σ outstanding) always equals Net − Paid after a discount edit or a
   *  level upgrade. A plan with money already applied is left intact (paid money is a fact — the
   *  delta path carries the increase). Mirrors PlanService.reconcileToNet; kept local because
   *  StudentsModule does not import PlansModule. Runs inside the caller's transaction. */
  private async rebuildUnpaidPlanToNet(c: any, enrolmentId: number) {
    const plans = await c.query(
      `SELECT pp.id, pp.plan_type, pp.frequency, pp.down_payment_minor, pp.num_installments,
              pp.start_date, e.net_fee_minor
         FROM payment_plan pp JOIN enrolment e ON e.id = pp.enrolment_id
        WHERE pp.enrolment_id = $1::bigint AND pp.status = 'active' AND pp.deleted_at IS NULL`,
      [enrolmentId]);
    for (const pp of plans.rows) {
      const paid = await c.query(
        `SELECT COALESCE(sum(paid_minor), 0) AS p FROM installment WHERE plan_id = $1::bigint`, [pp.id]);
      if (Number(paid.rows[0].p) > 0) continue;                 // money applied -> leave the schedule alone
      const total = Number(pp.net_fee_minor);
      const startDate = toDateString(pp.start_date) || new Date().toISOString().slice(0, 10);
      let schedule;
      try {
        schedule = generateSchedule({
          plan_type: pp.plan_type as PlanType, total_minor: total,
          down_payment_minor: Number(pp.down_payment_minor),
          num_installments: Math.max(1, Number(pp.num_installments)),
          frequency: pp.frequency as Frequency, start_date: startDate,
        });
      } catch { continue; }
      await c.query(`DELETE FROM installment WHERE plan_id = $1::bigint`, [pp.id]);
      for (const row of schedule) {
        await c.query(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, label)
           VALUES ($1,$2,$3,$4::date,$5,$6)`,
          [pp.id, enrolmentId, row.seq_no, row.due_date, row.amount_minor, row.label]);
      }
      await c.query(`UPDATE payment_plan SET total_minor = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [pp.id, total]);
      await c.query(
        `UPDATE payment_plan pp SET status = CASE WHEN pp.status = 'cancelled' THEN 'cancelled'
              WHEN NOT EXISTS (SELECT 1 FROM installment i WHERE i.plan_id = pp.id AND i.status NOT IN ('paid','waived'))
                THEN 'completed' ELSE 'active' END,
            updated_at = now() WHERE pp.id = $1::bigint`, [pp.id]);
    }
  }

  private async reconcilePlanIncrease(c: any, enrolmentId: number, deltaMinor: number) {
    if (!Number.isFinite(deltaMinor) || deltaMinor <= 0) return;
    const plan = (await c.query(
      `SELECT id FROM payment_plan WHERE enrolment_id = $1::bigint AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [enrolmentId])).rows[0];
    if (!plan) return;
    const planId = Number(plan.id);
    await c.query(`UPDATE payment_plan SET total_minor = total_minor + $2::bigint, updated_at = now() WHERE id = $1::bigint`, [planId, deltaMinor]);
    const target = (await c.query(
      `SELECT id, amount_minor, paid_minor FROM installment
        WHERE plan_id = $1::bigint AND status <> 'waived' AND paid_minor < amount_minor
        ORDER BY seq_no DESC LIMIT 1`, [planId])).rows[0];
    if (target) {
      const newAmt = Number(target.amount_minor) + deltaMinor;
      await c.query(
        `UPDATE installment
            SET amount_minor = $2::bigint,
                status = CASE WHEN paid_minor >= $2::bigint THEN 'paid' WHEN paid_minor > 0 THEN 'partial' ELSE 'pending' END,
                updated_at = now()
          WHERE id = $1::bigint`, [Number(target.id), newAmt]);
    } else {
      const last = (await c.query(`SELECT COALESCE(MAX(seq_no),0) AS seq, MAX(due_date) AS d FROM installment WHERE plan_id = $1::bigint`, [planId])).rows[0];
      await c.query(
        `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, label)
         VALUES ($1::bigint,$2::bigint,$3::int, COALESCE($4::date, (now() AT TIME ZONE 'Asia/Kolkata')::date), $5::bigint, $6)`,
        [planId, enrolmentId, Number(last.seq) + 1, last.d, deltaMinor, 'Level upgrade']);
    }
    await c.query(
      `UPDATE payment_plan pp
          SET status = CASE WHEN pp.status = 'cancelled' THEN 'cancelled'
                            WHEN NOT EXISTS (SELECT 1 FROM installment i WHERE i.plan_id = pp.id AND i.status NOT IN ('paid','waived'))
                              THEN 'completed' ELSE 'active' END,
              updated_at = now()
        WHERE pp.id = $1::bigint`, [planId]);
  }

  /** CHANGE a SINGLE enrolment's status — mirrors the student status endpoint. Per-status
   *  validation (SENSITIVE {on_hold, withdrawn, dropped_out, cancelled} need reason +
   *  last_attendance_date + effective_date + approved_by + the student.status_manage
   *  permission), outstanding snapshot for THAT enrolment, writes enrolment_status_history,
   *  and for a revenue-cancelling status flips enrolment.status='cancelled' so ONLY this
   *  enrolment drops out of booked revenue/targets. The overall student status is UNTOUCHED.
   *  Idempotent (same status -> no-op). Scope-enforced. When expectStudentId is given the
   *  enrolment must belong to that student. */
  async changeEnrolmentStatus(enrolmentId: number, dto: any, me: { id: number }, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    const to = String(dto?.to_status ?? '').trim();
    if (!to) throw new BadRequestException('Choose a status.');
    if (!ENROLMENT_STATUSES.has(to)) throw new BadRequestException('Unknown enrolment status.');
    const def = await this.db.one<any>(`SELECT * FROM student_status_def WHERE code = $1`, [to]);
    if (!def) throw new BadRequestException('Unknown status.');
    const from = String(enr.course_status ?? 'active');
    const sensitive = SENSITIVE_STATUSES.has(to);

    if (sensitive) {
      const grants = this.rbacData ? await this.rbacData.loadUserGrants(me.id) : null;
      const allowed = grants ? this.resolver.resolve(grants, 'student.status_manage').allowed : false;
      if (!allowed) {
        throw new ForbiddenException('You need the "Manage student status" permission to set a sensitive enrolment status (On Hold / Withdrawn / Dropped Out / Cancelled).');
      }
    }

    const clean = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
    const asDate = (v: unknown, label: string): string | null => {
      const c = clean(v);
      if (c == null) return null;
      return requireDateString(c, () => { throw new BadRequestException(`${label} is not a valid date.`); });
    };
    const reason = clean(dto?.reason);
    const lastAtt = asDate(dto?.last_attendance_date, 'Last Attendance Date');
    const effective = asDate(dto?.effective_date, to === 'on_hold' ? 'Hold Start Date' : 'Effective date');
    let approvedBy: number | null = dto?.approved_by != null && dto.approved_by !== '' ? Number(dto.approved_by) : null;

    if (sensitive) {
      const effLabel = to === 'on_hold' ? 'Hold Start Date' : 'Effective Date';
      if (!reason) throw new BadRequestException(`Reason is required for status "${def.label}".`);
      if (!lastAtt) throw new BadRequestException(`Last Attendance Date is required for status "${def.label}".`);
      if (!effective) throw new BadRequestException(`${effLabel} is required for status "${def.label}".`);
      if (approvedBy == null) throw new BadRequestException('Approved By is required.');
      const appr = await this.db.one<any>(`SELECT id FROM "user" WHERE id = $1::bigint`, [approvedBy]);
      if (!appr) throw new BadRequestException('Approved By must be a valid user.');
    }

    const outstanding = await this.enrolmentOutstandingMinor(enrolmentId);
    if (from === to) return { id: enrolmentId, course_status: to, unchanged: true, outstanding_minor: outstanding };

    const orgId = await this.orgId();
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET course_status = $2, course_status_reason = $3,
                              course_status_last_attendance_date = $4, course_status_effective_date = $5,
                              course_status_outstanding_minor = $6, course_status_approved_by = $7,
                              course_status_changed_by = $8, course_status_changed_at = now(), updated_at = now()
          WHERE id = $1::bigint`,
        [enrolmentId, to, reason, lastAtt, effective, outstanding, approvedBy, me.id]);
      await c.query(
        `INSERT INTO enrolment_status_history (org_id, branch_id, vertical_id, enrolment_id, student_id, course_id,
             from_status, to_status, reason, last_attendance_date, effective_date, outstanding_minor, approved_by, changed_by)
         VALUES ($1::bigint,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint)`,
        [orgId, enr.branch_id ?? null, enr.vertical_id ?? null, enrolmentId, enr.linked_student_id ?? null, enr.course_id ?? null,
          from, to, reason, lastAtt, effective, outstanding, approvedBy, me.id]);
      if (REVENUE_CANCELLING_STATUSES.has(to)) {
        await c.query(
          `UPDATE enrolment SET status = 'cancelled', updated_at = now()
            WHERE id = $1::bigint AND deleted_at IS NULL AND status IN ('active','pending_approval')`,
          [enrolmentId]);
      }
    });

    return {
      id: enrolmentId, from_status: from, to_status: to, course_status: to,
      lms_access: def.lms_access, outstanding_minor: outstanding, approved_by: approvedBy,
      revenue_excluded: REVENUE_CANCELLING_STATUSES.has(to),
    };
  }

  /**
   * COURSE TRANSFER (client feedback #8) — move ONE enrolment from its current course to a
   * DIFFERENT course. Mirrors the student BRANCH transfer (branchTransfer / 062 student_transfer)
   * at the per-enrolment/course level:
   *   - re-points enrolment.course_id (and, when the target is in another branch/vertical,
   *     branch_id/vertical_id); the old batch — which belonged to the old course/vertical — is
   *     CLEARED (re-assign a batch afterwards from the Course Enrollment / batch action);
   *   - FEE HANDLING: the gross fee is recomputed from the TARGET Course master (m_course.meta.fee,
   *     ₹→paise), or an explicit fee_minor override; the enrolment's existing discount
   *     (type/value) is re-applied to the new gross → new net. Payments already made (fee_receipt
   *     rows, keyed by enrolment_id) are UNTOUCHED, so the outstanding recomputes from the new net;
   *   - the per-course STATUS + admission STAGE are KEPT (only the course + its fee change) — the
   *     course change is LOGGED, not a status reset;
   *   - when the target vertical differs, the target vertical's VERTICAL-WISE Student ID is
   *     minted/attached (079 ensureVerticalId);
   *   - writes ONE enrolment_course_transfer history row (from/to course + branch/vertical + fee
   *     snapshots, reason, who).
   * RBAC: scope-enforced via enrolmentInScope on the source AND a scope check on the target
   * branch/vertical. IDEMPOTENT: transferring to the SAME course (same branch/vertical) is refused
   * with a clear message rather than a no-op row. Guarded by student.update at the controller.
   */
  async transferEnrolmentCourse(enrolmentId: number, dto: any, me: { id: number }, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    const toCourseId = Number(dto?.to_course_id ?? dto?.course_id);
    if (!toCourseId) throw new BadRequestException('Choose a course to transfer into.');
    const course = await this.db.one<any>(
      `SELECT id, name, meta FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [toCourseId]);
    if (!course) throw new BadRequestException('Unknown target course.');

    const fromCourseId = enr.course_id != null ? Number(enr.course_id) : null;
    const fromBranchId = enr.branch_id != null ? Number(enr.branch_id) : null;
    const fromVerticalId = enr.vertical_id != null ? Number(enr.vertical_id) : null;
    const fromBatchId = enr.batch_id != null ? Number(enr.batch_id) : null;

    // Target branch/vertical — default to the enrolment's own; honour an explicit choice, both
    // scope-enforced so a course transfer can never cross a scope boundary.
    let toVerticalId = fromVerticalId;
    let toBranchId = fromBranchId;
    if (dto?.to_vertical_id != null && String(dto.to_vertical_id).trim() !== '') {
      const vv = await this.db.one<any>(
        `SELECT id, branch_id FROM vertical WHERE id = $1::bigint AND deleted_at IS NULL`, [Number(dto.to_vertical_id)]);
      if (!vv) throw new BadRequestException('Unknown vertical for this transfer.');
      const vp: unknown[] = [Number(vv.id)];
      const vw = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, vp);
      const okV = await this.db.one<any>(
        `SELECT v.id FROM vertical v WHERE v.id = $1::bigint AND v.deleted_at IS NULL AND ${vw}`, vp);
      if (!okV) throw new BadRequestException('Target vertical is outside your access.');
      toVerticalId = Number(vv.id);
      toBranchId = dto?.to_branch_id != null && String(dto.to_branch_id).trim() !== ''
        ? Number(dto.to_branch_id) : Number(vv.branch_id);
    } else if (dto?.to_branch_id != null && String(dto.to_branch_id).trim() !== '') {
      toBranchId = Number(dto.to_branch_id);
    }
    if (toVerticalId == null) throw new BadRequestException('A vertical is required for this transfer.');
    // Only scope-check the target branch when it actually CHANGES — the enrolment's own branch is
    // already reachable (it was loaded through the scoped enrolmentInScope).
    if (toBranchId != null && Number(toBranchId) !== Number(fromBranchId ?? 0)) {
      const bp: unknown[] = [toBranchId];
      const bw = this.resolver.buildScopeWhere(scope, { branch: 'b.id' }, bp);
      const okB = await this.db.one<any>(
        `SELECT b.id FROM branch b WHERE b.id = $1::bigint AND b.deleted_at IS NULL AND ${bw}`, bp);
      if (!okB) throw new BadRequestException('Target branch is outside your access.');
    }

    // IDEMPOTENT: same course in the same branch+vertical is a no-op.
    if (fromCourseId === toCourseId && Number(fromVerticalId ?? 0) === Number(toVerticalId ?? 0)
        && Number(fromBranchId ?? 0) === Number(toBranchId ?? 0)) {
      throw new BadRequestException('The enrolment is already on that course.');
    }

    // Optional target batch — must live in the target branch+vertical AND teach the target course.
    const rawBatch = dto?.to_batch_id ?? dto?.batch_id;
    const wantsBatch = rawBatch !== undefined && rawBatch !== null && String(rawBatch).trim() !== '';
    let toBatchId: number | null = null;
    if (wantsBatch) {
      toBatchId = Number(rawBatch);
      if (!Number.isFinite(toBatchId) || toBatchId <= 0) throw new BadRequestException('Invalid target batch.');
      const b = await this.db.one<any>(
        `SELECT id FROM batch WHERE id = $1::bigint AND deleted_at IS NULL AND vertical_id = $2::bigint AND course_id = $3::bigint`,
        [toBatchId, toVerticalId, toCourseId]);
      if (!b) throw new BadRequestException("That batch is not in the target vertical for the target course.");
    }

    // FEE — recompute the gross from the TARGET Course master (or an explicit override), then
    // re-apply the enrolment's existing discount to derive the new net.
    let newGross: number;
    if (dto?.fee_minor != null && String(dto.fee_minor).trim() !== '') {
      newGross = Math.trunc(Number(dto.fee_minor));
    } else {
      const masterFee = Number((course.meta as any)?.fee ?? 0);
      newGross = Math.round((Number.isFinite(masterFee) ? masterFee : 0) * 100);
    }
    if (!Number.isFinite(newGross) || newGross < 0) throw new BadRequestException('Fee must be a non-negative amount.');
    // Carry the existing discount (type/value) forward; fall back to the stored discount amount.
    let dType: EnrolmentDiscountType = 'none'; let dValue = 0;
    const t = String(enr.discount_type ?? '').toLowerCase();
    if (t === 'percent') { dType = 'percent'; dValue = Number(enr.discount_value ?? 0); }
    else if (t === 'amount') { dType = 'amount'; dValue = Math.trunc(Number(enr.discount_value ?? enr.discount_amount_minor ?? 0)); }
    else {
      const amt = Math.trunc(Number(enr.discount_amount_minor ?? enr.discount_minor ?? 0));
      if (amt > 0) { dType = 'amount'; dValue = amt; }
    }
    let dsc;
    try { dsc = computeEnrolmentDiscount(newGross, dType, dValue); }
    catch (e) { throw new BadRequestException((e as Error).message); }
    const newNet = dsc.net_fee_minor;
    const fromGross = enr.gross_fee_minor != null ? Number(enr.gross_fee_minor) : (enr.fee_minor != null ? Number(enr.fee_minor) : null);
    const fromNet = enr.net_fee_minor != null ? Number(enr.net_fee_minor) : null;

    const orgId = await this.orgId();
    const studentId = enr.linked_student_id != null ? Number(enr.linked_student_id) : null;
    const reason = dto?.reason != null && String(dto.reason).trim() !== '' ? String(dto.reason).trim() : null;

    const out = await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment
            SET course_id = $2::bigint, branch_id = $3::bigint, vertical_id = $4::bigint, batch_id = $5,
                fee_minor = $6::bigint, gross_fee_minor = $6::bigint,
                discount_type = $7::varchar, discount_value = $8::numeric,
                discount_amount_minor = $9::bigint, discount_minor = $9::bigint,
                net_fee_minor = $10::bigint, updated_at = now()
          WHERE id = $1::bigint`,
        [enrolmentId, toCourseId, toBranchId, toVerticalId, toBatchId,
          newGross, dsc.discount_type, dsc.discount_value, dsc.discount_amount_minor, newNet]);

      const th = await c.query<{ id: string }>(
        `INSERT INTO enrolment_course_transfer
           (org_id, enrolment_id, student_id, from_course_id, to_course_id,
            from_branch_id, to_branch_id, from_vertical_id, to_vertical_id, from_batch_id, to_batch_id,
            from_gross_fee_minor, to_gross_fee_minor, from_net_fee_minor, to_net_fee_minor,
            reason, transferred_by)
         VALUES ($1::bigint,$2::bigint,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13::bigint,$14,$15::bigint,$16,$17::bigint)
         RETURNING id`,
        [orgId, enrolmentId, studentId, fromCourseId, toCourseId,
          fromBranchId, toBranchId, fromVerticalId, toVerticalId, fromBatchId, toBatchId,
          fromGross, newGross, fromNet, newNet, reason, me.id]);

      // Mint/attach the target vertical's vertical-wise Student ID (idempotent; only if we know
      // the student — a lead-stage enrolment has none).
      let svid: any = null;
      if (studentId != null) svid = await this.ensureVerticalId(c, studentId, toBranchId, toVerticalId, me.id);

      return {
        id: enrolmentId, transfer_id: Number(th.rows[0].id), transferred: true,
        from_course_id: fromCourseId, to_course_id: toCourseId, to_course_name: course.name,
        from_vertical_id: fromVerticalId, to_vertical_id: toVerticalId,
        from_branch_id: fromBranchId, to_branch_id: toBranchId,
        batch_cleared: fromBatchId != null && toBatchId == null, to_batch_id: toBatchId,
        gross_fee_minor: newGross, discount_type: dsc.discount_type, discount_value: dsc.discount_value,
        discount_amount_minor: dsc.discount_amount_minor, net_fee_minor: newNet,
        student_vertical_no: svid?.student_vertical_no ?? null,
      };
    });

    // Outstanding recomputes from the new net (payments preserved).
    const outstanding = await this.enrolmentOutstandingMinor(enrolmentId);
    return { ...out, outstanding_minor: outstanding };
  }

  /** The per-enrolment COURSE-TRANSFER history trail (client feedback #8). Scope-enforced;
   *  belongs-to-student optional. Names (courses/branch/vertical/who) so it reads + exports clean. */
  async enrolmentCourseTransferHistory(enrolmentId: number, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    return this.db.query<any>(
      `SELECT t.id, t.from_course_id, t.to_course_id, t.from_branch_id, t.to_branch_id,
              t.from_vertical_id, t.to_vertical_id, t.from_batch_id, t.to_batch_id,
              t.from_gross_fee_minor, t.to_gross_fee_minor, t.from_net_fee_minor, t.to_net_fee_minor,
              t.reason, t.transferred_by, t.created_at,
              fc.name AS from_course_name, tc.name AS to_course_name,
              fb.name AS from_branch_name, tb.name AS to_branch_name,
              fv.name AS from_vertical_name, tv.name AS to_vertical_name,
              u.name AS transferred_by_name
         FROM enrolment_course_transfer t
         LEFT JOIN m_course fc ON fc.id = t.from_course_id
         LEFT JOIN m_course tc ON tc.id = t.to_course_id
         LEFT JOIN branch   fb ON fb.id = t.from_branch_id
         LEFT JOIN branch   tb ON tb.id = t.to_branch_id
         LEFT JOIN vertical fv ON fv.id = t.from_vertical_id
         LEFT JOIN vertical tv ON tv.id = t.to_vertical_id
         LEFT JOIN "user"   u  ON u.id = t.transferred_by
        WHERE t.enrolment_id = $1::bigint
        ORDER BY t.created_at DESC, t.id DESC`, [enrolmentId]);
  }

  /** The per-enrolment status transition trail. Scope-enforced; belongs-to-student optional. */
  async enrolmentStatusHistory(enrolmentId: number, scope: ResolvedScope, expectStudentId?: number) {
    const enr = await this.enrolmentInScope(enrolmentId, scope);
    if (expectStudentId != null && Number(enr.linked_student_id) !== Number(expectStudentId)) {
      throw new NotFoundException('Enrolment not found for this student.');
    }
    return this.db.query<any>(
      `SELECT h.id, h.from_status, h.to_status, h.reason, h.last_attendance_date, h.effective_date,
              h.outstanding_minor, h.approved_by, h.changed_by, h.changed_at,
              df.label AS from_label, dt.label AS to_label,
              ap.name AS approved_by_name, ch.name AS changed_by_name
         FROM enrolment_status_history h
         LEFT JOIN student_status_def df ON df.code = h.from_status
         LEFT JOIN student_status_def dt ON dt.code = h.to_status
         LEFT JOIN "user" ap ON ap.id = h.approved_by
         LEFT JOIN "user" ch ON ch.id = h.changed_by
        WHERE h.enrolment_id = $1::bigint
        ORDER BY h.changed_at DESC, h.id DESC`, [enrolmentId]);
  }

  /**
   * STUDENT SYLLABUS / CONTENT ACCESS — per enrolled course, the PUBLISHED syllabus +
   * course_content + study_material the student may consume, gated by the COMBINED LMS access
   * (the more restrictive of overall-student-LMS and that-enrolment's-course-LMS). A course whose
   * effective access is NONE (e.g. a cancelled/withdrawn enrolment, or an overall-blocked student)
   * is returned marked blocked with no content — drafts are never leaked (published-only).
   */
  async learning(id: number, scope: ResolvedScope) {
    const student = await this.get(id, scope);
    const overall = studentLmsAccess(student.status);
    const overallLabel = student.status_label ?? student.status;
    const enrolments = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.course_id, e.batch_id, e.course_status,
              co.name AS course_name, bt.name AS batch_name
         FROM enrolment e
         LEFT JOIN m_course co ON co.id = e.course_id
         LEFT JOIN batch bt ON bt.id = e.batch_id
        WHERE e.deleted_at IS NULL AND e.course_id IS NOT NULL
          AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
        ORDER BY e.created_at DESC, e.id DESC`,
      [Number(student.id), student.enrolment_id ? Number(student.enrolment_id) : 0]);

    const courses: any[] = [];
    for (const e of enrolments) {
      const courseAccess = studentLmsAccess(e.course_status);
      const effective = combineAccess(overall, courseAccess);
      const canView = canViewMaterial(effective);
      let syllabus: any[] = [];
      let courseContent: any[] = [];
      let material: any[] = [];
      if (canView) {
        syllabus = await this.db.query<any>(
          `SELECT id, title, version, body, created_at FROM syllabus
            WHERE deleted_at IS NULL AND workflow_status = 'published' AND course_id = $1::bigint
            ORDER BY version, id`, [e.course_id]);
        courseContent = await this.db.query<any>(
          `SELECT id, title, module_no, description, created_at FROM course_content
            WHERE deleted_at IS NULL AND workflow_status = 'published' AND course_id = $1::bigint
            ORDER BY module_no, id`, [e.course_id]);
        material = await this.db.query<any>(
          `SELECT m.id, m.title, m.description, m.material_type, m.url, m.external_url, m.access_level, m.created_at
             FROM study_material m
            WHERE m.deleted_at IS NULL AND m.visibility = 'published'
              AND ( (m.access_level = 'batch' AND m.batch_id = $1::bigint)
                 OR (m.access_level = 'course' AND m.course_id = $2::bigint)
                 OR (m.access_level = 'vertical' AND m.vertical_id = $3::bigint) )
            ORDER BY m.created_at DESC`,
          [e.batch_id ?? null, e.course_id ?? null, student.vertical_id ?? null]);
      }
      courses.push({
        enrolment_id: e.id, enrolment_no: e.enrolment_no, course_id: e.course_id,
        course_name: e.course_name, batch_name: e.batch_name, course_status: e.course_status,
        course_lms_access: courseAccess, effective_lms_access: effective,
        can_view: canView, can_attempt: canAttempt(effective), blocked: !canView,
        syllabus, course_content: courseContent, material,
      });
    }
    return {
      student_id: Number(student.id), overall_status: student.status,
      overall_status_label: overallLabel, overall_lms_access: overall, courses,
    };
  }

}
