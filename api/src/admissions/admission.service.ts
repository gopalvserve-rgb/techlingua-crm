import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { StudentService } from '../students/student.service';
import { assertDateRange } from '../common/date.util';
import { normalizePhone } from '../common/phone.util';
import { RateLimiter } from '../ingestion/channels/rate-limit.util';

/**
 * ONLINE ADMISSION FORM + REVIEW QUEUE (ERP Batch 3).
 *
 * A prospective student fills a PUBLIC, key-authenticated form themselves — the same
 * public-endpoint shape as the website-form capture and the login-free parent report view.
 * A submit creates a PENDING `admission` (never a live student). Staff review the queue and
 * APPROVE (→ creates the student via the existing StudentService.create) or REJECT with a
 * reason. The full submission lives in JSONB `data`; scope + list columns are denormalised.
 *
 * The public submit sits OUTSIDE auth, so — exactly like the capture channels — it is guarded
 * by an unguessable per-form key, a rate limit applied before any DB work, a honeypot, and
 * India field validation (Aadhaar 12-digit, pincode 6-digit, phone → E.164).
 */
export const ADMISSION_SCOPE_COLS: ScopeColumnMap = { branch: 'a.branch_id', vertical: 'a.vertical_id', owner: 'a.owner_id' };
export const FORM_SCOPE_COLS: ScopeColumnMap = { branch: 'f.branch_id', vertical: 'f.vertical_id', owner: 'f.created_by' };

/** The student-profile fields the public form may submit (mirrors StudentService.profilePairs). */
const STUDENT_FIELDS = [
  'full_name', 'dob', 'gender', 'nationality', 'registration_date', 'admission_date',
  'phone', 'whatsapp_phone', 'alt_phone', 'email',
  'father_name', 'father_mobile', 'guardian_name', 'guardian_mobile', 'guardian_email', 'guardian_relation',
  'address_line1', 'address_line2', 'landmark', 'country', 'state_id', 'city_id', 'district', 'pincode',
  'permanent_address', 'current_address',
  'id_proof_type', 'id_proof_number', 'aadhaar', 'pan', 'passport',
  'qualification', 'institution', 'board_university', 'passing_year', 'previous_institution',
];

const SELECT_COLS = `a.id, a.admission_no, a.status, a.full_name, a.phone, a.email, a.created_at, a.reviewed_at,
  a.reject_reason, a.student_id, a.form_id, a.branch_id, a.vertical_id, a.course_id, a.data,
  b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
  u.name AS reviewed_by_name, st.student_no AS student_no`;
const SELECT_FROM = `FROM admission a
  LEFT JOIN branch b ON b.id = a.branch_id
  LEFT JOIN vertical v ON v.id = a.vertical_id
  LEFT JOIN m_course c ON c.id = a.course_id
  LEFT JOIN "user" u ON u.id = a.reviewed_by
  LEFT JOIN student st ON st.id = a.student_id`;

@Injectable()
export class AdmissionService {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly students: StudentService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* =========================================================== FORM LINKS === */

