import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rupeesToMinor } from '../common/money.util';
import { assertDateRange } from '../common/date.util';
import { computeRoyalty, monthsInPeriod, RoyaltySlab } from './royalty.util';
import { FranchiseService } from './franchise.service';

/**
 * ROYALTY PLANS + STATEMENT (Phase 4 Batch 1).
 *
 *  · Plan CRUD (four models + optional tiered slabs + monthly minimum guarantee),
 *    owned by a franchise or a reusable template.
 *  · `compute` — a preview of the royalty a plan produces for a hypothetical
 *    collected/net revenue (proves the resolver, mirrors the incentive preview).
 *  · `statement` — the real royalty payable for a franchise + period, computed from
 *    the franchise's branches' collected revenue (reconciles with Finance).
 */

const MODELS = ['percent_collected', 'percent_net', 'fixed', 'tiered'];

@Injectable()
export class RoyaltyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly franchises: FranchiseService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private mapSlab = (s: any): RoyaltySlab => ({
    min_amount_minor: Number(s.min_amount_minor) || 0,
    max_amount_minor: s.max_amount_minor === null || s.max_amount_minor === undefined ? null : Number(s.max_amount_minor),
    percent: Number(s.percent) || 0,
    label: s.label,
    sort_order: Number(s.sort_order ?? 0),
  });

  private mapPlan = (p: any, slabs: any[] = []) => ({
    id: Number(p.id),
    franchise_id: p.franchise_id === null || p.franchise_id === undefined ? null : Number(p.franchise_id),
    franchise_name: p.franchise_name ?? null,
    name: p.name,
    model: p.model,
    percent: Number(p.percent) || 0,
    fixed_amount_minor: Number(p.fixed_amount_minor) || 0,
    min_guarantee_minor: Number(p.min_guarantee_minor) || 0,
    tier_basis: p.tier_basis,
    effective_from: p.effective_from,
    effective_to: p.effective_to,
    status: p.status,
    note: p.note,
    slabs: slabs.map(this.mapSlab),
  });

  async list(franchiseId?: number) {
    const params: unknown[] = [];
    let clause = 'p.deleted_at IS NULL';
    if (franchiseId) { params.push(franchiseId); clause += ` AND p.franchise_id = $${params.length}::bigint`; }
    const plans = await this.db.query<any>(
      `SELECT p.*, f.name AS franchise_name
         FROM royalty_plan p LEFT JOIN franchise f ON f.id = p.franchise_id
        WHERE ${clause}
        ORDER BY p.status = 'active' DESC, lower(p.name)`, params);
    const ids = plans.map((p) => Number(p.id));
    const slabs = ids.length
      ? await this.db.query<any>(`SELECT * FROM royalty_slab WHERE plan_id = ANY($1::bigint[]) ORDER BY plan_id, min_amount_minor`, [ids])
      : [];
    const byPlan = new Map<number, any[]>();
    for (const s of slabs) {
      const k = Number(s.plan_id);
      if (!byPlan.has(k)) byPlan.set(k, []);
      byPlan.get(k)!.push(s);
    }
    return plans.map((p) => this.mapPlan(p, byPlan.get(Number(p.id)) ?? []));
  }

  async get(id: number) {
    const p = await this.db.one<any>(
      `SELECT p.*, f.name AS franchise_name FROM royalty_plan p LEFT JOIN franchise f ON f.id = p.franchise_id
        WHERE p.id = $1::bigint AND p.deleted_at IS NULL`, [id]);
    if (!p) throw new NotFoundException('Royalty plan not found');
    const slabs = await this.db.query<any>(`SELECT * FROM royalty_slab WHERE plan_id = $1::bigint ORDER BY min_amount_minor`, [id]);
    return this.mapPlan(p, slabs);
  }

  private normaliseSlabs(raw: any): RoyaltySlab[] {
    const arr: any[] = Array.isArray(raw?.slabs) ? raw.slabs : [];
    return arr.map((s, i): RoyaltySlab => {
      const min = s.min_amount_minor !== undefined && s.min_amount_minor !== null && s.min_amount_minor !== ''
        ? Math.trunc(Number(s.min_amount_minor)) : rupeesToMinor(s.min_amount ?? 0);
      if (!Number.isFinite(min) || min < 0) throw new BadRequestException(`Band ${i + 1}: the "from ₹" must be a non-negative amount.`);
      let max: number | null = null;
      if (s.max_amount_minor !== undefined && s.max_amount_minor !== null && s.max_amount_minor !== '') max = Math.trunc(Number(s.max_amount_minor));
      else if (s.max_amount !== undefined && s.max_amount !== null && s.max_amount !== '') max = rupeesToMinor(s.max_amount);
      if (max !== null && (!Number.isFinite(max) || max < min)) throw new BadRequestException(`Band ${i + 1}: the "to ₹" must be at least the "from ₹".`);
      const pct = Number(s.percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new BadRequestException(`Band ${i + 1}: the royalty % must be between 0 and 100.`);
      return { min_amount_minor: min, max_amount_minor: max, percent: pct, label: String(s.label ?? 'Band').slice(0, 60), sort_order: i + 1 };
    }).sort((a, b) => a.min_amount_minor - b.min_amount_minor);
  }

  async save(dto: any, me: { id: number }) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the plan a name.');
    const model = MODELS.includes(dto?.model) ? dto.model : 'percent_collected';
    const status = dto?.status === 'inactive' ? 'inactive' : 'active';
    const tierBasis = dto?.tier_basis === 'net' ? 'net' : 'collected';
    // Extract a YYYY-MM-DD from the form input WITHOUT String(x).slice(0,10) (banned by the
    // date-safety guard — a stringified Date silently truncates); a strict regex is the rule.
    const ymd10 = (v: unknown): string => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '')); return m ? m[1] : ''; };
    const from = ymd10(dto?.effective_from);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BadRequestException('An effective-from date is required.');
    const to = dto?.effective_to ? (ymd10(dto.effective_to) || null) : null;
    if (to && to < from) throw new BadRequestException('The effective-to date cannot be before the effective-from date.');

    const percent = Number(dto?.percent) || 0;
    if ((model === 'percent_collected' || model === 'percent_net')) {
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new BadRequestException('The royalty % must be between 0 and 100.');
    }
    const fixedMinor = dto?.fixed_amount_minor !== undefined && dto?.fixed_amount_minor !== null && dto?.fixed_amount_minor !== ''
      ? Math.trunc(Number(dto.fixed_amount_minor)) : rupeesToMinor(dto?.fixed_amount ?? 0);
    if (model === 'fixed' && fixedMinor <= 0) throw new BadRequestException('A fixed plan needs a monthly fee greater than zero.');
    const minGuarMinor = dto?.min_guarantee_minor !== undefined && dto?.min_guarantee_minor !== null && dto?.min_guarantee_minor !== ''
      ? Math.trunc(Number(dto.min_guarantee_minor)) : rupeesToMinor(dto?.min_guarantee ?? 0);

    const slabs = model === 'tiered' ? this.normaliseSlabs(dto) : [];
    if (model === 'tiered' && !slabs.length) throw new BadRequestException('A tiered plan needs at least one revenue band.');

    const franchiseId = dto?.franchise_id ? Number(dto.franchise_id) : null;
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;

    return this.db.tx(async (c) => {
      let planId: number;
      const cols = [name, franchiseId, model, percent, fixedMinor, minGuarMinor, tierBasis, from, to, status, dto?.note ?? null];
      if (id) {
        const upd = await c.query(
          `UPDATE royalty_plan SET name=$2, franchise_id=$3::bigint, model=$4, percent=$5, fixed_amount_minor=$6::bigint,
                  min_guarantee_minor=$7::bigint, tier_basis=$8, effective_from=$9::date, effective_to=$10::date,
                  status=$11, note=$12, updated_at=now()
            WHERE id=$1::bigint AND deleted_at IS NULL RETURNING id`,
          [id, ...cols]);
        if (!upd.rowCount) throw new NotFoundException('Royalty plan not found');
        planId = id;
        await c.query(`DELETE FROM royalty_slab WHERE plan_id = $1::bigint`, [planId]);
      } else {
        const ins = await c.query(
          `INSERT INTO royalty_plan (org_id, name, franchise_id, model, percent, fixed_amount_minor,
                  min_guarantee_minor, tier_basis, effective_from, effective_to, status, note, created_by)
           VALUES ($1::bigint,$2,$3::bigint,$4,$5,$6::bigint,$7::bigint,$8,$9::date,$10::date,$11,$12,$13::bigint) RETURNING id`,
          [orgId, ...cols, me.id]);
        planId = Number(ins.rows[0].id);
      }
      for (const s of slabs) {
        await c.query(
          `INSERT INTO royalty_slab (plan_id, min_amount_minor, max_amount_minor, percent, label, sort_order)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4,$5,$6::int)`,
          [planId, s.min_amount_minor, s.max_amount_minor, s.percent, s.label, s.sort_order]);
      }
      return { id: planId };
    });
  }

  async remove(id: number, me: { id: number }) {
    const r = await this.db.query<{ id: string }>(
      `UPDATE royalty_plan SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`, [id, me.id]);
    if (!r.length) throw new NotFoundException('Royalty plan not found');
    return { id, ok: true };
  }

  /** Preview: what does this plan produce for a given collected + refunds (paise), over `months`. */
  async compute(id: number, grossMinor: number, refundsMinor: number, months: number) {
    const plan = await this.get(id);
    return computeRoyalty(
      { model: plan.model, percent: plan.percent, fixed_amount_minor: plan.fixed_amount_minor,
        min_guarantee_minor: plan.min_guarantee_minor, tier_basis: plan.tier_basis === 'net' ? 'net' : 'collected',
        slabs: plan.slabs },
      { gross_collected_minor: grossMinor, refunds_minor: refundsMinor },
      months,
    );
  }

  /** The royalty STATEMENT for a franchise + period: revenue, rate applied, adjustments, payable. */
  async statement(franchiseId: number, opts: { from?: string; to?: string; plan_id?: number; adjustments_minor?: number } = {}) {
    const dr = assertDateRange(opts.from, opts.to);
    const scope = await this.franchises.scope(franchiseId);
    const rev = await this.franchises.revenueForBranches(scope.branch_ids, dr.from, dr.to);
    const months = monthsInPeriod(dr.from, dr.to);

    // Explicit plan wins; otherwise the franchise's active plan effective in the period.
    let planRow: any = null; let slabs: any[] = [];
    if (opts.plan_id) {
      const p = await this.get(opts.plan_id);
      planRow = { ...p }; slabs = p.slabs;
    } else {
      const active = await this.franchises.activePlan(franchiseId, dr.from, dr.to);
      if (active) { planRow = active.row; slabs = active.slabs; }
    }

    const adjustments = Math.trunc(Number(opts.adjustments_minor) || 0);
    let computation: any = null;
    let payable = adjustments;
    if (planRow) {
      computation = computeRoyalty(FranchiseService.toCompute(planRow, slabs),
        { gross_collected_minor: rev.gross_collected_minor, refunds_minor: rev.refunds_minor }, months);
      payable = computation.royalty_minor + adjustments;
    }

    return {
      franchise: { id: scope.franchise_id, name: scope.name, code: scope.code },
      branch_ids: scope.branch_ids,
      period: { from: dr.from ?? null, to: dr.to ?? null, months },
      plan: planRow ? {
        id: Number(planRow.id), name: planRow.name, model: planRow.model,
        percent: Number(planRow.percent) || 0, fixed_amount_minor: Number(planRow.fixed_amount_minor) || 0,
        min_guarantee_minor: Number(planRow.min_guarantee_minor) || 0, tier_basis: planRow.tier_basis,
      } : null,
      revenue: {
        gross_collected_minor: rev.gross_collected_minor,
        refunds_minor: rev.refunds_minor,
        net_collected_minor: rev.net_collected_minor,
        receipts: rev.receipts,
      },
      computation,
      adjustments_minor: adjustments,
      royalty_minor: computation ? computation.royalty_minor : 0,
      payable_minor: payable,
    };
  }
}
