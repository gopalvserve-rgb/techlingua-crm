import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { InventoryService } from './inventory.service';
import { computeLine, computeTotals, rupeesToMinor } from '../common/money.util';
import { requireDateString } from '../common/date.util';
import { Letterhead, purchaseOrderPdf, PurchaseOrderDoc } from '../pdf/documents';
import { PdfAssetService } from '../storage/pdf-asset.service';

/**
 * PROCUREMENT — purchase orders to a vendor for catalog items. Branch-scoped (ScopeResolver).
 * PO number auto-minted (PO-) from the numbering series per branch/vertical. Lifecycle
 * draft → sent → received → closed (or cancelled). India GST: each line carries a GST% and the
 * PO tax = sum of line taxes, computed exactly like quotations (discount-before-tax, per line,
 * half-up — common/money.util.ts), ₹ integer paise throughout.
 *
 * RECEIVING a PO (procurement.receive) writes an inventory RECEIPT movement for every line that
 * points at a catalog item, incrementing on-hand at the PO's branch/location — atomically, in the
 * PO transaction (InventoryService.applyMovementTx). A branded PO PDF reuses the quotation/receipt
 * PDF pipeline.
 */
export const PO_SCOPE_COLS: ScopeColumnMap = { branch: 'po.branch_id', vertical: 'po.vertical_id' };

