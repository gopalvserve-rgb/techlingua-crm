import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { config as appConfig } from '../config';
import { DOC_TYPES, DocType, MODULES, docTypeDef } from './builder-catalog';
import { DocConfig, defaultDocConfig, sanitizeDocConfig } from './builder-config';
import { loadDocData, sampleDocData } from './builder-data';
import { DocData, renderDoc } from './builder-render';

/**
 * DOCUMENT BUILDER (client 12 Nov 2026) — templates for every document except the Fee Invoice
 * (which has its own builder). See migration 137.
 *
 *   Hierarchy   a template applies to the organisation, a branch, a vertical and / or a course.
 *               At print time the MOST SPECIFIC published template wins (course > vertical >
 *               branch > organisation; a default beats a non-default at the same level), and only
 *               once its effective date has come. Nothing published → the document keeps its
 *               built-in layout (the existing generator), so publishing is the switch.
 *   Approval    doctemplate.manage edits and SUBMITS; doctemplate.approve approves (publishes) or
 *               sends back with a note. An approver may also publish directly.
 *   Versions    every publish is an immutable version; restore copies one back to the draft.
 *   Audit       every action is logged with who and when.
 *   Verify      a QR-enabled document gets a stable public code → /verify/<code>.
 */
const ACTIONS = ['created', 'cloned', 'edited', 'submitted', 'approved', 'rejected', 'published', 'unpublished', 'default_set', 'restored', 'deleted'] as const;
type AuditAction = (typeof ACTIONS)[number];

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const n = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : Number(v));

@Injectable()
export class DocBuilderService {
  constructor(private readonly db: DatabaseService, @Optional() private readonly storage?: StorageService) {}

  private async orgId(): Promise<number> {
    const o = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(o!.id);
  }

  private assertType(t: unknown): DocType {
    if (!docTypeDef(String(t))) throw new BadRequestException('Unknown document type.');
    return t as DocType;
  }

  private async audit(templateId: number, action: AuditAction, actorId: number | null, note?: string | null) {
    await this.db.query(`INSERT INTO doc_builder_audit (template_id, action, actor_id, note) VALUES ($1,$2,$3,$4)`,
      [templateId, action, actorId, note ? String(note).slice(0, 300) : null]);
  }

  /** The builder's catalogue: documents grouped by module, each with its default design. */
  catalog() {
    return {
      modules: MODULES,
      types: DOC_TYPES.map((d) => ({ type: d.type, label: d.label, module: d.module, source: d.source, page: d.page,
        orientation: d.orientation, groups: d.groups, tables: d.tables, default_config: defaultDocConfig(d.type) })),
    };
  }

  async list(f: { doc_type?: string } = {}) {
    const params: unknown[] = [];
    let where = 't.deleted_at IS NULL';
    if (f.doc_type) { params.push(f.doc_type); where += ` AND t.doc_type = $${params.length}`; }
    return this.db.query<any>(
      `SELECT t.id, t.doc_type, t.name, t.branch_id, t.vertical_id, t.course_id, t.is_default, t.status, t.effective_from,
              t.published_version_id, t.review_note, t.submitted_at, t.updated_at, t.created_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, u.name AS updated_by_name, su.name AS submitted_by_name,
              (SELECT max(version_no) FROM doc_builder_template_version x WHERE x.template_id = t.id) AS version_no
         FROM doc_builder_template t
         LEFT JOIN branch b ON b.id = t.branch_id LEFT JOIN vertical v ON v.id = t.vertical_id LEFT JOIN m_course c ON c.id = t.course_id
         LEFT JOIN "user" u ON u.id = t.updated_by LEFT JOIN "user" su ON su.id = t.submitted_by
        WHERE ${where}
        ORDER BY t.doc_type, (t.course_id IS NOT NULL), (t.vertical_id IS NOT NULL), (t.branch_id IS NOT NULL), t.name`, params);
  }

