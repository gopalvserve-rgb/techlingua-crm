import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rupeesToMinor } from '../common/money.util';

/**
 * INCENTIVE PLANS (dev/134, Part 1B).
 *
 * A plan is a name + what it applies to + which metric it pays on + an ordered
 * set of achievement SLABS. Every threshold and every amount is editable; the
 * migration seeds one example plan only.
 *
 * THE RESOLVER — resolveIncentive() — is a PURE function and is the single
 * definition of "what does this achievement % earn". The earned slab is the
 * slab with the GREATEST min_pct that is <= the achievement %. This is a
 * tiered lookup, which means:
 *   · a decimal achievement (69.5%) resolves to the 50-69.99 band, never a gap;
 *   · an exact boundary (100%) resolves to the 100-109.99 band (min_pct 100 <= 100);
 *   · below the lowest slab's min_pct there is no slab, so the earned amount is 0.
 * max_pct is a DISPLAY bound only (the printed top of a range) and is never
 * consulted by the resolver, so the printed ranges can be edited freely without
 * ever changing which band a number falls in.
 */

export interface Slab {
  min_pct: number;
  max_pct: number | null;
  tier: string;
  emoji?: string | null;
  label: string;
  amount_minor: number;
  sort_order?: number;
}

export interface Resolved {
  achievement_pct: number;
  slab: Slab | null;
  amount_minor: number;
}

/** PURE. The earned slab + amount for an achievement %. Exported for the unit test. */
export function resolveIncentive(slabs: Slab[], achievementPct: number): Resolved {
  const pct = Number.isFinite(achievementPct) ? achievementPct : 0;
  // Greatest min_pct <= pct. Sort ascending, walk, keep the last that qualifies.
  const sorted = [...slabs].sort((a, b) => a.min_pct - b.min_pct);
  let earned: Slab | null = null;
  for (const s of sorted) {
    if (pct >= s.min_pct) earned = s;
    else break;
  }
  return { achievement_pct: pct, slab: earned, amount_minor: earned ? earned.amount_minor : 0 };
}

const APPLICABLE = ['branch', 'vertical', 'user'];
const METRICS = ['admissions', 'revenue', 'collection', 'leads', 'walkin', 'meeting'];

