import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';

/**
 * ASSIGNMENTS (coursework). An assignment belongs to a batch (denormalises branch/vertical/
 * course for scope). Per-student SUBMISSIONS track the lifecycle assigned -> submitted ->
 * graded (marks + feedback).
 */
export const CW_SCOPE_COLS: ScopeColumnMap = { branch: 'a.branch_id', vertical: 'a.vertical_id', owner: 'a.created_by' };
const BATCH_SCOPE_COLS: ScopeColumnMap = { branch: 'bt.branch_id', vertical: 'bt.vertical_id' };

@Injectable()
export class CourseworkService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async batchInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const b = await this.db.one<any>(
      `SELECT bt.id, bt.name, bt.branch_id, bt.vertical_id, bt.course_id FROM batch bt
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`, params);
    if (!b) throw new NotFoundException('Batch not found (or outside your access)');
    return b;
  }

  private day(v: unknown): string | null {
    if (v == null || String(v).trim() === '') return null;
    return requireDateString(v, () => { throw new BadRequestException('That due date is not a valid date.'); });
  }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, CW_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('a.batch_id', f.batch_id);
    multi('a.branch_id', f.branch_id);
    multi('a.vertical_id', f.vertical_id);
    multi('a.course_id', f.course_id);
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.due_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.due_date <= $${params.length}::date`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`a.title ILIKE $${params.length}`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT a.id, a.title, a.due_date, a.max_marks, a.status, a.attachment_url, a.created_at,
              a.batch_id, a.branch_id, a.vertical_id, a.course_id,
              bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              (SELECT count(*) FROM coursework_submission su WHERE su.assignment_id = a.id AND su.deleted_at IS NULL AND su.status IN ('submitted','graded'))::int AS submitted,
              (SELECT count(*) FROM coursework_submission su WHERE su.assignment_id = a.id AND su.deleted_at IS NULL AND su.status = 'graded')::int AS graded
         FROM coursework_assignment a
         JOIN batch bt ON bt.id = a.batch_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN m_course c ON c.id = a.course_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.due_date DESC NULLS LAST, a.id DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, CW_SCOPE_COLS, params);
    const a = await this.db.one<any>(
      `SELECT a.*, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM coursework_assignment a
         JOIN batch bt ON bt.id = a.batch_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN m_course c ON c.id = a.course_id
        WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!a) throw new NotFoundException('Assignment not found (or outside your access)');
    const submissions = await this.db.query<any>(
      `SELECT s.id AS student_id, s.full_name, s.student_no,
              su.id AS submission_id, su.status, su.submission_url, su.submitted_at, su.marks, su.feedback
         FROM student s
         LEFT JOIN coursework_submission su ON su.student_id = s.id AND su.assignment_id = $1::bigint AND su.deleted_at IS NULL
        WHERE s.batch_id = $2::bigint AND s.deleted_at IS NULL
        ORDER BY s.full_name`, [id, a.batch_id]);
    return { ...a, submissions: submissions.map((r: any) => ({ ...r, status: r.status ?? 'assigned' })) };
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const batchId = Number(dto?.batch_id);
    if (!batchId) throw new BadRequestException('Choose a batch.');
    const b = await this.batchInScope(batchId, scope);
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the assignment a title.');
    const max = dto?.max_marks === '' || dto?.max_marks == null ? null : Number(dto.max_marks);
    if (max != null && !(max > 0)) throw new BadRequestException('Max marks must be greater than zero.');
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO coursework_assignment (org_id, batch_id, branch_id, vertical_id, course_id, title,
                                          description, due_date, attachment_url, max_marks, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6,$7,$8::date,$9,$10::numeric,$11::bigint)
       RETURNING id`,
      [orgId, batchId, b.branch_id, b.vertical_id, b.course_id ?? null, title,
        dto?.description ?? null, this.day(dto?.due_date), dto?.attachment_url ?? null, max, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const tt = String(dto.title).trim(); if (!tt) throw new BadRequestException('Title cannot be empty.'); set('title', tt); }
    if (dto?.description !== undefined) set('description', dto.description ?? null);
    if (dto?.due_date !== undefined) set('due_date', this.day(dto.due_date));
    if (dto?.attachment_url !== undefined) set('attachment_url', dto.attachment_url ?? null);
    if (dto?.max_marks !== undefined) { const m = dto.max_marks === '' || dto.max_marks == null ? null : Number(dto.max_marks); if (m != null && !(m > 0)) throw new BadRequestException('Max marks must be greater than zero.'); set('max_marks', m); }
    if (dto?.status !== undefined) { if (!['active', 'archived'].includes(String(dto.status))) throw new BadRequestException('Invalid status.'); set('status', String(dto.status)); }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE coursework_assignment SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE coursework_assignment SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /** Record/patch a student's submission (assigned -> submitted). */
  async saveSubmission(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const a = await this.get(id, scope);
    const sid = Number(dto?.student_id);
    if (!sid) throw new BadRequestException('Choose a student.');
    const belongs = await this.db.one<any>(`SELECT 1 FROM student WHERE id = $1::bigint AND batch_id = $2::bigint AND deleted_at IS NULL`, [sid, a.batch_id]);
    if (!belongs) throw new BadRequestException('That student is not in this assignment\'s batch.');
    const status = ['assigned', 'submitted'].includes(String(dto?.status)) ? String(dto.status) : 'submitted';
    const submittedAt = status === 'submitted' ? new Date() : null;
    const orgId = await this.orgId();
    await this.db.query(
      `INSERT INTO coursework_submission (org_id, assignment_id, student_id, status, submission_url, submitted_at)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4,$5,$6::timestamptz)
       ON CONFLICT (assignment_id, student_id) WHERE deleted_at IS NULL
       DO UPDATE SET status = EXCLUDED.status, submission_url = EXCLUDED.submission_url,
                     submitted_at = COALESCE(EXCLUDED.submitted_at, coursework_submission.submitted_at), updated_at = now()`,
      [orgId, id, sid, status, dto?.submission_url ?? null, submittedAt]);
    return { id, student_id: sid, status };
  }

  /** Grade a student's submission (marks + feedback -> status graded). */
  async grade(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const a = await this.get(id, scope);
    const sid = Number(dto?.student_id);
    if (!sid) throw new BadRequestException('Choose a student.');
    const belongs = await this.db.one<any>(`SELECT 1 FROM student WHERE id = $1::bigint AND batch_id = $2::bigint AND deleted_at IS NULL`, [sid, a.batch_id]);
    if (!belongs) throw new BadRequestException('That student is not in this assignment\'s batch.');
    const marks = dto?.marks === '' || dto?.marks == null ? null : Number(dto.marks);
    if (a.max_marks != null && marks != null && (marks < 0 || marks > Number(a.max_marks))) {
      throw new BadRequestException(`Marks must be between 0 and ${a.max_marks}.`);
    }
    const orgId = await this.orgId();
    await this.db.query(
      `INSERT INTO coursework_submission (org_id, assignment_id, student_id, status, marks, feedback, graded_by, submitted_at)
       VALUES ($1::bigint,$2::bigint,$3::bigint,'graded',$4::numeric,$5,$6::bigint, now())
       ON CONFLICT (assignment_id, student_id) WHERE deleted_at IS NULL
       DO UPDATE SET status = 'graded', marks = EXCLUDED.marks, feedback = EXCLUDED.feedback,
                     graded_by = EXCLUDED.graded_by,
                     submitted_at = COALESCE(coursework_submission.submitted_at, now()), updated_at = now()`,
      [orgId, id, sid, marks, dto?.feedback ?? null, me.id]);
    return { id, student_id: sid, status: 'graded' };
  }
}