  private async row(id: number) {
    const r = await this.db.one<any>(`SELECT * FROM doc_builder_template WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!r) throw new NotFoundException('Template not found');
    return r;
  }

  async get(id: number) {
    const r = await this.row(id);
    const versions = await this.db.query<any>(
      `SELECT v.id, v.version_no, v.note, v.effective_from, v.published_at, u.name AS published_by_name
         FROM doc_builder_template_version v LEFT JOIN "user" u ON u.id = v.published_by
        WHERE v.template_id = $1 ORDER BY v.version_no DESC`, [id]);
    const audit = await this.db.query<any>(
      `SELECT a.action, a.note, a.created_at, u.name AS actor_name FROM doc_builder_audit a LEFT JOIN "user" u ON u.id = a.actor_id
        WHERE a.template_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`, [id]);
    const num = (v: unknown) => (v == null ? null : Number(v));
    return { ...r, id: Number(r.id), branch_id: num(r.branch_id), vertical_id: num(r.vertical_id), course_id: num(r.course_id),
      published_version_id: num(r.published_version_id), config: sanitizeDocConfig(r.doc_type, r.config), versions, audit };
  }

  private async validateScope(branchId: number | null, verticalId: number | null, courseId: number | null) {
    if (verticalId) {
      const v = await this.db.one<any>(`SELECT branch_id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [verticalId]);
      if (!v) throw new BadRequestException('Vertical not found');
      if (branchId && Number(v.branch_id) !== branchId) throw new BadRequestException('That vertical is not under the chosen branch.');
    }
    if (courseId) {
      const c = await this.db.one<any>(`SELECT meta FROM m_course WHERE id = $1 AND deleted_at IS NULL`, [courseId]);
      if (!c) throw new BadRequestException('Course not found');
    }
  }

  async create(dto: any, me: { id: number }) {
    const type = this.assertType(dto?.doc_type);
    const name = String(dto?.name ?? '').trim().slice(0, 120) || `${docTypeDef(type)!.label}`;
    const b = n(dto?.branch_id); const v = n(dto?.vertical_id); const c = n(dto?.course_id);
    await this.validateScope(b, v, c);
    const cfg = dto?.config ? sanitizeDocConfig(type, dto.config) : defaultDocConfig(type);
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO doc_builder_template (org_id, doc_type, name, branch_id, vertical_id, course_id, config, effective_from, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9) RETURNING id`,
      [await this.orgId(), type, name, b, v, c, JSON.stringify(cfg), dto?.effective_from || null, me.id]);
    await this.audit(Number(r!.id), 'created', me.id);
    return this.get(Number(r!.id));
  }

  /** Copy a template to another branch / vertical / course (client: "Copy an existing template to another branch"). */
  async clone(id: number, dto: any, me: { id: number }) {
    const src = await this.row(id);
    const b = dto?.branch_id !== undefined ? n(dto.branch_id) : n(src.branch_id);
    const v = dto?.vertical_id !== undefined ? n(dto.vertical_id) : n(src.vertical_id);
    const c = dto?.course_id !== undefined ? n(dto.course_id) : n(src.course_id);
    await this.validateScope(b, v, c);
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO doc_builder_template (org_id, doc_type, name, branch_id, vertical_id, course_id, config, cloned_from_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9) RETURNING id`,
      [src.org_id, src.doc_type, String(dto?.name ?? `${src.name} (copy)`).slice(0, 120), b, v, c, JSON.stringify(src.config ?? {}), id, me.id]);
    await this.audit(Number(r!.id), 'cloned', me.id, `from "${src.name}" (#${id})`);
    return this.get(Number(r!.id));
  }

  async update(id: number, dto: any, me: { id: number }) {
    const r = await this.row(id);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
    if (dto?.name !== undefined) set('name', String(dto.name).trim().slice(0, 120) || r.name);
    if (dto?.config !== undefined) set('config', JSON.stringify(sanitizeDocConfig(r.doc_type, dto.config)), '::jsonb');
    if (dto?.effective_from !== undefined) set('effective_from', dto.effective_from || null, '::date');
    if (['branch_id', 'vertical_id', 'course_id'].some((k) => dto?.[k] !== undefined)) {
      const b = dto.branch_id !== undefined ? n(dto.branch_id) : n(r.branch_id);
      const v = dto.vertical_id !== undefined ? n(dto.vertical_id) : n(r.vertical_id);
      const c = dto.course_id !== undefined ? n(dto.course_id) : n(r.course_id);
      await this.validateScope(b, v, c);
      set('branch_id', b); set('vertical_id', v); set('course_id', c);
      if (r.is_default) set('is_default', false);
    }
    if (!sets.length) return this.get(id);
    // an edit of a template waiting for approval takes it back to draft
    if (r.status === 'pending') sets.push(`status = 'draft'`);
    params.push(me.id); sets.push(`updated_by = $${params.length}`);
    params.push(id);
    await this.db.query(`UPDATE doc_builder_template SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    await this.audit(id, 'edited', me.id, dto?.config !== undefined ? 'design changed' : null);
    return this.get(id);
  }

  async submit(id: number, me: { id: number }) {
    const r = await this.row(id);
    if (r.status === 'pending') return this.get(id);
    await this.db.query(`UPDATE doc_builder_template SET status = 'pending', submitted_by = $2, submitted_at = now(), review_note = NULL, updated_at = now() WHERE id = $1`, [id, me.id]);
    await this.audit(id, 'submitted', me.id);
    return this.get(id);
  }

  async reject(id: number, note: string, me: { id: number }) {
    const r = await this.row(id);
    if (r.status !== 'pending') throw new BadRequestException('Only a template waiting for approval can be sent back.');
    if (!String(note ?? '').trim()) throw new BadRequestException('Say what needs changing.');
    await this.db.query(`UPDATE doc_builder_template SET status = 'draft', reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now() WHERE id = $1`,
      [id, me.id, String(note).slice(0, 300)]);
    await this.audit(id, 'rejected', me.id, note);
    return this.get(id);
  }

  /** Approve = publish the current draft as a new immutable version. */
  async publish(id: number, dto: any, me: { id: number }) {
    const r = await this.row(id);
    const cfg = sanitizeDocConfig(r.doc_type, r.config);
    const eff = dto?.effective_from !== undefined ? (dto.effective_from || null) : r.effective_from;
    const vid = await this.db.tx(async (c) => {
      const nx = await c.query(`SELECT COALESCE(max(version_no), 0) + 1 AS n FROM doc_builder_template_version WHERE template_id = $1`, [id]);
      const v = await c.query(
        `INSERT INTO doc_builder_template_version (template_id, version_no, config, effective_from, note, published_by)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING id`, [id, nx.rows[0].n, JSON.stringify(cfg), eff, dto?.note ? String(dto.note).slice(0, 300) : null, me.id]);
      const versionId = Number(v.rows[0].id);
      await c.query(`UPDATE doc_builder_template SET status = 'published', published_version_id = $2, effective_from = $3, reviewed_by = $4, reviewed_at = now(),
                       review_note = NULL, updated_at = now() WHERE id = $1`, [id, versionId, eff, me.id]);
      // the first published template of a type at a scope becomes its default
      await c.query(
        `UPDATE doc_builder_template t SET is_default = TRUE WHERE t.id = $1 AND NOT EXISTS (
           SELECT 1 FROM doc_builder_template o WHERE o.id <> t.id AND o.deleted_at IS NULL AND o.is_default AND o.org_id = t.org_id
              AND o.doc_type = t.doc_type AND o.branch_id IS NOT DISTINCT FROM t.branch_id AND o.vertical_id IS NOT DISTINCT FROM t.vertical_id
              AND o.course_id IS NOT DISTINCT FROM t.course_id)`, [id]);
      return versionId;
    });
    await this.audit(id, r.status === 'pending' ? 'approved' : 'published', me.id, dto?.note ?? null);
    return { ...(await this.get(id)), published_version_id: vid };
  }

  async unpublish(id: number, me: { id: number }) {
    await this.row(id);
    await this.db.query(`UPDATE doc_builder_template SET status = 'unpublished', is_default = FALSE, updated_at = now() WHERE id = $1`, [id]);
    await this.audit(id, 'unpublished', me.id);
    return this.get(id);
  }

  async setDefault(id: number, me: { id: number }) {
    const r = await this.row(id);
    if (r.status !== 'published') throw new BadRequestException('Publish the template before making it the default.');
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE doc_builder_template SET is_default = FALSE WHERE deleted_at IS NULL AND org_id = $1 AND doc_type = $2
            AND branch_id IS NOT DISTINCT FROM $3::bigint AND vertical_id IS NOT DISTINCT FROM $4::bigint AND course_id IS NOT DISTINCT FROM $5::bigint`,
        [r.org_id, r.doc_type, r.branch_id, r.vertical_id, r.course_id]);
      await c.query(`UPDATE doc_builder_template SET is_default = TRUE, updated_at = now() WHERE id = $1`, [id]);
    });
    await this.audit(id, 'default_set', me.id);
    return this.get(id);
  }

  async restore(id: number, versionId: number, me: { id: number }) {
    await this.row(id);
    const v = await this.db.one<any>(`SELECT version_no, config FROM doc_builder_template_version WHERE id = $1 AND template_id = $2`, [versionId, id]);
    if (!v) throw new NotFoundException('Version not found');
    await this.db.query(`UPDATE doc_builder_template SET config = $2::jsonb, updated_by = $3, updated_at = now(),
                           status = CASE WHEN status = 'pending' THEN 'draft' ELSE status END WHERE id = $1`, [id, JSON.stringify(v.config), me.id]);
    await this.audit(id, 'restored', me.id, `version ${v.version_no} copied to the draft`);
    return this.get(id);
  }

  async remove(id: number, me: { id: number }) {
    await this.row(id);
    await this.audit(id, 'deleted', me.id);
    await this.db.query(`UPDATE doc_builder_template SET deleted_at = now(), deleted_by = $2, is_default = FALSE WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }

  /* -------------------------------------------------------------- resolve */

  /**
   * The template a document prints with: published, effective today, and the MOST SPECIFIC
   * match for its branch / vertical / course (a level left blank on a template means "any").
   */
  async resolve(type: DocType, ctx: { branch_id: number | null; vertical_id: number | null; course_id: number | null }, at = todayIst()) {
    const r = await this.db.one<any>(
      `SELECT t.id, t.name, v.id AS version_id, v.config
         FROM doc_builder_template t JOIN doc_builder_template_version v ON v.id = t.published_version_id
        WHERE t.deleted_at IS NULL AND t.status = 'published' AND t.doc_type = $1
          AND (t.effective_from IS NULL OR t.effective_from <= $5::date)
          AND (t.branch_id IS NULL OR t.branch_id = $2::bigint)
          AND (t.vertical_id IS NULL OR t.vertical_id = $3::bigint)
          AND (t.course_id IS NULL OR t.course_id = $4::bigint)
        ORDER BY (t.course_id IS NOT NULL) DESC, (t.vertical_id IS NOT NULL) DESC, (t.branch_id IS NOT NULL) DESC,
                 t.is_default DESC, t.effective_from DESC NULLS LAST, v.published_at DESC
        LIMIT 1`, [type, ctx.branch_id, ctx.vertical_id, ctx.course_id, at]);
    return r ? { template_id: Number(r.id), name: r.name, version_id: Number(r.version_id), config: sanitizeDocConfig(type, r.config) } : null;
  }

  /** The vertical's logo as JPEG bytes (PDFs embed JPEG only). */
  private async verticalLogo(verticalId: number | null): Promise<Buffer | null> {
    if (!verticalId || !this.storage) return null;
    try {
      const v = await this.db.one<any>(`SELECT logo_r2_key FROM vertical WHERE id = $1`, [verticalId]);
      if (!v?.logo_r2_key) return null;
      const o = await this.storage.getObject(String(v.logo_r2_key));
      return o.body && o.body[0] === 0xff && o.body[1] === 0xd8 ? o.body : null;
    } catch { return null; }
  }

  private async photoFor(type: DocType, refId: number): Promise<Buffer | null> {
    if (!this.storage) return null;
    try {
      let key: string | null = null;
      if (['student_id', 'marksheet', 'report_card'].includes(type)) {
        const sid = type === 'student_id' ? refId
          : Number((await this.db.one<any>(type === 'marksheet' ? `SELECT student_id FROM assessment_attempt WHERE id = $1` : `SELECT student_id FROM report_card WHERE id = $1`, [refId]))?.student_id);
        key = (await this.db.one<any>(`SELECT r2_key FROM student_document WHERE student_id = $1 AND doc_type = 'photo' AND deleted_at IS NULL AND r2_key IS NOT NULL ORDER BY id DESC LIMIT 1`, [sid]))?.r2_key ?? null;
      }
      if (!key) return null;
      const o = await this.storage.getObject(String(key));
      return o.body && o.body[0] === 0xff && o.body[1] === 0xd8 ? o.body : null;
    } catch { return null; }
  }

  /** A stable public verification code per issued document. */
  private async verification(type: DocType, refId: number, data: DocData, versionId: number | null, cfg: DocConfig): Promise<string> {
    const code = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12).toUpperCase();
    const r = await this.db.one<{ code: string }>(
      `INSERT INTO doc_verification (org_id, code, doc_type, ref_id, title, holder, doc_no, institute, details, template_version_id)
       VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (doc_type, ref_id) DO UPDATE SET title = EXCLUDED.title, holder = EXCLUDED.holder, doc_no = EXCLUDED.doc_no,
         institute = EXCLUDED.institute, details = EXCLUDED.details, template_version_id = EXCLUDED.template_version_id, updated_at = now()
       RETURNING code`,
      [code, type, refId, (data.fields.certificate_title || cfg.branding.title).slice(0, 120), data.holder.slice(0, 160), data.doc_no.slice(0, 80),
        (cfg.branding.institute_name || data.fields.institute_name || '').slice(0, 160),
        JSON.stringify(Object.fromEntries(['course_name', 'issue_date', 'completion_date', 'grade', 'percentage', 'result', 'designation', 'branch_name', 'vertical_name', 'exam_name']
          .filter((k) => data.fields[k]).map((k) => [k, data.fields[k]]))), versionId]);
    return r!.code;
  }

  /**
   * Render one record with its builder template. Returns null when no published template applies
   * (the caller then prints its built-in layout). `templateId` = an individual override.
   */
  async renderRecord(type: DocType, refId: number, opts: { templateId?: number | null; draftConfig?: unknown } = {}): Promise<{ buffer: Buffer; template_id: number | null; version_id: number | null } | null> {
    const loaded = await loadDocData(this.db, type, refId);
    if (!loaded) throw new NotFoundException('Record not found');
    let cfg: DocConfig | null = null; let templateId: number | null = null; let versionId: number | null = null;
    if (opts.draftConfig !== undefined) cfg = sanitizeDocConfig(type, opts.draftConfig);
    else if (opts.templateId) {
      const t = await this.db.one<any>(
        `SELECT t.id, t.doc_type, v.id AS vid, v.config FROM doc_builder_template t JOIN doc_builder_template_version v ON v.id = t.published_version_id
          WHERE t.id = $1 AND t.deleted_at IS NULL AND t.status = 'published'`, [opts.templateId]);
      if (!t || t.doc_type !== type) throw new BadRequestException('Pick a published template of this document type.');
      cfg = sanitizeDocConfig(type, t.config); templateId = Number(t.id); versionId = Number(t.vid);
    } else {
      const r = await this.resolve(type, loaded.ctx);
      if (!r) return null;
      cfg = r.config; templateId = r.template_id; versionId = r.version_id;
    }
    const data = loaded.data;
    data.logo = await this.verticalLogo(loaded.ctx.vertical_id);
    data.photo = await this.photoFor(type, refId);
    if (cfg.footer.show_qr) {
      const code = await this.verification(type, refId, data, versionId, cfg);
      data.verify_url = `${String(appConfig.webOrigin || '').replace(/\/+$/, '')}/verify/${code}`;
    }
    return { buffer: renderDoc(type, cfg, data), template_id: templateId, version_id: versionId };
  }

  /** Preview a draft config: on a real record when `refId` is given, else on sample data. */
  async preview(type: DocType, rawConfig: unknown, refId?: number | null): Promise<Buffer> {
    const cfg = sanitizeDocConfig(type, rawConfig);
    if (refId) {
      const loaded = await loadDocData(this.db, type, refId);
      if (!loaded) throw new NotFoundException('Record not found');
      loaded.data.logo = await this.verticalLogo(loaded.ctx.vertical_id);
      loaded.data.photo = await this.photoFor(type, refId);
      loaded.data.verify_url = `${String(appConfig.webOrigin || '').replace(/\/+$/, '')}/verify/PREVIEW`;
      return renderDoc(type, cfg, loaded.data);
    }
    return renderDoc(type, cfg, sampleDocData(type));
  }

  /** Records the preview can use, newest first (a picker in the builder). */
  async samples(type: DocType) {
    const SQL: Record<DocType, string> = {
      fee_receipt: `SELECT fr.id, fr.receipt_no || ' · ' || COALESCE(l.full_name, '') AS label FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id LEFT JOIN lead l ON l.id = e.lead_id WHERE fr.deleted_at IS NULL ORDER BY fr.id DESC LIMIT 20`,
      quotation: `SELECT q.id, q.quote_no || ' · ' || COALESCE(l.full_name, '') AS label FROM quotation q LEFT JOIN lead l ON l.id = q.lead_id WHERE q.deleted_at IS NULL ORDER BY q.id DESC LIMIT 20`,
      student_id: `SELECT id, full_name || COALESCE(' · ' || customer_no, '') AS label FROM student WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
      admission_form: `SELECT id, COALESCE(admission_no, '#' || id) || ' · ' || full_name AS label FROM admission WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
      marksheet: `SELECT a.id, s.full_name || ' · attempt ' || a.attempt_no AS label FROM assessment_attempt a JOIN student s ON s.id = a.student_id WHERE a.deleted_at IS NULL ORDER BY a.id DESC LIMIT 20`,
      report_card: `SELECT r.id, s.full_name || ' · ' || r.term AS label FROM report_card r JOIN student s ON s.id = r.student_id WHERE r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 20`,
      employee_id: `SELECT id, name || COALESCE(' · ' || employee_code, '') AS label FROM employee WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
      offer_letter: `SELECT id, name || COALESCE(' · ' || employee_code, '') AS label FROM employee WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
      experience_certificate: `SELECT id, name || COALESCE(' · ' || employee_code, '') AS label FROM employee WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
      certificate: `SELECT c.id, c.serial_no || ' · ' || s.full_name AS label FROM certificate c JOIN student s ON s.id = c.student_id WHERE c.deleted_at IS NULL ORDER BY c.id DESC LIMIT 20`,
    };
    return this.db.query<any>(SQL[type]);
  }

  /** Published templates of a type (the per-document override picker). */
  async published(type: DocType) {
    return this.db.query<any>(
      `SELECT t.id, t.name, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, t.is_default
         FROM doc_builder_template t LEFT JOIN branch b ON b.id = t.branch_id LEFT JOIN vertical v ON v.id = t.vertical_id LEFT JOIN m_course c ON c.id = t.course_id
        WHERE t.deleted_at IS NULL AND t.status = 'published' AND t.doc_type = $1 ORDER BY t.name`, [type]);
  }

  /** PUBLIC — what a scanned QR shows. No personal data beyond what is printed on the document. */
  async verify(code: string) {
    const clean = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    if (!clean) throw new NotFoundException('Not found');
    const r = await this.db.one<any>(`SELECT * FROM doc_verification WHERE code = $1`, [clean]);
    if (!r) return { valid: false, code: clean };
    let revoked = false;
    if (r.doc_type === 'certificate') {
      const c = await this.db.one<any>(`SELECT status, deleted_at FROM certificate WHERE id = $1`, [r.ref_id]);
      revoked = !c || !!c.deleted_at || c.status === 'revoked';
    } else if (['student_id', 'marksheet', 'report_card'].includes(r.doc_type)) {
      const tbl = r.doc_type === 'student_id' ? 'student' : r.doc_type === 'marksheet' ? 'assessment_attempt' : 'report_card';
      const c = await this.db.one<any>(`SELECT deleted_at FROM ${tbl} WHERE id = $1`, [r.ref_id]);
      revoked = !c || !!c.deleted_at;
    } else if (['employee_id', 'offer_letter', 'experience_certificate'].includes(r.doc_type)) {
      const c = await this.db.one<any>(`SELECT deleted_at FROM employee WHERE id = $1`, [r.ref_id]);
      revoked = !c || !!c.deleted_at;
    }
    return {
      valid: !revoked, revoked, code: r.code, document: docTypeDef(r.doc_type)?.label ?? r.doc_type, title: r.title,
      holder: r.holder, doc_no: r.doc_no, institute: r.institute, details: r.details ?? {}, issued_at: r.issued_at,
    };
  }

  /** Per-document override at print time needs doctemplate.override (checked by the controller). */
  assertOverride(allowed: boolean) { if (!allowed) throw new ForbiddenException('Choosing a different template needs the "override" permission.'); }
}
