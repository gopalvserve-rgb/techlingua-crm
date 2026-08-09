import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange } from '../common/date.util';
import { Letterhead, reportCardPdf, ReportCardDoc } from '../pdf/documents';

/**
 * REPORT CARD — a per-student, per-term academic-progress SNAPSHOT computed from Batch-1 data:
 * attendance %, test scores and assignment grades. Overall weights tests 50%, assignments 30%,
 * attendance 20% over the components that exist (renormalised), and the grade follows standard
 * Indian bands. A generated card can be published + given a share token for a login-free PARENT
 * VIEW. Report-card PDF reuses the PDF pipeline.
 */
export const RC_SCOPE_COLS: ScopeColumnMap = { branch: 'rc.branch_id', vertical: 'rc.vertical_id', owner: 'rc.generated_by' };
const STUDENT_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' };

/** Percentage -> Indian letter grade (shared with the tests module bands). */
export function overallGrade(pct: number | null): string | null {
  if (pct == null) return null;
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  if (pct >= 40) return 'E';
  return 'F';
}

/** PURE — weighted overall over the components present (tests .5, assignments .3, attendance .2). */
export function weightedOverall(parts: { attendance?: number | null; tests?: number | null; assignments?: number | null }): number | null {
  const w: Array<[number | null | undefined, number]> = [[parts.tests, 0.5], [parts.assignments, 0.3], [parts.attendance, 0.2]];
  let sum = 0, wsum = 0;
  for (const [v, weight] of w) if (v != null) { sum += Number(v) * weight; wsum += weight; }
  if (wsum === 0) return null;
  return Math.round((sum / wsum) * 10) / 10;
}

