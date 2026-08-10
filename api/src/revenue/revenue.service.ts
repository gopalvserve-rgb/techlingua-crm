import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, APP_TZ } from '../common/date.util';

/**
 * REVENUE (Phase 3 Batch 4) — the TWO views of revenue.
 *
 *   COLLECTION = actual money received = fee receipts, NET of approved refunds.
 *   ACCRUAL    = fee billed / earned = the net fee of enrolments recognised in the period.
 *
 * Both are scoped by the caller's RBAC scope (never widened); an optional branch/vertical
 * narrow + DateRange are ANDed on top. India ₹ (paise, integer). Breakdown by branch /
 * vertical / course / counsellor / payment mode / month / day. This service also powers
 * the collection-report screens and feeds the finance dashboard.
 */

const RECEIPT_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'fr.branch_id',
  vertical: 'fr.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};
const REFUND_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'rf.branch_id',
  vertical: 'rf.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};
const ENROL_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const COLLECTION_DIMENSIONS = ['day', 'month', 'branch', 'vertical', 'course', 'counsellor', 'mode'] as const;
export const ACCRUAL_DIMENSIONS = ['day', 'month', 'branch', 'vertical', 'course', 'counsellor'] as const;
export type Dimension = (typeof COLLECTION_DIMENSIONS)[number];

const MODE_LABELS: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online transfer' };

/** The grouping label expression for a dimension, given a table alias for the money row
 *  (fr / rf) and the enrolment alias (e). Returns { label, group } SQL fragments. */
function dimSql(dim: Dimension, moneyAlias: string, dateCol: string): { select: string; join: string; group: string; order: string } {
  switch (dim) {
    case 'day':
      return { select: `to_char((${dateCol} AT TIME ZONE '${APP_TZ}')::date, 'DD-MM-YYYY')`, join: '', group: `(${dateCol} AT TIME ZONE '${APP_TZ}')::date`, order: `(${dateCol} AT TIME ZONE '${APP_TZ}')::date` };
    case 'month':
      return { select: `to_char((${dateCol} AT TIME ZONE '${APP_TZ}'), 'Mon YYYY')`, join: '', group: `date_trunc('month', (${dateCol} AT TIME ZONE '${APP_TZ}'))`, order: `date_trunc('month', (${dateCol} AT TIME ZONE '${APP_TZ}'))` };
    case 'branch':
      return { select: `b.name`, join: `JOIN branch b ON b.id = ${moneyAlias}.branch_id`, group: `b.name`, order: `b.name` };
    case 'vertical':
      return { select: `v.name`, join: `JOIN vertical v ON v.id = ${moneyAlias}.vertical_id`, group: `v.name`, order: `v.name` };
    case 'course':
      return { select: `COALESCE(c.name, 'Unspecified')`, join: `LEFT JOIN m_course c ON c.id = e.course_id`, group: `c.name`, order: `c.name` };
    case 'counsellor':
      return { select: `COALESCE(u.name, 'Unassigned')`, join: `LEFT JOIN "user" u ON u.id = e.counsellor_id`, group: `u.name`, order: `u.name` };
    case 'mode':
      return { select: `${moneyAlias}.mode`, join: '', group: `${moneyAlias}.mode`, order: `${moneyAlias}.mode` };
  }
}

export interface RevenueOpts {
  from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[]; group_by?: string;
}

