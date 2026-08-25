import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { FranchiseService } from './franchise.service';

/**
 * FRANCHISE TARGETS & PERFORMANCE (Phase 4 Batch 3).
 *
 * A per-franchise target for a period (admissions, enrolments, revenue, collection).
 * ACTUALS are computed LIVE from the franchise's branches over the target period using the
 * SAME finance sources as the Finance / Franchise dashboards (fee_receipt = revenue collected,
 * net collected = collection; enrolment rows created in the period = enrolments; distinct
 * students = admissions), so target-vs-actual reconciles. A head-office LEADERBOARD ranks
 * franchises by overall achievement across their currently-active targets.
 */
const PERIODS = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'];
const pct = (actual: number, target: number) =>
  target > 0 ? Math.round((actual / target) * 1000) / 10 : (actual > 0 ? 100 : 0);

export interface FranchisePeriodActuals {
  admissions: number; enrolments: number;
  revenue_collected_minor: number; collection_minor: number;
}

@Injectable()
export class FranchiseTargetService {
  constructor(private readonly db: DatabaseService, private readonly franchises: FranchiseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private ymd(v: unknown): string | null {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
    return m ? m[1] : null;
  }

  /** Actuals for a franchise's branches over [from,to] (inclusive dates). */
  async actuals(franchiseId: number, from: string, to: string): Promise<FranchisePeriodActuals> {
    const branchIds = await this.franchises.branchIds(franchiseId);
    const rev = await this.franchises.revenueForBranches(branchIds, from, to);
    let admissions = 0, enrolments = 0;
    if (branchIds.length) {
      const e = await this.db.one<any>(
        `SELECT count(*) AS enrolments, count(DISTINCT lead_id) AS admissions
           FROM enrolment
          WHERE deleted_at IS NULL AND status NOT IN ('cancelled', 'rejected')
            AND branch_id = ANY($1::bigint[])
            AND created_at >= $2::date AND created_at < ($3::date + 1)`,
        [branchIds, from, to]);
      enrolments = Number(e?.enrolments ?? 0);
      admissions = Number(e?.admissions ?? 0);
    }
    return {
      admissions, enrolments,
      revenue_collected_minor: rev.gross_collected_minor,
      collection_minor: rev.net_collected_minor,
    };
  }

  private map = (t: any) => ({
    id: Number(t.id), franchise_id: Number(t.franchise_id), franchise_name: t.franchise_name ?? null,
    name: t.name, period_type: t.period_type, period_start: t.period_start, period_end: t.period_end,
    admissions_target: Number(t.admissions_target ?? 0), enrolments_target: Number(t.enrolments_target ?? 0),
    revenue_target_minor: Number(t.revenue_target_minor ?? 0), collection_target_minor: Number(t.collection_target_minor ?? 0),
    note: t.note ?? null, created_at: t.created_at,
  });

  /** List targets (optionally constrained to a franchise, or an owner's franchise set). */
  async list(franchiseId?: number, ownerFranchiseIds?: number[] | null) {
    const params: unknown[] = [];
    let clause = 't.deleted_at IS NULL';
    if (franchiseId) { params.push(franchiseId); clause += ` AND t.franchise_id = $${params.length}::bigint`; }
    if (ownerFranchiseIds && ownerFranchiseIds.length) {
      params.push(ownerFranchiseIds); clause += ` AND t.franchise_id = ANY($${params.length}::bigint[])`;
    } else if (ownerFranchiseIds && ownerFranchiseIds.length === 0) {
      return [];
    }
    const rows = await this.db.query<any>(
      `SELECT t.*, f.name AS franchise_name
         FROM franchise_target t JOIN franchise f ON f.id = t.franchise_id
        WHERE ${clause}
        ORDER BY t.period_end DESC, t.id DESC`, params);
    return rows.map(this.map);
  }

  /** One target WITH its live target-vs-actual performance. */
  async performance(id: number) {
    const t = await this.db.one<any>(
      `SELECT t.*, f.name AS franchise_name FROM franchise_target t JOIN franchise f ON f.id = t.franchise_id
        WHERE t.id = $1::bigint AND t.deleted_at IS NULL`, [id]);
    if (!t) throw new NotFoundException('Target not found');
    const from = this.ymd(t.period_start)!;
    const to = this.ymd(t.period_end)!;
    const a = await this.actuals(Number(t.franchise_id), from, to);
    const metrics = [
      { key: 'admissions', label: 'Admissions', target: Number(t.admissions_target), actual: a.admissions, money: false },
      { key: 'enrolments', label: 'Enrolments', target: Number(t.enrolments_target), actual: a.enrolments, money: false },
      { key: 'revenue', label: 'Revenue collected', target: Number(t.revenue_target_minor), actual: a.revenue_collected_minor, money: true },
      { key: 'collection', label: 'Net collection', target: Number(t.collection_target_minor), actual: a.collection_minor, money: true },
    ].map((m) => ({ ...m, pct: pct(m.actual, m.target) }));
    const withTarget = metrics.filter((m) => m.target > 0);
    const overall = withTarget.length
      ? Math.round((withTarget.reduce((s, m) => s + Math.min(m.pct, 200), 0) / withTarget.length) * 10) / 10
      : 0;
    return { target: this.map(t), actuals: a, metrics, overall_pct: overall };
  }

  /** Head-office leaderboard — every franchise's overall achievement on its active targets. */
  async leaderboard(ownerFranchiseIds?: number[] | null) {
    const params: unknown[] = [];
    let clause = `t.deleted_at IS NULL
        AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN t.period_start AND t.period_end`;
    if (ownerFranchiseIds && ownerFranchiseIds.length) {
      params.push(ownerFranchiseIds); clause += ` AND t.franchise_id = ANY($${params.length}::bigint[])`;
    } else if (ownerFranchiseIds && ownerFranchiseIds.length === 0) {
      return [];
    }
    const rows = await this.db.query<any>(
      `SELECT t.*, f.name AS franchise_name, f.code AS franchise_code
         FROM franchise_target t JOIN franchise f ON f.id = t.franchise_id
        WHERE ${clause} ORDER BY t.franchise_id, t.period_end DESC`, params);
    const out: any[] = [];
    for (const t of rows) {
      const perf = await this.performance(Number(t.id));
      out.push({
        target_id: Number(t.id), franchise_id: Number(t.franchise_id),
        franchise_name: t.franchise_name, franchise_code: t.franchise_code,
        target_name: t.name, period_start: t.period_start, period_end: t.period_end,
        overall_pct: perf.overall_pct, metrics: perf.metrics,
      });
    }
    out.sort((x, y) => y.overall_pct - x.overall_pct);
    return out.map((r, i) => ({ rank: i + 1, ...r }));
  }

  async save(dto: any, me: { id: number }) {
    const franchiseId = Number(dto?.franchise_id);
    if (!Number.isInteger(franchiseId) || franchiseId <= 0) throw new BadRequestException('Choose a franchise.');
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the target a name.');
    const period_type = PERIODS.includes(dto?.period_type) ? dto.period_type : 'monthly';
    const start = this.ymd(dto?.period_start);
    const end = this.ymd(dto?.period_end);
    if (!start || !end) throw new BadRequestException('Give the target a period (start and end date).');
    if (end < start) throw new BadRequestException('The period end cannot be before the start.');
    const n = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;
    const cols = [franchiseId, name, period_type, start, end,
      n(dto?.admissions_target), n(dto?.enrolments_target), n(dto?.revenue_target_minor), n(dto?.collection_target_minor),
      dto?.note ?? null];
    if (id) {
      const upd = await this.db.query<{ id: string }>(
        `UPDATE franchise_target SET franchise_id=$2::bigint, name=$3, period_type=$4, period_start=$5::date,
                period_end=$6::date, admissions_target=$7, enrolments_target=$8, revenue_target_minor=$9,
                collection_target_minor=$10, note=$11, updated_at=now()
          WHERE id=$1::bigint AND deleted_at IS NULL RETURNING id`, [id, ...cols]);
      if (!upd.length) throw new NotFoundException('Target not found');
      return { id };
    }
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO franchise_target (org_id, franchise_id, name, period_type, period_start, period_end,
              admissions_target, enrolments_target, revenue_target_minor, collection_target_minor, note, created_by)
       VALUES ($1::bigint,$2::bigint,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12::bigint) RETURNING id`,
      [orgId, ...cols, me.id]);
    return { id: Number(ins[0].id) };
  }

  async remove(id: number, me: { id: number }) {
    const r = await this.db.query<{ id: string }>(
      `UPDATE franchise_target SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`, [id, me.id]);
    if (!r.length) throw new NotFoundException('Target not found');
    return { id, ok: true };
  }
}
