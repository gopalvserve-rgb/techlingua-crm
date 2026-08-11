import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { NumberingService } from '../numbering/numbering.service';
import { NotificationEventService } from '../notificationevents/notification-event.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString } from '../common/date.util';
import { Letterhead, certificatePdf, CertificateDoc } from '../pdf/documents';
import { PdfAssetService } from '../storage/pdf-asset.service';

/**
 * CERTIFICATES — completion / participation / merit certificates issued to a student.
 * Serial from numbering kind 'certificate' (CERT-). Issue / reissue / revoke; branded PDF
 * reuses the quotation/receipt pipeline. Scope: branch/vertical denormalised from the student;
 * 'own' = certificates the caller issued (mirrors tests' created_by).
 */
export const CERT_SCOPE_COLS: ScopeColumnMap = { branch: 'ct.branch_id', vertical: 'ct.vertical_id', owner: 'ct.issued_by' };
const STUDENT_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' };
const TYPES = ['completion', 'participation', 'merit', 'other'];

@Injectable()
export class CertificateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    /** Notification Events — fires certificate_generated + certificate_issued. Optional. */
    private readonly notifEvents?: NotificationEventService,
    /** R2 storage — persist the certificate PDF to Cloudflare R2 on serve. Optional. */
    private readonly pdfAssets?: PdfAssetService,
  ) {}

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

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`ct.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, CERT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('ct.branch_id', f.branch_id);
    multi('ct.vertical_id', f.vertical_id);
    multi('ct.course_id', f.course_id);
    multi('ct.batch_id', f.batch_id);
    multi('ct.student_id', f.student_id);
    if (TYPES.includes(String(f.cert_type))) { params.push(f.cert_type); where.push(`ct.cert_type = $${params.length}::varchar`); }
    if (['issued', 'revoked'].includes(String(f.status))) { params.push(f.status); where.push(`ct.status = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`ct.issue_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`ct.issue_date <= $${params.length}::date`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(ct.title ILIKE $${params.length} OR ct.serial_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT ct.id, ct.serial_no, ct.cert_type, ct.title, ct.issue_date, ct.status, ct.remarks, ct.created_at,
              ct.student_id, ct.branch_id, ct.vertical_id, ct.course_id, ct.batch_id,
              s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name,
              u.name AS issued_by_name
         FROM certificate ct
         JOIN student s ON s.id = ct.student_id
         LEFT JOIN branch b ON b.id = ct.branch_id
         LEFT JOIN vertical v ON v.id = ct.vertical_id
         LEFT JOIN m_course c ON c.id = ct.course_id
         LEFT JOIN batch bt ON bt.id = ct.batch_id
         LEFT JOIN "user" u ON u.id = ct.issued_by
        WHERE ${where.join(' AND ')}
        ORDER BY ct.issue_date DESC, ct.id DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, CERT_SCOPE_COLS, params);
    const ct = await this.db.one<any>(
      `SELECT ct.*, s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name,
              u.name AS issued_by_name,
              o.name AS org_name, o.gst_no AS org_gst,
              b.address AS branch_address, b.contact_number AS branch_phone, b.email AS branch_email
         FROM certificate ct
         JOIN student s ON s.id = ct.student_id
         LEFT JOIN branch b ON b.id = ct.branch_id
         LEFT JOIN vertical v ON v.id = ct.vertical_id
         LEFT JOIN m_course c ON c.id = ct.course_id
         LEFT JOIN batch bt ON bt.id = ct.batch_id
         LEFT JOIN "user" u ON u.id = ct.issued_by
         LEFT JOIN organisation o ON o.id = ct.org_id
        WHERE ct.id = $1::bigint AND ct.deleted_at IS NULL AND ${w}`, params);
    if (!ct) throw new NotFoundException('Certificate not found (or outside your access)');
    return ct;
  }

  private day(v: unknown): string | null {
    if (v == null || String(v).trim() === '') return null;
    return requireDateString(v, () => { throw new BadRequestException('That issue date is not a valid date.'); });
  }

  async issue(dto: any, me: { id: number }, scope: ResolvedScope) {
    const studentId = Number(dto?.student_id);
    if (!studentId) throw new BadRequestException('Choose the student this certificate is for.');
    const s = await this.studentInScope(studentId, scope);
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the certificate a title.');
    const type = TYPES.includes(String(dto?.cert_type)) ? String(dto.cert_type) : 'completion';
    const orgId = await this.orgId();
    const out = await this.db.tx(async (c) => {
      const serial = await this.numbering.allocate('certificate', { branch_id: Number(s.branch_id), vertical_id: Number(s.vertical_id) }, c);
      const ins = await c.query(
        `INSERT INTO certificate (org_id, student_id, branch_id, vertical_id, course_id, batch_id, serial_no,
                                  cert_type, title, issue_date, remarks, issued_by)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7,$8,$9,
                 COALESCE($10::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),$11,$12::bigint)
         RETURNING id`,
        [orgId, studentId, s.branch_id, s.vertical_id, s.course_id ?? null, s.batch_id ?? null, serial,
          type, title, this.day(dto?.issue_date), dto?.remarks ?? null, me.id]);
      return { id: Number(ins.rows[0].id), serial_no: serial };
    });
    // Notification Events — a certificate is created AND issued in one step here. Best-effort.
    const certVars = { certificate_no: out.serial_no, title, cert_type: type };
    await this.notifEvents?.safeFire('certificate_generated', {
      student_id: studentId, vertical_id: Number(s.vertical_id), dedupe: `cert:${out.id}:${out.serial_no}`, vars: certVars });
    await this.notifEvents?.safeFire('certificate_issued', {
      student_id: studentId, vertical_id: Number(s.vertical_id), dedupe: `cert:${out.id}:${out.serial_no}`, vars: certVars });
    return out;
  }

  /** Reissue = a fresh serial + issue date on the same record (e.g. corrected name). */
  async reissue(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const out = await this.db.tx(async (c) => {
      const serial = await this.numbering.allocate('certificate', { branch_id: Number(cur.branch_id), vertical_id: Number(cur.vertical_id) }, c);
      await c.query(
        `UPDATE certificate SET serial_no = $2, status = 'issued', revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL,
                issue_date = COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),
                title = COALESCE($4, title), remarks = COALESCE($5, remarks), issued_by = $6::bigint, updated_at = now()
          WHERE id = $1::bigint`,
        [id, serial, this.day(dto?.issue_date), dto?.title ? String(dto.title).trim() : null, dto?.remarks ?? null, me.id]);
      return { id, serial_no: serial, reissued: true };
    });
    // Notification Events — a reissue is a fresh serial (regenerated + re-issued). Best-effort.
    const rVars = { certificate_no: out.serial_no, title: cur.title };
    await this.notifEvents?.safeFire('certificate_generated', {
      student_id: Number(cur.student_id), vertical_id: Number(cur.vertical_id), dedupe: `cert:${id}:${out.serial_no}`, vars: rVars });
    await this.notifEvents?.safeFire('certificate_issued', {
      student_id: Number(cur.student_id), vertical_id: Number(cur.vertical_id), dedupe: `cert:${id}:${out.serial_no}`, vars: rVars });
    return out;
  }

  async revoke(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE certificate SET status = 'revoked', revoked_at = now(), revoked_by = $2::bigint, revoke_reason = $3, updated_at = now()
        WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id, dto?.reason ?? null]);
    return { id, revoked: true };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE certificate SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private letterheadOf(ct: any): Letterhead {
    return {
      org_name: ct.org_name || 'Tech Lingua', org_gst: ct.org_gst ?? null,
      vertical_name: ct.vertical_name, branch_name: ct.branch_name,
      branch_address: ct.branch_address, branch_phone: ct.branch_phone, branch_email: ct.branch_email,
    };
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const ct = await this.get(id, scope);
    const doc: CertificateDoc = {
      serial_no: ct.serial_no, cert_type: ct.cert_type, title: ct.title,
      student_name: ct.student_name, student_no: ct.student_no, course_name: ct.course_name,
      batch_name: ct.batch_name, issue_date: ct.issue_date, status: ct.status, issued_by_name: ct.issued_by_name,
    };
    const out = { buffer: certificatePdf(doc, this.letterheadOf(ct)), filename: `${String(ct.serial_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
    await this.pdfAssets?.persist('certificate', id, ct.serial_no ? String(ct.serial_no) : null, out.buffer);
    return out;
  }

  /* ---- bulk delete ----------------------------------------------------- */
  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, CERT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT ct.id FROM certificate ct WHERE ct.id = ANY($1::bigint[]) AND ct.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'certificate', label: 'Certificate', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
