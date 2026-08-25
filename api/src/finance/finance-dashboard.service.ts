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
const REFUND_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'rf.branch_id',
  vertical: 'rf.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export interface FinScopeFilter {
  branch_ids?: number[]; vertical_ids?: number[];
  counsellor_ids?: number[]; course_ids?: number[]; trainer_ids?: number[];
  statuses?: string[]; payment_modes?: string[];
}

/** Column names for one query context, used to translate the filter bar into SQL. */
interface FinCols {
  branch: string; vertical: string; counsellor?: string; course?: string;
  status?: string; batch?: string; mode?: string;
}

@Injectable()
export class FinanceDashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /**
   * Narrow within scope by the finance filter bar (Branch, Vertical, Counsellor, Course,
   * Trainer, Status, Payment Mode). NEVER widens — every clause is ANDed on top of the RBAC
   * scope. Which clauses apply depends on the columns available in the query context (`cols`).
   * crm25aug (#5).
   */
  private narrow(cols: FinCols, f: FinScopeFilter, params: unknown[]): string {
    const parts: string[] = [];
    const addId = (col: string | undefined, arr?: number[]) => {
      if (!col) return;
      const vals = [...new Set((arr ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!vals.length) return;
      params.push(vals); parts.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    const addStr = (col: string | undefined, arr?: string[]) => {
      if (!col) return;
      const vals = [...new Set((arr ?? []).map((x) => String(x).trim()).filter(Boolean))];
      if (!vals.length) return;
      params.push(vals); parts.push(`${col} = ANY($${params.length}::varchar[])`);
    };
    addId(cols.branch, f.branch_ids); addId(cols.vertical, f.vertical_ids);
    addId(cols.counsellor, f.counsellor_ids); addId(cols.course, f.course_ids);
    addStr(cols.status, f.statuses); addStr(cols.mode, f.payment_modes);
    // Trainer lives on the BATCH, not the enrolment — translate to a batch-membership test.
    if (cols.batch) {
      const tvals = [...new Set((f.trainer_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (tvals.length) {
        params.push(tvals);
        parts.push(`${cols.batch} IN (SELECT id FROM batch WHERE trainer_id = ANY($${params.length}::bigint[]))`);
      }
    }
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  }

  async dashboard(scope: ResolvedScope, opts: { from?: string; to?: string } & FinScopeFilter = {}) {
    const dr = assertDateRange(opts.from, opts.to);
    const num = (v: unknown) => Number(v ?? 0);

    // ---- collections (fee_receipt) ----
    const rp: unknown[] = [];
    const rw = this.resolver.buildScopeWhere(scope, RECEIPT_COLS, rp)
      + this.narrow({ branch: 'fr.branch_id', vertical: 'fr.vertical_id', counsellor: 'e.counsellor_id',
                     course: 'e.course_id', status: 'e.status', batch: 'e.batch_id', mode: 'fr.mode' }, opts, rp);
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

    // ---- refunds (approved, net down the collection) ----
    const fp: unknown[] = [];
    const fw = this.resolver.buildScopeWhere(scope, REFUND_COLS, fp)
      + this.narrow({ branch: 'rf.branch_id', vertical: 'rf.vertical_id', counsellor: 'e.counsellor_id', course: 'e.course_id' }, opts, fp);
    let fDate = '';
    if (dr.from) { fp.push(dr.from); fDate += ` AND rf.refunded_at >= $${fp.length}::date`; }
    if (dr.to) { fp.push(dr.to); fDate += ` AND rf.refunded_at < ($${fp.length}::date + 1)`; }
    const refBase = `FROM refund rf JOIN enrolment e ON e.id = rf.enrolment_id
                     WHERE rf.deleted_at IS NULL AND rf.status = 'approved' AND ${fw}`;
    const refAll = await this.db.one<any>(
      `SELECT COALESCE(sum(rf.amount_minor), 0) AS all_time_minor,
              count(*) AS n ${refBase}`, fp);
    const refRange = await this.db.one<any>(
      `SELECT COALESCE(sum(rf.amount_minor), 0) AS range_minor ${refBase}${fDate}`, fp);

    // ---- invoices (gst_invoice) ----
    const ip: unknown[] = [];
    const iw = this.resolver.buildScopeWhere(scope, INVOICE_COLS, ip)
      + this.narrow({ branch: 'gi.branch_id', vertical: 'gi.vertical_id', counsellor: 'gi.counsellor_id' }, opts, ip);
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

    // ---- crm25aug (#5): collectible + net revenue (enrolment) ----
    const cp: unknown[] = [];
    const cw = this.resolver.buildScopeWhere(scope, ENROL_COLS, cp)
      + this.narrow({ branch: 'e.branch_id', vertical: 'e.vertical_id', counsellor: 'e.counsellor_id',
                     course: 'e.course_id', batch: 'e.batch_id' }, opts, cp);
    let cDate = '';
    if (dr.from) { cp.push(dr.from); cDate += ` AND e.created_at >= $${cp.length}::date`; }
    if (dr.to) { cp.push(dr.to); cDate += ` AND e.created_at < ($${cp.length}::date + 1)`; }
    const coll2 = await this.db.one<any>(
      `SELECT COALESCE(sum(e.net_fee_minor), 0) AS collectible_minor,
              COALESCE(sum(CASE WHEN TRUE${cDate ? ' AND ' + cDate.replace(/^ AND /, '') : ''} THEN e.net_fee_minor ELSE 0 END), 0) AS net_revenue_range_minor
         FROM enrolment e
        WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${cw}`, cp);

    // ---- crm25aug (#5): instalment KPIs (installment schedule) ----
    const sp: unknown[] = [];
    const sw = this.resolver.buildScopeWhere(scope, ENROL_COLS, sp)
      + this.narrow({ branch: 'e.branch_id', vertical: 'e.vertical_id', counsellor: 'e.counsellor_id',
                     course: 'e.course_id', batch: 'e.batch_id' }, opts, sp);
    const inst = await this.db.one<any>(
      `SELECT
         COALESCE(sum(i.amount_minor) FILTER (
            WHERE i.due_date >= date_trunc('month', now())::date
              AND i.due_date <  (date_trunc('month', now()) + interval '1 month')::date), 0) AS current_month_minor,
         COALESCE(sum((i.amount_minor - i.paid_minor)) FILTER (
            WHERE i.due_date < CURRENT_DATE AND i.status IN ('pending','partial')), 0) AS overdue_minor
       FROM installment i JOIN enrolment e ON e.id = i.enrolment_id
      WHERE e.deleted_at IS NULL AND ${sw}`, sp);

    // Overdue fee COLLECTED — receipt money that settled an instalment paid AFTER its due date
    // (a previously-overdue instalment recovered), within the selected DateRange + scope.
    const op: unknown[] = [];
    const ow = this.resolver.buildScopeWhere(scope, ENROL_COLS, op)
      + this.narrow({ branch: 'e.branch_id', vertical: 'e.vertical_id', counsellor: 'e.counsellor_id',
                     course: 'e.course_id', batch: 'e.batch_id' }, opts, op);
    let oDate = '';
    if (dr.from) { op.push(dr.from); oDate += ` AND fr.received_at >= $${op.length}::date`; }
    if (dr.to) { op.push(dr.to); oDate += ` AND fr.received_at < ($${op.length}::date + 1)`; }
    const overdueColl = await this.db.one<any>(
      `SELECT COALESCE(sum(ip.amount_minor), 0) AS overdue_collected_minor
         FROM installment_payment ip
         JOIN installment i ON i.id = ip.installment_id
         JOIN fee_receipt fr ON fr.id = ip.fee_receipt_id AND fr.deleted_at IS NULL
         JOIN enrolment e ON e.id = i.enrolment_id
        WHERE e.deleted_at IS NULL AND i.due_date < fr.received_at::date AND ${ow}${oDate}`, op);

    const totalCollected = num(coll?.all_time_minor);
    const totalCollectible = num(coll2?.collectible_minor);
    const collectionRatePct = totalCollectible > 0 ? Math.round((totalCollected * 1000) / totalCollectible) / 10 : 0;

    return {
      range: { from: dr.from ?? null, to: dr.to ?? null },
      kpis: {
        total_invoiced_minor: num(inv?.invoiced_minor),
        total_collected_minor: num(coll?.all_time_minor),
        refunds_minor: num(refAll?.refunds_all ?? refAll?.all_time_minor),
        net_collected_minor: num(coll?.all_time_minor) - num(refAll?.all_time_minor),
        refunds_in_range_minor: num(refRange?.range_minor),
        refunds_n: num(refAll?.n),
        collected_in_range_minor: num(rangeColl?.range_minor),
        collected_mtd_minor: num(coll?.mtd_minor),
        collected_today_minor: num(coll?.today_minor),
        outstanding_minor: num(dues?.outstanding_minor),
        total_unpaid_minor: num(dues?.outstanding_minor),
        total_collectible_minor: totalCollectible,
        collection_rate_pct: collectionRatePct,
        net_revenue_minor: num(coll2?.net_revenue_range_minor),
        current_month_installment_minor: num(inst?.current_month_minor),
        overdue_fee_minor: num(inst?.overdue_minor),
        overdue_fee_collected_minor: num(overdueColl?.overdue_collected_minor),
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
