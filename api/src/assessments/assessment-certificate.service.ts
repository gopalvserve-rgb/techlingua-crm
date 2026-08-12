import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { NumberingService } from '../numbering/numbering.service';
import { PdfAssetService } from '../storage/pdf-asset.service';
import { StorageService } from '../storage/storage.service';
import { GradeSchemeService } from './grade-scheme.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { Letterhead, certificatePdf, CertificateDoc } from '../pdf/documents';

/**
 * ASSESSMENT CERTIFICATES — Batch D.
 *
 * A certificate is ISSUED to a student for an EVALUATED, PASSED attempt (or ad-hoc against a
 * student + assessment). It carries a per-branch/vertical FY certificate number (ACRT-, from the
 * numbering series), the grade + percentage at issue, a generated PDF persisted to Cloudflare R2
 * (r2_key only — never on disk) and a public VERIFY code. Issue / revoke / delete; a PUBLIC
 * login-free verify endpoint reads only the minimal fields. Scope-enforced via the ScopeResolver.
 *
 * NOTE: distinct from the learning module's completion `certificate` (that is course-level, issued
 * by hand); this one is tied to an assessment RESULT and gates on pass.
 */
export const ACERT_SCOPE_COLS: ScopeColumnMap = { branch: 'ct.branch_id', vertical: 'ct.vertical_id', owner: 'ct.issued_by' };
const ATTEMPT_SCOPE_COLS: ScopeColumnMap = { branch: 'at.branch_id', vertical: 'at.vertical_id', owner: 'at.created_by' };
const STUDENT_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' };
const KIND = 'assessment_certificate';

