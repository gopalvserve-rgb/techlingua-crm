import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';
import { computeIsPassed } from './scorer';

/**
 * ASSIGNMENT SUBMISSION — Assessment Batch C.
 *
 * An assignment/practical test may be satisfied by a FILE submission (PDF/DOC/DOCX/image)
 * instead of MCQ answers. The file goes straight to Cloudflare R2 via a presigned PUT
 * (StorageService — only the r2_key is persisted, never bytes/disk). Faculty evaluate() sets
 * marks + feedback. Scope-enforced through the central ScopeResolver.
 */
export const SUBMISSION_SCOPE_COLS: ScopeColumnMap = {
  owner: 'sub.created_by', team: 'sub.team_id', branch: 'sub.branch_id',
  vertical: 'sub.vertical_id', pipeline: 'sub.pipeline_id',
};
const STUDENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id', vertical: 's.vertical_id',
};
const ASSESSMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.created_by', team: 'a.team_id', branch: 'a.branch_id', vertical: 'a.vertical_id', pipeline: 'a.pipeline_id',
};

interface Me { id: number; name?: string }

@Injectable()
export class SubmissionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly storage: StorageService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** Presigned PUT so the browser uploads the assignment file straight to R2. */
  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'file').trim() || 'file';
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.submissionKey(fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }

  private async signed(key?: string | null): Promise<string | null> {
    if (!key) return null;
    try { return await this.storage.presignGet(String(key), 600); } catch { return null; }
  }

  async create(assessmentId: number, dto: any, me: Me, scope: ResolvedScope) {
    const org = await this.orgId();
    const aParams: unknown[] = [assessmentId];
    const aw = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, aParams);
    const a = await this.db.one<any>(
      `SELECT a.* FROM assessment a WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${aw}`, aParams);
    if (!a) throw new NotFoundException('Test not found (or outside your access)');
    if (a.test_type !== 'assignment' && a.test_type !== 'practical') {
      throw new BadRequestException('File submissions are only for assignment / practical tests.');
    }
    const studentId = Number(dto?.student_id);
    if (!Number.isInteger(studentId) || studentId <= 0) throw new BadRequestException('Choose a student.');
    const sParams: unknown[] = [studentId];
    const sw = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, sParams);
    const s = await this.db.one<any>(
      `SELECT s.id, s.branch_id, s.vertical_id FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${sw}`, sParams);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');
    const key = String(dto?.file_r2_key ?? '').trim();
    if (!key) throw new BadRequestException('Upload a file first.');

    const r = await this.db.one<{ id: string }>(
      `INSERT INTO assignment_submission (org_id, branch_id, vertical_id, assessment_id, student_id,
          file_r2_key, original_filename, mime, size_bytes, max_marks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [org, s.branch_id ?? a.branch_id, s.vertical_id ?? a.vertical_id, assessmentId, studentId, key.slice(0, 400),
        dto?.original_filename ? String(dto.original_filename).slice(0, 240) : null,
        dto?.mime ? String(dto.mime).slice(0, 120) : null,
        dto?.size_bytes != null ? Math.max(0, Math.trunc(Number(dto.size_bytes))) : null,
        Number(a.total_marks) || 0, me.id]);
    return { id: Number(r!.id) };
  }

  async list(scope: ResolvedScope, f: { assessment_ids?: number[]; student_ids?: number[]; statuses?: string[]; branch_ids?: number[]; vertical_ids?: number[]; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`sub.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, SUBMISSION_SCOPE_COLS, params)];
    if (f.assessment_ids?.length) { params.push(f.assessment_ids); where.push(`sub.assessment_id = ANY($${params.length}::bigint[])`); }
    if (f.student_ids?.length) { params.push(f.student_ids); where.push(`sub.student_id = ANY($${params.length}::bigint[])`); }
    if (f.statuses?.length) { params.push(f.statuses); where.push(`sub.status = ANY($${params.length}::varchar[])`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`sub.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`sub.vertical_id = ANY($${params.length}::bigint[])`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    const rows = await this.db.query<any>(
      `SELECT sub.id, sub.assessment_id, sub.student_id, sub.file_r2_key, sub.original_filename, sub.mime, sub.size_bytes,
              sub.submitted_at, sub.status, sub.marks, sub.max_marks, sub.is_passed, sub.feedback, sub.evaluated_at,
              a.title AS assessment_title, a.test_type, s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, u.name AS evaluated_by_name
         FROM assignment_submission sub
         JOIN assessment a ON a.id = sub.assessment_id
         JOIN student s ON s.id = sub.student_id
         LEFT JOIN branch b ON b.id = sub.branch_id
         LEFT JOIN vertical v ON v.id = sub.vertical_id
         LEFT JOIN "user" u ON u.id = sub.evaluated_by
        WHERE ${where.join(' AND ')}
        ORDER BY sub.submitted_at DESC
        LIMIT $${params.length}`, params);
    // attach a short-lived presigned URL for the submitted file
    for (const r of rows) r.file_url = await this.signed(r.file_r2_key);
    return rows;
  }

  private async scoped(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, SUBMISSION_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT sub.*, a.passing_marks, a.passing_pct FROM assignment_submission sub
         JOIN assessment a ON a.id = sub.assessment_id
        WHERE sub.id = $1::bigint AND sub.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Submission not found (or outside your access)');
    return row;
  }

  async evaluate(id: number, dto: any, me: Me, scope: ResolvedScope) {
    const sub = await this.scoped(id, scope);
    const max = Number(sub.max_marks) || 0;
    let marks: number | null = dto?.marks === '' || dto?.marks == null ? null : Number(dto.marks);
    if (marks != null) marks = Math.max(0, Math.min(max || marks, Number.isFinite(marks) ? marks : 0));
    const status = dto?.status === 'returned' ? 'returned' : 'evaluated';
    const feedback = dto?.feedback != null ? String(dto.feedback) : null;
    const passed = marks != null ? computeIsPassed(marks, max, sub.passing_marks != null ? Number(sub.passing_marks) : null, sub.passing_pct != null ? Number(sub.passing_pct) : null) : null;
    await this.db.query(
      `UPDATE assignment_submission SET marks = $2, feedback = $3, status = $4, is_passed = $5,
          evaluated_by = $6, evaluated_at = now(), updated_at = now() WHERE id = $1::bigint`,
      [id, marks, feedback, status, passed, me.id]);
    return { id, status, marks, max_marks: max, is_passed: passed };
  }
}
