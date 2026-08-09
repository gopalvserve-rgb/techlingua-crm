import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

/**
 * INVENTORY — per-branch/location stock of catalog items + an append-only movement ledger.
 *
 *  · on-hand per (item, branch, location) in `inventory_stock`; low-stock when
 *    on_hand <= threshold (threshold > 0).
 *  · every stock change writes an `inventory_movement` row (receipt / issue / adjustment) with
 *    the signed delta AND the on-hand snapshot after — a full audit trail. The AuditInterceptor
 *    additionally records the mutation.
 *  · branch-scoped via the ScopeResolver (STOCK_SCOPE_COLS). RECEIVING a PO calls
 *    `receiveIntoTx` inside the PO transaction so the receipt + stock bump are atomic.
 *
 * Quantities are NUMERIC (no floats in money; qty may be fractional e.g. kg/hours).
 */
export const STOCK_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id' };
export const MOVE_SCOPE_COLS: ScopeColumnMap = { branch: 'm.branch_id' };

@Injectable()
export class InventoryService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */
  async list(scope: ResolvedScope, q: { branch_id?: string; item_id?: string; low?: string; q?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`s.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, STOCK_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('s.branch_id', q.branch_id);
    multi('s.item_id', q.item_id);
    if (q.low === '1' || q.low === 'true') where.push(`s.low_stock_threshold > 0 AND s.qty_on_hand <= s.low_stock_threshold`);
    if (q.q) { params.push(`%${q.q}%`); where.push(`(ci.name ILIKE $${params.length} OR ci.item_code ILIKE $${params.length})`); }
    params.push(Math.min(Number(q.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT s.id, s.item_id, s.branch_id, s.location, s.qty_on_hand, s.low_stock_threshold,
              (s.low_stock_threshold > 0 AND s.qty_on_hand <= s.low_stock_threshold) AS low_stock,
              ci.item_code, ci.name AS item_name, ci.unit, ci.category, b.name AS branch_name,
              s.updated_at
         FROM inventory_stock s
         JOIN catalog_item ci ON ci.id = s.item_id
         LEFT JOIN branch b ON b.id = s.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY low_stock DESC, ci.name ASC
        LIMIT $${params.length}`, params);
  }

  async summary(scope: ResolvedScope, q: { branch_id?: string } = {}) {
    const params: unknown[] = [];
    const where = [`s.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, STOCK_SCOPE_COLS, params)];
    const ids = String(q.branch_id ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) { params.push(ids); where.push(`s.branch_id = ANY($${params.length}::bigint[])`); }
    const w = where.join(' AND ');
    const kpi = await this.db.one<any>(
      `SELECT count(*) AS lines, count(DISTINCT s.item_id) AS items,
              count(*) FILTER (WHERE s.low_stock_threshold > 0 AND s.qty_on_hand <= s.low_stock_threshold) AS low
         FROM inventory_stock s WHERE ${w}`, params);
    return { lines: Number(kpi?.lines ?? 0), items: Number(kpi?.items ?? 0), low: Number(kpi?.low ?? 0) };
  }

  async movements(scope: ResolvedScope, q: { branch_id?: string; item_id?: string; type?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [this.resolver.buildScopeWhere(scope, MOVE_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const idl = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!idl.length) return; params.push(idl); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('m.branch_id', q.branch_id);
    multi('m.item_id', q.item_id);
    const types = String(q.type ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (types.length) { params.push(types); where.push(`m.movement_type = ANY($${params.length}::text[])`); }
    params.push(Math.min(Number(q.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT m.id, m.item_id, m.branch_id, m.location, m.movement_type, m.qty_delta, m.qty_after,
              m.reason, m.ref_type, m.ref_id, m.created_at,
              ci.item_code, ci.name AS item_name, ci.unit, b.name AS branch_name, u.name AS created_by_name
         FROM inventory_movement m
         JOIN catalog_item ci ON ci.id = m.item_id
         LEFT JOIN branch b ON b.id = m.branch_id
         LEFT JOIN "user" u ON u.id = m.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length}`, params);
  }

  /* --------------------------------------------------------------- mutations */
  /** Is `branchId` inside the caller's resolved scope? (write guard) */
  private async branchInScope(scope: ResolvedScope, branchId: number): Promise<boolean> {
    if (scope.all) return true;
    const params: unknown[] = [branchId];
    const w = this.resolver.buildScopeWhere(scope, { branch: 'e.id' }, params);
    const r = await this.db.one(`SELECT 1 AS ok FROM branch e WHERE e.id = $1::bigint AND ${w}`, params);
    return !!r;
  }

  /** Ensure a stock row exists for (item, branch, location); returns its id + current on-hand. */
  private async ensureStockTx(c: PoolClient, orgId: number, itemId: number, branchId: number, location: string, createdBy: number): Promise<{ id: number; qty: number; threshold: number }> {
    const found = await c.query<any>(
      `SELECT id, qty_on_hand, low_stock_threshold FROM inventory_stock
        WHERE item_id = $1::bigint AND branch_id = $2::bigint AND location = $3 AND deleted_at IS NULL`,
      [itemId, branchId, location]);
    if (found.rows.length) return { id: Number(found.rows[0].id), qty: Number(found.rows[0].qty_on_hand), threshold: Number(found.rows[0].low_stock_threshold) };
    const ins = await c.query<{ id: string }>(
      `INSERT INTO inventory_stock (org_id, item_id, branch_id, location, qty_on_hand, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4,0,$5::bigint) RETURNING id`,
      [orgId, itemId, branchId, location, createdBy]);
    return { id: Number(ins.rows[0].id), qty: 0, threshold: 0 };
  }

  /** Apply one movement inside a transaction (also used by procurement receive). */
  async applyMovementTx(c: PoolClient, args: {
    orgId: number; itemId: number; branchId: number; location: string;
    type: 'receipt' | 'issue' | 'adjustment'; delta: number; reason?: string | null;
    refType?: string | null; refId?: number | null; actorId: number;
  }): Promise<{ qty_after: number }> {
    const st = await this.ensureStockTx(c, args.orgId, args.itemId, args.branchId, args.location, args.actorId);
    const after = Number((st.qty + args.delta).toFixed(3));
    if (after < 0) throw new BadRequestException('This would take stock below zero — reduce the issued quantity.');
    await c.query(`UPDATE inventory_stock SET qty_on_hand = $2, updated_at = now() WHERE id = $1::bigint`, [st.id, after]);
    await c.query(
      `INSERT INTO inventory_movement (org_id, item_id, branch_id, location, movement_type, qty_delta, qty_after, reason, ref_type, ref_id, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11::bigint)`,
      [args.orgId, args.itemId, args.branchId, args.location, args.type, args.delta, after, args.reason ?? null, args.refType ?? null, args.refId ?? null, args.actorId]);
    return { qty_after: after };
  }

  /** Manual stock movement — receipt / issue / adjustment. */
  async adjust(dto: any, me: { id: number }, scope: ResolvedScope) {
    const itemId = Number(dto?.item_id);
    const branchId = Number(dto?.branch_id);
    if (!Number.isFinite(itemId) || itemId <= 0) throw new BadRequestException('Choose a catalog item.');
    if (!Number.isFinite(branchId) || branchId <= 0) throw new BadRequestException('Choose a branch.');
    const type = String(dto?.movement_type ?? '');
    if (!['receipt', 'issue', 'adjustment'].includes(type)) throw new BadRequestException('Movement type must be receipt, issue or adjustment.');
    const location = (dto?.location ? String(dto.location).trim() : 'Main').slice(0, 80) || 'Main';
    const orgId = await this.orgId();
    // scope: a scoped user can only move stock in a branch their scope allows.
    if (!(await this.branchInScope(scope, branchId))) throw new BadRequestException('That branch is outside your access.');
    const item = await this.db.one<any>(`SELECT id FROM catalog_item WHERE id = $1::bigint AND deleted_at IS NULL`, [itemId]);
    if (!item) throw new BadRequestException('Catalog item not found.');

    let delta: number;
    if (type === 'adjustment' && dto?.set_to !== undefined && dto?.set_to !== null && String(dto.set_to) !== '') {
      const target = Number(dto.set_to);
      if (!Number.isFinite(target) || target < 0) throw new BadRequestException('Set-to quantity must be zero or more.');
      const cur = await this.db.one<any>(`SELECT qty_on_hand FROM inventory_stock WHERE item_id=$1::bigint AND branch_id=$2::bigint AND location=$3 AND deleted_at IS NULL`, [itemId, branchId, location]);
      delta = Number((target - Number(cur?.qty_on_hand ?? 0)).toFixed(3));
    } else {
      const qty = Number(dto?.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Quantity must be greater than zero.');
      delta = type === 'issue' ? -qty : (type === 'adjustment' && dto?.direction === 'decrease' ? -qty : qty);
    }
    const out = await this.db.tx(async (c) =>
      this.applyMovementTx(c, { orgId, itemId, branchId, location, type: type as any, delta, reason: dto?.reason ?? null, actorId: me.id }));
    return { ok: true, qty_after: out.qty_after };
  }

  /** Set / clear the low-stock threshold on a stock row. */
  async setThreshold(id: number, dto: any, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STOCK_SCOPE_COLS, params);
    const row = await this.db.one<any>(`SELECT s.id FROM inventory_stock s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Stock record not found (or outside your access).');
    const th = Number(dto?.low_stock_threshold ?? 0);
    if (!Number.isFinite(th) || th < 0) throw new BadRequestException('Threshold must be zero or more.');
    await this.db.query(`UPDATE inventory_stock SET low_stock_threshold = $2, updated_at = now() WHERE id = $1::bigint`, [id, th]);
    return { id, low_stock_threshold: th };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STOCK_SCOPE_COLS, params);
    const row = await this.db.one<any>(`SELECT s.id FROM inventory_stock s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Stock record not found (or outside your access).');
    await this.db.query(`UPDATE inventory_stock SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, STOCK_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT s.id FROM inventory_stock s WHERE s.id = ANY($1::bigint[]) AND s.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'inventory', label: 'Stock record', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
