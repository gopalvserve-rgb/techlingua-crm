import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { FinanceSettingsService } from '../finance/finance-settings.service';
import { rupeesToMinor, amountInWordsINR, formatINR } from '../common/money.util';
import { computeGstLine, computeGstTotals, supplyTypeFor, GstLineComputed } from './gst.util';
import { Letterhead, invoicePdf } from '../pdf/documents';
import { assertDateRange } from '../common/date.util';
import { NotificationEventService } from '../notificationevents/notification-event.service';

/**
 * GST TAX INVOICES — Finance & Collections › Invoices (Phase 3 Batch 1).
 *
 * A proper India tax invoice raised against an enrolment/fee (or ad-hoc): seller GSTIN
 * + state, buyer GSTIN + place of supply, HSN/SAC lines, CGST+SGST (intra-state) or IGST
 * (inter-state), round-off, grand total, amount in words, branded PDF. Money is integer
 * paise via common/money.util; the CGST/SGST/IGST split is invoices/gst.util (pure,
 * unit-tested). The CLIENT NEVER POSTS A TOTAL — totals are always re-derived here.
 *
 * NUMBERING is allocated on ISSUE, not on create, so a deleted DRAFT never burns a GST
 * serial (auditors ask about gaps). The 'invoice' number_series resets per Indian FY.
 *
 * A snapshot (seller + buyer identity, state codes) is frozen on the row: a tax invoice
 * is a legal document and must not change if the branch later edits its GSTIN.
 */

export const INVOICE_SCOPE_COLS: ScopeColumnMap = {
  owner: 'gi.counsellor_id', team: 'gi.team_id', branch: 'gi.branch_id',
  vertical: 'gi.vertical_id', pipeline: 'gi.pipeline_id', campaign: 'gi.campaign_id',
};

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'cancelled';

interface NormItem {
  course_id: number | null; description: string; hsn_sac: string | null;
  qty: number; unit_price_minor: number; discount_type: 'amount' | 'percent';
  discount_value: number; gst_pct: number; computed: GstLineComputed;
}

@Injectable()
export class InvoiceService {
  private readonly log = new Logger('Invoices');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly finance?: FinanceSettingsService,
    /** Notification Events — fires fee_invoice_generated when a GST invoice is issued. Optional. */
    private readonly notifEvents?: NotificationEventService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* --------------------------------------------------------------- normalise */

