import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';

/**
 * PLACEMENT SUPPORT (client feedback #14). Staff post JOB OPENINGS (scope-enforced,
 * org > branch > vertical) and track APPLICATIONS; eligible students view + apply via the
 * student-facing seam (StudentPlacementsController). Files (JD) live in Cloudflare R2 (key only).
 *
 * ELIGIBILITY RULE (the single source of truth, `eligibilityExists`): a student is eligible for
 * an opening when they hold an enrolment (not cancelled/withdrawn/dropped-out) whose course is in
 * eligible_course_ids (or that list is empty) AND whose vertical is in eligible_vertical_ids (or
 * that list is empty), AND — when min_status is set — that enrolment's course_status equals it.
 */
export const JO_SCOPE_COLS: ScopeColumnMap = { branch: 'j.branch_id', vertical: 'j.vertical_id', owner: 'j.posted_by' };
const STUDENT_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' };
const EXCLUDED_ENROL_STATUSES = ['cancelled', 'withdrawn', 'dropped_out'];
const JOB_TYPES = ['full_time', 'part_time', 'internship', 'contract'];
const JOB_STATUSES = ['open', 'closed', 'filled'];
const APP_STATUSES = ['applied', 'shortlisted', 'selected', 'rejected'];

interface Me { id: number; name?: string }

@Injectable()
export class JobOpeningService {
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

  private textArr(raw: unknown): string[] | null {
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = arr.map((t) => String(t).trim()).filter(Boolean);
    return out.length ? out : null;
  }
  private idArr(raw: unknown): number[] | null {
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = arr.map((t) => Number(t)).filter((n) => Number.isFinite(n) && n > 0);
    return out.length ? out : null;
  }
  private money(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  /** Validate the branch+vertical are inside the caller's scope (placements are branch/vertical anchored). */
  private async branchVerticalInScope(branchId: number, verticalId: number, scope: ResolvedScope) {
    const p: unknown[] = [branchId, verticalId];
    const w = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, p);
    const v = await this.db.one<any>(
      `SELECT v.id FROM vertical v
        WHERE v.id = $2::bigint AND v.branch_id = $1::bigint AND v.deleted_at IS NULL AND ${w}`, p);
    if (!v) throw new BadRequestException('Choose a branch and vertical within your access.');
  }