@Injectable()
export class IncentiveService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private mapSlab = (s: any): Slab => ({
    min_pct: Number(s.min_pct),
    max_pct: s.max_pct === null || s.max_pct === undefined ? null : Number(s.max_pct),
    tier: s.tier,
    emoji: s.emoji ?? null,
    label: s.label,
    amount_minor: Number(s.amount_minor),
    sort_order: s.sort_order === undefined ? undefined : Number(s.sort_order),
  });

  async list() {
    const plans = await this.db.query<any>(
      `SELECT p.id, p.name, p.applicable_to, p.metric, p.status, p.note,
              (SELECT count(*) FROM target_definition td
                WHERE td.incentive_plan_id = p.id AND td.deleted_at IS NULL) AS targets_linked
         FROM incentive_plan p
        WHERE p.deleted_at IS NULL
        ORDER BY p.status = 'active' DESC, lower(p.name)`,
    );
    const ids = plans.map((p) => Number(p.id));
    const slabs = ids.length
      ? await this.db.query<any>(
          `SELECT * FROM incentive_slab WHERE plan_id = ANY($1::bigint[]) ORDER BY plan_id, min_pct`,
          [ids],
        )
      : [];
    const byPlan = new Map<number, Slab[]>();
    for (const s of slabs) {
      const k = Number(s.plan_id);
      if (!byPlan.has(k)) byPlan.set(k, []);
      byPlan.get(k)!.push(this.mapSlab(s));
    }
    return plans.map((p) => ({
      id: Number(p.id),
      name: p.name,
      applicable_to: p.applicable_to,
      metric: p.metric,
      status: p.status,
      note: p.note,
      targets_linked: Number(p.targets_linked ?? 0),
      slabs: byPlan.get(Number(p.id)) ?? [],
    }));
  }

  async get(id: number) {
    const p = await this.db.one<any>(
      `SELECT id, name, applicable_to, metric, status, note FROM incentive_plan WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id],
    );
    if (!p) throw new NotFoundException('Incentive plan not found');
    const slabs = await this.db.query<any>(
      `SELECT * FROM incentive_slab WHERE plan_id = $1::bigint ORDER BY min_pct`, [id],
    );
    return { ...p, id: Number(p.id), slabs: slabs.map(this.mapSlab) };
  }

  /** Compute the earned incentive for a plan at a given achievement %. */
  async compute(id: number, achievementPct: number): Promise<Resolved> {
    const plan = await this.get(id);
    return resolveIncentive(plan.slabs, achievementPct);
  }

  private normaliseSlabs(raw: any): Slab[] {
    const arr: any[] = Array.isArray(raw?.slabs) ? raw.slabs : [];
    if (!arr.length) throw new BadRequestException('An incentive plan needs at least one achievement slab.');
    const slabs = arr.map((s, i): Slab => {
      const min = Number(s.min_pct);
      if (!Number.isFinite(min) || min < 0) throw new BadRequestException(`Slab ${i + 1}: the "from %" must be a non-negative number.`);
      const max = s.max_pct === null || s.max_pct === undefined || s.max_pct === '' ? null : Number(s.max_pct);
      if (max !== null && (!Number.isFinite(max) || max < min)) throw new BadRequestException(`Slab ${i + 1}: the "to %" must be at least the "from %".`);
      let amt: number;
      try {
        amt = s.amount_minor !== undefined && s.amount_minor !== null && s.amount_minor !== ''
          ? Math.trunc(Number(s.amount_minor)) : rupeesToMinor(s.amount ?? 0);
      } catch (e) { throw new BadRequestException(`Slab ${i + 1} amount: ${(e as Error).message}`); }
      if (!Number.isFinite(amt) || amt < 0) throw new BadRequestException(`Slab ${i + 1}: the incentive amount cannot be negative.`);
      return {
        min_pct: min, max_pct: max, tier: String(s.tier ?? 'good').slice(0, 20),
        emoji: s.emoji ? String(s.emoji).slice(0, 8) : null,
        label: String(s.label ?? 'Slab').slice(0, 60), amount_minor: amt, sort_order: i + 1,
      };
    });
    slabs.sort((a, b) => a.min_pct - b.min_pct);
    return slabs;
  }

  async save(dto: any, me: { id: number }) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the plan a name.');
    const applicableTo = String(dto?.applicable_to ?? 'user');
    if (!APPLICABLE.includes(applicableTo)) throw new BadRequestException('Applicable To must be Branch, Vertical or Counsellor.');
    const metric = String(dto?.metric ?? 'admissions');
    if (!METRICS.includes(metric)) throw new BadRequestException('Unknown metric.');
    const status = dto?.status === 'inactive' ? 'inactive' : 'active';
    const slabs = this.normaliseSlabs(dto);
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;

    return this.db.tx(async (c) => {
      let planId: number;
      if (id) {
        const upd = await c.query(
          `UPDATE incentive_plan SET name = $2, applicable_to = $3, metric = $4, status = $5, note = $6, updated_at = now()
            WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`,
          [id, name, applicableTo, metric, status, dto?.note ?? null],
        );
        if (!upd.rowCount) throw new NotFoundException('Incentive plan not found');
        planId = id;
        await c.query(`DELETE FROM incentive_slab WHERE plan_id = $1::bigint`, [planId]);
      } else {
        const ins = await c.query(
          `INSERT INTO incentive_plan (org_id, name, applicable_to, metric, status, note, created_by)
           VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::bigint) RETURNING id`,
          [orgId, name, applicableTo, metric, status, dto?.note ?? null, me.id],
        );
        planId = Number(ins.rows[0].id);
      }
      for (const s of slabs) {
        await c.query(
          `INSERT INTO incentive_slab (plan_id, min_pct, max_pct, tier, emoji, label, amount_minor, sort_order)
           VALUES ($1::bigint, $2, $3, $4, $5, $6, $7::bigint, $8::int)`,
          [planId, s.min_pct, s.max_pct, s.tier, s.emoji, s.label, s.amount_minor, s.sort_order],
        );
      }
      return { id: planId };
    });
  }

  async remove(id: number, me: { id: number }) {
    const linked = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM target_definition WHERE incentive_plan_id = $1::bigint AND deleted_at IS NULL`, [id],
    );
    if (Number(linked?.n ?? 0) > 0) throw new BadRequestException('Unlink this plan from its targets before deleting it.');
    const r = await this.db.query<{ id: string }>(
      `UPDATE incentive_plan SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`,
      [id, me.id],
    );
    if (!r.length) throw new NotFoundException('Incentive plan not found');
    return { id, ok: true };
  }
}
