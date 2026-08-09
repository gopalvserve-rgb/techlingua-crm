import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';

/**
 * TESTS & SCORES. A test belongs to a batch (and denormalises branch/vertical/course for
 * scope). Scores are per-student; the grade + percentage are COMPUTED from marks / max_marks.
 * Feeds report cards (Batch 2).
 */
export const TEST_SCOPE_COLS: ScopeColumnMap = { branch: 't.branch_id', vertical: 't.vertical_id', owner: 't.created_by' };
const BATCH_SCOPE_COLS: ScopeColumnMap = { branch: 'bt.branch_id', vertical: 'bt.vertical_id' };
const TYPES = ['quiz', 'mock', 'exam', 'assignment', 'other'];

/** Percentage -> letter grade. Shared with report cards. */
export function gradeFor(marks: number | null, max: number, pass: number | null): { pct: number | null; grade: string | null } {
  if (marks == null || !(max > 0)) return { pct: null, grade: null };
  const pct = Math.round((marks / max) * 1000) / 10;
  let grade: string;
  if (pass != null && marks < pass) grade = 'F';
  else if (pct >= 90) grade = 'A+';
  else if (pct >= 80) grade = 'A';
  else if (pct >= 70) grade = 'B';
  else if (pct >= 60) grade = 'C';
  else if (pct >= 50) grade = 'D';
  else if (pct >= 40) grade = 'E';
  else grade = 'F';
  return { pct, grade };
}

