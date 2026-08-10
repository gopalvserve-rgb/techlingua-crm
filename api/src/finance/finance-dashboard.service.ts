import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange } from '../common/date.util';

/**
 * FINANCE DASHBOARD (Phase 3 Batch 1) — REAL ₹ KPIs from the fee/invoice/enrolment
 * tables. No fabricated numbers: every figure is a scoped SQL aggregate with a clean
 * empty state. Scope is the caller's RBAC scope (never widened); an optional top-bar
 * narrow + DateRange are ANDed on top and can only narrow within it.
 */

const RECEIPT_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'fr.branch_id',
  vertical: 'fr.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};
const ENROL_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};
const INVOICE_COLS: ScopeColumnMap = {
  owner: 'gi.counsellor_id', team: 'gi.team_id', branch: 'gi.branch_id',
  vertical: 'gi.vertical_id', pipeline: 'gi.pipeline_id', campaign: 'gi.campaign_id',
};

export interface FinScopeFilter {
  branch_ids?: number[]; vertical_ids?: number[];
}

@Injectable()
export class FinanceDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** Narrow within scope by an optional branch/vertical selection. Never widens. */
  private narrow(cols: { branch: string; vertical: string }, f: FinScopeFilter, params: unknown[]): string {
    const parts: string[] = [];
    const add = (col: string, arr?: number[]) => {
      const vals = [...new Set((arr ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!vals.length) return;
      params.push(vals); parts.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    add(cols.branch, f.branch_ids); add(cols.vertical, f.vertical_ids);
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  }

  async dashboard(scope: ResolvedScope, opts: { from?: string; to?: string } & FinScopeFilter = {}) {
    const dr = assertDateRange(opts.from, opts.to);
    const num = (v: unknown) => Number(v ?? 0);

    // ---- collections (fee_receipt) ----
    const rp: unknown[] = [];
    const rw = this.resolver.buildScopeWhere(scope, RECEIPT_COLS, rp)
      + this.narrow({ branch: 'fr.branch_id', vertical: 'fr.vertical_id' }, opts, rp);
    // optional date range on the receipt date
    let rDate = '';
    if (dr.from) { rp.push(dr.from); rDate += ` AND fr.received_at >= $${rp.length}::date`; }
    if (dr.to) { rp.push(dr.to); rDate += ` AND fr.received_at < ($${rp.length}::date + 1)`; }
    const rBase = `FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id
                   WHERE fr.deleted_at IS NULL AND ${rw}`;
    const coll = await this.db.one<any>(
      `SELECT COALESCE(sum(fr.amount_minor), 0) AS all_time_minor,
              COALESCE(sum(fr.amount_minor) FILTER (WHERE fr.received_at >= date_trunc('month', now())), 0) AS mtd_minor,
              COALESCE(sum(fr.amount_minor) FILTER (WHERE fr.received_at >= date_trunc('day', now())), 0) AS today_minor,
              count(*) AS receipts
       ${rBase}`, rp);
    // in-range collection (respects the DateRange)
    const rangeColl = await this.db.one<any>(
      `SELECT COALESCE(sum(fr.amount_minor), 0) AS range_minor, count(*) AS range_receipts
       ${rBase}${rDate}`, rp);
    const byMode = await this.db.query<any>(
      `SELECT fr.mode, COALESCE(sum(fr.amount_minor), 0) AS total_minor, count(*) AS n
       ${rBase}${rDate} GROUP BY fr.mode ORDER BY 2 DESC`, rp);
    const byBranch = await this.db.query<any>(
      `SELECT b.name AS label, COALESCE(sum(fr.amount_minor), 0) AS total_minor
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id JOIN branch b ON b.id = fr.branch_id
        WHERE fr.deleted_at IS NULL AND ${rw}${rDate}
        GROUP BY b.name ORDER BY 2 DESC LIMIT 12`, rp);
    const byVertical = await this.db.query<any>(
      `SELECT v.name AS label, COALESCE(sum(fr.amount_minor), 0) AS total_minor
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id JOIN vertical v ON v.id = fr.vertical_id
        WHERE fr.deleted_at IS NULL AND ${rw}${rDate}
        GROUP BY v.name ORDER BY 2 DESC LIMIT 12`, rp);
    const byCourse = await this.db.query<any>(
      `SELECT COALESCE(c.name, 'Unspecified') AS label, COALESCE(sum(fr.amount_minor), 0) AS total_minor
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id LEFT JOIN m_course c ON c.id = e.course_id
        WHERE fr.deleted_at IS NULL AND ${rw}${rDate}
        GROUP BY c.name ORDER BY 2 DESC LIMIT 12`, rp);
    const recent = await this.db.query<any>(
      `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.received_at,
              l.full_name AS lead_name, e.enrolment_no, b.name AS branch_name
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id
         JOIN lead l ON l.id = e.lead_id JOIN branch b ON b.id = fr.branch_id
        WHERE fr.deleted_at IS NULL AND ${rw}
        ORDER BY fr.received_at DESC LIMIT 8`, rp);

    // ---- outstanding / top dues (enrolment, live snapshot) ----
    const ep: unknown[] = [];
    const ew = this.resolver.buildScopeWhere(scope, ENROL_COLS, ep)
      + this.narrow({ branch: 'e.branch_id', vertical: 'e.vertical_id' }, opts, ep);
    const eBase = `FROM enrolment e
                   LEFT JOIN LATERAL (SELECT COALESCE(sum(fr.amount_minor),0) AS paid_minor
                                        FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL) p ON TRUE
                   WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${ew}`;
    const dues = await this.db.one<any>(
      `SELECT COALESCE(sum(e.net_fee_minor - p.paid_minor), 0) AS outstanding_minor,
              count(*) FILTER (WHERE e.net_fee_minor - p.paid_minor > 0) AS with_dues
       ${eBase}`, ep);
    const topDues = await this.db.query<any>(
      `SELECT e.id, e.enrolment_no, l.full_name AS lead_name, c.name AS course_name,
              e.net_fee_minor, p.paid_minor, (e.net_fee_minor - p.paid_minor) AS balance_minor,
              b.name AS branch_name
         FROM enrolment e
         LEFT JOIN LATERAL (SELECT COALESCE(sum(fr.amount_minor),0) AS paid_minor
                              FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL) p ON TRUE
         JOIN lead l ON l.id = e.lead_id JOIN branch b ON b.id = e.branch_id
         LEFT JOIN m_course c ON c.id = e.course_id
        WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${ew}
          AND (e.net_fee_minor - p.paid_minor) > 0
        ORDER BY balance_minor DESC LIMIT 8`, ep);

    // ---- invoices (gst_invoice) ----
    const ip: unknown[] = [];
    const iw = this.resolver.buildScopeWhere(scope, INVOICE_COLS, ip)
      + this.narrow({ branch: 'gi.branch_id', vertical: 'gi.vertical_id' }, opts, ip);
    let iDate = '';
    if (dr.from) { ip.push(dr.from); iDate += ` AND gi.invoice_date >= $${ip.length}::date`; }
    if (dr.to) { ip.push(dr.to); iDate += ` AND gi.invoice_date <= $${ip.length}::date`; }
    const inv = await this.db.one<any>(
      `SELECT COALESCE(sum(gi.total_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS invoiced_minor,
              COALESCE(sum(gi.taxable_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS taxable_minor,
              COALESCE(sum(gi.cgst_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS cgst_minor,
              COALESCE(sum(gi.sgst_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS sgst_minor,
              COALESCE(sum(gi.igst_minor) FILTER (WHERE gi.status IN ('issued','paid')), 0) AS igst_minor,
              count(*) FILTER (WHERE gi.status = 'issued') AS issued,
              count(*) FILTER (WHERE gi.status = 'paid') AS paid,
              count(*) FILTER (WHERE gi.status = 'draft') AS draft
         FROM gst_invoice gi
        WHERE gi.deleted_at IS NULL AND ${iw}${iDate}`, ip);

    const gstTotal = num(inv?.cgst_minor) + num(inv?.sgst_minor) + num(inv?.igst_minor);

    return {
      range: { from: dr.from ?? null, to: dr.to ?? null },
      kpis: {
        total_invoiced_minor: num(inv?.invoiced_minor),
        total_collected_minor: num(coll?.all_time_minor),
        collected_in_range_minor: num(rangeColl?.range_minor),
        collected_mtd_minor: num(coll?.mtd_minor),
        collected_today_minor: num(coll?.today_minor),
        outstanding_minor: num(dues?.outstanding_minor),
        gst_collected_minor: gstTotal,
        cgst_minor: num(inv?.cgst_minor), sgst_minor: num(inv?.sgst_minor), igst_minor: num(inv?.igst_minor),
        taxable_minor: num(inv?.taxable_minor),
        receipts: num(coll?.receipts),
        enrolments_with_dues: num(dues?.with_dues),
        invoices_issued: num(inv?.issued), invoices_paid: num(inv?.paid), invoices_draft: num(inv?.draft),
      },
      by_mode: byMode.map((m) => ({ mode: m.mode, total_minor: num(m.total_minor), n: num(m.n) })),
      by_branch: byBranch.map((r) => ({ label: r.label, total_minor: num(r.total_minor) })),
      by_vertical: byVertical.map((r) => ({ label: r.label, total_minor: num(r.total_minor) })),
      by_course: byCourse.map((r) => ({ label: r.label, total_minor: num(r.total_minor) })),
      recent_receipts: recent.map((r) => ({
        id: Number(r.id), receipt_no: r.receipt_no, amount_minor: num(r.amount_minor), mode: r.mode,
        received_at: r.received_at, lead_name: r.lead_name, enrolment_no: r.enrolment_no, branch_name: r.branch_name,
      })),
      top_dues: topDues.map((r) => ({
        id: Number(r.id), enrolment_no: r.enrolment_no, lead_name: r.lead_name, course_name: r.course_name,
        net_fee_minor: num(r.net_fee_minor), paid_minor: num(r.paid_minor), balance_minor: num(r.balance_minor),
        branch_name: r.branch_name,
      })),
    };
  }
}
