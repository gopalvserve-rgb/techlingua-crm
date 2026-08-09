import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange } from '../common/date.util';

/**
 * STUDENT — the PHASE-2 student profile produced by winning a lead (§5 lead→student).
 *
 * =============================================================================
 * HOW A STUDENT RELATES TO AN ENROLMENT — the seam Sprint 5 left (029 §"THE SEAMS")
 * =============================================================================
 * Sprint 5's `enrolment` is the SALE CLOSURE and already carries everything about the
 * sale (course, fee, plan, branch, vertical, counsellor, the lead it came from) plus two
 * empty seam columns: `student_profile_id` and `batch_id`. Phase 2 FILLS them — it does
 * not copy or re-model the enrolment.
 *
 *   normal path  : a WON lead that has an enrolment ->
 *                    student.enrolment_id  -> enrolment  (link back)
 *                    enrolment.student_profile_id -> student  (link forward)
 *   early path   : a WON lead with no enrolment yet -> student.enrolment_id = NULL.
 *
 * ONE LEAD -> ONE LIVE STUDENT, enforced by the partial unique index `uq_student_lead`,
 * the mirror of `uq_enrolment_lead`. "Convert to Student" is therefore IDEMPOTENT: a
 * second press links/returns the existing student, it never makes a second one.
 *
 * WINNING THE LEAD: converting moves the lead to its pipeline's WON stage (same rule as
 * enrolment closure — "the two cannot disagree"). If the pipeline has no won stage we do
 * NOT invent one and do NOT fail (a stage taxonomy must never block conversion).
 */

export const STUDENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id',
  vertical: 's.vertical_id', pipeline: 's.pipeline_id', campaign: 's.campaign_id',
};

@Injectable()
export class StudentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
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

    // Global-scope + in-panel multi-select filters (comma-separated ids), same shape leads use.
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
    if (f.q) { params.push(`%${f.q}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.student_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));

    return this.db.query<any>(
      `SELECT s.id, s.student_no, s.full_name, s.phone, s.email, s.status,
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
              l.full_name AS lead_name
         FROM student s
         LEFT JOIN branch  b  ON b.id = s.branch_id
         LEFT JOIN vertical v ON v.id = s.vertical_id
         LEFT JOIN m_course c ON c.id = s.course_id
         LEFT JOIN "user"  u  ON u.id = s.owner_id
         LEFT JOIN batch   bt ON bt.id = s.batch_id
         LEFT JOIN enrolment e ON e.id = s.enrolment_id
         LEFT JOIN lead l ON l.id = s.lead_id
        WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!row) throw new NotFoundException('Student not found (or outside your access)');
    return row;
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
   * Every count is RBAC-scoped (STUDENT_SCOPE_COLS) and narrowed by the same global-scope
   * ids + date range the list uses; a metric with no data returns 0/[] (a clean empty state).
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
    // The DATE RANGE narrows the "new students" cohort only (like the lead dashboard):
    // total/active/by-* are all-time within scope; new_in_range honours from/to.
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

    // FEE COLLECTION summary — real money, joined via the student's linked enrolment to the
    // LITE fee_receipt rows (Sprint 5). Only students that carry an enrolment contribute.
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

  /* --------------------------------------------------------------- mutations */

  private async leadInScope(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const lw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const lead = await this.db.one<any>(
      `SELECT l.id, l.org_id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id,
              l.owner_id, l.team_id, l.full_name, l.phone, l.email, l.course_id, l.stage_id
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
   *   3. else create the student (carry name/phone/email/branch/vertical/course/owner),
   *      linking the live enrolment if one exists (both directions);
   *   4. WIN the lead (move to the pipeline's won stage);
   *   5. write the lead activity. All in ONE transaction.
   */
  async convert(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    if (!leadId) throw new BadRequestException('Choose the lead to convert.');
    const lead = await this.leadInScope(leadId, scope);

    // Idempotency (fast path — outside the tx). The unique index is the real guarantee.
    const existing = await this.db.one<any>(
      `SELECT id, student_no, full_name, status FROM student WHERE lead_id = $1::bigint AND deleted_at IS NULL`,
      [leadId],
    );
    if (existing) return { ...existing, already: true, lead_id: leadId };

    // The live enrolment for this lead, if any (the sale closure to link to).
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
        const ins = await c.query<{ id: string }>(
          `INSERT INTO student (org_id, lead_id, enrolment_id, full_name, phone, email,
                                branch_id, vertical_id, pipeline_id, campaign_id, course_id,
                                owner_id, team_id, status, created_by)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6,
                   $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint,
                   $12::bigint, $13::bigint, 'active', $14::bigint)
           RETURNING id`,
          [orgId, leadId, enrolment?.id ?? null, lead.full_name, lead.phone ?? null, lead.email ?? null,
            lead.branch_id, lead.vertical_id, lead.pipeline_id ?? null, lead.campaign_id ?? null, courseId,
            ownerId, lead.team_id ?? null, me.id],
        );
        const id = Number(ins.rows[0].id);
        const studentNo = `STU-${String(id).padStart(5, '0')}`;
        await c.query(`UPDATE student SET student_no = $2 WHERE id = $1::bigint`, [id, studentNo]);

        // link the enrolment forward (the seam column), if there is one
        if (enrolment?.id) {
          await c.query(
            `UPDATE enrolment SET student_profile_id = $2::bigint, updated_at = now()
              WHERE id = $1::bigint AND student_profile_id IS NULL`,
            [enrolment.id, id],
          );
        }

        await this.winLead(c, lead, me.id, studentNo);
        await this.activity(c, leadId, me.id, `Converted to student ${studentNo}`);
        return { id, student_no: studentNo };
      });
      return { ...out, already: false, lead_id: leadId };
    } catch (e) {
      // uq_student_lead — a genuine double-submit that beat the fast-path read. Return the
      // student that DID land, not a 500 (idempotency holds under a race too).
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

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (dto?.status !== undefined) {
      const st = String(dto.status);
      if (st !== 'active' && st !== 'inactive') throw new BadRequestException('Status must be active or inactive.');
      set('status', st);
    }
    if (dto?.batch_id !== undefined) {
      const bid = dto.batch_id === null || dto.batch_id === '' ? null : Number(dto.batch_id);
      if (bid != null) {
        // a batch can only be assigned if it exists AND matches the student's branch+vertical
        const b = await this.db.one<any>(
          `SELECT id FROM batch WHERE id = $1::bigint AND deleted_at IS NULL
             AND branch_id = $2::bigint AND vertical_id = $3::bigint`,
          [bid, cur.branch_id, cur.vertical_id],
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
    await this.get(id, scope); // scope check + existence
    await this.db.query(
      `UPDATE student SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id, me.id],
    );
    return { id, deleted: true };
  }

  /* ------------------------------------------------------------------ helpers */

  /** Move the lead to its pipeline's WON stage. Copy of EnrolmentService.winLead — the two
   *  conversions must agree, and neither may invent a stage the client did not configure. */
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
