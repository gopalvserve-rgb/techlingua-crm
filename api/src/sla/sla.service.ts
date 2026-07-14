import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';

/**
 * SLA / TAT (Phase-1 scope: "SLA/TAT", feeding the Sprint-6 TAT reports).
 *
 * THE MODEL
 * ---------
 * `sla_policy` is CONFIGURABLE per stage and per pipeline. Two metrics:
 *
 *   first_response  — the clock starts when the lead is CREATED and stops at the first
 *                     human touch (a completed follow-up, a disposition, a note, a stage
 *                     move, an owner assignment). "Respond within N minutes."
 *   stage_duration  — the clock runs while the lead sits in `stage_id` and stops when it
 *                     leaves. "No lead may sit in Negotiation for more than 3 days."
 *
 * MOST SPECIFIC POLICY WINS: a stage-scoped policy beats a pipeline-scoped one, which
 * beats a global one (pipeline_id IS NULL). Exactly one clock per (lead, policy, stage) —
 * enforced by a UNIQUE INDEX, so a replayed event can never open a second clock.
 *
 * BREACH is detected by a set-based sweep in the Sprint-3 worker:
 *     UPDATE lead_sla SET breached_at = now()
 *      WHERE due_at <= now() AND satisfied_at IS NULL AND breached_at IS NULL RETURNING *
 * The claim and the notification commit in the same transaction, so a breach notifies
 * EXACTLY ONCE even with several API replicas.
 *
 * TAT is recorded in `lead_stage_tat`: one row per (lead, stage) visit with entered_at /
 * exited_at / seconds. A partial unique index guarantees a lead is in exactly one stage.
 */

export interface SlaPolicyDto {
  name: string;
  metric: 'first_response' | 'stage_duration';
  pipeline_id?: number | null;
  stage_id?: number | null;
  threshold_minutes: number;
  escalate_after_minutes?: number;
  notify_manager?: boolean;
  is_active?: boolean;
}

@Injectable()
export class SlaService {
  private readonly log = new Logger('SlaService');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /* --------------------------- policies (admin) --------------------------- */

  async listPolicies(includeInactive = false) {
    return this.db.query(
      `SELECT p.id, p.name, p.metric, p.pipeline_id, p.stage_id, p.threshold_minutes,
              p.escalate_after_minutes, p.notify_manager, p.is_active, p.created_at, p.updated_at,
              pl.name AS pipeline_name, st.name AS stage_name
         FROM sla_policy p
         LEFT JOIN pipeline pl ON pl.id = p.pipeline_id
         LEFT JOIN pipeline_stage st ON st.id = p.stage_id
        WHERE p.deleted_at IS NULL ${includeInactive ? '' : 'AND p.is_active'}
        ORDER BY p.metric, p.pipeline_id NULLS FIRST, p.stage_id NULLS FIRST, p.id`,
    );
  }

  private validate(dto: Partial<SlaPolicyDto>, partial = false) {
    const out: Record<string, unknown> = {};
    if (dto.name !== undefined || !partial) {
      const name = String(dto.name ?? '').trim();
      if (!name) throw new BadRequestException('name is required');
      out.name = name;
    }
    if (dto.metric !== undefined || !partial) {
      if (!['first_response', 'stage_duration'].includes(String(dto.metric))) {
        throw new BadRequestException('metric must be first_response or stage_duration');
      }
      out.metric = dto.metric;
    }
    if (dto.threshold_minutes !== undefined || !partial) {
      const t = Number(dto.threshold_minutes);
      if (!Number.isFinite(t) || t <= 0) throw new BadRequestException('threshold_minutes must be a positive number');
      out.threshold_minutes = Math.round(t);
    }
    if (dto.escalate_after_minutes !== undefined) {
      const e = Number(dto.escalate_after_minutes);
      if (!Number.isFinite(e) || e < 0) throw new BadRequestException('escalate_after_minutes must be 0 or more');
      out.escalate_after_minutes = Math.round(e);
    }
    if (dto.pipeline_id !== undefined) out.pipeline_id = dto.pipeline_id ? Number(dto.pipeline_id) : null;
    if (dto.stage_id !== undefined) out.stage_id = dto.stage_id ? Number(dto.stage_id) : null;
    if (dto.notify_manager !== undefined) out.notify_manager = dto.notify_manager !== false;
    if (dto.is_active !== undefined) out.is_active = dto.is_active !== false;
    // a stage_duration policy without a stage would be meaningless
    if (out.metric === 'stage_duration' && !partial && !out.stage_id) {
      throw new BadRequestException('a stage_duration policy must name a stage');
    }
    return out;
  }

