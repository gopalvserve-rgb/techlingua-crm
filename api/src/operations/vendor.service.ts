import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * VENDOR — org-wide vendor master (India: GSTIN, contact, address, category, optional bank).
 * Master-like (NOT branch-scoped), permission-gated by vendor.*. Used by procurement (PO) and
 * assets (purchased-from). GSTIN is soft-validated to the 15-char format (stored as-is).
 */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

@Injectable()
export class VendorService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(q: { q?: string; category?: string; active?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`v.deleted_at IS NULL`];
    if (q.q) { params.push(`%${q.q}%`); where.push(`(v.name ILIKE $${params.length} OR v.gstin ILIKE $${params.length} OR v.contact_person ILIKE $${params.length} OR v.phone ILIKE $${params.length})`); }
    const cats = String(q.category ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (cats.length) { params.push(cats); where.push(`v.category = ANY($${params.length}::text[])`); }
    if (q.active === 'active') where.push(`v.is_active`);
    if (q.active === 'inactive') where.push(`NOT v.is_active`);
    params.push(Math.min(Number(q.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT v.id, v.name, v.gstin, v.category, v.contact_person, v.phone, v.email,
              v.city, v.state, v.pincode, v.is_active, v.created_at
         FROM vendor v WHERE ${where.join(' AND ')} ORDER BY v.name ASC LIMIT $${params.length}`, params);
  }

  async get(id: number) {
    const row = await this.db.one<any>(`SELECT * FROM vendor WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Vendor not found');
    return row;
  }

  private fields(dto: any) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Vendor name is required.');
    const gstin = dto?.gstin ? String(dto.gstin).trim().toUpperCase().slice(0, 15) : null;
    if (gstin && !GSTIN_RE.test(gstin)) throw new BadRequestException('GSTIN must be a valid 15-character GST number (e.g. 27AAPFU0939F1ZV).');
    const pincode = dto?.pincode ? String(dto.pincode).trim() : null;
    if (pincode && !/^\d{6}$/.test(pincode)) throw new BadRequestException('An Indian pincode must be exactly 6 digits.');
    const clean = (k: string, max = 200) => (dto?.[k] != null && String(dto[k]).trim() !== '' ? String(dto[k]).trim().slice(0, max) : null);
    return {
      name, gstin, pincode,
      category: clean('category', 80),
      contact_person: clean('contact_person', 160),
      phone: clean('phone', 24),
      email: clean('email', 160),
      address: dto?.address != null && String(dto.address).trim() !== '' ? String(dto.address).trim() : null,
      city: clean('city', 120),
      state: clean('state', 120),
      bank_name: clean('bank_name', 160),
      bank_account: clean('bank_account', 40),
      bank_ifsc: dto?.bank_ifsc ? String(dto.bank_ifsc).trim().toUpperCase().slice(0, 20) : null,
      notes: dto?.notes != null && String(dto.notes).trim() !== '' ? String(dto.notes).trim() : null,
      is_active: dto?.is_active === undefined ? true : !!dto.is_active,
    };
  }

  async create(dto: any, me: { id: number }) {
    const f = this.fields(dto);
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO vendor (org_id, name, gstin, category, contact_person, phone, email, address, city, state, pincode, bank_name, bank_account, bank_ifsc, notes, is_active, created_by)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::bigint) RETURNING id`,
      [orgId, f.name, f.gstin, f.category, f.contact_person, f.phone, f.email, f.address, f.city, f.state, f.pincode, f.bank_name, f.bank_account, f.bank_ifsc, f.notes, f.is_active, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any) {
    await this.get(id);
    const f = this.fields(dto);
    const cols = ['name', 'gstin', 'category', 'contact_person', 'phone', 'email', 'address', 'city', 'state', 'pincode', 'bank_name', 'bank_account', 'bank_ifsc', 'notes', 'is_active'] as const;
    const params: unknown[] = []; const sets: string[] = [];
    for (const col of cols) { params.push((f as any)[col]); sets.push(`${col} = $${params.length}`); }
    params.push(id);
    await this.db.query(`UPDATE vendor SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }) {
    await this.get(id);
    await this.db.query(`UPDATE vendor SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  async bulkImpact(raw: unknown) {
    const ids = this.idList(raw);
    const rows = ids.length ? await this.db.query<{ id: string }>(`SELECT id FROM vendor WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]) : [];
    return { entity: 'vendor', label: 'Vendor', requested: ids.length, in_scope: rows.length, out_of_scope: ids.length - rows.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }) {
    const ids = this.idList(raw);
    if (!ids.length) return { deleted: 0, skipped: 0 };
    const rows = await this.db.query<{ id: string }>(`SELECT id FROM vendor WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
    let deleted = 0;
    for (const r of rows) { await this.remove(Number(r.id), me); deleted++; }
    return { deleted, skipped: ids.length - deleted };
  }
}
