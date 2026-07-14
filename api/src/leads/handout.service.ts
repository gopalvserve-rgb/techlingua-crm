import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { DistributionConfig } from './distribution.util';
import { FollowUpsService } from './followups.service';

/**
 * ON-DEMAND "START CALLING" HAND-OUT (PROJECT_DOCUMENTATION §4.1, Sprint 2 / WS4).
 *
 * An `on_demand` campaign leaves every incoming lead UNASSIGNED (owner_id IS NULL)
 * — that is the pool. An agent clicks **Start Calling** and the system hands them
 * the next batch (default 10, `distribution_config.batch_size` per campaign),
 * assigning those leads to them. This service is the whole rule set:
 *
 * THE RULES (all three are decisions — recorded in the decision log):
 *
 *  1. BATCH SIZE — `campaign.distribution_config.batch_size`, default **10** (§4).
 *     A client may ask for fewer (`size` in the body, 1..batch_size) — never more.
 *
 *  2. ORDER — **priority band first (high → med → low), then oldest-first**
 *     (created_at ASC, id ASC). §4 does not fix an order, but it does make Priority
 *     a first-class campaign/lead setting; a queue that buries a High-priority lead
 *     behind 500 old ones would make that setting meaningless. Within a band it is
 *     strict FIFO, so nothing starves. Flipping this to pure FIFO = the ORDER BY below.
 *
 *  3. GUARDRAIL (anti-hoarding) — CONFIGURABLE, **default OFF** (app_setting
 *     `handout_guard`). §4 defines no hoarding rule, so the default must not invent
 *     one. Turned on, an agent cannot pull a fresh batch until `min_actioned_pct` %
 *     of their open batch has been actioned (409, with the numbers in the message).
 *     With it OFF, pulling again simply supersedes the previous batch ('closed') —
 *     the unworked leads STAY assigned to the agent and stay in their lead list;
 *     nothing is silently returned to the pool.
 *
 * RACE SAFETY: the claim is a single `FOR UPDATE ... SKIP LOCKED` statement (the
 * pattern the import queue already uses). Two agents clicking at the same instant
 * lock disjoint row sets, so a lead can never be handed to two people; the loser of
 * a race simply gets the next leads down the queue. `lead_handout_item` additionally
 * carries UNIQUE(lead_id).
 *
 * TELEPHONY IS OUT OF SCOPE: this is a work queue, not a dialler. Nothing here dials.
 */

/** Scope columns for `campaign c` (the hand-out screens scope through the campaign). */
export const CAMPAIGN_SCOPE_COLS: ScopeColumnMap = {
  branch: 'c.branch_id', vertical: 'c.vertical_id', pipeline: 'c.pipeline_id', campaign: 'c.id',
};

export const HANDOUT_DEFAULT_SIZE = 10;

/** Hand-out order: priority band, then oldest-first. Shared by the claim and the previews. */
const ORDER_BY = `CASE l.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, l.created_at, l.id`;

/** A lead is "in the pool" when it is unassigned, live, and not closed (won/lost). */
const POOL_WHERE = `l.owner_id IS NULL AND l.is_active AND l.deleted_at IS NULL
  AND COALESCE(st.stage_type, 'open') NOT IN ('won', 'lost')
  AND NOT EXISTS (SELECT 1 FROM lead_handout_item hi WHERE hi.lead_id = l.id)`;

export interface HandoutGuard { enabled: boolean; min_actioned_pct: number }
export const GUARD_OFF: HandoutGuard = { enabled: false, min_actioned_pct: 100 };

export interface DispositionDto {
  lead_id: number;
  disposition_id?: number | null;
  stage_id?: number | null;
  status_id?: number | null;
  temperature?: 'hot' | 'warm' | 'cold' | null;
  priority?: 'low' | 'med' | 'high';
  note?: string | null;
  next_follow_up_at?: string | null;
}