  async listForms(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, FORM_SCOPE_COLS, params);
    return this.db.query<any>(
      `SELECT f.id, f.title, f.form_key, f.is_active, f.submissions, f.branch_id, f.vertical_id, f.course_id, f.created_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM admission_form f
         LEFT JOIN branch b ON b.id = f.branch_id
         LEFT JOIN vertical v ON v.id = f.vertical_id
         LEFT JOIN m_course c ON c.id = f.course_id
        WHERE f.deleted_at IS NULL AND ${w}
        ORDER BY f.created_at DESC`, params);
  }

  private newKey(): string { return randomBytes(18).toString('base64url'); }

  private async validateFormScope(branchId: number | null, verticalId: number | null, courseId: number | null) {
    if (branchId && verticalId) {
      const v = await this.db.one<any>(`SELECT id FROM vertical WHERE id=$1::bigint AND branch_id=$2::bigint AND deleted_at IS NULL`, [verticalId, branchId]);
      if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    }
    if (verticalId && !branchId) throw new BadRequestException('Pick a branch for that vertical.');
    if (courseId) {
      const c = await this.db.one<any>(`SELECT id FROM m_course WHERE id=$1::bigint AND is_active`, [courseId]);
      if (!c) throw new BadRequestException('Choose an active course.');
    }
  }

  async createForm(dto: any, me: { id: number }, scope: ResolvedScope) {
    const branchId = dto?.branch_id ? Number(dto.branch_id) : null;
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    await this.validateFormScope(branchId, verticalId, courseId);
    const orgId = await this.orgId();
    const title = String(dto?.title ?? '').trim().slice(0, 160) || 'Admission Form';
    const row = await this.db.one<any>(
      `INSERT INTO admission_form (org_id, branch_id, vertical_id, course_id, title, form_key, created_by)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,$7::bigint)
       RETURNING id, title, form_key, is_active, branch_id, vertical_id, course_id`,
      [orgId, branchId, verticalId, courseId, title, this.newKey(), me.id]);
    return row;
  }

  private async formInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, FORM_SCOPE_COLS, params);
    const f = await this.db.one<any>(`SELECT f.* FROM admission_form f WHERE f.id=$1::bigint AND f.deleted_at IS NULL AND ${w}`, params);
    if (!f) throw new NotFoundException('Form not found (or outside your access)');
    return f;
  }

  async updateForm(id: number, dto: any, scope: ResolvedScope) {
    await this.formInScope(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    if (dto?.title !== undefined) { params.push(String(dto.title).trim().slice(0, 160) || 'Admission Form'); sets.push(`title=$${params.length}`); }
    if (dto?.is_active !== undefined) { params.push(!!dto.is_active); sets.push(`is_active=$${params.length}`); }
    if (!sets.length) return { id };
    params.push(id);
    await this.db.query(`UPDATE admission_form SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length}::bigint`, params);
    return { id, updated: true };
  }

  async regenerateForm(id: number, scope: ResolvedScope) {
    await this.formInScope(id, scope);
    const key = this.newKey();
    await this.db.query(`UPDATE admission_form SET form_key=$2, updated_at=now() WHERE id=$1::bigint`, [id, key]);
    return { id, form_key: key };
  }

  async removeForm(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.formInScope(id, scope);
    await this.db.query(`UPDATE admission_form SET deleted_at=now(), deleted_by=$2::bigint WHERE id=$1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ========================================================= PUBLIC SUBMIT === */

  /** The public form descriptor + the option lists the applicant picks from. No auth. */
  async publicForm(formKey: string) {
    const f = await this.db.one<any>(
      `SELECT id, title, is_active, branch_id, vertical_id, course_id FROM admission_form
        WHERE form_key=$1 AND deleted_at IS NULL`, [String(formKey)]);
    if (!f || !f.is_active) throw new NotFoundException('This admission form is not available.');
    const branches = await this.db.query<any>(`SELECT id, name FROM branch WHERE deleted_at IS NULL AND is_active ORDER BY name`);
    const verticals = await this.db.query<any>(`SELECT id, name, branch_id FROM vertical WHERE deleted_at IS NULL ORDER BY name`);
    const courses = await this.db.query<any>(`SELECT id, name FROM m_course WHERE is_active ORDER BY name`);
    return {
      title: f.title,
      fixed: { branch_id: f.branch_id, vertical_id: f.vertical_id, course_id: f.course_id },
      options: { branches, verticals, courses },
    };
  }

  private validateIndia(data: Record<string, any>) {
    if (!data.full_name || !String(data.full_name).trim()) throw new BadRequestException('Your full name is required.');
    if (!data.phone) throw new BadRequestException('A mobile number is required.');
    if (data.aadhaar && !/^\d{12}$/.test(String(data.aadhaar).replace(/\s+/g, ''))) {
      throw new BadRequestException('Aadhaar must be exactly 12 digits.');
    }
    const country = data.country;
    const isIndia = country == null || String(country).trim() === '' || /india/i.test(String(country));
    if (isIndia && data.pincode && !/^\d{6}$/.test(String(data.pincode))) {
      throw new BadRequestException('An Indian pincode must be exactly 6 digits.');
    }
    if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email))) {
      throw new BadRequestException('Enter a valid email address.');
    }
  }

  async submitPublic(formKey: string, dto: any, meta: { ip?: string }) {
    // Rate limit BEFORE any DB work — per form key + per IP, 20/min (abuse guard, not a quota).
    const key = `admission:${formKey}:${meta.ip ?? 'na'}`;
    if (!this.limiter.allow(key, 20)) {
      throw new ForbiddenException('Too many submissions — please wait a minute and try again.');
    }
    // Honeypot: a bot fills the hidden field. Pretend success, create nothing.
    if (dto && typeof dto._hp === 'string' && dto._hp.trim() !== '') return { ok: true };

    const f = await this.db.one<any>(
      `SELECT id, is_active, branch_id, vertical_id, course_id FROM admission_form WHERE form_key=$1 AND deleted_at IS NULL`, [String(formKey)]);
    if (!f || !f.is_active) throw new NotFoundException('This admission form is not available.');

    const branchId = f.branch_id ? Number(f.branch_id) : (dto?.branch_id ? Number(dto.branch_id) : null);
    const verticalId = f.vertical_id ? Number(f.vertical_id) : (dto?.vertical_id ? Number(dto.vertical_id) : null);
    const courseId = f.course_id ? Number(f.course_id) : (dto?.course_id ? Number(dto.course_id) : null);
    if (!branchId) throw new BadRequestException('Please choose a branch.');
    if (!verticalId) throw new BadRequestException('Please choose a vertical.');
    await this.validateFormScope(branchId, verticalId, courseId);

    // Build the whitelisted profile payload; normalise phones/aadhaar/pan the way the student create does.
    const data: Record<string, any> = {};
    for (const k of STUDENT_FIELDS) {
      let v = dto?.[k];
      if (v == null || String(v).trim() === '') continue;
      v = String(v).trim();
      if (k === 'phone' || k === 'whatsapp_phone' || k === 'alt_phone' || k === 'father_mobile' || k === 'guardian_mobile') {
        v = normalizePhone(v) ?? v;
      } else if (k === 'aadhaar') { v = v.replace(/\s+/g, ''); }
      else if (k === 'pan') { v = v.toUpperCase(); }
      data[k] = v;
    }
    this.validateIndia(data);

    const orgId = await this.orgId();
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO admission (org_id, form_id, branch_id, vertical_id, course_id, full_name, phone, email, data, source_ip)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5,$6,$7,$8,$9::jsonb,$10)
       RETURNING id`,
      [orgId, f.id, branchId, verticalId, courseId, String(data.full_name).slice(0, 160),
        data.phone ?? null, data.email ?? null, JSON.stringify(data), (meta.ip ?? '').slice(0, 64)]);
    await this.db.query(`UPDATE admission_form SET submissions = submissions + 1 WHERE id=$1::bigint`, [f.id]);
    return { ok: true, reference: Number(row!.id) };
  }

  /* ========================================================= REVIEW QUEUE === */

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ADMISSION_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('a.branch_id', f.branch_id);
    multi('a.vertical_id', f.vertical_id);
    multi('a.course_id', f.course_id);
    if (['pending', 'approved', 'rejected'].includes(String(f.status))) { params.push(f.status); where.push(`a.status = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.created_at >= $${params.length}::timestamptz`); }
    if (dr.to) { params.push(dr.to); where.push(`a.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(a.full_name ILIKE $${params.length} OR a.phone ILIKE $${params.length} OR a.admission_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(`SELECT ${SELECT_COLS} ${SELECT_FROM} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ADMISSION_SCOPE_COLS, params);
    const row = await this.db.one<any>(`SELECT ${SELECT_COLS} ${SELECT_FROM} WHERE a.id=$1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Admission not found (or outside your access)');
    return row;
  }

  /** Edit a pending submission's payload before approving (fix a typo, set the course). */
  async update(id: number, dto: any, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.status !== 'pending') throw new BadRequestException('Only a pending admission can be edited.');
    const data = { ...(cur.data ?? {}) };
    for (const k of STUDENT_FIELDS) {
      if (dto?.[k] === undefined) continue;
      const v = dto[k]; data[k] = (v == null || String(v).trim() === '') ? undefined : String(v).trim();
    }
    if (!data.full_name) throw new BadRequestException('Full name is required.');
    const courseId = dto?.course_id !== undefined ? (dto.course_id ? Number(dto.course_id) : null) : cur.course_id;
    await this.db.query(
      `UPDATE admission SET data=$2::jsonb, full_name=$3, phone=$4, email=$5, course_id=$6, updated_at=now() WHERE id=$1::bigint`,
      [id, JSON.stringify(data), String(data.full_name).slice(0, 160), data.phone ?? null, data.email ?? null, courseId]);
    return { id, updated: true };
  }

  async approve(id: number, me: { id: number }, scope: ResolvedScope) {
    const a = await this.get(id, scope);
    if (a.status !== 'pending') throw new BadRequestException(`This admission is already ${a.status}.`);
    const studentDto = { ...(a.data ?? {}), branch_id: a.branch_id, vertical_id: a.vertical_id, course_id: a.course_id };
    if (!studentDto.admission_date) studentDto.admission_date = new Date().toISOString().slice(0, 10);
    const student = await this.students.create(studentDto, me, scope);
    const admissionNo = await this.numbering.allocate('admission', { branch_id: Number(a.branch_id), vertical_id: Number(a.vertical_id) });
    await this.db.query(
      `UPDATE admission SET status='approved', student_id=$2::bigint, admission_no=$3, reviewed_by=$4::bigint, reviewed_at=now(), updated_at=now()
        WHERE id=$1::bigint`, [id, student.id, admissionNo, me.id]);
    return { id, approved: true, admission_no: admissionNo, student_id: student.id, student_no: student.student_no };
  }

  async reject(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const a = await this.get(id, scope);
    if (a.status !== 'pending') throw new BadRequestException(`This admission is already ${a.status}.`);
    const reason = String(dto?.reason ?? '').trim() || null;
    await this.db.query(
      `UPDATE admission SET status='rejected', reject_reason=$2, reviewed_by=$3::bigint, reviewed_at=now(), updated_at=now() WHERE id=$1::bigint`,
      [id, reason, me.id]);
    return { id, rejected: true };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE admission SET deleted_at=now(), deleted_by=$2::bigint WHERE id=$1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ---- bulk delete ----------------------------------------------------- */
  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, ADMISSION_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT a.id FROM admission a WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'admission', label: 'Admission', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