  async createPolicy(dto: SlaPolicyDto, actorId: number) {
    const v = this.validate(dto);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const row = await this.db.one(
      `INSERT INTO sla_policy (org_id, name, metric, pipeline_id, stage_id, threshold_minutes,
                               escalate_after_minutes, notify_manager, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [Number(org!.id), v.name, v.metric, v.pipeline_id ?? null, v.stage_id ?? null, v.threshold_minutes,
        v.escalate_after_minutes ?? 0, v.notify_manager ?? true, v.is_active ?? true, actorId],
    );
    return row;
  }

  async updatePolicy(id: number, dto: Partial<SlaPolicyDto>, _actorId: number) {
    const before = await this.db.one(`SELECT * FROM sla_policy WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!before) throw new NotFoundException('SLA policy not found');
    const v = this.validate(dto, true);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, val] of Object.entries(v)) { params.push(val); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    return this.db.one(
      `UPDATE sla_policy SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
  }

  async deletePolicy(id: number, actorId: number) {
    const row = await this.db.one(
      `UPDATE sla_policy SET deleted_at = now(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, name`, [id, actorId],
    );
    if (!row) throw new NotFoundException('SLA policy not found');
    return row;
  }

  /* --------------------------- clocks (lead events) --------------------------- */

  /**
   * Pick the ONE policy that governs a lead for a metric: stage > pipeline > global.
   * `stageId` is only relevant for stage_duration.
   */
  private async policyFor(
    metric: 'first_response' | 'stage_duration', pipelineId: number, stageId: number | null, client?: PoolClient,
  ) {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);
    const rows = await q(
      `SELECT * FROM sla_policy
        WHERE is_active AND deleted_at IS NULL AND metric = $1
          AND (pipeline_id IS NULL OR pipeline_id = $2)
          AND (stage_id IS NULL OR stage_id = $3)
        ORDER BY (stage_id IS NOT NULL) DESC, (pipeline_id IS NOT NULL) DESC, id
        LIMIT 1`,
      [metric, pipelineId, stageId],
    );
    return rows[0] ?? null;
  }

  /**
   * A lead was created: start its first-response clock and open its TAT row.
   * Idempotent — the unique indexes make a replay a no-op (ON CONFLICT DO NOTHING).
   */
  async onLeadCreated(leadId: number, client?: PoolClient): Promise<void> {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);
    const lead = (await q(
      `SELECT id, pipeline_id, stage_id, created_at FROM lead WHERE id = $1`, [leadId],
    ))[0];
    if (!lead) return;

    const policy = await this.policyFor('first_response', Number(lead.pipeline_id), null, client);
    if (policy) {
      await q(
        `INSERT INTO lead_sla (lead_id, policy_id, metric, stage_id, started_at, due_at)
         VALUES ($1, $2, 'first_response', NULL, $3, $3 + ($4 || ' minutes')::interval)
         ON CONFLICT DO NOTHING`,
        [leadId, Number(policy.id), lead.created_at, String(policy.threshold_minutes)],
      );
    }
    if (lead.stage_id) await this.enterStage(leadId, Number(lead.pipeline_id), Number(lead.stage_id), client);
  }

  /**
   * A human touched the lead (follow-up done, disposition, note, stage move, assignment).
   * Stops the first-response clock. A LATE stop still stops it — `satisfied_at` after
   * `due_at` means "responded, but breached", which is exactly what a TAT report wants.
   */
  async onLeadTouched(leadId: number, client?: PoolClient): Promise<void> {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);
    await q(
      `UPDATE lead_sla
          SET satisfied_at = now(),
              elapsed_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
        WHERE lead_id = $1 AND metric = 'first_response' AND satisfied_at IS NULL`,
      [leadId],
    );
  }

  /** Open the TAT row + any stage_duration clock for the stage the lead just entered. */
  private async enterStage(leadId: number, pipelineId: number, stageId: number, client?: PoolClient) {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);
    await q(
      `INSERT INTO lead_stage_tat (lead_id, pipeline_id, stage_id, entered_at)
       VALUES ($1,$2,$3, now()) ON CONFLICT DO NOTHING`,
      [leadId, pipelineId, stageId],
    );
    const policy = await this.policyFor('stage_duration', pipelineId, stageId, client);
    if (policy) {
      await q(
        `INSERT INTO lead_sla (lead_id, policy_id, metric, stage_id, started_at, due_at)
         VALUES ($1,$2,'stage_duration',$3, now(), now() + ($4 || ' minutes')::interval)
         ON CONFLICT DO NOTHING`,
        [leadId, Number(policy.id), stageId, String(policy.threshold_minutes)],
      );
    }
  }

  /**
   * The lead moved stage: close the open TAT row (that is the TAT number), satisfy the
   * old stage's clock, and open the new stage's TAT + clock. Also counts as a human
   * touch, so the first-response clock stops here too.
   */
  async onStageChanged(leadId: number, toStageId: number | null, client?: PoolClient): Promise<void> {
    const q = async (sql: string, params: unknown[]) =>
      client ? (await client.query(sql, params as any[])).rows : this.db.query(sql, params);

    await this.onLeadTouched(leadId, client);

    const open = (await q(
      `SELECT id, stage_id FROM lead_stage_tat WHERE lead_id = $1 AND exited_at IS NULL LIMIT 1`, [leadId],
    ))[0];

    if (open && Number(open.stage_id) === Number(toStageId)) return;   // no real move

    if (open) {
      await q(
        `UPDATE lead_stage_tat
            SET exited_at = now(), seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - entered_at))::int)
          WHERE id = $1`, [Number(open.id)],
      );
      await q(
        `UPDATE lead_sla
            SET satisfied_at = now(),
                elapsed_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
          WHERE lead_id = $1 AND metric = 'stage_duration' AND stage_id = $2 AND satisfied_at IS NULL`,
        [leadId, Number(open.stage_id)],
      );
    }

    if (!toStageId) return;
    const lead = (await q(`SELECT pipeline_id FROM lead WHERE id = $1`, [leadId]))[0];
    if (lead) await this.enterStage(leadId, Number(lead.pipeline_id), Number(toStageId), client);
  }

  /** Never let SLA bookkeeping break the operation that triggered it. */
  async safe(fn: () => Promise<void>, what: string): Promise<void> {
    try { await fn(); } catch (e) { this.log.warn(`${what} failed: ${(e as Error).message}`); }
  }

  /* --------------------------- reads (UI) --------------------------- */

  /** SLA state of one lead — the badge on the lead sheet. */
  async forLead(leadId: number) {
    const clocks = await this.db.query(
      `SELECT s.id, s.metric, s.stage_id, s.started_at, s.due_at, s.satisfied_at, s.breached_at,
              s.elapsed_seconds, p.name AS policy_name, p.threshold_minutes, st.name AS stage_name,
              (s.satisfied_at IS NULL AND s.due_at <= now()) OR s.breached_at IS NOT NULL AS is_breached
         FROM lead_sla s
         JOIN sla_policy p ON p.id = s.policy_id
         LEFT JOIN pipeline_stage st ON st.id = s.stage_id
        WHERE s.lead_id = $1
        ORDER BY s.started_at`, [leadId],
    );
    const tat = await this.db.query(
      `SELECT t.id, t.stage_id, st.name AS stage_name, t.entered_at, t.exited_at, t.seconds
         FROM lead_stage_tat t JOIN pipeline_stage st ON st.id = t.stage_id
        WHERE t.lead_id = $1 ORDER BY t.entered_at`, [leadId],
    );
    return { clocks, tat };
  }

  /** The MANAGER VIEW: every breached, unsatisfied clock inside the caller's scope. */
  async breaches(scope: ResolvedScope, limit = 100) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    params.push(Math.min(Number(limit) || 100, 500));
    return this.db.query(
      `SELECT s.id, s.lead_id, s.metric, s.started_at, s.due_at, s.breached_at, s.satisfied_at,
              GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.satisfied_at, now()) - s.due_at))::int) AS overdue_seconds,
              p.name AS policy_name, p.threshold_minutes,
              l.full_name AS lead_name, l.phone AS lead_phone, l.temperature, l.score,
              u.name AS owner_name, l.owner_id, b.name AS branch_name, st.name AS stage_name
         FROM lead_sla s
         JOIN sla_policy p ON p.id = s.policy_id
         JOIN lead l ON l.id = s.lead_id
         LEFT JOIN "user" u ON u.id = l.owner_id
         JOIN branch b ON b.id = l.branch_id
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE (${w}) AND l.deleted_at IS NULL AND l.is_active
          AND s.satisfied_at IS NULL AND s.due_at <= now()
        ORDER BY s.due_at
        LIMIT $${params.length}`, params,
    );
  }

  /** KPI strip for the SLA & TAT screen — scoped. Feeds the Sprint-6 TAT reports too. */
  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    const kpis = await this.db.one(
      `SELECT
         COUNT(*) FILTER (WHERE s.satisfied_at IS NULL AND s.due_at <= now())::int AS open_breaches,
         COUNT(*) FILTER (WHERE s.breached_at IS NOT NULL
                            AND s.breached_at >= date_trunc('day', now()))::int AS breaches_today,
         COUNT(*) FILTER (WHERE s.notified_at IS NOT NULL
                            AND s.notified_at >= date_trunc('day', now()))::int AS escalated_today,
         COUNT(*) FILTER (WHERE s.metric = 'first_response' AND s.satisfied_at IS NOT NULL)::int AS responded,
         COALESCE(ROUND(AVG(s.elapsed_seconds) FILTER (WHERE s.metric = 'first_response'
                                                         AND s.satisfied_at IS NOT NULL))::int, 0) AS avg_response_seconds,
         COUNT(*) FILTER (WHERE s.metric = 'first_response' AND s.satisfied_at IS NOT NULL
                            AND s.satisfied_at <= s.due_at)::int AS met_on_time
         FROM lead_sla s JOIN lead l ON l.id = s.lead_id
        WHERE (${w}) AND l.deleted_at IS NULL AND l.is_active`, params,
    );
    const p2: unknown[] = [];
    const w2 = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p2);
    const tat = await this.db.query(
      `SELECT st.name AS stage_name, st.sort_order,
              COUNT(*)::int AS moves,
              COALESCE(ROUND(AVG(t.seconds))::int, 0) AS avg_seconds
         FROM lead_stage_tat t
         JOIN lead l ON l.id = t.lead_id
         JOIN pipeline_stage st ON st.id = t.stage_id
        WHERE (${w2}) AND t.exited_at IS NOT NULL AND l.deleted_at IS NULL
        GROUP BY st.name, st.sort_order
        ORDER BY st.sort_order`, p2,
    );
    return { kpis, tat };
  }
}
