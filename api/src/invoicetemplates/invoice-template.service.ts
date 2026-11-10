import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { InvoiceTemplateConfig, defaultConfig, sanitizeConfig } from './template-config';
import { InvoiceTplData, loadInvoiceTplData, sampleTplData } from './template-data';
import { renderInvoiceTemplate } from './template-render';

/**
 * FEE INVOICE TEMPLATE BUILDER (client 5 Nov 2026) — templates, versions, publishing, defaults
 * per branch, and rendering. The client's rules, as implemented:
 *   1. an issued invoice is immutable → it is stamped with the template VERSION it was issued
 *      with (gst_invoice.template_version_id) and always renders with that version;
 *   2. editing a template never changes issued invoices → edits go to the draft config; only
 *      Publish creates a new version, and only invoices issued after that use it;
 *   3. every published version is kept (version history, restore);
 *   4. publishing / editing needs settings.update (controller);
 *   5. numbering and amounts stay with the finance module — a template only lays them out.
 * Resolution for a new invoice: the published DEFAULT template of the invoice's branch, else the
 * published global default, else the built-in layout (unchanged from before this feature).
 */
@Injectable()
export class InvoiceTemplateService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const o = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(o!.id);
  }

  async list() {
    return this.db.query<any>(
      `SELECT t.id, t.name, t.branch_id, b.name AS branch_name, t.is_default, t.status, t.updated_at,
              t.config->>'layout' AS layout, u.name AS updated_by_name,
              v.version_no AS published_version_no, v.published_at,
              (SELECT count(*) FROM invoice_template_version x WHERE x.template_id = t.id) AS versions,
              (SELECT count(*) FROM gst_invoice gi JOIN invoice_template_version x ON x.id = gi.template_version_id
                WHERE x.template_id = t.id) AS invoices_issued,
              (v.id IS NOT NULL AND v.config <> t.config) AS has_unpublished_changes
         FROM invoice_template t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN "user" u ON u.id = t.updated_by
         LEFT JOIN invoice_template_version v ON v.id = t.published_version_id
        WHERE t.deleted_at IS NULL
        ORDER BY t.is_default DESC, t.branch_id NULLS FIRST, t.id`);
  }

  async get(id: number) {
    const t = await this.db.one<any>(
      `SELECT t.*, b.name AS branch_name, v.version_no AS published_version_no,
              (v.id IS NOT NULL AND v.config <> t.config) AS has_unpublished_changes
         FROM invoice_template t LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN invoice_template_version v ON v.id = t.published_version_id
        WHERE t.id = $1::bigint AND t.deleted_at IS NULL`, [id]);
    if (!t) throw new NotFoundException('Invoice template not found');
    return { ...t, config: sanitizeConfig(t.config) };
  }

  /** New template: from a layout (professional / minimal / detailed) or a copy of another. */
  async create(dto: any, me: { id: number }) {
    const name = String(dto?.name ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('Give the template a name.');
    const branchId = dto?.branch_id ? Number(dto.branch_id) : null;
    let config: InvoiceTemplateConfig;
    if (dto?.from_id) config = (await this.get(Number(dto.from_id))).config;
    else config = defaultConfig(['minimal', 'detailed'].includes(dto?.layout) ? dto.layout : 'professional');
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO invoice_template (org_id, name, branch_id, config, created_by, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5) RETURNING id`,
      [await this.orgId(), name, branchId, JSON.stringify(config), me.id]);
    return this.get(Number(r!.id));
  }

  async duplicate(id: number, me: { id: number }) {
    const t = await this.get(id);
    return this.create({ name: `Copy of ${t.name}`.slice(0, 120), branch_id: t.branch_id, from_id: id }, me);
  }

  /** Save the DRAFT (name, branch override, design). Issued invoices are untouched. */
  async update(id: number, dto: any, me: { id: number }) {
    const t = await this.get(id);
    const name = dto?.name !== undefined ? String(dto.name).trim().slice(0, 120) : t.name;
    if (!name) throw new BadRequestException('Give the template a name.');
    const branchId = dto?.branch_id !== undefined ? (dto.branch_id ? Number(dto.branch_id) : null) : t.branch_id;
    if (t.is_default && String(branchId ?? '') !== String(t.branch_id ?? '')) {
      throw new BadRequestException('This is the default template for its scope — make another template the default before moving it to a different branch.');
    }
    const config = dto?.config !== undefined ? sanitizeConfig(dto.config) : t.config;
    await this.db.query(
      `UPDATE invoice_template SET name = $2, branch_id = $3, config = $4::jsonb, updated_by = $5, updated_at = now() WHERE id = $1::bigint`,
      [id, name, branchId, JSON.stringify(config), me.id]);
    return this.get(id);
  }

  /** PUBLISH the draft as a new immutable version; the first published template of a scope
   *  becomes that scope's default automatically. */
  async publish(id: number, dto: any, me: { id: number }) {
    const t = await this.get(id);
    return this.db.tx(async (c) => {
      const n = await c.query<{ v: number }>(`SELECT COALESCE(max(version_no), 0) + 1 AS v FROM invoice_template_version WHERE template_id = $1::bigint`, [id]);
      const ver = Number(n.rows[0].v);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO invoice_template_version (template_id, version_no, config, note, published_by) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
        [id, ver, JSON.stringify(t.config), dto?.note ? String(dto.note).slice(0, 300) : null, me.id]);
      await c.query(`UPDATE invoice_template SET status = 'published', published_version_id = $2, updated_by = $3, updated_at = now() WHERE id = $1::bigint`,
        [id, Number(ins.rows[0].id), me.id]);
      const hasDefault = await c.query(
        `SELECT 1 FROM invoice_template WHERE org_id = $1 AND COALESCE(branch_id, 0) = COALESCE($2::bigint, 0) AND is_default AND deleted_at IS NULL AND id <> $3`,
        [t.org_id, t.branch_id, id]);
      if (!hasDefault.rowCount && !t.is_default) await c.query(`UPDATE invoice_template SET is_default = TRUE WHERE id = $1::bigint`, [id]);
      return { id, version_no: ver };
    });
  }

  async unpublish(id: number, me: { id: number }) {
    const t = await this.get(id);
    if (t.status !== 'published') throw new BadRequestException('This template is not published.');
    await this.db.query(`UPDATE invoice_template SET status = 'unpublished', updated_by = $2, updated_at = now() WHERE id = $1::bigint`, [id, me.id]);
    return { id, status: 'unpublished', was_default: !!t.is_default };
  }

  async setDefault(id: number, me: { id: number }) {
    const t = await this.get(id);
    if (t.status !== 'published') throw new BadRequestException('Publish this template before making it the default.');
    await this.db.tx(async (c) => {
      await c.query(`UPDATE invoice_template SET is_default = FALSE WHERE org_id = $1 AND COALESCE(branch_id, 0) = COALESCE($2::bigint, 0) AND is_default`, [t.org_id, t.branch_id]);
      await c.query(`UPDATE invoice_template SET is_default = TRUE, updated_by = $2, updated_at = now() WHERE id = $1::bigint`, [id, me.id]);
    });
    return { id, is_default: true };
  }

  async versions(id: number) {
    await this.get(id);
    return this.db.query<any>(
      `SELECT v.id, v.version_no, v.note, v.published_at, u.name AS published_by_name,
              (SELECT count(*) FROM gst_invoice gi WHERE gi.template_version_id = v.id) AS invoices
         FROM invoice_template_version v LEFT JOIN "user" u ON u.id = v.published_by
        WHERE v.template_id = $1::bigint ORDER BY v.version_no DESC`, [id]);
  }

  /** RESTORE an earlier version into the draft (publish it again to make it live). */
  async restore(id: number, versionId: number, me: { id: number }) {
    await this.get(id);
    const v = await this.db.one<any>(`SELECT config, version_no FROM invoice_template_version WHERE id = $1::bigint AND template_id = $2::bigint`, [versionId, id]);
    if (!v) throw new NotFoundException('That version does not belong to this template.');
    await this.db.query(`UPDATE invoice_template SET config = $2::jsonb, updated_by = $3, updated_at = now() WHERE id = $1::bigint`,
      [id, JSON.stringify(sanitizeConfig(v.config)), me.id]);
    return { ...(await this.get(id)), restored_version_no: v.version_no };
  }

  async remove(id: number, me: { id: number }) {
    const t = await this.get(id);
    if (t.is_default && t.status === 'published') {
      throw new BadRequestException('This is the default invoice template — make another template the default (or unpublish it) before deleting.');
    }
    await this.db.query(`UPDATE invoice_template SET deleted_at = now(), deleted_by = $2, is_default = FALSE WHERE id = $1::bigint`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ------------------------------------------------------------ rendering */

  /** The published version a NEW invoice of this branch is issued with (null = built-in). */
  async versionForBranch(branchId: number | null): Promise<{ id: number; config: InvoiceTemplateConfig } | null> {
    const r = await this.db.one<any>(
      `SELECT v.id, v.config FROM invoice_template t JOIN invoice_template_version v ON v.id = t.published_version_id
        WHERE t.deleted_at IS NULL AND t.status = 'published' AND t.is_default
          AND (t.branch_id = $1::bigint OR t.branch_id IS NULL)
        ORDER BY (t.branch_id IS NULL) ASC LIMIT 1`, [branchId]);
    return r ? { id: Number(r.id), config: sanitizeConfig(r.config) } : null;
  }

  /**
   * The design an invoice renders with: its stamped version when issued; the current default for
   * a draft (a preview of what issuing will produce); null → the built-in layout (an invoice
   * issued before templates existed keeps the layout it was issued with).
   */
  async configForInvoice(gi: any): Promise<InvoiceTemplateConfig | null> {
    if (gi.template_version_id) {
      const v = await this.db.one<any>(`SELECT config FROM invoice_template_version WHERE id = $1::bigint`, [Number(gi.template_version_id)]);
      return v ? sanitizeConfig(v.config) : null;
    }
    if (String(gi.status) === 'draft') return (await this.versionForBranch(gi.branch_id ? Number(gi.branch_id) : null))?.config ?? null;
    return null;
  }

  async invoiceData(gi: any): Promise<InvoiceTplData> {
    return loadInvoiceTplData(this.db as any, gi);
  }

  render(config: InvoiceTemplateConfig, data: InvoiceTplData): Buffer {
    return renderInvoiceTemplate(config, data);
  }

  /** Builder preview: an unsaved design rendered with sample data or with a real invoice. */
  async preview(rawConfig: unknown, gi: any | null, supply?: string): Promise<Buffer> {
    const cfg = sanitizeConfig(rawConfig);
    const data = gi ? await this.invoiceData(gi) : sampleTplData(supply === 'inter' ? 'inter' : 'intra');
    return renderInvoiceTemplate(cfg, data, { title: 'Invoice template preview' });
  }
}