@Injectable()
export class AssessmentCertificateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly grades: GradeSchemeService,
    private readonly storage: StorageService,
    private readonly pdfAssets: PdfAssetService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private verifyCode(): string { return randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toUpperCase(); }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`ct.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ACERT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('ct.branch_id', f.branch_id);
    multi('ct.vertical_id', f.vertical_id);
    multi('ct.student_id', f.student_id);
    multi('ct.assessment_id', f.assessment_id);
    if (['issued', 'revoked'].includes(String(f.status))) { params.push(f.status); where.push(`ct.status = $${params.length}::varchar`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(ct.title ILIKE $${params.length} OR ct.certificate_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT ct.id, ct.certificate_no, ct.title, ct.grade_label, ct.percentage, ct.issued_on, ct.status,
              ct.verify_code, ct.pdf_r2_key, ct.student_id, ct.assessment_id, ct.attempt_id, ct.branch_id, ct.vertical_id,
              s.full_name AS student_name, s.student_no, a.title AS assessment_title,
              b.name AS branch_name, v.name AS vertical_name, u.name AS issued_by_name
         FROM assessment_certificate ct
         JOIN student s ON s.id = ct.student_id
         LEFT JOIN assessment a ON a.id = ct.assessment_id
         LEFT JOIN branch b ON b.id = ct.branch_id
         LEFT JOIN vertical v ON v.id = ct.vertical_id
         LEFT JOIN "user" u ON u.id = ct.issued_by
        WHERE ${where.join(' AND ')}
        ORDER BY ct.issued_on DESC, ct.id DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ACERT_SCOPE_COLS, params);
    const ct = await this.db.one<any>(
      `SELECT ct.*, s.full_name AS student_name, s.student_no, a.title AS assessment_title, a.test_type,
              b.name AS branch_name, v.name AS vertical_name, u.name AS issued_by_name,
              o.name AS org_name, o.gst_no AS org_gst,
              b.address AS branch_address, b.contact_number AS branch_phone, b.email AS branch_email
         FROM assessment_certificate ct
         JOIN student s ON s.id = ct.student_id
         LEFT JOIN assessment a ON a.id = ct.assessment_id
         LEFT JOIN branch b ON b.id = ct.branch_id
         LEFT JOIN vertical v ON v.id = ct.vertical_id
         LEFT JOIN "user" u ON u.id = ct.issued_by
         LEFT JOIN organisation o ON o.id = ct.org_id
        WHERE ct.id = $1::bigint AND ct.deleted_at IS NULL AND ${w}`, params);
    if (!ct) throw new NotFoundException('Certificate not found (or outside your access)');
    return ct;
  }

  /** Issue for an evaluated + passed attempt (attempt_id), or ad-hoc (student_id + assessment_id). */
  async issue(dto: any, me: { id: number }, scope: ResolvedScope) {
    const attemptId = Number(dto?.attempt_id) || null;
    let studentId: number, assessmentId: number | null, branchId: number | null, verticalId: number | null;
    let gradeLabel: string | null = null, pct: number | null = null, assessmentTitle = '';

    if (attemptId) {
      const p: unknown[] = [attemptId];
      const w = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p);
      const at = await this.db.one<any>(
        `SELECT at.*, a.title AS assessment_title, a.grade_scheme_id
           FROM assessment_attempt at JOIN assessment a ON a.id = at.assessment_id
          WHERE at.id = $1::bigint AND at.deleted_at IS NULL AND ${w}`, p);
      if (!at) throw new NotFoundException('Attempt not found (or outside your access)');
      if (at.status !== 'evaluated') throw new BadRequestException('A certificate can only be issued for a fully evaluated attempt.');
      if (at.is_passed !== true) throw new BadRequestException('A certificate can only be issued for a PASSED attempt.');
      const existing = await this.db.one<{ id: string }>(
        `SELECT id FROM assessment_certificate WHERE attempt_id = $1::bigint AND deleted_at IS NULL AND status = 'issued'`, [attemptId]);
      if (existing) throw new BadRequestException('A certificate has already been issued for this attempt.');
      studentId = Number(at.student_id); assessmentId = Number(at.assessment_id);
      branchId = at.branch_id ?? null; verticalId = at.vertical_id ?? null;
      assessmentTitle = at.assessment_title;
      const total = at.total_score != null ? Number(at.total_score) : null;
      const max = Number(at.max_score) || 0;
      pct = total != null && max > 0 ? Math.round((total / max) * 10000) / 100 : null;
      const g = await this.grades.gradeFor(pct, at.grade_scheme_id ? Number(at.grade_scheme_id) : null);
      gradeLabel = g.grade_label;
    } else {
      studentId = Number(dto?.student_id);
      if (!studentId) throw new BadRequestException('Choose the student (or a passed attempt) this certificate is for.');
      const p: unknown[] = [studentId];
      const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, p);
      const s = await this.db.one<any>(
        `SELECT s.id, s.branch_id, s.vertical_id FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, p);
      if (!s) throw new NotFoundException('Student not found (or outside your access)');
      branchId = s.branch_id ?? null; verticalId = s.vertical_id ?? null;
      assessmentId = Number(dto?.assessment_id) || null;
      if (assessmentId) {
        const a = await this.db.one<any>(`SELECT title FROM assessment WHERE id = $1::bigint AND deleted_at IS NULL`, [assessmentId]);
        assessmentTitle = a?.title ?? '';
      }
      pct = dto?.percentage != null ? Number(dto.percentage) : null;
      if (pct != null) { const g = await this.grades.gradeFor(pct, null); gradeLabel = g.grade_label; }
    }

    const title = String(dto?.title ?? '').trim() || `Certificate of Achievement${assessmentTitle ? ` — ${assessmentTitle}` : ''}`;
    const org = await this.orgId();
    const out = await this.db.tx(async (c) => {
      const certNo = await this.numbering.allocate(KIND, { branch_id: branchId, vertical_id: verticalId }, c);
      const r = await c.query<{ id: string }>(
        `INSERT INTO assessment_certificate (org_id, branch_id, vertical_id, student_id, assessment_id, attempt_id,
            certificate_no, title, grade_label, percentage, verify_code, status, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'issued',$12) RETURNING id`,
        [org, branchId, verticalId, studentId, assessmentId, attemptId, certNo, title, gradeLabel, pct, this.verifyCode(), me.id]);
      return { id: Number(r.rows[0].id), certificate_no: certNo };
    });
    // best-effort: generate + persist the PDF to R2 now (degrades cleanly if R2 not configured)
    try { await this.pdf(out.id, scope); } catch { /* the download path re-persists */ }
    return out;
  }

  /** Bulk-issue for every passed, evaluated attempt of a test that has no live certificate yet. */
  async bulkIssueForAssessment(assessmentId: number, me: { id: number }, scope: ResolvedScope) {
    const p: unknown[] = [assessmentId];
    const w = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p);
    const rows = await this.db.query<any>(
      `SELECT at.id FROM assessment_attempt at
        WHERE at.assessment_id = $1::bigint AND at.deleted_at IS NULL AND at.status = 'evaluated' AND at.is_passed IS TRUE
          AND ${w}
          AND NOT EXISTS (SELECT 1 FROM assessment_certificate ac WHERE ac.attempt_id = at.id AND ac.deleted_at IS NULL AND ac.status = 'issued')`, p);
    let issued = 0;
    for (const r of rows) { try { await this.issue({ attempt_id: Number(r.id) }, me, scope); issued += 1; } catch { /* skip */ } }
    return { issued, candidates: rows.length };
  }

  async revoke(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE assessment_certificate SET status = 'revoked', revoked_at = now(), revoked_by = $2::bigint, revoke_reason = $3, updated_at = now()
        WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id, dto?.reason ?? null]);
    return { id, revoked: true };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE assessment_certificate SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private letterheadOf(ct: any): Letterhead {
    return {
      org_name: ct.org_name || 'Tech Lingua', org_gst: ct.org_gst ?? null,
      vertical_name: ct.vertical_name, branch_name: ct.branch_name,
      branch_address: ct.branch_address, branch_phone: ct.branch_phone, branch_email: ct.branch_email,
    };
  }

  /** Generate the PDF, persist to R2, and return the bytes. */
  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const ct = await this.get(id, scope);
    const gradeLine = ct.grade_label ? `Grade ${ct.grade_label}${ct.percentage != null ? ` (${Number(ct.percentage)}%)` : ''}` : (ct.percentage != null ? `${Number(ct.percentage)}%` : null);
    const doc: CertificateDoc = {
      serial_no: ct.certificate_no, cert_type: 'merit', title: ct.title,
      student_name: ct.student_name, student_no: ct.student_no,
      course_name: [ct.assessment_title, gradeLine].filter(Boolean).join(' — ') || null,
      batch_name: null, issue_date: ct.issued_on, status: ct.status, issued_by_name: ct.issued_by_name,
    };
    const buffer = certificatePdf(doc, this.letterheadOf(ct));
    const key = await this.pdfAssets.persist(KIND, id, ct.certificate_no ? String(ct.certificate_no) : null, buffer, Number(ct.org_id));
    if (key && ct.pdf_r2_key !== key) {
      await this.db.query(`UPDATE assessment_certificate SET pdf_r2_key = $2, updated_at = now() WHERE id = $1::bigint`, [id, key]);
    }
    return { buffer, filename: `${String(ct.certificate_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
  }

  /** A short-lived presigned R2 URL for the certificate PDF (generates + persists if needed). */
  async presignedUrl(id: number, scope: ResolvedScope): Promise<{ url: string | null }> {
    const ct = await this.get(id, scope);
    // ensure it is in R2
    if (!ct.pdf_r2_key) { try { await this.pdf(id, scope); } catch { /* R2 off */ } }
    const url = await this.pdfAssets.presignedUrl(KIND, id, `${String(ct.certificate_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`);
    return { url };
  }

  /* ---------------------------------------------------------- PUBLIC verify */

  async verify(code: string) {
    const clean = String(code ?? '').trim();
    if (!clean || clean.length > 48) return { valid: false, reason: 'No such certificate.' };
    const ct = await this.db.one<any>(
      `SELECT ct.certificate_no, ct.title, ct.grade_label, ct.percentage, ct.issued_on, ct.status,
              s.full_name AS student_name, a.title AS assessment_title, o.name AS org_name
         FROM assessment_certificate ct
         JOIN student s ON s.id = ct.student_id
         LEFT JOIN assessment a ON a.id = ct.assessment_id
         LEFT JOIN organisation o ON o.id = ct.org_id
        WHERE ct.verify_code = $1 AND ct.deleted_at IS NULL`, [clean]);
    if (!ct) return { valid: false, reason: 'No certificate matches this code.' };
    const revoked = ct.status === 'revoked';
    return {
      valid: !revoked,
      revoked,
      reason: revoked ? 'This certificate has been revoked by the issuing institute.' : '',
      certificate_no: ct.certificate_no,
      student_name: ct.student_name,
      assessment_title: ct.assessment_title,
      title: ct.title,
      grade_label: ct.grade_label,
      percentage: ct.percentage != null ? Number(ct.percentage) : null,
      issued_on: ct.issued_on,
      org_name: ct.org_name,
    };
  }

  /* ---- bulk delete (list treatment) ---- */
  private idList(raw: unknown): number[] { return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0); }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, ACERT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT ct.id FROM assessment_certificate ct WHERE ct.id = ANY($1::bigint[]) AND ct.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'assessment_certificate', label: 'Certificate', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