  /** Turn UI/machine items into exact integer GST lines for a given supply type. */
  normaliseItems(raw: unknown, supply: 'intra' | 'inter'): NormItem[] {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) throw new BadRequestException('An invoice needs at least one line item.');
    if (list.length > 50) throw new BadRequestException('An invoice is limited to 50 line items.');
    return list.map((r: any, i) => {
      const n = i + 1;
      const description = String(r?.description ?? '').trim();
      if (!description) throw new BadRequestException(`Line ${n}: a description is required.`);
      const qty = Number(r?.qty ?? 1);
      if (!Number.isInteger(qty) || qty < 1) throw new BadRequestException(`Line ${n}: quantity must be a whole number of 1 or more.`);

      let unit_price_minor: number;
      try {
        unit_price_minor = r?.unit_price_minor !== undefined && r?.unit_price_minor !== null
          ? Math.trunc(Number(r.unit_price_minor)) : rupeesToMinor(r?.unit_price);
      } catch (e) { throw new BadRequestException(`Line ${n}: ${(e as Error).message}`); }
      if (!Number.isFinite(unit_price_minor) || unit_price_minor < 0) throw new BadRequestException(`Line ${n}: the rate cannot be negative.`);

      const discount_type = String(r?.discount_type ?? 'amount') as 'amount' | 'percent';
      if (!['amount', 'percent'].includes(discount_type)) throw new BadRequestException(`Line ${n}: a discount is an amount or a percent.`);
      let discount_value: number;
      try {
        discount_value = discount_type === 'percent'
          ? Number(String(r?.discount_value ?? 0).trim() || 0) : rupeesToMinor(r?.discount_value);
      } catch (e) { throw new BadRequestException(`Line ${n}: ${(e as Error).message}`); }
      if (!Number.isFinite(discount_value) || discount_value < 0) throw new BadRequestException(`Line ${n}: a discount cannot be negative.`);
      if (discount_type === 'percent' && discount_value > 100) throw new BadRequestException(`Line ${n}: a percentage discount cannot exceed 100%.`);

      const gst_pct = Number(String(r?.gst_pct ?? 0).trim() || 0);
      if (!Number.isFinite(gst_pct) || gst_pct < 0 || gst_pct > 100) throw new BadRequestException(`Line ${n}: GST must be between 0 and 100%.`);

      const computed = computeGstLine({ qty, unit_price_minor, discount_type, discount_value, gst_pct }, supply);
      return {
        course_id: r?.course_id ? Number(r.course_id) : null,
        description: description.slice(0, 240),
        hsn_sac: r?.hsn_sac ? String(r.hsn_sac).trim().slice(0, 8) : null,
        qty, unit_price_minor, discount_type, discount_value, gst_pct, computed,
      };
    });
  }

  /* -------------------------------------------------------------------- reads */

  async list(scope: ResolvedScope, f: {
    status?: string; statuses?: string[]; supply_type?: string;
    branch_ids?: number[]; vertical_ids?: number[];
    enrolment_id?: number; q?: string; from?: string; to?: string; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const where = [`gi.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, INVOICE_SCOPE_COLS, params)];
    const statuses = [...(f.statuses ?? []), ...(f.status ? [f.status] : [])].filter(Boolean);
    if (statuses.length) { params.push(statuses); where.push(`gi.status = ANY($${params.length}::varchar[])`); }
    if (f.supply_type) { params.push(f.supply_type); where.push(`gi.supply_type = $${params.length}::varchar`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`gi.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`gi.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.enrolment_id) { params.push(Number(f.enrolment_id)); where.push(`gi.enrolment_id = $${params.length}::bigint`); }
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`gi.invoice_date >= $${params.length}::date`); }
    if (_dr.to) { params.push(_dr.to); where.push(`gi.invoice_date <= $${params.length}::date`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(gi.invoice_no ILIKE $${params.length} OR gi.buyer_name ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT gi.id, gi.invoice_no, gi.invoice_date, gi.status, gi.supply_type,
              gi.buyer_name, gi.buyer_gstin, gi.enrolment_id, e.enrolment_no,
              gi.taxable_minor, gi.cgst_minor, gi.sgst_minor, gi.igst_minor, gi.total_minor,
              gi.pos_state_name, gi.created_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name,
              u.name AS counsellor_name,
              (SELECT count(*) FROM gst_invoice_item ii WHERE ii.invoice_id = gi.id) AS item_count
         FROM gst_invoice gi
         JOIN branch b ON b.id = gi.branch_id
         JOIN vertical v ON v.id = gi.vertical_id
         LEFT JOIN enrolment e ON e.id = gi.enrolment_id
         LEFT JOIN m_course c ON c.id = (SELECT ii.course_id FROM gst_invoice_item ii WHERE ii.invoice_id = gi.id AND ii.course_id IS NOT NULL LIMIT 1)
         LEFT JOIN "user" u ON u.id = gi.counsellor_id
        WHERE ${where.join(' AND ')}
        ORDER BY gi.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, INVOICE_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE gi.status = 'draft')     AS draft,
              count(*) FILTER (WHERE gi.status = 'issued')    AS issued,
              count(*) FILTER (WHERE gi.status = 'paid')      AS paid,
              count(*) FILTER (WHERE gi.status = 'cancelled') AS cancelled,
              COALESCE(sum(gi.total_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS invoiced_minor,
              COALESCE(sum(gi.cgst_minor + gi.sgst_minor + gi.igst_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS gst_minor
         FROM gst_invoice gi
        WHERE gi.deleted_at IS NULL AND ${w}`,
      params,
    );
    const num = (v: unknown) => Number(v ?? 0);
    return {
      draft: num(r?.draft), issued: num(r?.issued), paid: num(r?.paid), cancelled: num(r?.cancelled),
      invoiced_minor: num(r?.invoiced_minor), gst_minor: num(r?.gst_minor),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, INVOICE_SCOPE_COLS, params);
    const gi = await this.db.one<any>(
      `SELECT gi.*, e.enrolment_no,
              b.name AS branch_name, b.address AS branch_address, b.contact_number AS branch_phone,
              b.email AS branch_email,
              v.name AS vertical_name, o.name AS org_name
         FROM gst_invoice gi
         JOIN branch b ON b.id = gi.branch_id
         JOIN vertical v ON v.id = gi.vertical_id
         JOIN organisation o ON o.id = gi.org_id
         LEFT JOIN enrolment e ON e.id = gi.enrolment_id
        WHERE gi.id = $1::bigint AND gi.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!gi) throw new NotFoundException('Invoice not found');
    const items = await this.db.query<any>(
      `SELECT ii.*, c.name AS course_name FROM gst_invoice_item ii
         LEFT JOIN m_course c ON c.id = ii.course_id
        WHERE ii.invoice_id = $1::bigint ORDER BY ii.line_no`,
      [id],
    );
    return { ...gi, items };
  }

  letterheadOf(gi: any): Letterhead {
    return {
      org_name: gi.org_name, org_gst: gi.seller_gstin,
      vertical_name: gi.vertical_name, branch_name: gi.branch_name,
      branch_address: gi.seller_address ?? gi.branch_address,
      branch_phone: gi.branch_phone, branch_email: gi.branch_email,
    };
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const gi = await this.get(id, scope);
    return {
      buffer: invoicePdf(gi as any, this.letterheadOf(gi)),
      filename: `${String(gi.invoice_no || 'invoice-draft').replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`,
    };
  }

  /* ------------------------------------------------------------------- writes */

  /** CREATE a DRAFT — from an enrolment (path/seller/buyer derived server-side) or ad-hoc. */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const orgId = await this.orgId();
    let ctx: any;

    if (dto?.enrolment_id) {
      ctx = await this.enrolmentContext(Number(dto.enrolment_id), scope);
    } else {
      // ad-hoc: caller supplies branch + vertical (must be in scope) + buyer
      const branchId = Number(dto?.branch_id);
      const verticalId = Number(dto?.vertical_id);
      if (!branchId || !verticalId) throw new BadRequestException('Choose the enrolment, or a branch & vertical for an ad-hoc invoice.');
      ctx = await this.branchContext(branchId, verticalId, scope);
    }

    // buyer (dto overrides derived)
    const buyer = {
      name: String(dto?.buyer_name ?? ctx.buyer_name ?? '').trim(),
      gstin: dto?.buyer_gstin ? String(dto.buyer_gstin).trim().toUpperCase().slice(0, 15) : null,
      address: dto?.buyer_address ? String(dto.buyer_address).trim() : (ctx.buyer_address ?? null),
      email: dto?.buyer_email ? String(dto.buyer_email).trim() : (ctx.buyer_email ?? null),
      phone: dto?.buyer_phone ? String(dto.buyer_phone).trim() : (ctx.buyer_phone ?? null),
    };
    if (!buyer.name) throw new BadRequestException('The buyer name is required.');

    // place of supply: dto override, else buyer/enrolment state, else the seller state (intra)
    const posStateId = dto?.pos_state_id ? Number(dto.pos_state_id)
      : (ctx.buyer_state_id ?? ctx.seller_state_id ?? null);
    const pos = await this.stateOf(posStateId);
    const seller = { state_id: ctx.seller_state_id, ...(await this.stateOf(ctx.seller_state_id, 'seller')) };
    const supply = supplyTypeFor(ctx.seller_state_id, posStateId);

    // items: dto.items, else a single line from the enrolment's net fee
    const rawItems = Array.isArray(dto?.items) && dto.items.length
      ? dto.items
      : ctx.defaultItems;
    if (!rawItems || !rawItems.length) throw new BadRequestException('An invoice needs at least one line item.');
    const items = this.normaliseItems(rawItems, supply);

    if (this.finance) {
      const guard = await this.finance.guardFor(Number(ctx.vertical_id), me.id);
      items.forEach((it, i) => guard.enforce('discount', it.computed.gross_minor, it.computed.discount_minor, `Line ${i + 1}`));
    }
    const totals = computeGstTotals(items.map((i) => i.computed));
    const words = amountInWordsINR(totals.total_minor);

    return this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO gst_invoice (
            org_id, status, enrolment_id, quotation_id, lead_id, student_id,
            branch_id, vertical_id, pipeline_id, campaign_id, counsellor_id, team_id,
            seller_legal_name, seller_gstin, seller_pan, seller_address, seller_state_id, seller_state_name, seller_state_code,
            buyer_name, buyer_gstin, buyer_address, buyer_email, buyer_phone, pos_state_id, pos_state_name, pos_state_code,
            supply_type, taxable_minor, discount_minor, cgst_minor, sgst_minor, igst_minor,
            round_off_minor, total_minor, amount_in_words, notes, terms, created_by)
         VALUES ($1,'draft',$2,$3,$4,$5, $6,$7,$8,$9,$10,$11,
                 $12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,
                 $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
         RETURNING id`,
        [orgId, ctx.enrolment_id ?? null, ctx.quotation_id ?? null, ctx.lead_id ?? null, ctx.student_id ?? null,
          ctx.branch_id, ctx.vertical_id, ctx.pipeline_id ?? null, ctx.campaign_id ?? null, ctx.counsellor_id ?? me.id, ctx.team_id ?? null,
          ctx.seller_legal_name ?? '', ctx.seller_gstin ?? null, ctx.seller_pan ?? null,
          ctx.seller_address ?? null, ctx.seller_state_id ?? null, seller.name ?? null, seller.code ?? null,
          buyer.name, buyer.gstin, buyer.address, buyer.email, buyer.phone, posStateId, pos.name ?? null, pos.code ?? null,
          supply, totals.taxable_minor, totals.discount_minor, totals.cgst_minor, totals.sgst_minor, totals.igst_minor,
          totals.round_off_minor, totals.total_minor, words, dto?.notes ?? null, dto?.terms ?? null, me.id],
      );
      const invId = Number(r.rows[0].id);
      await this.insertItems(c, invId, items);
      return { id: invId, status: 'draft', supply_type: supply };
    });
  }

  /** ISSUE — allocate the FY-aware invoice number and freeze the document. */
  async issue(id: number, me: { id: number }, scope: ResolvedScope) {
    const gi = await this.get(id, scope);
    if (gi.status !== 'draft') throw new BadRequestException(`${gi.invoice_no || 'This invoice'} is already ${gi.status}.`);
    if (!gi.seller_gstin) throw new BadRequestException('Set the branch GSTIN before issuing a tax invoice (Administration › Branches › Edit).');
    const out = await this.db.tx(async (c) => {
      const invoiceNo = await this.numbering.allocate('invoice', { branch_id: Number(gi.branch_id), vertical_id: Number(gi.vertical_id) }, c);
      await c.query(
        `UPDATE gst_invoice SET invoice_no = $2::varchar, status = 'issued', invoice_date = CURRENT_DATE,
                                issued_at = now(), issued_by = $3::bigint, updated_at = now()
          WHERE id = $1::bigint`,
        [id, invoiceNo, me.id],
      );
      return { id, invoice_no: invoiceNo, status: 'issued' };
    });
    // Notification Events — a GST tax invoice was issued to the buyer (student/lead). Best-effort.
    await this.notifEvents?.safeFire('fee_invoice_generated', {
      student_id: gi.student_id ? Number(gi.student_id) : null,
      lead_id: gi.lead_id ? Number(gi.lead_id) : null,
      vertical_id: Number(gi.vertical_id),
      dedupe: `inv:${id}`,
      vars: { invoice_no: out.invoice_no, amount: formatINR(Number(gi.total_minor)), enrolment_no: gi.enrolment_no ?? null },
    });
    return out;
  }

  async markPaid(id: number, me: { id: number }, scope: ResolvedScope) {
    const gi = await this.get(id, scope);
    if (gi.status !== 'issued') throw new BadRequestException(`Only an issued invoice can be marked paid. ${gi.invoice_no || 'This invoice'} is ${gi.status}.`);
    await this.db.query(`UPDATE gst_invoice SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1::bigint`, [id]);
    return { id, status: 'paid' };
  }

  async cancel(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const gi = await this.get(id, scope);
    if (!['issued', 'paid'].includes(gi.status)) throw new BadRequestException(`Only an issued or paid invoice is cancelled. ${gi.invoice_no || 'This invoice'} is ${gi.status} — delete the draft instead.`);
    await this.db.query(
      `UPDATE gst_invoice SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2::bigint,
                              cancel_reason = $3, updated_at = now() WHERE id = $1::bigint`,
      [id, me.id, dto?.reason ? String(dto.reason).slice(0, 500) : null],
    );
    return { id, status: 'cancelled' };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const gi = await this.get(id, scope);
    if (['issued', 'paid'].includes(gi.status)) {
      throw new BadRequestException(`${gi.invoice_no} has been issued — a GST tax invoice cannot be deleted. Cancel it instead.`);
    }
    await this.db.query(`UPDATE gst_invoice SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  /* ---- bulk delete (drafts / cancelled only; issued & paid refuse) ---- */

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { total: 0, deletable: 0, blocked: 0 };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, INVOICE_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE gi.status IN ('draft','cancelled')) AS deletable,
              count(*) FILTER (WHERE gi.status IN ('issued','paid')) AS blocked
         FROM gst_invoice gi
        WHERE gi.id = ANY($1::bigint[]) AND gi.deleted_at IS NULL AND ${w}`,
      params,
    );
    return { total: Number(r?.total ?? 0), deletable: Number(r?.deletable ?? 0), blocked: Number(r?.blocked ?? 0),
      note: 'Issued or paid tax invoices cannot be deleted — cancel them instead.' };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deleted: 0 };
    const params: unknown[] = [clean, me.id];
    const w = this.resolver.buildScopeWhere(scope, INVOICE_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE gst_invoice gi SET deleted_at = now(), deleted_by = $2::bigint
        WHERE gi.id = ANY($1::bigint[]) AND gi.deleted_at IS NULL
          AND gi.status IN ('draft','cancelled') AND ${w}
        RETURNING gi.id`,
      params,
    );
    return { deleted: rows.length };
  }

  /* --------------------------------------------------------------- contexts */

  private async enrolmentContext(enrolmentId: number, scope: ResolvedScope) {
    const params: unknown[] = [enrolmentId];
    const ew = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, params);
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.quotation_id, e.lead_id, e.student_profile_id, e.course_id,
              e.branch_id, e.vertical_id, e.pipeline_id, e.campaign_id, e.counsellor_id, e.team_id,
              e.fee_minor, e.discount_minor, e.net_fee_minor,
              l.full_name AS lead_name, l.phone AS lead_phone, l.email AS lead_email, l.state_id AS lead_state_id,
              c.name AS course_name,
              b.legal_name AS seller_legal_name, b.gstin AS seller_gstin, b.pan AS seller_pan,
              b.name AS branch_name, b.address AS seller_address, b.state_id AS seller_state_id
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         LEFT JOIN m_course c ON c.id = e.course_id
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${ew}`,
      params,
    );
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');
    return {
      enrolment_id: Number(e.id), quotation_id: e.quotation_id, lead_id: e.lead_id, student_id: e.student_profile_id,
      branch_id: Number(e.branch_id), vertical_id: Number(e.vertical_id), pipeline_id: e.pipeline_id,
      campaign_id: e.campaign_id, counsellor_id: e.counsellor_id, team_id: e.team_id,
      seller_legal_name: e.seller_legal_name, seller_gstin: e.seller_gstin, seller_pan: e.seller_pan,
      seller_address: e.seller_address, seller_state_id: e.seller_state_id != null ? Number(e.seller_state_id) : null,
      buyer_name: e.lead_name, buyer_email: e.lead_email, buyer_phone: e.lead_phone,
      buyer_address: null, buyer_state_id: e.lead_state_id != null ? Number(e.lead_state_id) : null,
      defaultItems: [{
        course_id: e.course_id ?? null,
        description: e.course_name ? `${e.course_name} — course fee` : 'Course fee',
        qty: 1,
        // the enrolment's NET fee (fee - discount) is the taxable value; GST is added ON TOP.
        unit_price_minor: Number(e.net_fee_minor),
        discount_type: 'amount', discount_value: 0,
        gst_pct: 18,
      }],
    };
  }

  private async branchContext(branchId: number, verticalId: number, scope: ResolvedScope) {
    const params: unknown[] = [branchId, verticalId];
    const bw = this.resolver.buildScopeWhere(scope, { branch: 'b.id', vertical: 'v.id' }, params);
    const b = await this.db.one<any>(
      `SELECT b.id AS branch_id, v.id AS vertical_id,
              b.legal_name AS seller_legal_name, b.gstin AS seller_gstin, b.pan AS seller_pan,
              b.address AS seller_address, b.state_id AS seller_state_id
         FROM branch b JOIN vertical v ON v.branch_id = b.id
        WHERE b.id = $1::bigint AND v.id = $2::bigint AND b.deleted_at IS NULL AND ${bw}`,
      params,
    );
    if (!b) throw new NotFoundException('Branch / vertical not found (or outside your access)');
    return {
      enrolment_id: null, quotation_id: null, lead_id: null, student_id: null,
      branch_id: Number(b.branch_id), vertical_id: Number(b.vertical_id),
      pipeline_id: null, campaign_id: null, counsellor_id: null, team_id: null,
      seller_legal_name: b.seller_legal_name, seller_gstin: b.seller_gstin, seller_pan: b.seller_pan,
      seller_address: b.seller_address, seller_state_id: b.seller_state_id != null ? Number(b.seller_state_id) : null,
      buyer_name: null, buyer_email: null, buyer_phone: null, buyer_address: null, buyer_state_id: null,
      defaultItems: [],
    };
  }

  private async stateOf(stateId: number | null, _who = 'pos'): Promise<{ name: string | null; code: string | null }> {
    if (!stateId) return { name: null, code: null };
    const r = await this.db.one<any>(`SELECT name, code FROM state WHERE id = $1::bigint`, [stateId]);
    return { name: r?.name ?? null, code: r?.code ?? null };
  }

  private async insertItems(c: PoolClient, invoiceId: number, items: NormItem[]) {
    let n = 0;
    for (const i of items) {
      n += 1;
      await c.query(
        `INSERT INTO gst_invoice_item (invoice_id, line_no, course_id, description, hsn_sac, qty,
                                       unit_price_minor, discount_type, discount_value, gst_pct,
                                       gross_minor, discount_minor, taxable_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
         VALUES ($1::bigint,$2::int,$3::bigint,$4::varchar,$5,$6::int,$7::bigint,$8::varchar,$9::numeric,$10::numeric,
                 $11::bigint,$12::bigint,$13::bigint,$14::bigint,$15::bigint,$16::bigint,$17::bigint)`,
        [invoiceId, n, i.course_id, i.description, i.hsn_sac, i.qty, i.unit_price_minor,
          i.discount_type, i.discount_value, i.gst_pct,
          i.computed.gross_minor, i.computed.discount_minor, i.computed.taxable_minor,
          i.computed.cgst_minor, i.computed.sgst_minor, i.computed.igst_minor, i.computed.total_minor],
      );
    }
  }
}