@Injectable()
export class ProcurementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly inventory: InventoryService,
    private readonly pdfAssets?: PdfAssetService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */
  async list(scope: ResolvedScope, q: { branch_id?: string; vendor_id?: string; status?: string; q?: string; from?: string; to?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`po.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, PO_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string, txt = false) => {
      const vals = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      if (txt) { params.push(vals); where.push(`${col} = ANY($${params.length}::text[])`); }
      else { const ids = vals.map(Number).filter((n) => Number.isFinite(n) && n > 0); if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`); }
    };
    multi('po.branch_id', q.branch_id);
    multi('po.vendor_id', q.vendor_id);
    multi('po.status', q.status, true);
    if (q.q) { params.push(`%${q.q}%`); where.push(`(po.po_no ILIKE $${params.length} OR ve.name ILIKE $${params.length})`); }
    if (q.from) { params.push(requireDateString(q.from, () => { throw new BadRequestException('Bad from date'); })); where.push(`po.order_date >= $${params.length}::date`); }
    if (q.to) { params.push(requireDateString(q.to, () => { throw new BadRequestException('Bad to date'); })); where.push(`po.order_date <= $${params.length}::date`); }
    params.push(Math.min(Number(q.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT po.id, po.po_no, po.vendor_id, po.branch_id, po.vertical_id, po.status,
              po.order_date, po.expected_date, po.total_minor, po.tax_minor, po.subtotal_minor,
              po.location, po.received_at, po.created_at,
              ve.name AS vendor_name, b.name AS branch_name, v.name AS vertical_name
         FROM purchase_order po
         JOIN vendor ve ON ve.id = po.vendor_id
         LEFT JOIN branch b ON b.id = po.branch_id
         LEFT JOIN vertical v ON v.id = po.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY po.created_at DESC, po.id DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, PO_SCOPE_COLS, params);
    const po = await this.db.one<any>(
      `SELECT po.*, ve.name AS vendor_name, ve.gstin AS vendor_gstin, ve.address AS vendor_address,
              ve.phone AS vendor_phone, ve.email AS vendor_email,
              b.name AS branch_name, v.name AS vertical_name, u.name AS created_by_name, ru.name AS received_by_name
         FROM purchase_order po
         JOIN vendor ve ON ve.id = po.vendor_id
         LEFT JOIN branch b ON b.id = po.branch_id
         LEFT JOIN vertical v ON v.id = po.vertical_id
         LEFT JOIN "user" u ON u.id = po.created_by
         LEFT JOIN "user" ru ON ru.id = po.received_by
        WHERE po.id = $1::bigint AND po.deleted_at IS NULL AND ${w}`, params);
    if (!po) throw new NotFoundException('Purchase order not found (or outside your access).');
    const items = await this.db.query<any>(
      `SELECT poi.*, ci.item_code, ci.name AS catalog_name FROM purchase_order_item poi
         LEFT JOIN catalog_item ci ON ci.id = poi.item_id
        WHERE poi.po_id = $1::bigint ORDER BY poi.line_no`, [id]);
    return { ...po, items };
  }

  /* --------------------------------------------------------------- compute */
  private buildLines(rawLines: any[]): Array<{ line_no: number; item_id: number | null; description: string; hsn_code: string | null; qty: number; unit: string | null; unit_price_minor: number; discount_type: string; discount_value: number; tax_pct: number; gross: number; discount: number; taxable: number; tax: number; total: number }> {
    const list = Array.isArray(rawLines) ? rawLines : [];
    if (!list.length) throw new BadRequestException('A purchase order needs at least one line item.');
    const out: any[] = [];
    let n = 1;
    for (const l of list) {
      const description = String(l?.description ?? '').trim();
      if (!description) throw new BadRequestException(`Line ${n}: description is required.`);
      const qty = Number(l?.qty ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) throw new BadRequestException(`Line ${n}: quantity must be greater than zero.`);
      const unit_price_minor = l?.unit_price_minor !== undefined ? Math.trunc(Number(l.unit_price_minor)) : rupeesToMinor(l?.unit_price ?? 0);
      const discount_type = l?.discount_type === 'percent' ? 'percent' : 'amount';
      const discount_value_raw = l?.discount_value ?? 0;
      const discount_value = discount_type === 'percent' ? Number(discount_value_raw || 0) : rupeesToMinor(discount_value_raw);
      const tax_pct = Number(l?.tax_pct ?? 0);
      if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) throw new BadRequestException(`Line ${n}: GST % must be between 0 and 100.`);
      const c = computeLine({ qty: Math.trunc(qty), unit_price_minor, discount_type: discount_type as any, discount_value, tax_pct });
      out.push({
        line_no: n, item_id: l?.item_id ? Number(l.item_id) : null, description, hsn_code: l?.hsn_code ? String(l.hsn_code).trim().slice(0, 12) : null,
        qty: Math.trunc(qty), unit: l?.unit ? String(l.unit).slice(0, 24) : null, unit_price_minor,
        discount_type, discount_value, tax_pct,
        gross: c.gross_minor, discount: c.discount_minor, taxable: c.taxable_minor, tax: c.tax_minor, total: c.total_minor,
      });
      n++;
    }
    return out;
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const vendorId = Number(dto?.vendor_id);
    const branchId = Number(dto?.branch_id);
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    if (!Number.isFinite(vendorId) || vendorId <= 0) throw new BadRequestException('Choose a vendor.');
    if (!Number.isFinite(branchId) || branchId <= 0) throw new BadRequestException('Choose a branch.');
    const vendor = await this.db.one<any>(`SELECT id FROM vendor WHERE id = $1::bigint AND deleted_at IS NULL`, [vendorId]);
    if (!vendor) throw new BadRequestException('Vendor not found.');
    if (verticalId) {
      const v = await this.db.one<any>(`SELECT id FROM vertical WHERE id = $1::bigint AND branch_id = $2::bigint AND deleted_at IS NULL`, [verticalId, branchId]);
      if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    }
    const lines = this.buildLines(dto?.items);
    const totals = computeTotals(lines.map((l) => ({ gross_minor: l.gross, discount_minor: l.discount, taxable_minor: l.taxable, tax_minor: l.tax, total_minor: l.total })));
    const orderDate = dto?.order_date ? requireDateString(dto.order_date, () => { throw new BadRequestException('Order date is not valid.'); }) : null;
    const expDate = dto?.expected_date ? requireDateString(dto.expected_date, () => { throw new BadRequestException('Expected date is not valid.'); }) : null;
    const location = (dto?.location ? String(dto.location).trim() : 'Main').slice(0, 80) || 'Main';
    const orgId = await this.orgId();

    return this.db.tx(async (c) => {
      const poNo = await this.numbering.allocate('po', { branch_id: branchId, vertical_id: verticalId }, c);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO purchase_order (org_id, po_no, vendor_id, branch_id, vertical_id, location, status,
                                     order_date, expected_date, notes, terms, subtotal_minor, discount_minor, tax_minor, total_minor, created_by)
         VALUES ($1::bigint,$2,$3::bigint,$4::bigint,$5::bigint,$6,$7,$8::date,$9::date,$10,$11,$12::bigint,$13::bigint,$14::bigint,$15::bigint,$16::bigint)
         RETURNING id`,
        [orgId, poNo, vendorId, branchId, verticalId, location, dto?.status === 'sent' ? 'sent' : 'draft',
          orderDate, expDate, dto?.notes ?? null, dto?.terms ?? null,
          totals.subtotal_minor, totals.discount_minor, totals.tax_minor, totals.total_minor, me.id]);
      const poId = Number(ins.rows[0].id);
      for (const l of lines) {
        await c.query(
          `INSERT INTO purchase_order_item (org_id, po_id, line_no, item_id, description, hsn_code, qty, unit,
                                            unit_price_minor, discount_type, discount_value, discount_minor, tax_pct,
                                            gross_minor, taxable_minor, tax_minor, total_minor)
           VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6,$7,$8,$9::bigint,$10,$11,$12::bigint,$13,$14::bigint,$15::bigint,$16::bigint,$17::bigint)`,
          [orgId, poId, l.line_no, l.item_id, l.description, l.hsn_code, l.qty, l.unit, l.unit_price_minor,
            l.discount_type, l.discount_value, l.discount, l.tax_pct, l.gross, l.taxable, l.tax, l.total]);
      }
      return { id: poId, po_no: poNo };
    });
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.status === 'received' || cur.status === 'closed') throw new BadRequestException('A received or closed PO cannot be edited.');
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (dto?.notes !== undefined) set('notes', dto.notes ?? null);
    if (dto?.terms !== undefined) set('terms', dto.terms ?? null);
    if (dto?.location !== undefined) set('location', (String(dto.location || 'Main').trim()).slice(0, 80) || 'Main');
    if (dto?.order_date !== undefined) set('order_date', dto.order_date ? requireDateString(dto.order_date, () => { throw new BadRequestException('Order date is not valid.'); }) : null);
    if (dto?.expected_date !== undefined) set('expected_date', dto.expected_date ? requireDateString(dto.expected_date, () => { throw new BadRequestException('Expected date is not valid.'); }) : null);

    let lines: ReturnType<ProcurementService['buildLines']> | null = null;
    if (dto?.items !== undefined) { lines = this.buildLines(dto.items); }

    await this.db.tx(async (c) => {
      if (lines) {
        const totals = computeTotals(lines.map((l) => ({ gross_minor: l.gross, discount_minor: l.discount, taxable_minor: l.taxable, tax_minor: l.tax, total_minor: l.total })));
        await c.query(`DELETE FROM purchase_order_item WHERE po_id = $1::bigint`, [id]);
        for (const l of lines) {
          await c.query(
            `INSERT INTO purchase_order_item (org_id, po_id, line_no, item_id, description, hsn_code, qty, unit,
                                              unit_price_minor, discount_type, discount_value, discount_minor, tax_pct,
                                              gross_minor, taxable_minor, tax_minor, total_minor)
             VALUES ($1::bigint,$2::bigint,$3,$4::bigint,$5,$6,$7,$8,$9::bigint,$10,$11,$12::bigint,$13,$14::bigint,$15::bigint,$16::bigint,$17::bigint)`,
            [cur.org_id, id, l.line_no, l.item_id, l.description, l.hsn_code, l.qty, l.unit, l.unit_price_minor,
              l.discount_type, l.discount_value, l.discount, l.tax_pct, l.gross, l.taxable, l.tax, l.total]);
        }
        set('subtotal_minor', totals.subtotal_minor); set('discount_minor', totals.discount_minor);
        set('tax_minor', totals.tax_minor); set('total_minor', totals.total_minor);
      }
      if (sets.length) { params.push(id); await c.query(`UPDATE purchase_order SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params); }
    });
    return { id };
  }

  /** Move status draft↔sent, or →closed / →cancelled (receive is a separate action). */
  async setStatus(id: number, status: string, _me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const allowed: Record<string, string[]> = {
      draft: ['sent', 'cancelled'], sent: ['draft', 'cancelled', 'closed'],
      received: ['closed'], closed: [], cancelled: [],
    };
    if (!['sent', 'draft', 'closed', 'cancelled'].includes(status)) throw new BadRequestException('Invalid status.');
    if (!(allowed[cur.status] ?? []).includes(status)) throw new BadRequestException(`Cannot move a ${cur.status} PO to ${status}.`);
    await this.db.query(`UPDATE purchase_order SET status = $2, updated_at = now() WHERE id = $1::bigint`, [id, status]);
    return { id, status };
  }

  /** RECEIVE the PO — write inventory receipts for catalog lines, increment on-hand, mark received. */
  async receive(id: number, _dto: any, me: { id: number }, scope: ResolvedScope) {
    const po = await this.get(id, scope);
    if (po.status === 'received' || po.status === 'closed') throw new BadRequestException('This PO has already been received.');
    if (po.status === 'cancelled') throw new BadRequestException('A cancelled PO cannot be received.');
    const orgId = Number(po.org_id);
    const branchId = Number(po.branch_id);
    const location = po.location || 'Main';
    const received = await this.db.tx(async (c) => {
      let count = 0;
      for (const it of po.items) {
        await c.query(`UPDATE purchase_order_item SET received_qty = qty WHERE id = $1::bigint`, [it.id]);
        if (it.item_id) {
          await this.inventory.applyMovementTx(c, {
            orgId, itemId: Number(it.item_id), branchId, location,
            type: 'receipt', delta: Number(it.qty), reason: `PO ${po.po_no} received`,
            refType: 'po', refId: id, actorId: me.id,
          });
          count++;
        }
      }
      await c.query(`UPDATE purchase_order SET status = 'received', received_at = now(), received_by = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [id, me.id]);
      return count;
    });
    return { id, status: 'received', items_stocked: received };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE purchase_order SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ------------------------------------------------------------------ PDF */
  private letterheadOf(po: any): Letterhead {
    return {
      org_name: po.org_name || 'Tech Lingua', org_gst: po.org_gst ?? null,
      vertical_name: po.vertical_name, branch_name: po.branch_name,
      branch_address: po.branch_address, branch_phone: po.branch_phone, branch_email: po.branch_email,
    };
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const po = await this.get(id, scope);
    const lh = await this.db.one<any>(
      `SELECT o.name AS org_name, o.gst_no AS org_gst, b.name AS branch_name, b.address AS branch_address,
              b.contact_number AS branch_phone, b.email AS branch_email, v.name AS vertical_name
         FROM purchase_order po
         JOIN organisation o ON o.id = po.org_id
         LEFT JOIN branch b ON b.id = po.branch_id
         LEFT JOIN vertical v ON v.id = po.vertical_id
        WHERE po.id = $1::bigint`, [id]);
    const doc: PurchaseOrderDoc = {
      po_no: po.po_no, status: po.status, order_date: po.order_date, expected_date: po.expected_date,
      vendor_name: po.vendor_name, vendor_gstin: po.vendor_gstin, vendor_address: po.vendor_address,
      vendor_phone: po.vendor_phone, vendor_email: po.vendor_email,
      branch_name: po.branch_name, notes: po.notes, terms: po.terms,
      subtotal_minor: Number(po.subtotal_minor), discount_minor: Number(po.discount_minor),
      tax_minor: Number(po.tax_minor), total_minor: Number(po.total_minor),
      items: po.items.map((it: any) => ({
        line_no: it.line_no, description: it.description, hsn_code: it.hsn_code, qty: Number(it.qty),
        unit_price_minor: Number(it.unit_price_minor), discount_type: it.discount_type, discount_value: it.discount_value,
        discount_minor: Number(it.discount_minor), tax_pct: it.tax_pct, tax_minor: Number(it.tax_minor), total_minor: Number(it.total_minor),
      })),
    };
    const out = { buffer: purchaseOrderPdf(doc, this.letterheadOf(lh ?? {})), filename: `${String(po.po_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
    await this.pdfAssets?.persist('purchase_order', id, po.po_no ? String(po.po_no) : null, out.buffer);
    return out;
  }

  /* --------------------------------------------------------------- bulk */
  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, PO_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT po.id FROM purchase_order po WHERE po.id = ANY($1::bigint[]) AND po.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'procurement', label: 'Purchase order', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
