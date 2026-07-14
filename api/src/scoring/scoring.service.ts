import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import {
  DEFAULT_SCORE_CONFIG, EVALUATORS, LeadFacts, RULE_TYPES, ScoreConfig, ScoreRule, scoreLead,
} from './score.engine';

/**
 * Applies the (pure) score engine to real leads and keeps `lead.score`,
 * `lead.temperature` (the Hot/Warm/Cold BAND) and `lead.score_breakdown` current.
 *
 * RECOMPUTE TRIGGERS (client: "recomputes on lead events, not a nightly-only job"):
 *   · lead created            — LeadIngestionService + manual Add Lead
 *   · lead updated            — stage/status/field change, merge
 *   · follow-up created/completed/disposition
 *   · walk-in / referral captured
 *   · hand-out disposition
 *   · rules or bands edited   — recomputeAll()
 *   · ageing                  — the Sprint-3 worker re-scores STALE open leads every tick
 *                               (that is what makes `no_response_days` actually fire)
 *
 * Scoring never throws into its caller: a lead must still be created if scoring
 * hiccups (`safeRescore`). The score is a derived value, not a business invariant.
 */
@Injectable()
export class ScoringService {
  private readonly log = new Logger('ScoringService');

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /* ------------------------------ config + rules ------------------------------ */

  async config(): Promise<ScoreConfig & { age_sweep_hours: number }> {
    const raw = await this.settings.get('lead_score_config', {
      ...DEFAULT_SCORE_CONFIG, age_sweep_hours: 6,
    } as unknown as Record<string, unknown>);
    const bands = (raw.bands ?? DEFAULT_SCORE_CONFIG.bands) as { hot: number; warm: number };
    return {
      bands: { hot: Number(bands.hot ?? 70), warm: Number(bands.warm ?? 40) },
      min: Number(raw.min ?? 0),
      max: Number(raw.max ?? 100),
      age_sweep_hours: Number(raw.age_sweep_hours ?? 6),
    };
  }

  async saveConfig(body: Record<string, unknown>, actorId: number) {
    const cur = await this.config();
    const hot = body.hot !== undefined ? Number(body.hot) : cur.bands.hot;
    const warm = body.warm !== undefined ? Number(body.warm) : cur.bands.warm;
    const min = body.min !== undefined ? Number(body.min) : cur.min;
    const max = body.max !== undefined ? Number(body.max) : cur.max;
    if (![hot, warm, min, max].every(Number.isFinite)) throw new BadRequestException('bands must be numbers');
    if (warm >= hot) throw new BadRequestException('the Warm threshold must be below the Hot threshold');
    if (min >= max) throw new BadRequestException('min must be below max');
    await this.settings.set('lead_score_config', {
      bands: { hot, warm }, min, max, age_sweep_hours: cur.age_sweep_hours,
    }, actorId);
    // a band change re-bands every lead — otherwise the list would lie until the next event
    const n = await this.recomputeAll();
    return { bands: { hot, warm }, min, max, rescored: n };
  }

  ruleTypes() { return RULE_TYPES; }

  async listRules(includeInactive = false) {
    return this.db.query(
      `SELECT r.id, r.name, r.rule_type, r.config, r.points, r.sort_order, r.is_active,
              r.created_at, r.updated_at
         FROM lead_score_rule r
        WHERE r.deleted_at IS NULL ${includeInactive ? '' : 'AND r.is_active'}
        ORDER BY r.sort_order, r.id`,
    );
  }

  private validateRule(dto: Record<string, unknown>, partial = false) {
    const out: Record<string, unknown> = {};
    if (dto.name !== undefined || !partial) {
      const name = String(dto.name ?? '').trim();
      if (!name) throw new BadRequestException('name is required');
      out.name = name;
    }
    if (dto.rule_type !== undefined || !partial) {
      const t = String(dto.rule_type ?? '');
      if (!EVALUATORS[t]) {
        throw new BadRequestException(`unknown rule type "${t}" — expected one of: ${Object.keys(EVALUATORS).join(', ')}`);
      }
      out.rule_type = t;
    }
    if (dto.points !== undefined || !partial) {
      const p = Number(dto.points);
      if (!Number.isFinite(p)) throw new BadRequestException('points must be a number (negative = a penalty)');
      out.points = Math.round(p);
    }
    if (dto.config !== undefined) {
      const c = dto.config;
      if (c !== null && (typeof c !== 'object' || Array.isArray(c))) throw new BadRequestException('config must be an object');
      out.config = c ?? {};
    }
    if (dto.sort_order !== undefined) out.sort_order = Number(dto.sort_order) || 0;
    if (dto.is_active !== undefined) out.is_active = dto.is_active !== false && dto.is_active !== 'false';
    return out;
  }