  /* ============================================================ STAFF: CRUD */

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`j.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, JO_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('j.branch_id', f.branch_id); multi('j.vertical_id', f.vertical_id);
    if (f.status && JOB_STATUSES.includes(String(f.status))) { params.push(String(f.status)); where.push(`j.status = $${params.length}::varchar`); }
    if (f.job_type && JOB_TYPES.includes(String(f.job_type))) { params.push(String(f.job_type)); where.push(`j.job_type = $${params.length}::varchar`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(j.title ILIKE $${params.length} OR j.employer ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT j.id, j.title, j.employer, j.location, j.job_type, j.openings,
              j.salary_min_minor, j.salary_max_minor, j.skills, j.eligible_course_ids, j.eligible_vertical_ids,
              j.min_status, j.jd_r2_key, j.deadline, j.status, j.branch_id, j.vertical_id, j.created_at,
              b.name AS branch_name, v.name AS vertical_name,
              (SELECT count(*) FROM placement_application pa WHERE pa.job_opening_id = j.id AND pa.deleted_at IS NULL) AS applicant_count
         FROM job_opening j
         LEFT JOIN branch b ON b.id = j.branch_id
         LEFT JOIN vertical v ON v.id = j.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT $${params.length}`, params);
  }

  private async getRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, JO_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT j.*, b.name AS branch_name, v.name AS vertical_name
         FROM job_opening j
         LEFT JOIN branch b ON b.id = j.branch_id
         LEFT JOIN vertical v ON v.id = j.vertical_id
        WHERE j.id = $1::bigint AND j.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Job opening not found (or outside your access)');
    return r;
  }

  async get(id: number, scope: ResolvedScope) {
    const r = await this.getRow(id, scope);
    let jd_url: string | null = null;
    if (r.jd_r2_key) { try { jd_url = await this.storage.presignGet(String(r.jd_r2_key), 600); } catch { jd_url = null; } }
    return { ...r, jd_url };
  }

  async create(dto: any, me: Me, scope: ResolvedScope) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the opening a title.');
    const branchId = Number(dto?.branch_id);
    const verticalId = Number(dto?.vertical_id);
    if (!branchId || !verticalId) throw new BadRequestException('Choose a branch and vertical.');
    await this.branchVerticalInScope(branchId, verticalId, scope);
    const jobType = JOB_TYPES.includes(String(dto?.job_type)) ? String(dto.job_type) : 'full_time';
    const status = JOB_STATUSES.includes(String(dto?.status)) ? String(dto.status) : 'open';
    const minStatus = dto?.min_status ? String(dto.min_status).trim() : null;
    const org = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO job_opening (org_id, branch_id, vertical_id, title, employer, description, location,
          job_type, openings, salary_min_minor, salary_max_minor, skills, eligible_course_ids,
          eligible_vertical_ids, min_status, jd_r2_key, deadline, status, posted_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
       RETURNING id`,
      [org, branchId, verticalId, title, dto?.employer ?? null, dto?.description ?? null, dto?.location ?? null,
        jobType, Number.isFinite(Number(dto?.openings)) ? Number(dto.openings) : 1,
        this.money(dto?.salary_min_minor), this.money(dto?.salary_max_minor), this.textArr(dto?.skills),
        this.idArr(dto?.eligible_course_ids), this.idArr(dto?.eligible_vertical_ids), minStatus,
        dto?.jd_r2_key ?? null, dto?.deadline || null, status, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, scope: ResolvedScope) {
    await this.getRow(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.employer !== undefined) set('employer', dto.employer ?? null);
    if (dto?.description !== undefined) set('description', dto.description ?? null);
    if (dto?.location !== undefined) set('location', dto.location ?? null);
    if (dto?.job_type !== undefined) { if (!JOB_TYPES.includes(String(dto.job_type))) throw new BadRequestException('Invalid job type.'); set('job_type', String(dto.job_type)); }
    if (dto?.openings !== undefined) set('openings', Number.isFinite(Number(dto.openings)) ? Number(dto.openings) : 1);
    if (dto?.salary_min_minor !== undefined) set('salary_min_minor', this.money(dto.salary_min_minor));
    if (dto?.salary_max_minor !== undefined) set('salary_max_minor', this.money(dto.salary_max_minor));
    if (dto?.skills !== undefined) set('skills', this.textArr(dto.skills));
    if (dto?.eligible_course_ids !== undefined) set('eligible_course_ids', this.idArr(dto.eligible_course_ids));
    if (dto?.eligible_vertical_ids !== undefined) set('eligible_vertical_ids', this.idArr(dto.eligible_vertical_ids));
    if (dto?.min_status !== undefined) set('min_status', dto.min_status ? String(dto.min_status).trim() : null);
    if (dto?.jd_r2_key !== undefined) set('jd_r2_key', dto.jd_r2_key ?? null);
    if (dto?.deadline !== undefined) set('deadline', dto.deadline || null);
    if (dto?.status !== undefined) { if (!JOB_STATUSES.includes(String(dto.status))) throw new BadRequestException('Invalid status.'); set('status', String(dto.status)); }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE job_opening SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.db.query(`UPDATE job_opening SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, JO_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT j.id FROM job_opening j WHERE j.id = ANY($1::bigint[]) AND j.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'job_opening', label: 'Job Openings', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: Me, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    for (const id of ok) await this.db.query(`UPDATE job_opening SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { deleted: ok.length, skipped: this.idList(raw).length - ok.length };
  }

  /** Presigned PUT so the browser uploads a JD file straight to R2. */
  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'jd');
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.materialKey('placement-jd', fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }

  /* ==================================================== STAFF: applications */

  /** Applicants for an opening (scope-enforced on the opening). */
  async applications(jobId: number, scope: ResolvedScope) {
    await this.getRow(jobId, scope);
    return this.db.query<any>(
      `SELECT pa.id, pa.job_opening_id, pa.student_id, pa.status, pa.applied_at, pa.note, pa.updated_at,
              s.full_name AS student_name, s.student_no, s.phone, s.email,
              b.name AS branch_name, v.name AS vertical_name
         FROM placement_application pa
         JOIN student s ON s.id = pa.student_id
         LEFT JOIN branch b ON b.id = s.branch_id
         LEFT JOIN vertical v ON v.id = s.vertical_id
        WHERE pa.job_opening_id = $1::bigint AND pa.deleted_at IS NULL
        ORDER BY pa.applied_at DESC, pa.id DESC`, [jobId]);
  }

  /** Advance an application status. Scope-enforced via the parent opening. */
  async advanceApplication(appId: number, dto: any, me: Me, scope: ResolvedScope) {
    const params: unknown[] = [appId];
    const w = this.resolver.buildScopeWhere(scope, JO_SCOPE_COLS, params);
    const app = await this.db.one<any>(
      `SELECT pa.id FROM placement_application pa
         JOIN job_opening j ON j.id = pa.job_opening_id AND j.deleted_at IS NULL
        WHERE pa.id = $1::bigint AND pa.deleted_at IS NULL AND ${w}`, params);
    if (!app) throw new NotFoundException('Application not found (or outside your access)');
    const status = String(dto?.status ?? '');
    if (!APP_STATUSES.includes(status)) throw new BadRequestException('Invalid application status.');
    await this.db.query(
      `UPDATE placement_application SET status = $2::varchar, note = COALESCE($3, note), updated_by = $4::bigint, updated_at = now()
        WHERE id = $1::bigint`, [appId, status, dto?.note ?? null, me.id]);
    return { id: appId, status };
  }

  /* ============================================ STUDENT-FACING (eligibility) */

  /** Load a student inside the caller's scope (branch/vertical/owner). */
  private async studentInScope(studentId: number, scope: ResolvedScope) {
    const params: unknown[] = [studentId];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const s = await this.db.one<any>(
      `SELECT s.id, s.full_name, s.enrolment_id, s.vertical_id, s.branch_id
         FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');
    return s;
  }

  /**
   * The EXISTS(...) eligibility clause. Appends its params to `params` and returns the SQL.
   * `jobAlias` is the job_opening alias whose eligibility columns are matched.
   */
  private eligibilityExists(jobAlias: string, studentId: number, enrolmentId: number, params: unknown[]): string {
    params.push(studentId); const sidP = params.length;
    params.push(enrolmentId); const enrP = params.length;
    params.push(EXCLUDED_ENROL_STATUSES); const exP = params.length;
    return `EXISTS (
      SELECT 1 FROM enrolment e
       WHERE e.deleted_at IS NULL AND e.course_id IS NOT NULL
         AND (e.student_profile_id = $${sidP}::bigint OR e.id = $${enrP}::bigint)
         AND (e.course_status IS NULL OR e.course_status <> ALL($${exP}::text[]))
         AND (COALESCE(array_length(${jobAlias}.eligible_course_ids, 1), 0) = 0 OR e.course_id = ANY(${jobAlias}.eligible_course_ids))
         AND (COALESCE(array_length(${jobAlias}.eligible_vertical_ids, 1), 0) = 0 OR e.vertical_id = ANY(${jobAlias}.eligible_vertical_ids))
         AND (${jobAlias}.min_status IS NULL OR e.course_status = ${jobAlias}.min_status)
    )`;
  }

  /** Openings the student is eligible for (open + not past deadline), each with their application (if any). */
  async studentPlacements(studentId: number, scope: ResolvedScope) {
    const student = await this.studentInScope(studentId, scope);
    const params: unknown[] = [];
    params.push(student.id); const sidTop = params.length;   // for the application LEFT JOIN
    const elig = this.eligibilityExists('j', Number(student.id), student.enrolment_id ? Number(student.enrolment_id) : 0, params);
    const rows = await this.db.query<any>(
      `SELECT j.id, j.title, j.employer, j.location, j.job_type, j.openings,
              j.salary_min_minor, j.salary_max_minor, j.skills, j.min_status, j.deadline, j.status,
              j.jd_r2_key, b.name AS branch_name, v.name AS vertical_name,
              pa.id AS application_id, pa.status AS application_status, pa.applied_at
         FROM job_opening j
         LEFT JOIN branch b ON b.id = j.branch_id
         LEFT JOIN vertical v ON v.id = j.vertical_id
         LEFT JOIN placement_application pa ON pa.job_opening_id = j.id AND pa.student_id = $${sidTop}::bigint AND pa.deleted_at IS NULL
        WHERE j.deleted_at IS NULL AND j.status = 'open'
          AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)
          AND ${elig}
        ORDER BY j.deadline NULLS LAST, j.created_at DESC`, params);
    return { student_id: Number(student.id), student_name: student.full_name, openings: rows };
  }

  /** Is this student eligible for THIS opening (open + not expired)? */
  private async isEligible(studentId: number, enrolmentId: number, jobId: number): Promise<boolean> {
    const params: unknown[] = [jobId];
    const elig = this.eligibilityExists('j', studentId, enrolmentId, params);
    const r = await this.db.one<any>(
      `SELECT 1 FROM job_opening j
        WHERE j.id = $1::bigint AND j.deleted_at IS NULL AND j.status = 'open'
          AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE) AND ${elig}`, params);
    return !!r;
  }

  /** Eligible student applies. Idempotent per student+job (UNIQUE + ON CONFLICT DO NOTHING). */
  async apply(studentId: number, jobId: number, dto: any, me: Me, scope: ResolvedScope) {
    const student = await this.studentInScope(studentId, scope);
    // The opening must exist within the caller's scope too (staff acting on the student's behalf).
    await this.getRow(jobId, scope);
    const eligible = await this.isEligible(Number(student.id), student.enrolment_id ? Number(student.enrolment_id) : 0, jobId);
    if (!eligible) throw new BadRequestException('This student is not eligible for this opening (or it is closed/expired).');
    const org = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO placement_application (org_id, job_opening_id, student_id, status, note, updated_by)
       VALUES ($1,$2,$3,'applied',$4,$5)
       ON CONFLICT (job_opening_id, student_id) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`, [org, jobId, student.id, dto?.note ?? null, me.id]);
    if (ins.length) return { id: Number(ins[0].id), status: 'applied', created: true };
    const existing = await this.db.one<any>(
      `SELECT id, status FROM placement_application WHERE job_opening_id = $1::bigint AND student_id = $2::bigint AND deleted_at IS NULL`,
      [jobId, student.id]);
    return { id: Number(existing?.id), status: existing?.status ?? 'applied', created: false, idempotent: true };
  }

  /** The student's own applications (scope-enforced on the student). */
  async studentApplications(studentId: number, scope: ResolvedScope) {
    const student = await this.studentInScope(studentId, scope);
    return this.db.query<any>(
      `SELECT pa.id, pa.job_opening_id, pa.status, pa.applied_at, pa.note,
              j.title, j.employer, j.location, j.job_type, j.deadline, j.status AS opening_status
         FROM placement_application pa
         JOIN job_opening j ON j.id = pa.job_opening_id AND j.deleted_at IS NULL
        WHERE pa.student_id = $1::bigint AND pa.deleted_at IS NULL
        ORDER BY pa.applied_at DESC, pa.id DESC`, [student.id]);
  }
}
