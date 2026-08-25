import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NumberingService } from '../numbering/numbering.service';
import { assertDateRange } from '../common/date.util';
import { rupeesToMinor } from '../common/money.util';
import { FranchiseService } from './franchise.service';
import { ageingBuckets, royaltyAgeBucket, invoiceOutstanding, isFullyPaid } from './franchise-ops.util';
import { RoyaltyService } from './royalty.service';

/**
 * ROYALTY INVOICING, COLLECTION & OUTSTANDING (Phase 4 Batch 2).
 *
 *  · A royalty INVOICE bills a franchise for a period. It is generated FROM the royalty
 *    statement (reuses RoyaltyService.statement -> computeRoyalty), freezing that
 *    period's revenue + royalty + adjustments into amount_minor (payable). It carries
 *    its own numbering series (ROY-<FY>/####), like the GST invoice series.
 *  · PAYMENTS (royalty_payment) collect against an invoice; outstanding = amount - Σ
 *    paid, and the invoice flips to 'paid' once fully collected — the same pattern as
 *    fee_receipt vs a payment plan.
 *  · OUTSTANDING is an AGEING view (current / 30 / 60 / 90+), anchored on the invoice
 *    issue_date in IST, mirroring the Phase-3 fee-dues ageing.
 *  · REPORTS roll every franchise up (branches, students/enrolments, revenue, royalty
 *    billed vs paid vs outstanding) for an on-screen table + CSV export.
 */

