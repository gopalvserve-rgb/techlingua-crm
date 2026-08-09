import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NumberingService } from '../numbering/numbering.service';
import { rupeesToMinor } from '../common/money.util';

/**
 * CATALOG — the org-wide master of items/products/services the institute deals in
 * (books, kits, merchandise, service items). Master-like: NOT branch-scoped (the masters
 * pattern), permission-gated by catalog.*. India: ₹ integer paise price + GST% + HSN/SAC.
 * item_code is auto-minted (ITM-) from the numbering series when left blank, else used as-is.
 * Used by inventory (stock) and procurement (PO line items).
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DatabaseService, private readonly numbering: NumberingService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(q: { q?: string; category?: string; item_type?: string; active?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`c.deleted_at IS NULL`];
    if (q.q) { params.push(`%${q.q}%`); where.push(`(c.name ILIKE $${params.length} OR c.item_code ILIKE $${params.length} OR c.hsn_code ILIKE $${params.length})`); }
    const cats = String(q.category ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (cats.length) { params.push(cats); where.push(`c.category = ANY($${params.length}::text[])`); }
    const types = String(q.item_type ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (types.length) { params.push(types); where.push(`c.item_type = ANY($${params.length}::text[])`); }
    if (q.active === 'active') where.push(`c.is_active`);
    if (q.active === 'inactive') where.push(`NOT c.is_active`);
    params.push(Math.min(Number(q.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT c.id, c.item_code, c.name, c.category, c.item_type, c.unit, c.price_minor,
              c.tax_pct, c.hsn_code, c.description, c.is_active, c.created_at
         FROM catalog_item c
        WHERE ${where.join(' AND ')}
        ORDER BY c.name ASC
        LIMIT $${params.length}`, params);
  }

  async get(id: number) {
    const row = await this.db.one<any>(`SELECT * FROM catalog_item WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Catalog item not found');
    return row;
  }

  private fields(dto: any): { name: string; category: string | null; item_type: string; unit: string; price_minor: number; tax_pct: number; hsn_code: string | null; description: string | null; is_active: boolean } {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Item name is required.');
    const item_type = dto?.item_type === 'service' ? 'service' : 'product';
    const price_minor = rupeesToMinor(dto?.price ?? dto?.price_minor_input ?? 0);
    const tax_pct = Number(dto?.tax_pct ?? 0);
    if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) throw new BadRequestException('GST % must be between 0 and 100.');
    return {
      name,
      category: dto?.category ? String(dto.category).trim().slice(0, 80) : null,
      item_type,
      unit: (dto?.unit ? String(dto.unit).trim() : 'pcs').slice(0, 24) || 'pcs',
      price_minor,
      tax_pct,
      hsn_code: dto?.hsn_code ? String(dto.hsn_code).trim().slice(0, 12) : null,
      description: dto?.description ? String(dto.description).trim() : null,
      is_active: dto?.is_active === undefined ? true : !!dto.is_active,
    };
  }

  async create(dto: any, me: { id: number }) {
    const f = this.fields(dto);
    const orgId = await this.orgId();
    const manual = dto?.item_code != null && String(dto.item_code).trim() !== '' ? String(dto.item_code).trim().slice(0, 48) : null;
    return this.db.tx(async (c) => {
      const code = manual ?? await this.numbering.allocate('catalog', {}, c);
      const dup = await c.query(`SELECT 1 FROM catalog_item WHERE org_id = $1::bigint AND lower(item_code) = lower($2) AND deleted_at IS NULL`, [orgId, code]);
      if (dup.rows.length) throw new BadRequestException(`Item code "${code}" already exists.`);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO catalog_item (org_id, item_code, name, category, item_type, unit, price_minor, tax_pct, hsn_code, description, is_active, created_by)
         VALUES ($1::bigint,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12::bigint) RETURNING id`,
        [orgId, code, f.name, f.category, f.item_type, f.unit, f.price_minor, f.tax_pct, f.hsn_code, f.description, f.is_active, me.id]);
      return { id: Number(ins.rows[0].id), item_code: code };
    });
  }

  async update(id: number, dto: any, _me: { id: number }) {
    await this.get(id);
    const f = this.fields(dto);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    set('name', f.name); set('category', f.category); set('item_type', f.item_type); set('unit', f.unit);
    set('price_minor', f.price_minor); set('tax_pct', f.tax_pct); set('hsn_code', f.hsn_code);
    set('description', f.description); set('is_active', f.is_active);
    if (dto?.item_code !== undefined && String(dto.item_code).trim() !== '') set('item_code', String(dto.item_code).trim().slice(0, 48));
    params.push(id);
    await this.db.query(`UPDATE catalog_item SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }) {
    await this.get(id);
    await this.db.query(`UPDATE catalog_item SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  async bulkImpact(raw: unknown) {
    const ids = this.idList(raw);
    const rows = ids.length ? await this.db.query<{ id: string }>(`SELECT id FROM catalog_item WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]) : [];
    return { entity: 'catalog', label: 'Catalog item', requested: ids.length, in_scope: rows.length, out_of_scope: ids.length - rows.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }) {
    const ids = this.idList(raw);
    if (!ids.length) return { deleted: 0, skipped: 0 };
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM catalog_item WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
    let deleted = 0;
    for (const r of rows) { await this.remove(Number(r.id), me); deleted++; }
    return { deleted, skipped: ids.length - deleted };
  }
}