@Injectable()
export class AssessmentService {
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
    return requireDateString(v, () => { throw new BadRequestException('That test date is not a valid date.'); });
  }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`t.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, TEST_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('t.batch_id', f.batch_id);
    multi('t.branch_id', f.branch_id);
    multi('t.vertical_id', f.vertical_id);
    multi('t.course_id', f.course_id);
    if (TYPES.includes(String(f.test_type))) { params.push(f.test_type); where.push(`t.test_type = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`t.test_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`t.test_date <= $${params.length}::date`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`t.name ILIKE $${params.length}`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT t.id, t.name, t.test_type, t.test_date, t.max_marks, t.pass_marks, t.status, t.created_at,
              t.batch_id, t.branch_id, t.vertical_id, t.course_id,
              bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              (SELECT count(*) FROM assessment_score sc WHERE sc.test_id = t.id AND sc.deleted_at IS NULL)::int AS scored,
              (SELECT round(avg(sc.marks_obtained), 2) FROM assessment_score sc WHERE sc.test_id = t.id AND sc.deleted_at IS NULL AND sc.marks_obtained IS NOT NULL) AS avg_marks
         FROM assessment_test t
         JOIN batch bt ON bt.id = t.batch_id
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN m_course c ON c.id = t.course_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.test_date DESC NULLS LAST, t.id DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, TEST_SCOPE_COLS, params);
    const t = await this.db.one<any>(
      `SELECT t.*, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM assessment_test t
         JOIN batch bt ON bt.id = t.batch_id
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN m_course c ON c.id = t.course_id
        WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`, params);
    if (!t) throw new NotFoundException('Test not found (or outside your access)');
    // Result sheet: every live student in the batch, with their score (if any).
    const results = await this.db.query<any>(
      `SELECT s.id AS student_id, s.full_name, s.student_no,
              sc.id AS score_id, sc.marks_obtained, sc.grade, sc.remarks
         FROM student s
         LEFT JOIN assessment_score sc ON sc.student_id = s.id AND sc.test_id = $1::bigint AND sc.deleted_at IS NULL
        WHERE s.batch_id = $2::bigint AND s.deleted_at IS NULL
        ORDER BY s.full_name`, [id, t.batch_id]);
    const withPct = results.map((r: any) => ({
      ...r, ...gradeFor(r.marks_obtained == null ? null : Number(r.marks_obtained), Number(t.max_marks), t.pass_marks == null ? null : Number(t.pass_marks)),
    }));
    return { ...t, results: withPct };
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const batchId = Number(dto?.batch_id);
    if (!batchId) throw new BadRequestException('Choose a batch.');
    const b = await this.batchInScope(batchId, scope);
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the test a name.');
    const type = TYPES.includes(String(dto?.test_type)) ? String(dto.test_type) : 'quiz';
    const max = Number(dto?.max_marks);
    if (!(max > 0)) throw new BadRequestException('Max marks must be greater than zero.');
    const pass = dto?.pass_marks === '' || dto?.pass_marks == null ? null : Number(dto.pass_marks);
    if (pass != null && (!(pass >= 0) || pass > max)) throw new BadRequestException('Pass marks must be between 0 and max marks.');
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO assessment_test (org_id, batch_id, branch_id, vertical_id, course_id, name, test_type,
                                    test_date, max_marks, pass_marks, remarks, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6,$7,$8::date,$9::numeric,$10::numeric,$11,$12::bigint)
       RETURNING id`,
      [orgId, batchId, b.branch_id, b.vertical_id, b.course_id ?? null, name, type,
        this.day(dto?.test_date), max, pass, dto?.remarks ?? null, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.name !== undefined) { const n = String(dto.name).trim(); if (!n) throw new BadRequestException('Name cannot be empty.'); set('name', n); }
    if (dto?.test_type !== undefined) { if (!TYPES.includes(String(dto.test_type))) throw new BadRequestException('Invalid test type.'); set('test_type', String(dto.test_type)); }
    if (dto?.test_date !== undefined) set('test_date', this.day(dto.test_date));
    if (dto?.max_marks !== undefined) { const m = Number(dto.max_marks); if (!(m > 0)) throw new BadRequestException('Max marks must be greater than zero.'); set('max_marks', m); }
    if (dto?.pass_marks !== undefined) { const p = dto.pass_marks === '' || dto.pass_marks == null ? null : Number(dto.pass_marks); set('pass_marks', p); }
    if (dto?.remarks !== undefined) set('remarks', dto.remarks ?? null);
    if (dto?.status !== undefined) { if (!['active', 'archived'].includes(String(dto.status))) throw new BadRequestException('Invalid status.'); set('status', String(dto.status)); }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE assessment_test SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE assessment_test SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /** Upsert scores for a test; grade is computed from marks / max_marks. */
  async saveScores(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const t = await this.get(id, scope);
    const entries: any[] = Array.isArray(dto?.entries) ? dto.entries : [];
    if (!entries.length) throw new BadRequestException('No scores to save.');
    const max = Number(t.max_marks);
    const pass = t.pass_marks == null ? null : Number(t.pass_marks);
    const orgId = await this.orgId();
    let saved = 0;
    await this.db.tx(async (c) => {
      for (const e of entries) {
        const sid = Number(e?.student_id);
        if (!sid) continue;
        const belongs = await c.query(`SELECT 1 FROM student WHERE id = $1::bigint AND batch_id = $2::bigint AND deleted_at IS NULL`, [sid, t.batch_id]);
        if (!belongs.rowCount) continue;
        const marks = e?.marks_obtained === '' || e?.marks_obtained == null ? null : Number(e.marks_obtained);
        if (marks != null && (marks < 0 || marks > max)) throw new BadRequestException(`A score must be between 0 and ${max}.`);
        const { grade } = gradeFor(marks, max, pass);
        await c.query(
          `INSERT INTO assessment_score (org_id, test_id, student_id, marks_obtained, grade, remarks, marked_by)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4::numeric,$5,$6,$7::bigint)
           ON CONFLICT (test_id, student_id) WHERE deleted_at IS NULL
           DO UPDATE SET marks_obtained = EXCLUDED.marks_obtained, grade = EXCLUDED.grade,
                         remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by, updated_at = now()`,
          [orgId, id, sid, marks, grade, e?.remarks ?? null, me.id]);
        saved++;
      }
    });
    return { id, saved };
  }
}