@Injectable()
export class RevenueService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private narrow(branchCol: string, verticalCol: string, o: RevenueOpts, params: unknown[]): string {
    const parts: string[] = [];
    const bv = [...new Set((o.branch_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const vv = [...new Set((o.vertical_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (bv.length) { params.push(bv); parts.push(`${branchCol} = ANY($${params.length}::bigint[])`); }
    if (vv.length) { params.push(vv); parts.push(`${verticalCol} = ANY($${params.length}::bigint[])`); }
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  }

  private label(dim: Dimension, raw: string): string {
    return dim === 'mode' ? (MODE_LABELS[raw] ?? raw) : raw;
  }

  /** COLLECTION grouped by a dimension, NET of approved refunds. */
  async collection(scope: ResolvedScope, opts: RevenueOpts) {
    const dim = (opts.group_by ?? 'branch') as Dimension;
    if (!(COLLECTION_DIMENSIONS as readonly string[]).includes(dim)) throw new BadRequestException(`Unknown collection dimension "${dim}"`);
    const dr = assertDateRange(opts.from, opts.to);

    // receipts
    const rp: unknown[] = [];
    const rw = this.resolver.buildScopeWhere(scope, RECEIPT_COLS, rp) + this.narrow('fr.branch_id', 'fr.vertical_id', opts, rp);
    let rDate = '';
    if (dr.from) { rp.push(dr.from); rDate += ` AND fr.received_at >= $${rp.length}::date`; }
    if (dr.to) { rp.push(dr.to); rDate += ` AND fr.received_at < ($${rp.length}::date + 1)`; }
    const rd = dimSql(dim, 'fr', 'fr.received_at');
    const receipts = await this.db.query<any>(
      `SELECT ${rd.select} AS label, COALESCE(sum(fr.amount_minor), 0) AS gross_minor, count(*) AS n
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id ${rd.join}
        WHERE fr.deleted_at IS NULL AND ${rw}${rDate}
        GROUP BY ${rd.group} ORDER BY ${rd.order}`, rp);

    // refunds (approved, by refunded date)
    const fp: unknown[] = [];
    const fw = this.resolver.buildScopeWhere(scope, REFUND_COLS, fp) + this.narrow('rf.branch_id', 'rf.vertical_id', opts, fp);
    let fDate = '';
    if (dr.from) { fp.push(dr.from); fDate += ` AND rf.refunded_at >= $${fp.length}::date`; }
    if (dr.to) { fp.push(dr.to); fDate += ` AND rf.refunded_at < ($${fp.length}::date + 1)`; }
    const fd = dimSql(dim, 'rf', 'rf.refunded_at');
    const refunds = await this.db.query<any>(
      `SELECT ${fd.select} AS label, COALESCE(sum(rf.amount_minor), 0) AS refunds_minor, count(*) AS n
         FROM refund rf JOIN enrolment e ON e.id = rf.enrolment_id ${fd.join}
        WHERE rf.deleted_at IS NULL AND rf.status = 'approved' AND ${fw}${fDate}
        GROUP BY ${fd.group} ORDER BY ${fd.order}`, fp);

    // merge on label
    const map = new Map<string, { label: string; gross_minor: number; refunds_minor: number; receipts_n: number; refunds_n: number }>();
    for (const r of receipts) {
      const lab = this.label(dim, r.label);
      map.set(lab, { label: lab, gross_minor: Number(r.gross_minor), refunds_minor: 0, receipts_n: Number(r.n), refunds_n: 0 });
    }
    for (const r of refunds) {
      const lab = this.label(dim, r.label);
      const cur = map.get(lab) ?? { label: lab, gross_minor: 0, refunds_minor: 0, receipts_n: 0, refunds_n: 0 };
      cur.refunds_minor = Number(r.refunds_minor); cur.refunds_n = Number(r.n);
      map.set(lab, cur);
    }
    const rows = [...map.values()].map((x) => ({ ...x, net_minor: x.gross_minor - x.refunds_minor }));
    const totals = rows.reduce((t, x) => ({
      gross_minor: t.gross_minor + x.gross_minor, refunds_minor: t.refunds_minor + x.refunds_minor,
      net_minor: t.net_minor + x.net_minor, receipts_n: t.receipts_n + x.receipts_n, refunds_n: t.refunds_n + x.refunds_n,
    }), { gross_minor: 0, refunds_minor: 0, net_minor: 0, receipts_n: 0, refunds_n: 0 });
    return { view: 'collection', group_by: dim, range: { from: dr.from ?? null, to: dr.to ?? null }, totals, rows };
  }

  /** ACCRUAL grouped by a dimension — net fee recognised at enrolment (created_at). */
  async accrual(scope: ResolvedScope, opts: RevenueOpts) {
    const dim = (opts.group_by ?? 'branch') as Dimension;
    if (!(ACCRUAL_DIMENSIONS as readonly string[]).includes(dim)) throw new BadRequestException(`Unknown accrual dimension "${dim}" (accrual has no payment mode)`);
    const dr = assertDateRange(opts.from, opts.to);
    const ep: unknown[] = [];
    const ew = this.resolver.buildScopeWhere(scope, ENROL_COLS, ep) + this.narrow('e.branch_id', 'e.vertical_id', opts, ep);
    let eDate = '';
    if (dr.from) { ep.push(dr.from); eDate += ` AND e.created_at >= $${ep.length}::date`; }
    if (dr.to) { ep.push(dr.to); eDate += ` AND e.created_at < ($${ep.length}::date + 1)`; }
    const ed = dimSql(dim, 'e', 'e.created_at');
    const rows0 = await this.db.query<any>(
      `SELECT ${ed.select} AS label, COALESCE(sum(e.net_fee_minor), 0) AS accrual_minor, count(*) AS n
         FROM enrolment e ${ed.join}
        WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${ew}${eDate}
        GROUP BY ${ed.group} ORDER BY ${ed.order}`, ep);
    const rows = rows0.map((r) => ({ label: this.label(dim, r.label), accrual_minor: Number(r.accrual_minor), enrolments: Number(r.n) }));
    const totals = rows.reduce((t, x) => ({ accrual_minor: t.accrual_minor + x.accrual_minor, enrolments: t.enrolments + x.enrolments }), { accrual_minor: 0, enrolments: 0 });
    return { view: 'accrual', group_by: dim, range: { from: dr.from ?? null, to: dr.to ?? null }, totals, rows };
  }

  /** The revenue OVERVIEW — both views' headline totals + a default breakdown, for the
   *  Revenue screen and to feed the finance dashboard. */
  async overview(scope: ResolvedScope, opts: RevenueOpts) {
    const coll = await this.collection(scope, { ...opts, group_by: 'vertical' });
    const acc = await this.accrual(scope, { ...opts, group_by: 'vertical' });
    return {
      range: coll.range,
      collection: { totals: coll.totals, by_vertical: coll.rows },
      accrual: { totals: acc.totals, by_vertical: acc.rows },
    };
  }

  async revenue(scope: ResolvedScope, opts: RevenueOpts & { view?: string }) {
    const view = opts.view ?? 'collection';
    if (view === 'accrual') return this.accrual(scope, opts);
    if (view === 'collection') return this.collection(scope, opts);
    throw new BadRequestException(`Unknown revenue view "${view}" — use collection or accrual.`);
  }
}