@Injectable()
export class HandoutService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly followups: FollowUpsService,
  ) {}

  // ---- settings -----------------------------------------------------------

  /** The anti-hoarding guardrail. Absent / malformed row => OFF (never block by accident). */
  async guard(): Promise<HandoutGuard> {
    const row = await this.db.one<{ value: unknown }>(`SELECT value FROM app_setting WHERE key = 'handout_guard'`);
    const v = (row?.value ?? {}) as Record<string, unknown>;
    const pct = Number(v.min_actioned_pct);
    return {
      enabled: v.enabled === true,
      min_actioned_pct: Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct : 100,
    };
  }

  // ---- eligibility (the campaign side) ------------------------------------

  /**
   * Everything that must be true before an agent may pull from a campaign:
   * in the caller's RBAC record scope · live campaign · mode = on_demand ·
   * the caller is in the campaign's agent pool (an EMPTY pool means "anyone in
   * scope may self-assign" — the rule the campaign form already documents) ·
   * the caller is an active user.
   */
  private async eligibleCampaign(campaignId: number, userId: number, scope: ResolvedScope) {
    await this.enforcer.assertRefInScope(scope, 'campaign', campaignId, userId);
    const camp = await this.db.one<any>(
      `SELECT c.id, c.org_id, c.branch_id, c.vertical_id, c.pipeline_id, c.name, c.distribution_config
         FROM campaign c WHERE c.id = $1 AND c.is_active AND c.deleted_at IS NULL`,
      [campaignId],
    );
    if (!camp) throw new NotFoundException('campaign not found');

    const dist = (camp.distribution_config ?? {}) as DistributionConfig;
    const mode = dist.mode ?? 'on_demand';
    if (mode !== 'on_demand') {
      throw new BadRequestException(
        `"${camp.name}" distributes leads automatically (${mode === 'equal' ? 'Equal' : 'Conditional'}) — `
        + 'Start Calling only applies to On Demand campaigns, where leads wait in a pool.',
      );
    }
    const pool = Array.isArray(dist.agent_user_ids) ? dist.agent_user_ids.map(Number) : [];
    if (pool.length && !pool.includes(Number(userId))) {
      throw new ForbiddenException(`You are not in the agent pool of "${camp.name}" — ask an admin to add you to the campaign.`);
    }
    const active = await this.db.one(
      `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [userId],
    );
    if (!active) throw new ForbiddenException('your user account is not active');

    const batch = Number(dist.batch_size);
    return {
      camp,
      batchSize: Number.isInteger(batch) && batch > 0 ? batch : HANDOUT_DEFAULT_SIZE,
      agentPool: pool,
    };
  }

  /** How many leads are waiting in a campaign's pool right now. */
  async waiting(campaignId: number): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lead l
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE l.campaign_id = $1 AND ${POOL_WHERE}`,
      [campaignId],
    );
    return row?.n ?? 0;
  }

  // ---- what an agent can pull from (the Start Calling screen's picker) -----

  /** On-demand campaigns the caller may pull from, with pool sizes. */
  async campaigns(userId: number, scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, CAMPAIGN_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT c.id, c.name, c.distribution_config,
              b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name,
              (SELECT COUNT(*)::int FROM lead l
                 LEFT JOIN pipeline_stage st ON st.id = l.stage_id
                WHERE l.campaign_id = c.id AND ${POOL_WHERE}) AS waiting
         FROM campaign c
         JOIN branch b   ON b.id = c.branch_id
         JOIN vertical v ON v.id = c.vertical_id
         JOIN pipeline p ON p.id = c.pipeline_id
        WHERE (${where}) AND c.is_active AND c.deleted_at IS NULL
          AND COALESCE(c.distribution_config->>'mode', 'on_demand') = 'on_demand'
        ORDER BY c.name`,
      params,
    );
    return rows
      .filter((r) => {
        const pool = (r.distribution_config?.agent_user_ids ?? []) as number[];
        return !pool.length || pool.map(Number).includes(Number(userId));   // empty pool = anyone in scope
      })
      .map((r) => ({
        id: Number(r.id), name: r.name,
        branch_name: r.branch_name, vertical_name: r.vertical_name, pipeline_name: r.pipeline_name,
        batch_size: Number(r.distribution_config?.batch_size) > 0 ? Number(r.distribution_config.batch_size) : HANDOUT_DEFAULT_SIZE,
        waiting: Number(r.waiting),
      }));
  }

  // ---- the hand-out itself -------------------------------------------------

  /**
   * Claim the next N unassigned leads of a campaign and assign them to the agent.
   * Atomic + race-safe (FOR UPDATE SKIP LOCKED). An empty pool is NOT an error:
   * it returns `{ status: 'empty' }` so the UI can render a clean empty state.
   */
  async pull(campaignId: number, userId: number, scope: ResolvedScope, requested?: number) {
    const { camp, batchSize } = await this.eligibleCampaign(campaignId, userId, scope);

    // the caller may ask for FEWER than the campaign's batch size, never more
    let size = batchSize;
    if (requested != null) {
      const n = Number(requested);
      if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('size must be a positive integer');
      size = Math.min(n, batchSize);
    }

    // guardrail (default OFF) — see the class doc
    const guard = await this.guard();
    const open = await this.openBatches(userId);
    if (guard.enabled) {
      const blocking = open.find((h) => this.pct(h) < guard.min_actioned_pct);
      if (blocking) {
        throw new ConflictException(
          `Finish your current batch first — ${blocking.actioned_count} of ${blocking.size} leads actioned `
          + `(${guard.min_actioned_pct}% required). Log a disposition on the rest, then pull again.`,
        );
      }
    }

    const out = await this.db.tx(async (c) => {
      const claimed = await this.claim(c, campaignId, userId, size);
      if (!claimed.length) return null;

      // guardrail OFF: a fresh pull supersedes the previous open batch(es) for this
      // campaign. Their leads STAY assigned to the agent — nothing goes back to the pool.
      await c.query(
        `UPDATE lead_handout SET status = 'closed', completed_at = now()
          WHERE user_id = $1 AND campaign_id = $2 AND status = 'open'`,
        [userId, campaignId],
      );

      const h = await c.query(
        `INSERT INTO lead_handout (org_id, branch_id, vertical_id, pipeline_id, campaign_id, user_id,
                                   requested_size, size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
        [Number(camp.org_id), Number(camp.branch_id), Number(camp.vertical_id), Number(camp.pipeline_id),
          campaignId, userId, size, claimed.length],
      );
      const handoutId = Number(h.rows[0].id);

      for (let i = 0; i < claimed.length; i++) {
        const lead = claimed[i];
        await c.query(
          `INSERT INTO lead_handout_item (handout_id, lead_id, position) VALUES ($1,$2,$3)`,
          [handoutId, Number(lead.id), i + 1],
        );
        // every assignment is on the lead's timeline, exactly like the auto-distribution engine
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
           VALUES ($1,$2,$3,$4,'assign',$5,$6,$7)`,
          [Number(lead.id), Number(camp.org_id), Number(camp.branch_id), userId,
            JSON.stringify({ owner_id: null }), JSON.stringify({ owner_id: userId, handout_id: handoutId }),
            `Start Calling — lead ${i + 1} of ${claimed.length} handed out from the "${camp.name}" pool (On Demand)`],
        );
      }

      // ONE precise, transactional audit row per hand-out (the interceptor skips this
      // route — see common/audit.interceptor.ts — so the ids below are the record).
      await c.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
         VALUES ($1,$2,'lead_handout',$3,'handout',$4)`,
        [Number(camp.org_id), userId, handoutId,
          JSON.stringify({
            handout_id: handoutId, campaign_id: campaignId, user_id: userId,
            size: claimed.length, requested: size, lead_ids: claimed.map((l) => Number(l.id)),
          })],
      );
      return handoutId;
    });

    if (out == null) {
      return {
        status: 'empty' as const, handout: null, leads: [],
        waiting: 0, campaign: { id: campaignId, name: camp.name },
        message: `No leads are waiting in the "${camp.name}" pool right now.`,
      };
    }
    const batch = await this.batch(out, userId);
    return { status: 'ok' as const, ...batch };
  }

  /**
   * THE atomic claim. `FOR UPDATE OF l SKIP LOCKED` makes concurrent pulls disjoint:
   * agent B's transaction skips the rows agent A has locked but not yet committed,
   * and takes the next ones down the queue. The `owner_id IS NULL` re-check in the
   * UPDATE closes the last theoretical gap.
   */
  private async claim(c: PoolClient, campaignId: number, userId: number, size: number): Promise<any[]> {
    const res = await c.query(
      `WITH pool AS (
         SELECT l.id
           FROM lead l
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE l.campaign_id = $1 AND ${POOL_WHERE}
          ORDER BY ${ORDER_BY}
          LIMIT $2
          FOR UPDATE OF l SKIP LOCKED
       )
       UPDATE lead l
          SET owner_id = $3, last_activity_at = now(), updated_at = now()
         FROM pool
        WHERE l.id = pool.id AND l.owner_id IS NULL
       RETURNING l.id, l.full_name, l.phone, l.priority, l.created_at`,
      [campaignId, size, userId],
    );
    // preserve hand-out order (UPDATE ... RETURNING has no defined order)
    return res.rows.slice().sort((a: any, b: any) => {
      const rank = (p: string) => (p === 'high' ? 0 : p === 'med' ? 1 : 2);
      return rank(a.priority) - rank(b.priority)
        || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        || Number(a.id) - Number(b.id);
    });
  }

  // ---- the working queue ---------------------------------------------------

  private pct(h: { size: number; actioned_count: number }): number {
    const size = Number(h.size) || 0;
    if (!size) return 100;
    return Math.round((Number(h.actioned_count) / size) * 100);
  }

  private openBatches(userId: number) {
    return this.db.query<any>(
      `SELECT id, campaign_id, size, actioned_count FROM lead_handout
        WHERE user_id = $1 AND status = 'open' ORDER BY id DESC`, [userId],
    );
  }

  /** One batch + its leads, in hand-out order, with progress — the calling screen. */
  async batch(handoutId: number, userId: number) {
    const h = await this.db.one<any>(
      `SELECT h.*, c.name AS campaign_name, b.name AS branch_name, v.name AS vertical_name
         FROM lead_handout h
         JOIN campaign c ON c.id = h.campaign_id
         JOIN branch b   ON b.id = h.branch_id
         JOIN vertical v ON v.id = h.vertical_id
        WHERE h.id = $1`, [handoutId],
    );
    if (!h) throw new NotFoundException('handout not found');
    // a batch is private to the agent who pulled it (managers use the pool screen)
    if (Number(h.user_id) !== Number(userId)) throw new NotFoundException('handout not found');

    const leads = await this.db.query<any>(
      `SELECT i.position, i.actioned_at, i.disposition_id, d.name AS disposition_name,
              l.id, l.full_name, l.phone, l.email, l.priority, l.temperature, l.score,
              l.stage_id, l.status_id, l.owner_id, l.next_follow_up_at, l.created_at,
              co.name AS course_name, ci.name AS city_name, st.name AS stage_name,
              src.name AS source_name
         FROM lead_handout_item i
         JOIN lead l ON l.id = i.lead_id
         LEFT JOIN m_disposition d ON d.id = i.disposition_id
         LEFT JOIN m_course co ON co.id = l.course_id
         LEFT JOIN city ci ON ci.id = l.city_id
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
         LEFT JOIN source src ON src.id = l.source_id
        WHERE i.handout_id = $1
        ORDER BY i.position`, [handoutId],
    );
    const stages = await this.db.query(
      `SELECT id, name, sort_order, stage_type, is_default FROM pipeline_stage
        WHERE pipeline_id = $1 AND is_active ORDER BY sort_order`, [Number(h.pipeline_id)],
    );
    return {
      handout: {
        id: Number(h.id), campaign_id: Number(h.campaign_id), campaign_name: h.campaign_name,
        branch_name: h.branch_name, vertical_name: h.vertical_name,
        size: Number(h.size), requested_size: Number(h.requested_size),
        actioned_count: Number(h.actioned_count), status: h.status,
        created_at: h.created_at, completed_at: h.completed_at,
      },
      leads, stages,
      waiting: await this.waiting(Number(h.campaign_id)),
    };
  }

  /** The agent's live queue (the most recent open batch), or null when they have none. */
  async current(userId: number) {
    const h = await this.db.one<{ id: string }>(
      `SELECT id FROM lead_handout WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`, [userId],
    );
    if (!h) return { handout: null, leads: [], stages: [], waiting: 0 };
    return this.batch(Number(h.id), userId);
  }

  // ---- working a lead in the queue -----------------------------------------

  /**
   * Log a disposition on one lead of the caller's batch and mark it actioned.
   * This is the queue's "Save & next": it updates the lead (stage/status/priority/
   * temperature), writes a `disposition` activity, optionally schedules the next
   * follow-up (through the existing FollowUpsService, so its own activity + the
   * lead's next_follow_up_at are handled in one place), and advances the progress.
   */
  async action(handoutId: number, dto: DispositionDto, userId: number, scope: ResolvedScope) {
    const item = await this.db.one<any>(
      `SELECT i.id, i.actioned_at, i.position, h.id AS handout_id, h.user_id, h.size, h.status AS handout_status,
              l.id AS lead_id, l.org_id, l.branch_id, l.pipeline_id, l.owner_id, l.stage_id, l.status_id
         FROM lead_handout_item i
         JOIN lead_handout h ON h.id = i.handout_id
         JOIN lead l ON l.id = i.lead_id
        WHERE i.handout_id = $1 AND i.lead_id = $2 AND l.deleted_at IS NULL`,
      [handoutId, Number(dto?.lead_id)],
    );
    if (!item) throw new NotFoundException('lead is not in this batch');
    if (Number(item.user_id) !== Number(userId)) throw new NotFoundException('handout not found');
    if (Number(item.owner_id) !== Number(userId)) {
      throw new ForbiddenException('this lead is no longer assigned to you');
    }

    if (dto.priority != null && !['low', 'med', 'high'].includes(dto.priority)) {
      throw new BadRequestException('invalid priority');
    }
    if (dto.temperature != null && !['hot', 'warm', 'cold'].includes(dto.temperature)) {
      throw new BadRequestException('invalid temperature');
    }
    if (dto.stage_id != null) {
      const stage = await this.db.one<{ pipeline_id: string }>(
        `SELECT pipeline_id FROM pipeline_stage WHERE id = $1`, [Number(dto.stage_id)],
      );
      if (!stage || Number(stage.pipeline_id) !== Number(item.pipeline_id)) {
        throw new BadRequestException('stage does not belong to the lead pipeline');
      }
    }
    if (dto.disposition_id != null) {
      const d = await this.db.one(
        `SELECT id FROM m_disposition WHERE id = $1 AND is_active AND deleted_at IS NULL`, [Number(dto.disposition_id)],
      );
      if (!d) throw new BadRequestException('unknown disposition');
    }

    const leadId = Number(item.lead_id);
    const org = Number(item.org_id);
    const branch = Number(item.branch_id);

    await this.db.tx(async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (dto.stage_id != null && Number(dto.stage_id) !== Number(item.stage_id)) set('stage_id', Number(dto.stage_id));
      if (dto.status_id != null && Number(dto.status_id) !== Number(item.status_id)) set('status_id', Number(dto.status_id));
      if (dto.priority != null) set('priority', dto.priority);
      if (dto.temperature !== undefined) set('temperature', dto.temperature);

      if (sets.length) {
        params.push(leadId);
        await c.query(
          `UPDATE lead SET ${sets.join(', ')}, last_activity_at = now(), updated_at = now()
            WHERE id = $${params.length}`, params,
        );
      } else {
        await c.query(`UPDATE lead SET last_activity_at = now() WHERE id = $1`, [leadId]);
      }
      if (dto.stage_id != null && Number(dto.stage_id) !== Number(item.stage_id)) {
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value)
           VALUES ($1,$2,$3,$4,'stage_change',$5,$6)`,
          [leadId, org, branch, userId,
            JSON.stringify({ id: item.stage_id }), JSON.stringify({ id: Number(dto.stage_id) })],
        );
      }
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note)
         VALUES ($1,$2,$3,$4,'disposition',$5,$6)`,
        [leadId, org, branch, userId,
          JSON.stringify({
            handout_id: handoutId, position: Number(item.position),
            disposition_id: dto.disposition_id ?? null,
          }),
          dto.note?.trim() ? dto.note.trim() : null],
      );

      // idempotent: re-dispositioning the same lead updates it, it does not double-count
      if (!item.actioned_at) {
        await c.query(
          `UPDATE lead_handout_item SET actioned_at = now(), disposition_id = $2 WHERE id = $1`,
          [Number(item.id), dto.disposition_id ?? null],
        );
        await c.query(
          `UPDATE lead_handout SET actioned_count = actioned_count + 1 WHERE id = $1`, [handoutId],
        );
        await c.query(
          `UPDATE lead_handout SET status = 'completed', completed_at = now()
            WHERE id = $1 AND status = 'open' AND actioned_count >= size`, [handoutId],
        );
      } else {
        await c.query(
          `UPDATE lead_handout_item SET disposition_id = $2 WHERE id = $1`,
          [Number(item.id), dto.disposition_id ?? null],
        );
      }
    });

    // the next follow-up goes through the existing service (one place owns follow-ups:
    // its activity row, the lead's next_follow_up_at and the My Tasks views).
    if (dto.next_follow_up_at) {
      await this.followups.create({
        lead_id: leadId, scheduled_at: dto.next_follow_up_at,
        disposition_id: dto.disposition_id ?? undefined,
        notes: dto.note?.trim() || undefined,
        owner_id: userId,
      }, userId, scope);
    }

    return this.batch(handoutId, userId);
  }

  // ---- manager view: pool status per campaign -------------------------------

  /**
   * "How many leads are waiting, and who pulled what and when" — the manager/admin
   * view of every on_demand campaign in their record scope. An `own`-scoped agent
   * gets nothing here (campaigns have no owner column, so buildScopeWhere yields
   * 1=0) — they use the Start Calling screen instead.
   */
  async pool(scope: ResolvedScope, campaignId?: number) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, CAMPAIGN_SCOPE_COLS, params);
    if (campaignId) params.push(campaignId);
    const campFilter = campaignId ? ` AND c.id = $${params.length}` : '';

    const campaigns = await this.db.query<any>(
      `SELECT c.id, c.name, c.distribution_config,
              b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name,
              (SELECT COUNT(*)::int FROM lead l
                 LEFT JOIN pipeline_stage st ON st.id = l.stage_id
                WHERE l.campaign_id = c.id AND ${POOL_WHERE}) AS waiting,
              (SELECT MIN(l.created_at) FROM lead l
                 LEFT JOIN pipeline_stage st ON st.id = l.stage_id
                WHERE l.campaign_id = c.id AND ${POOL_WHERE}) AS oldest_waiting_at,
              (SELECT COUNT(*)::int FROM lead_handout h
                WHERE h.campaign_id = c.id AND h.created_at >= CURRENT_DATE) AS handouts_today,
              (SELECT COALESCE(SUM(h.size), 0)::int FROM lead_handout h
                WHERE h.campaign_id = c.id AND h.created_at >= CURRENT_DATE) AS leads_handed_today,
              (SELECT COUNT(*)::int FROM lead_handout h
                WHERE h.campaign_id = c.id AND h.status = 'open') AS open_batches
         FROM campaign c
         JOIN branch b   ON b.id = c.branch_id
         JOIN vertical v ON v.id = c.vertical_id
         JOIN pipeline p ON p.id = c.pipeline_id
        WHERE (${where}) AND c.is_active AND c.deleted_at IS NULL
          AND COALESCE(c.distribution_config->>'mode', 'on_demand') = 'on_demand'${campFilter}
        ORDER BY waiting DESC, c.name`,
      params,
    );

    const p2: unknown[] = [];
    const where2 = this.resolver.buildScopeWhere(scope, CAMPAIGN_SCOPE_COLS, p2);
    if (campaignId) p2.push(campaignId);
    const campFilter2 = campaignId ? ` AND c.id = $${p2.length}` : '';
    const handouts = await this.db.query<any>(
      `SELECT h.id, h.campaign_id, c.name AS campaign_name, h.user_id, u.name AS user_name,
              h.size, h.actioned_count, h.status, h.created_at, h.completed_at
         FROM lead_handout h
         JOIN campaign c ON c.id = h.campaign_id
         JOIN "user" u ON u.id = h.user_id
        WHERE (${where2})${campFilter2}
        ORDER BY h.id DESC LIMIT 50`,
      p2,
    );

    return {
      campaigns: campaigns.map((c) => ({
        id: Number(c.id), name: c.name,
        branch_name: c.branch_name, vertical_name: c.vertical_name, pipeline_name: c.pipeline_name,
        batch_size: Number(c.distribution_config?.batch_size) > 0 ? Number(c.distribution_config.batch_size) : HANDOUT_DEFAULT_SIZE,
        agents: (c.distribution_config?.agent_user_ids ?? []).length,
        waiting: Number(c.waiting), oldest_waiting_at: c.oldest_waiting_at,
        handouts_today: Number(c.handouts_today), leads_handed_today: Number(c.leads_handed_today),
        open_batches: Number(c.open_batches),
      })),
      handouts: handouts.map((h) => ({
        id: Number(h.id), campaign_id: Number(h.campaign_id), campaign_name: h.campaign_name,
        user_id: Number(h.user_id), user_name: h.user_name,
        size: Number(h.size), actioned_count: Number(h.actioned_count),
        status: h.status, created_at: h.created_at, completed_at: h.completed_at,
      })),
      guard: await this.guard(),
    };
  }
}