const MODES = ['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'adjustment', 'other'];

@Injectable()
export class RoyaltyInvoiceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly numbering: NumberingService,
    private readonly franchises: FranchiseService,
    private readonly royalty: RoyaltyService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private mapInvoice = (r: any) => ({
    id: Number(r.id),
    franchise_id: Number(r.franchise_id),
    franchise_name: r.franchise_name ?? null,
    plan_id: r.plan_id === null || r.plan_id === undefined ? null : Number(r.plan_id),
    plan_name: r.plan_name ?? null,
    plan_model: r.plan_model ?? null,
    rate_pct: r.rate_pct === null || r.rate_pct === undefined ? null : Number(r.rate_pct),
    invoice_no: r.invoice_no,
    status: r.status,
    issue_date: r.issue_date,
    period_from: r.period_from,
    period_to: r.period_to,
    months: Number(r.months ?? 1),
    gross_collected_minor: Number(r.gross_collected_minor ?? 0),
    refunds_minor: Number(r.refunds_minor ?? 0),
    net_collected_minor: Number(r.net_collected_minor ?? 0),
    royalty_minor: Number(r.royalty_minor ?? 0),
    adjustments_minor: Number(r.adjustments_minor ?? 0),
    amount_minor: Number(r.amount_minor ?? 0),
    paid_minor: Number(r.paid_minor ?? 0),
    outstanding_minor: invoiceOutstanding(Number(r.amount_minor ?? 0), Number(r.paid_minor ?? 0)),
    note: r.note ?? null,
    created_at: r.created_at,
  });

  /** List invoices (with Σ payments joined), optionally filtered by franchise + status. */
  async list(franchiseId?: number, status?: string) {
    const params: unknown[] = [];
    let clause = 'ri.deleted_at IS NULL';
    if (franchiseId) { params.push(franchiseId); clause += ` AND ri.franchise_id = $${params.length}::bigint`; }
    if (status && ['draft', 'issued', 'paid', 'cancelled'].includes(status)) {
      params.push(status); clause += ` AND ri.status = $${params.length}`;
    }
    const rows = await this.db.query<any>(
      `SELECT ri.*, f.name AS franchise_name,
              COALESCE((SELECT sum(rp.amount_minor) FROM royalty_payment rp
                          WHERE rp.invoice_id = ri.id AND rp.deleted_at IS NULL), 0) AS paid_minor
         FROM royalty_invoice ri JOIN franchise f ON f.id = ri.franchise_id
        WHERE ${clause}
        ORDER BY ri.issue_date DESC, ri.id DESC`, params);
    return rows.map(this.mapInvoice);
  }

  async get(id: number) {
    const r = await this.db.one<any>(
      `SELECT ri.*, f.name AS franchise_name, f.code AS franchise_code,
              COALESCE((SELECT sum(rp.amount_minor) FROM royalty_payment rp
                          WHERE rp.invoice_id = ri.id AND rp.deleted_at IS NULL), 0) AS paid_minor
         FROM royalty_invoice ri JOIN franchise f ON f.id = ri.franchise_id
        WHERE ri.id = $1::bigint AND ri.deleted_at IS NULL`, [id]);
    if (!r) throw new NotFoundException('Royalty invoice not found');
    const payments = await this.db.query<any>(
      `SELECT rp.id, rp.amount_minor, rp.paid_on, rp.mode, rp.reference, rp.note, rp.created_at,
              u.name AS by_name
         FROM royalty_payment rp LEFT JOIN "user" u ON u.id = rp.created_by
        WHERE rp.invoice_id = $1::bigint AND rp.deleted_at IS NULL
        ORDER BY rp.paid_on, rp.id`, [id]);
    return {
      ...this.mapInvoice(r),
      franchise_code: r.franchise_code,
      payments: payments.map((p) => ({
        id: Number(p.id), amount_minor: Number(p.amount_minor), paid_on: p.paid_on,
        mode: p.mode, reference: p.reference, note: p.note, by_name: p.by_name ?? null, created_at: p.created_at,
      })),
    };
  }

  /** Generate a royalty invoice for a franchise + period FROM its royalty statement. */
  async createFromStatement(dto: any, me: { id: number }) {
    const franchiseId = Number(dto?.franchise_id);
    if (!Number.isInteger(franchiseId) || franchiseId <= 0) throw new BadRequestException('Choose a franchise.');
    const dr = assertDateRange(dto?.from, dto?.to);
    const adjustments = dto?.adjustments_minor !== undefined && dto?.adjustments_minor !== null && dto?.adjustments_minor !== ''
      ? Math.trunc(Number(dto.adjustments_minor)) : rupeesToMinor(dto?.adjustments ?? 0);
    const planId = dto?.plan_id ? Number(dto.plan_id) : undefined;
    const issued = dto?.issue !== false; // default: issue immediately; pass issue:false for a draft

    const stmt = await this.royalty.statement(franchiseId, {
      from: dr.from ?? undefined, to: dr.to ?? undefined, plan_id: planId, adjustments_minor: adjustments,
    });
    const payable = Math.max(0, Number(stmt.payable_minor) || 0);
    const orgId = await this.orgId();

    return this.db.tx(async (c) => {
      const invoiceNo = await this.numbering.allocate('royalty_invoice', {}, c);
      const ins = await c.query(
        `INSERT INTO royalty_invoice
            (org_id, franchise_id, plan_id, invoice_no, status, period_from, period_to, months,
             gross_collected_minor, refunds_minor, net_collected_minor, royalty_minor,
             adjustments_minor, amount_minor, plan_name, plan_model, rate_pct, note, created_by)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4,$5,$6::date,$7::date,$8::int,
                 $9::bigint,$10::bigint,$11::bigint,$12::bigint,$13::bigint,$14::bigint,$15,$16,$17,$18,$19::bigint)
         RETURNING id`,
        [orgId, franchiseId, stmt.plan ? stmt.plan.id : null, invoiceNo, issued ? 'issued' : 'draft',
          dr.from, dr.to, stmt.period.months,
          stmt.revenue.gross_collected_minor, stmt.revenue.refunds_minor, stmt.revenue.net_collected_minor,
          Number(stmt.royalty_minor) || 0, adjustments, payable,
          stmt.plan ? stmt.plan.name : null, stmt.plan ? stmt.plan.model : null,
          stmt.computation && stmt.computation.rate_pct != null ? stmt.computation.rate_pct : null,
          dto?.note ?? null, me.id]);
      return { id: Number(ins.rows[0].id), invoice_no: invoiceNo };
    });
  }

  /** Change invoice status (issue a draft, or cancel). Paid is set by payments, not here. */
  async setStatus(id: number, status: string, me: { id: number }) {
    const inv = await this.get(id);
    const next = String(status);
    if (!['draft', 'issued', 'cancelled'].includes(next)) {
      throw new BadRequestException('Status must be draft, issued or cancelled.');
    }
    if (inv.status === 'paid') throw new BadRequestException('A paid invoice cannot change status.');
    if (next === 'cancelled' && inv.paid_minor > 0) {
      throw new BadRequestException('This invoice has payments — delete them before cancelling.');
    }
    await this.db.query(
      `UPDATE royalty_invoice SET status = $2, updated_at = now() WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id, next]);
    void me;
    return this.get(id);
  }

  async remove(id: number, me: { id: number }) {
    const inv = await this.get(id);
    if (inv.paid_minor > 0) throw new BadRequestException('This invoice has payments — delete them before deleting the invoice.');
    const r = await this.db.query<{ id: string }>(
      `UPDATE royalty_invoice SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`, [id, me.id]);
    if (!r.length) throw new NotFoundException('Royalty invoice not found');
    return { id, ok: true };
  }

  /** Record a payment against a royalty invoice; flips the invoice to 'paid' when fully collected. */
  async addPayment(invoiceId: number, dto: any, me: { id: number }) {
    const inv = await this.get(invoiceId);
    if (inv.status === 'cancelled') throw new BadRequestException('Cannot collect against a cancelled invoice.');
    if (inv.status === 'draft') throw new BadRequestException('Issue the invoice before collecting a payment.');
    const amount = dto?.amount_minor !== undefined && dto?.amount_minor !== null && dto?.amount_minor !== ''
      ? Math.trunc(Number(dto.amount_minor)) : rupeesToMinor(dto?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Enter a payment amount greater than zero.');
    if (amount > inv.outstanding_minor) throw new BadRequestException(`The payment exceeds the outstanding of ${inv.outstanding_minor / 100}.`);
    const mode = MODES.includes(dto?.mode) ? dto.mode : 'bank_transfer';
    const paidOn = /^(\d{4}-\d{2}-\d{2})/.exec(String(dto?.paid_on ?? ''));
    const orgId = await this.orgId();

    return this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO royalty_payment (org_id, invoice_id, amount_minor, paid_on, mode, reference, note, created_by)
         VALUES ($1::bigint,$2::bigint,$3::bigint, COALESCE($4::date, (now() AT TIME ZONE 'Asia/Kolkata')::date), $5,$6,$7,$8::bigint)`,
        [orgId, invoiceId, amount, paidOn ? paidOn[1] : null, mode, dto?.reference ?? null, dto?.note ?? null, me.id]);
      const paid = await c.query<{ s: string }>(
        `SELECT COALESCE(sum(amount_minor),0) AS s FROM royalty_payment WHERE invoice_id = $1::bigint AND deleted_at IS NULL`,
        [invoiceId]);
      const total = Number(paid.rows[0].s);
      const fully = isFullyPaid(inv.amount_minor, total);
      await c.query(
        `UPDATE royalty_invoice SET status = CASE WHEN $2::boolean THEN 'paid' ELSE 'issued' END, updated_at = now()
          WHERE id = $1::bigint`, [invoiceId, fully]);
      return { ok: true };
    });
  }

  async removePayment(invoiceId: number, paymentId: number, me: { id: number }) {
    const r = await this.db.query<{ id: string }>(
      `UPDATE royalty_payment SET deleted_at = now(), deleted_by = $3::bigint
        WHERE id = $1::bigint AND invoice_id = $2::bigint AND deleted_at IS NULL RETURNING id`,
      [paymentId, invoiceId, me.id]);
    if (!r.length) throw new NotFoundException('Payment not found');
    // Re-open the invoice if it is no longer fully paid.
    const paid = await this.db.one<{ s: string }>(
      `SELECT COALESCE(sum(amount_minor),0) AS s FROM royalty_payment WHERE invoice_id = $1::bigint AND deleted_at IS NULL`,
      [invoiceId]);
    const inv = await this.db.one<any>(`SELECT amount_minor, status FROM royalty_invoice WHERE id = $1::bigint`, [invoiceId]);
    if (inv && inv.status !== 'cancelled' && Number(paid?.s ?? 0) < Number(inv.amount_minor)) {
      await this.db.query(`UPDATE royalty_invoice SET status = 'issued', updated_at = now() WHERE id = $1::bigint AND status = 'paid'`, [invoiceId]);
    }
    return { ok: true };
  }

  /**
   * OUTSTANDING ageing. Every not-fully-paid, non-cancelled invoice, bucketed by the age
   * of its issue_date in IST: current (0-30d) / 31-60 / 61-90 / 90+.
   */
  async outstanding(franchiseId?: number) {
    const params: unknown[] = [];
    let clause = `ri.deleted_at IS NULL AND ri.status IN ('issued', 'paid')`;
    if (franchiseId) { params.push(franchiseId); clause += ` AND ri.franchise_id = $${params.length}::bigint`; }
    const rows = await this.db.query<any>(
      `SELECT ri.*, f.name AS franchise_name,
              COALESCE((SELECT sum(rp.amount_minor) FROM royalty_payment rp
                          WHERE rp.invoice_id = ri.id AND rp.deleted_at IS NULL), 0) AS paid_minor,
              ((now() AT TIME ZONE 'Asia/Kolkata')::date - ri.issue_date) AS age_days
         FROM royalty_invoice ri JOIN franchise f ON f.id = ri.franchise_id
        WHERE ${clause}
        ORDER BY ri.issue_date`, params);

    const items = rows
      .map((r) => ({ ...this.mapInvoice(r), age_days: Number(r.age_days ?? 0) }))
      .filter((r) => r.outstanding_minor > 0)
      .map((r) => ({ ...r, bucket: royaltyAgeBucket(r.age_days) }));
    const buckets = ageingBuckets(items);
    return { buckets, items };
  }

  /**
   * FRANCHISE REPORTS — per-franchise rollup for a period: branches, students/enrolments,
   * revenue collected, net revenue, outstanding dues, and royalty BILLED vs PAID vs
   * OUTSTANDING (from royalty_invoice / royalty_payment issued/paid in the period).
   */
  async reports(opts: { from?: string; to?: string } = {}) {
    const dr = assertDateRange(opts.from, opts.to);
    const franchises = await this.franchises.list();
    const out: any[] = [];
    const totals = {
      branches: 0, students: 0, enrolments: 0,
      revenue_collected_minor: 0, net_revenue_minor: 0, outstanding_dues_minor: 0,
      royalty_billed_minor: 0, royalty_paid_minor: 0, royalty_outstanding_minor: 0,
    };
    for (const f of franchises) {
      const dash = await this.franchises.dashboard(f.id, { from: dr.from ?? undefined, to: dr.to ?? undefined });
      const k = dash.kpis;

      // Royalty billed = Σ amount of issued/paid invoices whose issue_date is in the period.
      const rip: unknown[] = [f.id];
      let rClause = `ri.deleted_at IS NULL AND ri.franchise_id = $1::bigint AND ri.status IN ('issued','paid')`;
      if (dr.from) { rip.push(dr.from); rClause += ` AND ri.issue_date >= $${rip.length}::date`; }
      if (dr.to) { rip.push(dr.to); rClause += ` AND ri.issue_date <= $${rip.length}::date`; }
      const billed = await this.db.one<any>(
        `SELECT COALESCE(sum(ri.amount_minor),0) AS billed,
                COALESCE(sum(GREATEST(ri.amount_minor - COALESCE(p.paid,0),0)),0) AS outstanding
           FROM royalty_invoice ri
           LEFT JOIN LATERAL (SELECT COALESCE(sum(rp.amount_minor),0) AS paid FROM royalty_payment rp
                                WHERE rp.invoice_id = ri.id AND rp.deleted_at IS NULL) p ON TRUE
          WHERE ${rClause}`, rip);

      // Royalty paid = Σ payments whose paid_on is in the period (across this franchise's invoices).
      const pp: unknown[] = [f.id];
      let pClause = `rp.deleted_at IS NULL AND ri.franchise_id = $1::bigint`;
      if (dr.from) { pp.push(dr.from); pClause += ` AND rp.paid_on >= $${pp.length}::date`; }
      if (dr.to) { pp.push(dr.to); pClause += ` AND rp.paid_on <= $${pp.length}::date`; }
      const paid = await this.db.one<any>(
        `SELECT COALESCE(sum(rp.amount_minor),0) AS paid
           FROM royalty_payment rp JOIN royalty_invoice ri ON ri.id = rp.invoice_id AND ri.deleted_at IS NULL
          WHERE ${pClause}`, pp);

      const row = {
        franchise_id: f.id, franchise_name: f.name, code: f.code, status: f.status,
        branches: k.total_branches, active_branches: k.active_branches,
        students: k.students, enrolments: k.enrolments,
        revenue_collected_minor: k.revenue_collected_minor,
        net_revenue_minor: k.net_revenue_minor,
        outstanding_dues_minor: k.outstanding_minor,
        royalty_billed_minor: Number(billed?.billed ?? 0),
        royalty_paid_minor: Number(paid?.paid ?? 0),
        royalty_outstanding_minor: Number(billed?.outstanding ?? 0),
      };
      totals.branches += row.branches;
      totals.students += row.students;
      totals.enrolments += row.enrolments;
      totals.revenue_collected_minor += row.revenue_collected_minor;
      totals.net_revenue_minor += row.net_revenue_minor;
      totals.outstanding_dues_minor += row.outstanding_dues_minor;
      totals.royalty_billed_minor += row.royalty_billed_minor;
      totals.royalty_paid_minor += row.royalty_paid_minor;
      totals.royalty_outstanding_minor += row.royalty_outstanding_minor;
      out.push(row);
    }
    return { range: { from: dr.from ?? null, to: dr.to ?? null }, rows: out, totals };
  }
}
