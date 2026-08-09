import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { rupeesToMinor } from '../common/money.util';
import { requireDateString } from '../common/date.util';

/**
 * ASSETS — the equipment / furniture / IT register. Branch-scoped (ScopeResolver). Asset code
 * is auto-minted (AST-) from the numbering series per branch/vertical, or supplied manually.
 * Lifecycle status in_use → in_repair → retired; assigned-to a user; warranty + AMC dates;
 * India ₹ integer-paise cost. Optional vendor (purchased-from).
 */
export const ASSET_SCOPE_COLS: ScopeColumnMap = { branch: 'a.branch_id', vertical: 'a.vertical_id' };
const STATUSES = ['in_use', 'in_repair', 'retired'];

@Injectable()
export class AssetService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService, private readonly numbering: NumberingService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(scope: ResolvedScope, q: { branch_id?: string; vertical_id?: string; status?: string; category?: string; assigned_to?: string; q?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ASSET_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string, txt = false) => {
      const vals = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      if (txt) { params.push(vals); where.push(`${col} = ANY($${params.length}::text[])`); }
      else { const ids = vals.map(Number).filter((n) => Number.isFinite(n) && n > 0); if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`); }
    };
    multi('a.branch_id', q.branch_id);
    multi('a.vertical_id', q.vertical_id);
    multi('a.assigned_to', q.assigned_to);
    multi('a.status', q.status, true);
    multi('a.category', q.category, true);
    if (q.q) { params.push(`%${q.q}%`); where.push(`(a.name ILIKE $${params.length} OR a.asset_code ILIKE $${params.length} OR a.serial_no ILIKE $${params.length})`); }
    params.push(Math.min(Number(q.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT a.id, a.asset_code, a.name, a.category, a.branch_id, a.vertical_id, a.location,
              a.serial_no, a.purchase_date, a.cost_minor, a.vendor_id, a.status, a.assigned_to,
              a.warranty_until, a.amc_until, a.created_at,
              b.name AS branch_name, v.name AS vertical_name, u.name AS assigned_to_name, ve.name AS vendor_name
         FROM asset a
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u ON u.id = a.assigned_to
         LEFT JOIN vendor ve ON ve.id = a.vendor_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length}`, params);
  }

  async summary(scope: ResolvedScope, q: { branch_id?: string } = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ASSET_SCOPE_COLS, params)];
    const ids = String(q.branch_id ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) { params.push(ids); where.push(`a.branch_id = ANY($${params.length}::bigint[])`); }
    const w = where.join(' AND ');
    const kpi = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE a.status = 'in_use') AS in_use,
              count(*) FILTER (WHERE a.status = 'in_repair') AS in_repair,
              count(*) FILTER (WHERE a.status = 'retired') AS retired,
              COALESCE(sum(a.cost_minor), 0) AS value_minor
         FROM asset a WHERE ${w}`, params);
    return {
      total: Number(kpi?.total ?? 0), in_use: Number(kpi?.in_use ?? 0), in_repair: Number(kpi?.in_repair ?? 0),
      retired: Number(kpi?.retired ?? 0), value_minor: Number(kpi?.value_minor ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ASSET_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT a.*, b.name AS branch_name, v.name AS vertical_name, u.name AS assigned_to_name, ve.name AS vendor_name
         FROM asset a
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u ON u.id = a.assigned_to
         LEFT JOIN vendor ve ON ve.id = a.vendor_id
        WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Asset not found (or outside your access).');
    return row;
  }

  private async assertHierarchy(branchId: number, verticalId: number | null) {
    if (!branchId) throw new BadRequestException('Choose a branch.');
    if (verticalId) {
      const v = await this.db.one<any>(`SELECT id FROM vertical WHERE id = $1::bigint AND branch_id = $2::bigint AND deleted_at IS NULL`, [verticalId, branchId]);
      if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    }
  }

  private mapDate(dto: any, k: string, label: string): string | null | undefined {
    if (dto?.[k] === undefined) return undefined;
    if (dto[k] == null || String(dto[k]).trim() === '') return null;
    return requireDateString(dto[k], () => { throw new BadRequestException(`${label} is not a valid date.`); });
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const branchId = Number(dto?.branch_id);
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    await this.assertHierarchy(branchId, verticalId);
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Asset name is required.');
    const status = STATUSES.includes(dto?.status) ? dto.status : 'in_use';
    const cost = rupeesToMinor(dto?.cost ?? dto?.cost_minor_input ?? 0);
    const orgId = await this.orgId();
    const manual = dto?.asset_code != null && String(dto.asset_code).trim() !== '' ? String(dto.asset_code).trim().slice(0, 48) : null;
    const purchase = this.mapDate(dto, 'purchase_date', 'Purchase Date') ?? null;
    const warranty = this.mapDate(dto, 'warranty_until', 'Warranty date') ?? null;
    const amc = this.mapDate(dto, 'amc_until', 'AMC date') ?? null;
    const str = (k: string, max: number) => (dto?.[k] != null && String(dto[k]).trim() !== '' ? String(dto[k]).trim().slice(0, max) : null);

    return this.db.tx(async (c) => {
      const code = manual ?? await this.numbering.allocate('asset', { branch_id: branchId, vertical_id: verticalId }, c);
      const dup = await c.query(`SELECT 1 FROM asset WHERE org_id = $1::bigint AND lower(asset_code) = lower($2) AND deleted_at IS NULL`, [orgId, code]);
      if (dup.rows.length) throw new BadRequestException(`Asset code "${code}" already exists.`);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO asset (org_id, asset_code, name, category, branch_id, vertical_id, location, serial_no,
                            purchase_date, cost_minor, vendor_id, status, assigned_to, warranty_until, amc_until, notes, created_by)
         VALUES ($1::bigint,$2,$3,$4,$5::bigint,$6::bigint,$7,$8,$9::date,$10::bigint,$11::bigint,$12,$13::bigint,$14::date,$15::date,$16,$17::bigint)
         RETURNING id`,
        [orgId, code, name, str('category', 80), branchId, verticalId, str('location', 120), str('serial_no', 120),
          purchase, cost, dto?.vendor_id ? Number(dto.vendor_id) : null, status, dto?.assigned_to ? Number(dto.assigned_to) : null,
          warranty, amc, str('notes', 4000), me.id]);
      return { id: Number(ins.rows[0].id), asset_code: code };
    });
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    const str = (col: string, k: string, max: number) => { if (dto?.[k] !== undefined) set(col, dto[k] != null && String(dto[k]).trim() !== '' ? String(dto[k]).trim().slice(0, max) : null); };

    if (dto?.name !== undefined) { const n = String(dto.name).trim(); if (!n) throw new BadRequestException('Asset name is required.'); set('name', n); }
    str('category', 'category', 80);
    str('location', 'location', 120);
    str('serial_no', 'serial_no', 120);
    str('notes', 'notes', 4000);
    if (dto?.asset_code !== undefined && String(dto.asset_code).trim() !== '') set('asset_code', String(dto.asset_code).trim().slice(0, 48));
    if (dto?.cost !== undefined || dto?.cost_minor_input !== undefined) set('cost_minor', rupeesToMinor(dto.cost ?? dto.cost_minor_input ?? 0));
    if (dto?.status !== undefined) { if (!STATUSES.includes(dto.status)) throw new BadRequestException('Status must be in_use, in_repair or retired.'); set('status', dto.status); }
    if (dto?.assigned_to !== undefined) set('assigned_to', dto.assigned_to ? Number(dto.assigned_to) : null);
    if (dto?.vendor_id !== undefined) set('vendor_id', dto.vendor_id ? Number(dto.vendor_id) : null);
    const pd = this.mapDate(dto, 'purchase_date', 'Purchase Date'); if (pd !== undefined) set('purchase_date', pd);
    const wd = this.mapDate(dto, 'warranty_until', 'Warranty date'); if (wd !== undefined) set('warranty_until', wd);
    const ad = this.mapDate(dto, 'amc_until', 'AMC date'); if (ad !== undefined) set('amc_until', ad);
    if (dto?.branch_id !== undefined || dto?.vertical_id !== undefined) {
      const branchId = Number(dto.branch_id ?? cur.branch_id);
      const verticalId = dto?.vertical_id !== undefined ? (dto.vertical_id ? Number(dto.vertical_id) : null) : (cur.vertical_id ? Number(cur.vertical_id) : null);
      await this.assertHierarchy(branchId, verticalId);
      set('branch_id', branchId); set('vertical_id', verticalId);
    }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE asset SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE asset SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, ASSET_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT a.id FROM asset a WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'asset', label: 'Asset', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