  async createRule(dto: Record<string, unknown>, actorId: number) {
    const v = this.validateRule(dto);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const row = await this.db.one(
      `INSERT INTO lead_score_rule (org_id, name, rule_type, config, points, sort_order, is_active, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`,
      [Number(org!.id), v.name, v.rule_type, JSON.stringify(v.config ?? {}), v.points,
        v.sort_order ?? 0, v.is_active ?? true, actorId],
    );
    await this.recomputeAll();
    return row;
  }

  async updateRule(id: number, dto: Record<string, unknown>, actorId: number) {
    const before = await this.db.one(`SELECT * FROM lead_score_rule WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!before) throw new NotFoundException('scoring rule not found');
    const v = this.validateRule(dto, true);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, val] of Object.entries(v)) {
      params.push(k === 'config' ? JSON.stringify(val) : val);
      sets.push(`${k} = $${params.length}${k === 'config' ? '::jsonb' : ''}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const row = await this.db.one(
      `UPDATE lead_score_rule SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
    await this.recomputeAll();
    return row;
  }

  async deleteRule(id: number, actorId: number) {
    const row = await this.db.one(
      `UPDATE lead_score_rule SET deleted_at = now(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, name`, [id, actorId],
    );
    if (!row) throw new NotFoundException('scoring rule not found');
    await this.recomputeAll();
    return row;
  }

  /* ------------------------------ scoring ------------------------------ */

  private async rules(): Promise<ScoreRule[]> {
    const rows = await this.db.query(
      `SELECT id, name, rule_type, config, points, sort_order, is_active
         FROM lead_score_rule WHERE deleted_at IS NULL AND is_active ORDER BY sort_order, id`,
    );
    return rows.map((r) => ({
      id: Number(r.id), name: String(r.name), rule_type: String(r.rule_type),
      config: (r.config ?? {}) as Record<string, unknown>, points: Number(r.points),
      is_active: r.is_active !== false, sort_order: Number(r.sort_order ?? 0),
    }));
  }

  /**
   * The FACTS query — one row per lead, everything the engine may look at.
   * `days_since_activity` / `days_since_created` are computed in SQL so the engine
   * stays clock-free and therefore deterministic in tests.
   */
  private factsSql(where: string) {
    return `
      SELECT l.id AS lead_id, l.source_id, so.channel AS source_channel, l.campaign_id, l.course_id,
             l.budget_id,
             NULLIF(bu.meta->>'amount', '')::numeric AS budget_amount,
             l.priority, l.email, l.whatsapp_phone, l.alt_phone,
             st.stage_type, l.is_duplicate,
             EXISTS (SELECT 1 FROM walk_in w WHERE w.lead_id = l.id AND w.deleted_at IS NULL) AS is_walk_in,
             EXISTS (SELECT 1 FROM referral rf WHERE rf.lead_id = l.id AND rf.deleted_at IS NULL) AS is_referral,
             (SELECT COUNT(*) FROM follow_up f
               WHERE f.lead_id = l.id AND f.status = 'done' AND f.deleted_at IS NULL)::int AS followups_done,
             GREATEST(0, EXTRACT(DAY FROM (now() - COALESCE(l.last_activity_at, l.created_at)))::int) AS days_since_activity,
             GREATEST(0, EXTRACT(DAY FROM (now() - l.created_at))::int) AS days_since_created
        FROM lead l
        LEFT JOIN source so ON so.id = l.source_id
        LEFT JOIN m_budget bu ON bu.id = l.budget_id
        LEFT JOIN pipeline_stage st ON st.id = l.stage_id
       WHERE ${where}`;
  }

  private toFacts(r: Record<string, any>): LeadFacts {
    return {
      lead_id: Number(r.lead_id),
      source_id: r.source_id != null ? Number(r.source_id) : null,
      source_channel: r.source_channel ?? null,
      campaign_id: r.campaign_id != null ? Number(r.campaign_id) : null,
      course_id: r.course_id != null ? Number(r.course_id) : null,
      budget_id: r.budget_id != null ? Number(r.budget_id) : null,
      budget_amount: r.budget_amount != null ? Number(r.budget_amount) : null,
      priority: r.priority ?? null,
      email: r.email ?? null,
      whatsapp_phone: r.whatsapp_phone ?? null,
      alt_phone: r.alt_phone ?? null,
      stage_type: r.stage_type ?? null,
      is_duplicate: r.is_duplicate === true,
      is_walk_in: r.is_walk_in === true,
      is_referral: r.is_referral === true,
      followups_done: Number(r.followups_done ?? 0),
      days_since_activity: Number(r.days_since_activity ?? 0),
      days_since_created: Number(r.days_since_created ?? 0),
    };
  }

  /** Score ONE lead and persist score + band + breakdown. Returns null if the lead is gone. */
  async rescore(leadId: number, client?: PoolClient) {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);

    const rows = await q(this.factsSql('l.id = $1 AND l.deleted_at IS NULL'), [leadId]);
    if (!rows.length) return null;
    const [cfg, rules] = await Promise.all([this.config(), this.rules()]);
    const res = scoreLead(this.toFacts(rows[0]), rules, cfg);
    await q(
      `UPDATE lead SET score = $2, temperature = $3, score_breakdown = $4::jsonb, scored_at = now()
        WHERE id = $1`,
      [leadId, res.score, res.band, JSON.stringify(res.breakdown)],
    );
    return res;
  }

  /**
   * Scoring must NEVER break the operation that triggered it (creating a lead,
   * completing a follow-up). Log and move on — the ageing sweep will pick the
   * lead up on the next tick anyway.
   */
  async safeRescore(leadId: number | null | undefined, client?: PoolClient): Promise<void> {
    if (!leadId) return;
    try { await this.rescore(Number(leadId), client); }
    catch (e) { this.log.warn(`rescore(lead ${leadId}) failed: ${(e as Error).message}`); }
  }

  /** Re-score every live lead (rule/band edits). Batched; returns the count. */
  async recomputeAll(limit = 5000): Promise<number> {
    const [cfg, rules] = await Promise.all([this.config(), this.rules()]);
    const rows = await this.db.query(
      this.factsSql('l.deleted_at IS NULL AND l.is_active') + ` ORDER BY l.id LIMIT ${Number(limit) || 5000}`,
    );
    let n = 0;
    for (const r of rows) {
      const res = scoreLead(this.toFacts(r), rules, cfg);
      await this.db.query(
        `UPDATE lead SET score = $2, temperature = $3, score_breakdown = $4::jsonb, scored_at = now() WHERE id = $1`,
        [Number(r.lead_id), res.score, res.band, JSON.stringify(res.breakdown)],
      );
      n++;
    }
    return n;
  }

  /**
   * THE AGEING SWEEP (worker). Re-scores open leads whose score is stale, so the
   * `no_response_days` / `age_days` penalties actually fire without waiting for a
   * human to touch the lead. Bounded per tick so it never hogs the API process.
   */
  async ageingSweep(batch = 100): Promise<number> {
    const cfg = await this.config();
    const rows = await this.db.query<{ id: string }>(
      `SELECT l.id FROM lead l
        WHERE l.deleted_at IS NULL AND l.is_active
          AND (l.scored_at IS NULL OR l.scored_at < now() - ($1 || ' hours')::interval)
          AND (l.stage_id IS NULL OR EXISTS (
                SELECT 1 FROM pipeline_stage st WHERE st.id = l.stage_id AND st.stage_type = 'open'))
        ORDER BY l.scored_at NULLS FIRST
        LIMIT $2`,
      [String(cfg.age_sweep_hours), batch],
    );
    for (const r of rows) await this.safeRescore(Number(r.id));
    return rows.length;
  }

  /** Band distribution for the Lead Scoring screen — SCOPED (a counsellor sees only their own). */
  async distribution(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    const row = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE l.temperature = 'hot')::int  AS hot,
              COUNT(*) FILTER (WHERE l.temperature = 'warm')::int AS warm,
              COUNT(*) FILTER (WHERE l.temperature = 'cold')::int AS cold,
              COUNT(*) FILTER (WHERE l.temperature IS NULL)::int  AS unscored,
              COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(l.score))::int, 0) AS avg_score
         FROM lead l
        WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL`, params,
    );
    return { ...row, config: await this.config() };
  }
}
