import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';
import { normalizePhone } from '../common/phone.util';
import { NumberingService } from '../numbering/numbering.service';

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

/** The Guardian Relation and ID Proof and Gender option sets the form offers. Kept lax
 *  (stored as-is) — the client may add options — but the known set documents intent. */
const GENDERS = ['Male', 'Female', 'Other'];

@Injectable()
export class StudentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
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
    if (f.status === 'active' || f.status === 'inactive') { params.push(f.status); where.push(`s.status = $${params.length}::varchar`); }

    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`s.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`s.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.student_no ILIKE $${params.length} OR s.enrollment_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));

    return this.db.query<any>(
      `SELECT s.id, s.student_no, s.enrollment_no, s.full_name, s.phone, s.email, s.status,
              s.branch_id, s.vertical_id, s.course_id, s.batch_id, s.owner_id,
              s.enrolment_id, s.created_at, s.lead_id,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              u.name AS owner_name, bt.name AS batch_name, e.enrolment_no
         FROM student s
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
              l.full_name AS lead_name, st.name AS state_name, ci.name AS city_name
         FROM student s
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

    // --- Attendance: summary + recent records ---------------------------------
    const attKpi = await this.db.one<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'present')::int AS present,
              count(*) FILTER (WHERE status = 'absent')::int  AS absent,
              count(*) FILTER (WHERE status = 'late')::int    AS late,
              count(*) FILTER (WHERE status = 'excused')::int AS excused
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
    const enrolments = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.net_fee_minor, e.fee_minor, e.discount_minor,
              e.payment_plan, e.start_date, e.created_at, co.name AS course_name
         FROM enrolment e
         LEFT JOIN m_course co ON co.id = e.course_id
        WHERE e.deleted_at IS NULL
          AND (e.student_profile_id = $1::bigint OR e.id = $2::bigint)
        ORDER BY e.created_at DESC`, [sid, student.enrolment_id ? Number(student.enrolment_id) : 0]);
    const enrolmentIds = enrolments.map((e: any) => Number(e.id));
    let receipts: any[] = [];
    if (enrolmentIds.length) {
      receipts = await this.db.query<any>(
        `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at,
                fr.note, u.name AS received_by_name
           FROM fee_receipt fr LEFT JOIN "user" u ON u.id = fr.received_by
          WHERE fr.enrolment_id = ANY($1::bigint[]) AND fr.deleted_at IS NULL
          ORDER BY fr.received_at DESC`, [enrolmentIds]);
    }
    const netFee = enrolments.reduce((s: number, e: any) => s + Number(e.net_fee_minor ?? 0), 0);
    const collected = receipts.reduce((s: number, r: any) => s + Number(r.amount_minor ?? 0), 0);

    return {
      student,
      siblings,
      academics: {
        current_batch: student.batch_id
          ? { id: Number(student.batch_id), name: student.batch_name ?? null }
          : null,
        transfers,
        waitlist,
        attendance: {
          summary: {
            total: attTotal, present: attPresent,
            absent: Number(attKpi?.absent ?? 0), late: Number(attKpi?.late ?? 0),
            excused: Number(attKpi?.excused ?? 0),
            present_pct: attTotal ? Math.round((attPresent / attTotal) * 1000) / 10 : null,
          },
          records: attendance_records,
        },
        tests,
        assignments,
      },
      certificates,
      report_cards,
      fees: {
        enrolments,
        receipts,
        summary: {
          net_fee_minor: netFee,
          collected_minor: collected,
          balance_minor: Math.max(netFee - collected, 0),
          receipt_count: receipts.length,
        },
      },
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
      `SELECT s.id, s.student_no, s.full_name, s.created_at,
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

    const out = await this.db.tx(async (c) => {
      const studentNo = await this.numbering.allocate('student', { branch_id: branchId, vertical_id: verticalId }, c);
      const enrollmentNo = manualEnrollment
        ?? await this.numbering.allocate('enrollment', { branch_id: branchId, vertical_id: verticalId }, c);
      const allCols = [...cols, 'student_no', 'enrollment_no'];
      const allVals = [...vals, studentNo, enrollmentNo];
      const ph = allCols.map((_, i) => `$${i + 1}`).join(', ');
      const ins = await c.query<{ id: string }>(
        `INSERT INTO student (${allCols.join(', ')}) VALUES (${ph}) RETURNING id`, allVals as any[],
      );
      return { id: Number(ins.rows[0].id), student_no: studentNo, enrollment_no: enrollmentNo };
    });
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

    try {
      const out = await this.db.tx(async (c) => {
        const studentNo = await this.numbering.allocate('student', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c);
        const enrollmentNo = await this.numbering.allocate('enrollment', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO student (org_id, lead_id, enrolment_id, student_no, enrollment_no, full_name,
                                phone, whatsapp_phone, alt_phone, email,
                                branch_id, vertical_id, pipeline_id, campaign_id, course_id,
                                owner_id, team_id, status, created_by)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6,
                   $7, $8, $9, $10,
                   $11::bigint, $12::bigint, $13::bigint, $14::bigint, $15::bigint,
                   $16::bigint, $17::bigint, 'active', $18::bigint)
           RETURNING id`,
          [orgId, leadId, enrolment?.id ?? null, studentNo, enrollmentNo, lead.full_name,
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
      return { ...out, already: false, lead_id: leadId };
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
      if (st !== 'active' && st !== 'inactive') throw new BadRequestException('Status must be active or inactive.');
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
}
