import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MessagingService } from '../messaging/messaging.service';
import { TemplateService } from '../templates/template.service';
import { NotifierService } from '../notifications/notifier.service';
import { ManagerResolverService } from '../notifications/manager-resolver.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { ResolvedScope } from '../rbac/rbac.types';
import {
  JourneyAction, JourneyDef, LeadFacts, TRIGGERS, matches, normaliseActions, triggerKey, waitMs,
} from './journey.engine';

export interface StepResult {
  kind: string;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
  message_id?: number;
  at: string;
}

/**
 * AUTOMATION JOURNEYS.
 *
 *   fire(trigger, leadId)  — an event happened. Find the active journeys that match,
 *                            CLAIM a run for each (idempotently), and execute it.
 *   execute(runId)         — walk the actions; a `wait` step parks the run and the worker
 *                            picks it up later.
 *
 * THE NO-DOUBLE-SEND GUARANTEE lives in one statement:
 *
 *     INSERT INTO journey_run (...) VALUES (...)
 *     ON CONFLICT (journey_id, lead_id, trigger_key) DO NOTHING
 *     RETURNING id
 *
 * Only the caller that actually inserted gets an id back. Fire the same event twice, run
 * two API replicas, replay a webhook, re-import the CSV — the second attempt returns no
 * row and does nothing. It is not "we check first, then insert" (which races); the unique
 * index IS the check.
 */