@Injectable()
export class ReportCardService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async studentInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const s = await this.db.one<any>(
      `SELECT s.id, s.full_name, s.student_no, s.branch_id, s.vertical_id, s.course_id, s.batch_id
         FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');
    return s;
  }

  /** Compute the three components for a student over an optional [from,to] window. */
  async compute(studentId: number, from?: string, to?: string) {
    const dp: unknown[] = [studentId];
    let dateW = '';
    if (from) { dp.push(from); dateW += ` AND a.session_date >= $${dp.length}::date`; }
    if (to) { dp.push(to); dateW += ` AND a.session_date <= $${dp.length}::date`; }
    const att = await this.db.one<any>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE a.status = 'present')::int AS present
         FROM attendance a WHERE a.student_id = $1::bigint AND a.deleted_at IS NULL${dateW}`, dp);

    const tp: unknown[] = [studentId];
    let tW = '';
    if (from) { tp.push(from); tW += ` AND t.test_date >= $${tp.length}::date`; }
    if (to) { tp.push(to); tW += ` AND t.test_date <= $${tp.length}::date`; }
    const tst = await this.db.one<any>(
      `SELECT count(*)::int AS n, round(avg(sc.marks_obtained / t.max_marks * 100), 1) AS pct
         FROM assessment_score sc
         JOIN assessment_test t ON t.id = sc.test_id AND t.deleted_at IS NULL
        WHERE sc.student_id = $1::bigint AND sc.deleted_at IS NULL AND sc.marks_obtained IS NOT NULL
          AND t.max_marks > 0${tW}`, tp);

    const asg = await this.db.one<any>(
      `SELECT count(*)::int AS n, round(avg(su.marks / ca.max_marks * 100), 1) AS pct
         FROM coursework_submission su
         JOIN coursework_assignment ca ON ca.id = su.assignment_id AND ca.deleted_at IS NULL
        WHERE su.student_id = $1::bigint AND su.deleted_at IS NULL AND su.status = 'graded'
          AND su.marks IS NOT NULL AND ca.max_marks > 0`, [studentId]);

    const attTotal = Number(att?.total ?? 0);
    const attPct = attTotal ? Math.round((Number(att.present) / attTotal) * 1000) / 10 : null;
    const testPct = tst?.pct == null ? null : Number(tst.pct);
    const asgPct = asg?.pct == null ? null : Number(asg.pct);
    const overall = weightedOverall({ attendance: attPct, tests: testPct, assignments: asgPct });
    return {
      attendance_pct: attPct, attendance_present: Number(att?.present ?? 0), attendance_total: attTotal,
      test_avg_pct: testPct, test_count: Number(tst?.n ?? 0),
      assignment_avg_pct: asgPct, assignment_count: Number(asg?.n ?? 0),
      overall_pct: overall, overall_grade: overallGrade(overall),
    };
  }

  /** Scope-checked component preview for a student (powers the report-card preview). */
  async computeForStudent(studentId: number, scope: ResolvedScope, from?: string, to?: string) {
    await this.studentInScope(studentId, scope);
    return this.compute(studentId, from, to);
  }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`rc.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, RC_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('rc.branch_id', f.branch_id);
    multi('rc.vertical_id', f.vertical_id);
    multi('rc.course_id', f.course_id);
    multi('rc.batch_id', f.batch_id);
    multi('rc.student_id', f.student_id);
    if (['draft', 'published'].includes(String(f.status))) { params.push(f.status); where.push(`rc.status = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`rc.created_at >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`rc.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`rc.term ILIKE $${params.length}`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT rc.id, rc.term, rc.period_from, rc.period_to, rc.attendance_pct, rc.test_avg_pct,
              rc.assignment_avg_pct, rc.overall_pct, rc.overall_grade, rc.status, rc.share_token, rc.created_at,
              rc.student_id, rc.branch_id, rc.vertical_id, rc.course_id, rc.batch_id,
              s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name,
              u.name AS generated_by_name
         FROM report_card rc
         JOIN student s ON s.id = rc.student_id
         LEFT JOIN branch b ON b.id = rc.branch_id
         LEFT JOIN vertical v ON v.id = rc.vertical_id
         LEFT JOIN m_course c ON c.id = rc.course_id
         LEFT JOIN batch bt ON bt.id = rc.batch_id
         LEFT JOIN "user" u ON u.id = rc.generated_by
        WHERE ${where.join(' AND ')}
        ORDER BY rc.created_at DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, RC_SCOPE_COLS, params);
    const rc = await this.rowBy(`rc.id = $1::bigint AND ${w}`, params);
    if (!rc) throw new NotFoundException('Report card not found (or outside your access)');
    return rc;
  }

  private async rowBy(cond: string, params: unknown[]) {
    return this.db.one<any>(
      `SELECT rc.*, s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name,
              u.name AS generated_by_name,
              o.name AS org_name, o.gst_no AS org_gst,
              b.address AS branch_address, b.contact_number AS branch_phone, b.email AS branch_email
         FROM report_card rc
         JOIN student s ON s.id = rc.student_id
         LEFT JOIN branch b ON b.id = rc.branch_id
         LEFT JOIN vertical v ON v.id = rc.vertical_id
         LEFT JOIN m_course c ON c.id = rc.course_id
         LEFT JOIN batch bt ON bt.id = rc.batch_id
         LEFT JOIN "user" u ON u.id = rc.generated_by
         LEFT JOIN organisation o ON o.id = rc.org_id
        WHERE rc.deleted_at IS NULL AND ${cond}`, params);
  }

  /** Generate (compute + snapshot) a report card for a student/term. Re-generating the same
   *  term updates the snapshot (ON CONFLICT). */
  async generate(dto: any, me: { id: number }, scope: ResolvedScope) {
    const studentId = Number(dto?.student_id);
    if (!studentId) throw new BadRequestException('Choose the student.');
    const term = String(dto?.term ?? '').trim();
    if (!term) throw new BadRequestException('Give the report a term / period name (e.g. "Term 1 2026").');
    const s = await this.studentInScope(studentId, scope);
    const dr = assertDateRange(dto?.period_from, dto?.period_to);
    const comp = await this.compute(studentId, dr.from ?? undefined, dr.to ?? undefined);
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO report_card (org_id, student_id, branch_id, vertical_id, course_id, batch_id, term,
              period_from, period_to, attendance_pct, attendance_present, attendance_total,
              test_avg_pct, test_count, assignment_avg_pct, assignment_count, overall_pct, overall_grade,
              remarks, generated_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7,
               $8::date,$9::date,$10::numeric,$11::int,$12::int,$13::numeric,$14::int,$15::numeric,$16::int,
               $17::numeric,$18,$19,$20::bigint)
       ON CONFLICT (student_id, lower(term)) WHERE deleted_at IS NULL DO UPDATE SET
         period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
         attendance_pct = EXCLUDED.attendance_pct, attendance_present = EXCLUDED.attendance_present,
         attendance_total = EXCLUDED.attendance_total, test_avg_pct = EXCLUDED.test_avg_pct,
         test_count = EXCLUDED.test_count, assignment_avg_pct = EXCLUDED.assignment_avg_pct,
         assignment_count = EXCLUDED.assignment_count, overall_pct = EXCLUDED.overall_pct,
         overall_grade = EXCLUDED.overall_grade, remarks = COALESCE(EXCLUDED.remarks, report_card.remarks),
         generated_by = EXCLUDED.generated_by, updated_at = now()
       RETURNING id`,
      [orgId, studentId, s.branch_id, s.vertical_id, s.course_id ?? null, s.batch_id ?? null, term,
        dr.from ?? null, dr.to ?? null, comp.attendance_pct, comp.attendance_present, comp.attendance_total,
        comp.test_avg_pct, comp.test_count, comp.assignment_avg_pct, comp.assignment_count,
        comp.overall_pct, comp.overall_grade, dto?.remarks ?? null, me.id]);
    return { id: Number(ins[0].id), ...comp };
  }

  async publish(id: number, publish: boolean, _me: { id: number }, scope: ResolvedScope) {
    const rc = await this.get(id, scope);
    let token = rc.share_token;
    if (publish && !token) token = randomBytes(18).toString('base64url');
    await this.db.query(
      `UPDATE report_card SET status = $2, share_token = $3, updated_at = now() WHERE id = $1::bigint`,
      [id, publish ? 'published' : 'draft', publish ? token : rc.share_token]);
    return { id, status: publish ? 'published' : 'draft', share_token: publish ? token : rc.share_token };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE report_card SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private letterheadOf(rc: any): Letterhead {
    return {
      org_name: rc.org_name || 'Tech Lingua', org_gst: rc.org_gst ?? null,
      vertical_name: rc.vertical_name, branch_name: rc.branch_name,
      branch_address: rc.branch_address, branch_phone: rc.branch_phone, branch_email: rc.branch_email,
    };
  }

  private toDoc(rc: any): ReportCardDoc {
    return {
      student_name: rc.student_name, student_no: rc.student_no, term: rc.term,
      period_from: rc.period_from, period_to: rc.period_to, course_name: rc.course_name, batch_name: rc.batch_name,
      attendance_pct: rc.attendance_pct, attendance_present: rc.attendance_present, attendance_total: rc.attendance_total,
      test_avg_pct: rc.test_avg_pct, test_count: rc.test_count,
      assignment_avg_pct: rc.assignment_avg_pct, assignment_count: rc.assignment_count,
      overall_pct: rc.overall_pct, overall_grade: rc.overall_grade, remarks: rc.remarks, status: rc.status,
    };
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const rc = await this.get(id, scope);
    return { buffer: reportCardPdf(this.toDoc(rc), this.letterheadOf(rc)),
      filename: `report-card-${String(rc.student_no ?? rc.student_id)}-${String(rc.term).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
  }

  /* ---- PARENT VIEW: a login-free read by share token (published cards only) ---- */
  async byToken(token: string) {
    if (!token) throw new NotFoundException('Not found');
    const rc = await this.rowBy(`rc.share_token = $1 AND rc.status = 'published'`, [token]);
    if (!rc) throw new NotFoundException('This report card link is invalid or has been unpublished.');
    return rc;
  }

  async pdfByToken(token: string): Promise<{ buffer: Buffer; filename: string }> {
    const rc = await this.byToken(token);
    return { buffer: reportCardPdf(this.toDoc(rc), this.letterheadOf(rc)),
      filename: `report-card-${String(rc.term).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
  }

  /* ---- bulk delete ----------------------------------------------------- */
  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, RC_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT rc.id FROM report_card rc WHERE rc.id = ANY($1::bigint[]) AND rc.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'report_card', label: 'Report Card', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
