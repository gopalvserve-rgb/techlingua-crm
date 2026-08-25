import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

/**
 * FRANCHISE COMPLIANCE & AUDITS (Phase 4 Batch 3).
 *
 * A per-franchise compliance checklist materialised on first access from the seeded default
 * TEMPLATE (migration 107). Each item carries a status (pending / compliant / non_compliant /
 * na), an optional due date, an evidence document (R2) and a note. A progress summary gives
 * the compliance % (compliant / applicable) and an overdue count. The AUDIT view reuses the
 * existing append-only audit_log filtered to franchise-critical entity types.
 */
const STATUSES = ['pending', 'compliant', 'non_compliant', 'na'];
const AUDIT_ENTITIES = [
  'franchise', 'franchise_agreement', 'royalty_plan', 'royalty_invoice',
  'royalty_payment', 'franchise_target', 'franchise_compliance_item',
];

@Injectable()
export class FranchiseComplianceService {
  constructor(private readonly db: DatabaseService, private readonly storage: StorageService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async assertFranchise(id: number) {
    const f = await this.db.one<{ id: string }>(`SELECT id FROM franchise WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!f) throw new NotFoundException('Franchise not found');
  }

  /** Copy the org's default template items into a franchise that has none yet (idempotent). */
  private async materialise(franchiseId: number, orgId: number) {
    const has = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM franchise_compliance_item WHERE franchise_id = $1::bigint`, [franchiseId]);
    if (Number(has?.n ?? 0) > 0) return;
    await this.db.query(
      `INSERT INTO franchise_compliance_item (org_id, franchise_id, title, category, sort_order)
       SELECT $1::bigint, $2::bigint, t.title, t.category, t.sort_order
         FROM franchise_compliance_template t WHERE t.org_id = $1::bigint ORDER BY t.sort_order`,
      [orgId, franchiseId]);
  }

  private async presign(item: any) {
    let evidence_url: string | null = null;
    if (item.evidence_key) { try { evidence_url = await this.storage.presignGet(String(item.evidence_key), 600); } catch { evidence_url = null; } }
    return {
      id: Number(item.id), title: item.title, category: item.category, status: item.status,
      due_date: item.due_date, note: item.note ?? null, sort_order: Number(item.sort_order ?? 0),
      has_evidence: !!item.evidence_key, evidence_name: item.evidence_name ?? null, evidence_url,
      completed_at: item.completed_at, completed_by_name: item.completed_by_name ?? null,
    };
  }

  /** The franchise's checklist + a progress summary. */
  async list(franchiseId: number) {
    await this.assertFranchise(franchiseId);
    const orgId = await this.orgId();
    await this.materialise(franchiseId, orgId);
    const rows = await this.db.query<any>(
      `SELECT i.*, u.name AS completed_by_name
         FROM franchise_compliance_item i LEFT JOIN "user" u ON u.id = i.completed_by
        WHERE i.franchise_id = $1::bigint ORDER BY i.sort_order, i.id`, [franchiseId]);
    const items = await Promise.all(rows.map((r) => this.presign(r)));
    const today = new Date().toISOString().slice(0, 10);
    const applicable = items.filter((i) => i.status !== 'na').length;
    const compliant = items.filter((i) => i.status === 'compliant').length;
    const non_compliant = items.filter((i) => i.status === 'non_compliant').length;
    const pending = items.filter((i) => i.status === 'pending').length;
    const overdue = items.filter((i) => i.status !== 'compliant' && i.status !== 'na' && i.due_date && String(i.due_date).slice(0, 10) < today).length;
    const progress_pct = applicable > 0 ? Math.round((compliant / applicable) * 1000) / 10 : 0;
    return {
      items,
      summary: { total: items.length, applicable, compliant, non_compliant, pending, overdue, progress_pct },
    };
  }

  async setStatus(franchiseId: number, itemId: number, dto: any, me: { id: number }) {
    await this.assertFranchise(franchiseId);
    const status = STATUSES.includes(dto?.status) ? dto.status : null;
    if (!status) throw new BadRequestException('Choose a valid status.');
    const due = /^(\d{4}-\d{2}-\d{2})/.exec(String(dto?.due_date ?? '')) ? String(dto.due_date).slice(0, 10) : null;
    const done = status === 'compliant';
    const r = await this.db.query<{ id: string }>(
      `UPDATE franchise_compliance_item
          SET status=$3, due_date = COALESCE($4::date, due_date), note = COALESCE($5, note),
              evidence_key = CASE WHEN $6::text IS NOT NULL AND $6::text <> '' THEN $6 ELSE evidence_key END,
              evidence_name = CASE WHEN $6::text IS NOT NULL AND $6::text <> '' THEN $7 ELSE evidence_name END,
              completed_by = CASE WHEN $8::boolean THEN $9::bigint ELSE NULL END,
              completed_at = CASE WHEN $8::boolean THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id=$1::bigint AND franchise_id=$2::bigint RETURNING id`,
      [itemId, franchiseId, status, due, dto?.note ?? null, dto?.evidence_key ?? null, dto?.evidence_name ?? null, done, me.id]);
    if (!r.length) throw new NotFoundException('Compliance item not found');
    await this.db.query(
      `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
       VALUES ((SELECT org_id FROM franchise_compliance_item WHERE id=$1::bigint), $2::bigint,
               'franchise_compliance_item', $1::bigint, 'update', $3::jsonb)`,
      [itemId, me.id, JSON.stringify({ franchise_id: franchiseId, status })],
    ).catch(() => undefined);
    return this.list(franchiseId);
  }

  async addItem(franchiseId: number, dto: any) {
    await this.assertFranchise(franchiseId);
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the item a title.');
    const orgId = await this.orgId();
    await this.materialise(franchiseId, orgId);
    const max = await this.db.one<{ m: string }>(
      `SELECT COALESCE(max(sort_order),0) AS m FROM franchise_compliance_item WHERE franchise_id = $1::bigint`, [franchiseId]);
    await this.db.query(
      `INSERT INTO franchise_compliance_item (org_id, franchise_id, title, category, due_date, sort_order)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5::date,$6)`,
      [orgId, franchiseId, title, String(dto?.category ?? 'general'),
       /^(\d{4}-\d{2}-\d{2})/.exec(String(dto?.due_date ?? '')) ? String(dto.due_date).slice(0, 10) : null,
       Number(max?.m ?? 0) + 10]);
    return this.list(franchiseId);
  }

  async removeItem(franchiseId: number, itemId: number) {
    await this.assertFranchise(franchiseId);
    const r = await this.db.query<{ id: string }>(
      `DELETE FROM franchise_compliance_item WHERE id=$1::bigint AND franchise_id=$2::bigint RETURNING id`,
      [itemId, franchiseId]);
    if (!r.length) throw new NotFoundException('Compliance item not found');
    return this.list(franchiseId);
  }

  /** Presigned PUT for a compliance evidence document (browser -> R2). */
  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'evidence.pdf');
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.materialKey('franchise-compliance', fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }

  /**
   * AUDIT view — the append-only audit_log for franchise-critical entities. Optionally
   * narrowed to a single franchise (by franchise entity id OR items belonging to it).
   */
  async audit(opts: { franchiseId?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const params: unknown[] = [AUDIT_ENTITIES];
    let clause = 'a.entity_type = ANY($1::text[])';
    if (opts.franchiseId) {
      params.push(opts.franchiseId);
      // franchise row itself, or a child entity whose after->>'franchise_id' matches.
      clause += ` AND ((a.entity_type = 'franchise' AND a.entity_id = $${params.length}::bigint)
                    OR (a.after ->> 'franchise_id') = $${params.length}::text
                    OR (a.entity_type = 'franchise_target' AND a.entity_id IN
                          (SELECT id FROM franchise_target WHERE franchise_id = $${params.length}::bigint))
                    OR (a.entity_type = 'franchise_agreement' AND a.entity_id IN
                          (SELECT id FROM franchise_agreement WHERE franchise_id = $${params.length}::bigint))
                    OR (a.entity_type = 'royalty_invoice' AND a.entity_id IN
                          (SELECT id FROM royalty_invoice WHERE franchise_id = $${params.length}::bigint)))`;
    }
    params.push(limit);
    const rows = await this.db.query<any>(
      `SELECT a.id, a.entity_type, a.entity_id, a.action, a.after, a.occurred_at, u.name AS actor_name
         FROM audit_log a LEFT JOIN "user" u ON u.id = a.actor_id
        WHERE ${clause} ORDER BY a.occurred_at DESC LIMIT $${params.length}`, params);
    return rows.map((r) => ({
      id: Number(r.id), entity_type: r.entity_type, entity_id: r.entity_id == null ? null : Number(r.entity_id),
      action: r.action, actor_name: r.actor_name ?? null, occurred_at: r.occurred_at, detail: r.after ?? null,
    }));
  }
}