@Injectable()
export class JourneyService {
  private readonly log = new Logger('Journeys');

  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly templates: TemplateService,
    private readonly notifier: NotifierService,
    private readonly managers: ManagerResolverService,
    private readonly resolver: ScopeResolverService,
  ) {}

  triggers() { return TRIGGERS; }

  // ------------------------------------------------------------------- CRUD

  async list() {
    return this.db.query<any>(
      `SELECT j.*, b.name AS branch_name, v.name AS vertical_name,
              (SELECT COUNT(*)::int FROM journey_run r WHERE r.journey_id = j.id) AS runs,
              (SELECT COUNT(*)::int FROM journey_run r WHERE r.journey_id = j.id AND r.status = 'failed') AS failures
         FROM journey j
         LEFT JOIN branch b ON b.id = j.branch_id
         LEFT JOIN vertical v ON v.id = j.vertical_id
        WHERE j.deleted_at IS NULL
        ORDER BY j.id DESC`,
    );
  }

  async get(id: number) {
    const row = await this.db.one<any>(`SELECT * FROM journey WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('journey not found');
    return row;
  }

  private validate(dto: any) {
    if (!String(dto?.name ?? '').trim()) throw new BadRequestException('Give the journey a name.');
    const trigger = String(dto?.trigger_type ?? '');
    if (!TRIGGERS.some((t) => t.key === trigger)) throw new BadRequestException('Choose a trigger.');
    const actions = normaliseActions(dto?.actions);
    if (!actions.length) {
      throw new BadRequestException('A journey needs at least one action (send a message, create a task, change the stage, or notify someone).');
    }
    return { trigger, actions };
  }

  async create(dto: any, actorId: number) {
    const { trigger, actions } = this.validate(dto);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return this.db.one<any>(
      `INSERT INTO journey (org_id, name, description, trigger_type, trigger_config, conditions,
                            actions, guardrails, status, branch_id, vertical_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$12) RETURNING *`,
      [
        Number(org!.id), String(dto.name).trim(), dto?.description ?? null, trigger,
        JSON.stringify(dto?.trigger_config ?? {}), JSON.stringify(dto?.conditions ?? {}),
        JSON.stringify(actions), JSON.stringify(dto?.guardrails ?? {}),
        ['draft', 'active', 'paused'].includes(String(dto?.status)) ? String(dto.status) : 'draft',
        dto?.branch_id ? Number(dto.branch_id) : null,
        dto?.vertical_id ? Number(dto.vertical_id) : null,
        actorId,
      ],
    );
  }

  async update(id: number, dto: any, actorId: number) {
    const existing = await this.get(id);
    const merged = { ...existing, ...dto };
    const { trigger, actions } = this.validate(merged);
    return this.db.one<any>(
      `UPDATE journey
          SET name = $2, description = $3, trigger_type = $4, trigger_config = $5::jsonb,
              conditions = $6::jsonb, actions = $7::jsonb, guardrails = $8::jsonb, status = $9,
              branch_id = $10, vertical_id = $11, updated_at = now(), updated_by = $12
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [
        id, String(merged.name).trim(), merged.description ?? null, trigger,
        JSON.stringify(merged.trigger_config ?? {}), JSON.stringify(merged.conditions ?? {}),
        JSON.stringify(actions), JSON.stringify(merged.guardrails ?? {}),
        ['draft', 'active', 'paused'].includes(String(merged.status)) ? String(merged.status) : 'draft',
        merged.branch_id ? Number(merged.branch_id) : null,
        merged.vertical_id ? Number(merged.vertical_id) : null,
        actorId,
      ],
    );
  }

  /** Activate / pause — the client's kill switch. A paused journey fires for nobody. */
  async setStatus(id: number, status: string, actorId: number) {
    if (!['draft', 'active', 'paused'].includes(status)) throw new BadRequestException('Unknown status');
    await this.get(id);
    return this.db.one<any>(
      `UPDATE journey SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
      [id, status, actorId],
    );
  }

  async remove(id: number, actorId: number) {
    await this.get(id);
    await this.db.query(
      `UPDATE journey SET deleted_at = now(), deleted_by = $2, status = 'paused' WHERE id = $1`, [id, actorId],
    );
    return { id, deleted: true };
  }

  /** Run history — per journey, and (on the lead sheet) per lead. */
  async runs(f: { journey_id?: number; lead_id?: number; limit?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (f.journey_id) { params.push(Number(f.journey_id)); where.push(`r.journey_id = $${params.length}`); }
    if (f.lead_id) { params.push(Number(f.lead_id)); where.push(`r.lead_id = $${params.length}`); }
    params.push(Math.min(Number(f.limit) || 100, 300));
    return this.db.query<any>(
      `SELECT r.id, r.journey_id, r.lead_id, r.trigger_key, r.status, r.steps, r.reason,
              r.step_index, r.next_run_at, r.created_at, r.finished_at,
              j.name AS journey_name, j.trigger_type, l.full_name AS lead_name
         FROM journey_run r
         JOIN journey j ON j.id = r.journey_id
         JOIN lead l ON l.id = r.lead_id
        WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  // ------------------------------------------------------------------- fire

  private async facts(leadId: number): Promise<LeadFacts | null> {
    return this.db.one<any>(
      `SELECT id, campaign_id, source_id, branch_id, vertical_id, pipeline_id, stage_id,
              course_id, temperature, priority, score, owner_id, org_id
         FROM lead WHERE id = $1 AND deleted_at IS NULL AND is_active`,
      [leadId],
    );
  }

  private async activeFor(trigger: string): Promise<JourneyDef[]> {
    return this.db.query<any>(
      `SELECT * FROM journey WHERE trigger_type = $1 AND status = 'active' AND deleted_at IS NULL`,
      [trigger],
    );
  }

  /**
   * An event happened. Claim a run per matching journey and execute it.
   * NEVER throws at the caller: a broken journey must not stop a lead being created.
   */
  async fire(trigger: string, leadId: number, ctx: { stage_id?: number | null; days?: number; date?: Date } = {}): Promise<number[]> {
    const ids: number[] = [];
    try {
      const f = await this.facts(leadId);
      if (!f) return ids;
      const journeys = await this.activeFor(trigger);
      for (const j of journeys) {
        if (!matches(j, trigger, f)) continue;
        const key = triggerKey(trigger, { stage_id: ctx.stage_id ?? f.stage_id, days: ctx.days, date: ctx.date });
        const run = await this.claim(Number(j.id), leadId, key, Number((f as any).org_id));
        if (!run) continue;                 // already ran for this exact event — the whole point
        ids.push(run);
        await this.execute(run);
      }
    } catch (e) {
      this.log.warn(`journey fire(${trigger}, lead ${leadId}) failed: ${(e as Error).message}`);
    }
    return ids;
  }

  /** THE claim. Returns an id ONLY to the caller that actually created the run. */
  private async claim(journeyId: number, leadId: number, key: string, orgId: number): Promise<number | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO journey_run (org_id, journey_id, lead_id, trigger_key, status)
       VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (journey_id, lead_id, trigger_key) DO NOTHING
       RETURNING id`,
      [orgId, journeyId, leadId, key],
    );
    return row ? Number(row.id) : null;
  }

  /** Best-effort hook for the ingestion pipeline (never let automation lose a lead). */
  async safeFire(trigger: string, leadId: number, ctx: { stage_id?: number | null } = {}): Promise<void> {
    try { await this.fire(trigger, leadId, ctx); } catch { /* logged inside fire() */ }
  }

  // ---------------------------------------------------------------- execute

  /**
   * Walk the actions from `step_index`. A `wait` parks the run (status stays `pending`,
   * `next_run_at` moves forward) and the worker resumes it — so a 3-day nurture sequence
   * survives a deploy, a restart and a replica change.
   */
  async execute(runId: number): Promise<void> {
    const run = await this.db.one<any>(`SELECT * FROM journey_run WHERE id = $1`, [runId]);
    if (!run || ['done', 'failed', 'skipped'].includes(run.status)) return;

    const j = await this.db.one<any>(`SELECT * FROM journey WHERE id = $1`, [run.journey_id]);
    if (!j) return;
    const actions = normaliseActions(j.actions);
    const lead = await this.db.one<any>(
      `SELECT id, owner_id, branch_id, vertical_id, pipeline_id, campaign_id, org_id, full_name
         FROM lead WHERE id = $1`, [run.lead_id],
    );
    if (!lead) {
      await this.finish(runId, 'skipped', 'The lead no longer exists');
      return;
    }

    const steps: StepResult[] = Array.isArray(run.steps) ? run.steps : [];
    let i = Number(run.step_index ?? 0);

    await this.db.query(`UPDATE journey_run SET status = 'running', locked_at = now(), attempts = attempts + 1 WHERE id = $1`, [runId]);

    try {
      for (; i < actions.length; i++) {
        const a = actions[i];
        if (a.kind === 'wait') {
          const ms = waitMs(a);
          if (ms > 0) {
            // park and resume later — this is what makes multi-day journeys real
            await this.db.query(
              `UPDATE journey_run
                  SET status = 'pending', step_index = $2, next_run_at = now() + ($3 || ' milliseconds')::interval,
                      steps = $4::jsonb, locked_at = NULL, updated_at = now()
                WHERE id = $1`,
              [runId, i + 1, String(ms), JSON.stringify([...steps, {
                kind: 'wait', status: 'done', detail: `Waiting ${a.days ? `${a.days}d ` : ''}${a.hours ? `${a.hours}h` : ''}`.trim(),
                at: new Date().toISOString(),
              }])],
            );
            return;
          }
          continue;
        }
        steps.push(await this.runAction(a, j, run, lead));
        await this.db.query(
          `UPDATE journey_run SET steps = $2::jsonb, step_index = $3, updated_at = now() WHERE id = $1`,
          [runId, JSON.stringify(steps), i + 1],
        );
      }
      await this.finish(runId, 'done', null, steps);
      await this.db.query(`UPDATE journey SET run_count = run_count + 1, last_run_at = now() WHERE id = $1`, [j.id]);
      // the run is visible ON THE LEAD, not only in an admin report
      await this.timeline(lead, `Journey "${j.name}" ran: ${steps.map((s) => s.kind).join(', ')}`);
    } catch (e) {
      await this.finish(runId, 'failed', (e as Error).message, steps);
    }
  }

  private async finish(runId: number, status: string, reason?: string | null, steps?: StepResult[]) {
    await this.db.query(
      `UPDATE journey_run
          SET status = $2, reason = $3, finished_at = now(), locked_at = NULL, updated_at = now(),
              steps = COALESCE($4::jsonb, steps)
        WHERE id = $1`,
      [runId, status, reason ?? null, steps ? JSON.stringify(steps) : null],
    );
  }

  private async timeline(lead: any, note: string) {
    await this.db.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note)
       VALUES ($1,$2,$3,NULL,'note',$4)`,
      [lead.id, lead.org_id, lead.branch_id, note.slice(0, 500)],
    );
  }

  /**
   * owner | manager | a specific user id.
   *
   * DEF-S4-02 (found by the LIVE smoke): an **On Demand** campaign deliberately parks its
   * leads UNASSIGNED until an agent clicks Start Calling (§4.1). Such a lead has no owner,
   * so "create a task for the owner" had nobody to give it to and skipped — the journey
   * silently did half its job.
   *
   * A task delivered to nobody is the exact failure Sprint 3 ruled out for escalations, so
   * the same rule applies here: **fall back to the manager** (team leader -> vertical ->
   * branch -> org admin, an admin backstop that always resolves). The work item exists and
   * a human sees it; when the lead is later claimed, its owner takes it over.
   */
  private async manager(lead: any): Promise<number | null> {
    const ms = await this.managers.managersFor(Number(lead.id), Number(lead.owner_id) || null);
    return ms[0] ?? null;
  }

  private async resolveUser(who: unknown, lead: any): Promise<number | null> {
    if (who === 'manager') return this.manager(lead);
    if (who === 'owner' || who === undefined || who === null) {
      return lead.owner_id ? Number(lead.owner_id) : this.manager(lead);   // never nobody
    }
    const n = Number(who);
    if (Number.isFinite(n) && n > 0) return n;
    return lead.owner_id ? Number(lead.owner_id) : this.manager(lead);
  }

  private async runAction(a: JourneyAction, j: any, run: any, lead: any): Promise<StepResult> {
    const at = new Date().toISOString();
    try {
      switch (a.kind) {
        case 'send_message': {
          const msg = await this.templates.build({ lead_id: Number(lead.id), template_id: Number(a.template_id) });
          // GUARDED: opt-out, the daily cap and business hours all apply to automation.
          const out = await this.messaging.queue({
            ...msg, journey_id: Number(j.id), journey_run_id: Number(run.id), guarded: true,
          });
          return out.status === 'skipped'
            ? { kind: a.kind, status: 'skipped', detail: out.reason, message_id: out.id, at }
            : { kind: a.kind, status: 'done', detail: `${msg.channel} queued to ${msg.to}`, message_id: out.id, at };
        }

        case 'create_task': {
          const owner = await this.resolveUser(a.assign_to, lead);
          if (!owner) return { kind: a.kind, status: 'skipped', detail: 'The lead has no owner to assign the task to', at };
          const due = new Date(Date.now() + Number(a.due_in_days ?? 1) * 86_400_000);
          const row = await this.db.one<{ id: string }>(
            `INSERT INTO follow_up (lead_id, owner_id, type_id, scheduled_at, priority, notes)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              lead.id, owner,
              a.followup_type_id ? Number(a.followup_type_id) : null,
              due, ['low', 'medium', 'high'].includes(String(a.priority)) ? String(a.priority) : 'medium',
              (a.title ?? `Follow up — ${j.name}`).slice(0, 500),
            ],
          );
          return { kind: a.kind, status: 'done', detail: `Task #${row!.id} due ${due.toLocaleDateString('en-IN')}`, at };
        }

        case 'change_stage': {
          const stage = await this.db.one<any>(
            `SELECT id, name, pipeline_id FROM pipeline_stage WHERE id = $1`, [Number(a.stage_id)],
          );
          if (!stage) return { kind: a.kind, status: 'skipped', detail: 'That stage no longer exists', at };
          // a stage from another pipeline would corrupt the lead's path
          if (Number(stage.pipeline_id) !== Number(lead.pipeline_id)) {
            return { kind: a.kind, status: 'skipped', detail: `"${stage.name}" belongs to another pipeline`, at };
          }
          await this.db.query(`UPDATE lead SET stage_id = $2, updated_at = now() WHERE id = $1`, [lead.id, stage.id]);
          await this.db.query(
            `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note)
             VALUES ($1,$2,$3,NULL,'stage_change',$4)`,
            [lead.id, lead.org_id, lead.branch_id, `Journey "${j.name}" moved the lead to ${stage.name}`],
          );
          return { kind: a.kind, status: 'done', detail: `Stage -> ${stage.name}`, at };
        }

        case 'notify_user': {
          const user = await this.resolveUser(a.assign_to, lead);
          if (!user) return { kind: a.kind, status: 'skipped', detail: 'Nobody to notify', at };
          await this.notifier.notify({
            userId: user, type: 'system', severity: 'info',
            title: (a.title ?? `Journey: ${j.name}`).slice(0, 200),
            body: a.body ?? `Lead ${lead.full_name}`,
            link: { type: 'lead', id: Number(lead.id) },
          });
          return { kind: a.kind, status: 'done', detail: `Notified user #${user}`, at };
        }

        default:
          return { kind: String(a.kind), status: 'skipped', detail: 'Unknown action', at };
      }
    } catch (e) {
      // ONE bad step does not abort the journey — the rest still run, and the failure is
      // recorded against the step, on the lead, where somebody will actually see it.
      return { kind: String(a.kind), status: 'failed', detail: (e as Error).message, at };
    }
  }

  /** Manual "Run now" for a journey against a single lead — respects idempotency. */
  async runFor(journeyId: number, leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const where = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    const lead = await this.db.one<any>(
      `SELECT l.id FROM lead l WHERE l.id = $1 AND l.deleted_at IS NULL AND (${where})`, params,
    );
    if (!lead) throw new NotFoundException('lead not found');
    const j = await this.get(journeyId);
    const ids = await this.fire(String(j.trigger_type), leadId, {});
    return { fired: ids.length, run_ids: ids };
  }
}
