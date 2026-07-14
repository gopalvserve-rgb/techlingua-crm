import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { ScoringService } from '../scoring/scoring.service';
import { NotifierService } from './notifier.service';
import { ManagerResolverService } from './manager-resolver.service';

/**
 * THE SPRINT-3 WORKER — reminders · overdue escalation · SLA breaches · score ageing.
 *
 * NOT a second scheduler. It is the SAME topology as the Sprint-2 ingestion worker
 * (decision log #22): an in-process ticker over Postgres, because Railway runs a single
 * `api` service. What is different is that these sweeps are SET-BASED, not a job queue —
 * there is no work item to enqueue, only "which rows have become due since the last tick".
 *
 * EXACTLY-ONCE, by construction and not by hope:
 *   every sweep CLAIMS its rows with a conditional UPDATE inside the transaction that
 *   also writes the notification —
 *       UPDATE follow_up SET reminded_at = now()
 *        WHERE id = $1 AND reminded_at IS NULL RETURNING id
 *   If the claim returns no row, another replica already fired it and we do nothing.
 *   If the notification write fails, the claim rolls back and the next tick retries.
 *   Two replicas therefore cannot double-remind, double-escalate or double-breach.
 *
 * Disable with SPRINT3_WORKER=0 (tests drive tick() directly).
 */
@Injectable()
export class ReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReminderWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 30_000;   // reminders are minute-grained; 30 s is plenty
  static readonly BATCH = 50;

  static readonly DEFAULT_POLICY = {
    enabled: true,
    reminder_lead_minutes: 30,
    overdue_after_minutes: 120,
    actions: ['notify_owner', 'notify_manager', 'flag_lead'] as string[],
    repeat_every_minutes: 0,
    max_levels: 1,
  };

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly notifier: NotifierService,
    private readonly managers: ManagerResolverService,
    private readonly scoring: ScoringService,
  ) {}

  onModuleInit() {
    if (process.env.SPRINT3_WORKER === '0') { this.log.warn('reminder worker disabled (SPRINT3_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, ReminderWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('reminder / escalation / SLA worker started (postgres sweeps, in-process)');
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async policy() {
    return this.settings.get('escalation_policy', ReminderWorker.DEFAULT_POLICY as unknown as Record<string, unknown>) as
      unknown as Promise<typeof ReminderWorker.DEFAULT_POLICY>;
  }

  /** One cycle. Public so tests can drive it deterministically. */
  async tick(): Promise<{ reminders: number; escalations: number; breaches: number; rescored: number }> {
    if (this.running) return { reminders: 0, escalations: 0, breaches: 0, rescored: 0 };
    this.running = true;
    try {
      const p = await this.policy();
      const reminders = p.enabled ? await this.sweepReminders(p) : 0;
      const escalations = p.enabled ? await this.sweepEscalations(p) : 0;
      const breaches = await this.sweepSlaBreaches();
      const rescored = await this.scoring.ageingSweep(ReminderWorker.BATCH);
      return { reminders, escalations, breaches, rescored };
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return { reminders: 0, escalations: 0, breaches: 0, rescored: 0 };
    } finally {
      this.running = false;
    }
  }

  /* --------------------------- 1. DUE-SOON REMINDERS --------------------------- */

  /**
   * A follow-up is reminded when `remind_at` arrives. When the user set no explicit
   * remind_at, the policy's `reminder_lead_minutes` derives one from `scheduled_at`
   * (default: 30 minutes before it is due) — that is the "due-soon" notification.
   */
  async sweepReminders(p = ReminderWorker.DEFAULT_POLICY): Promise<number> {
    const due = await this.db.query(
      `SELECT f.id, f.lead_id, f.owner_id, f.scheduled_at, f.notes,
              l.full_name AS lead_name, ft.name AS type_name
         FROM follow_up f
         JOIN lead l ON l.id = f.lead_id
         LEFT JOIN m_followup_type ft ON ft.id = f.type_id
        WHERE f.status = 'pending' AND f.reminded_at IS NULL
          AND f.deleted_at IS NULL AND f.is_active AND l.deleted_at IS NULL
          AND COALESCE(f.remind_at, f.scheduled_at - ($1 || ' minutes')::interval) <= now()
        ORDER BY f.scheduled_at
        LIMIT $2`,
      [String(p.reminder_lead_minutes ?? 30), ReminderWorker.BATCH],
    );

    let fired = 0;
    for (const f of due) {
      const ok = await this.db.tx(async (c) => {
        // THE CLAIM — if another replica already reminded, this returns nothing.
        const claim = await c.query(
          `UPDATE follow_up SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING id`,
          [Number(f.id)],
        );
        if (!claim.rowCount) return false;
        const when = new Date(f.scheduled_at).toLocaleString('en-IN', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        await this.notifier.notify({
          userId: Number(f.owner_id),
          type: 'reminder',
          severity: 'info',
          title: `${f.type_name || 'Follow-up'} due: ${f.lead_name}`,
          body: `Scheduled for ${when}.${f.notes ? ` — ${String(f.notes).slice(0, 120)}` : ''}`,
          link: { type: 'lead', id: Number(f.lead_id) },
          meta: { follow_up_id: Number(f.id) },
        }, c);
        return true;
      });
      if (ok) fired++;
    }
    if (fired) this.log.log(`reminders sent: ${fired}`);
    return fired;
  }

  /* --------------------------- 2. OVERDUE ESCALATION --------------------------- */

  /**
   * THE ESCALATION POLICY (app_setting `escalation_policy`, editable — no deploy):
   *   after `overdue_after_minutes` past a follow-up's due time, run the configured
   *   `actions`, any of:
   *      notify_owner        — a warn notification to the owner
   *      notify_manager      — the same to the owner's manager (ManagerResolver: team
   *                            leader → vertical manager → branch manager → org admin)
   *      flag_lead           — lead.is_flagged = true + a reason, so the LIST shows it
   *      reassign_to_manager — hands the follow-up (and the lead) to the manager
   *   `max_levels` caps how many times one follow-up may escalate;
   *   `repeat_every_minutes` (0 = once) spaces repeats.
   */
  async sweepEscalations(p = ReminderWorker.DEFAULT_POLICY): Promise<number> {
    const actions = Array.isArray(p.actions) ? p.actions : [];
    const maxLevels = Math.max(1, Number(p.max_levels ?? 1));
    const repeat = Number(p.repeat_every_minutes ?? 0);

    const rows = await this.db.query(
      `SELECT f.id, f.lead_id, f.owner_id, f.scheduled_at, f.escalation_level,
              l.full_name AS lead_name, l.owner_id AS lead_owner_id, ft.name AS type_name
         FROM follow_up f
         JOIN lead l ON l.id = f.lead_id
         LEFT JOIN m_followup_type ft ON ft.id = f.type_id
        WHERE f.status = 'pending'
          AND f.deleted_at IS NULL AND f.is_active AND l.deleted_at IS NULL
          AND f.scheduled_at <= now() - ($1 || ' minutes')::interval
          AND f.escalation_level < $2
          AND (f.escalated_at IS NULL
               OR ($3 > 0 AND f.escalated_at <= now() - ($3 || ' minutes')::interval))
        ORDER BY f.scheduled_at
        LIMIT $4`,
      [String(p.overdue_after_minutes ?? 120), maxLevels, repeat, ReminderWorker.BATCH],
    );

    let fired = 0;
    for (const f of rows) {
      const managerIds = actions.includes('notify_manager') || actions.includes('reassign_to_manager')
        ? await this.managers.managersFor(Number(f.lead_id), Number(f.owner_id))
        : [];

      const ok = await this.db.tx(async (c) => {
        // THE CLAIM — level is bumped atomically; a concurrent replica sees the new level.
        const claim = await c.query(
          `UPDATE follow_up
              SET escalated_at = now(), escalation_level = escalation_level + 1
            WHERE id = $1 AND escalation_level = $2 AND status = 'pending'
            RETURNING id, escalation_level`,
          [Number(f.id), Number(f.escalation_level)],
        );
        if (!claim.rowCount) return false;
        const level = Number(claim.rows[0].escalation_level);

        const overdueMin = Math.round((Date.now() - new Date(f.scheduled_at).getTime()) / 60000);
        const title = `Overdue follow-up: ${f.lead_name}`;
        const body = `${f.type_name || 'Follow-up'} was due ${overdueMin} min ago and is still open.`;

        if (actions.includes('notify_owner')) {
          await this.notifier.notify({
            userId: Number(f.owner_id), type: 'escalation', severity: 'warn', title,
            body, link: { type: 'lead', id: Number(f.lead_id) },
            meta: { follow_up_id: Number(f.id), level },
          }, c);
        }
        if (actions.includes('notify_manager') && managerIds.length) {
          await this.notifier.notifyMany(managerIds, {
            type: 'escalation', severity: 'warn',
            title: `Escalation — ${f.lead_name}`,
            body: `${body} Owner has not actioned it.`,
            link: { type: 'lead', id: Number(f.lead_id) },
            meta: { follow_up_id: Number(f.id), level, escalated_from: Number(f.owner_id) },
          }, c);
        }
        if (actions.includes('flag_lead')) {
          await c.query(
            `UPDATE lead SET is_flagged = TRUE, flag_reason = $2, updated_at = now() WHERE id = $1`,
            [Number(f.lead_id), `Follow-up overdue by ${overdueMin} min`],
          );
        }
        if (actions.includes('reassign_to_manager') && managerIds.length) {
          const to = managerIds[0];
          await c.query(`UPDATE follow_up SET owner_id = $2, updated_at = now() WHERE id = $1`, [Number(f.id), to]);
          await c.query(`UPDATE lead SET owner_id = $2, updated_at = now() WHERE id = $1`, [Number(f.lead_id), to]);
          const lead = (await c.query(`SELECT org_id, branch_id FROM lead WHERE id = $1`, [Number(f.lead_id)])).rows[0];
          await c.query(
            `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
             VALUES ($1,$2,$3,NULL,'assign',$4,$5,$6)`,
            [Number(f.lead_id), Number(lead.org_id), Number(lead.branch_id),
              JSON.stringify({ owner_id: Number(f.owner_id) }), JSON.stringify({ owner_id: to }),
              'Auto-reassigned to manager by the overdue escalation policy'],
          );
          await this.notifier.notify({
            userId: to, type: 'assignment', severity: 'warn',
            title: `Lead reassigned to you: ${f.lead_name}`,
            body: 'The overdue escalation policy moved this lead to you.',
            link: { type: 'lead', id: Number(f.lead_id) },
          }, c);
        }

        await c.query(
          `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
           SELECT l.org_id, NULL, 'follow_up', $1, 'escalate', $2::jsonb FROM lead l WHERE l.id = $3`,
          [Number(f.id), JSON.stringify({ level, actions, lead_id: Number(f.lead_id), overdue_minutes: overdueMin }),
            Number(f.lead_id)],
        );
        return true;
      });
      if (ok) fired++;
    }
    if (fired) this.log.log(`escalations fired: ${fired}`);
    return fired;
  }

  /* --------------------------- 3. SLA BREACH SWEEP --------------------------- */

  /**
   * Any clock past `due_at` that was never satisfied is a BREACH. The row is claimed
   * (breached_at IS NULL → now()) in the same transaction as the notification, so a
   * breach is announced exactly once. `escalate_after_minutes` on the policy delays
   * the notification without delaying the breach FLAG (the badge appears immediately).
   */
  async sweepSlaBreaches(): Promise<number> {
    const rows = await this.db.query(
      `SELECT s.id, s.lead_id, s.metric, s.due_at, p.name AS policy_name, p.notify_manager,
              p.escalate_after_minutes, l.full_name AS lead_name, l.owner_id
         FROM lead_sla s
         JOIN sla_policy p ON p.id = s.policy_id
         JOIN lead l ON l.id = s.lead_id
        WHERE s.satisfied_at IS NULL AND s.notified_at IS NULL
          AND l.deleted_at IS NULL AND l.is_active
          AND s.due_at + (p.escalate_after_minutes || ' minutes')::interval <= now()
        ORDER BY s.due_at
        LIMIT $1`,
      [ReminderWorker.BATCH],
    );

    let fired = 0;
    for (const s of rows) {
      const managerIds = s.notify_manager
        ? await this.managers.managersFor(Number(s.lead_id), s.owner_id ? Number(s.owner_id) : null)
        : [];

      const ok = await this.db.tx(async (c) => {
        const claim = await c.query(
          `UPDATE lead_sla SET breached_at = COALESCE(breached_at, now()), notified_at = now()
            WHERE id = $1 AND notified_at IS NULL RETURNING id`,
          [Number(s.id)],
        );
        if (!claim.rowCount) return false;

        const overdueMin = Math.round((Date.now() - new Date(s.due_at).getTime()) / 60000);
        const what = s.metric === 'first_response' ? 'First response' : 'Stage duration';
        const title = `SLA breached — ${s.lead_name}`;
        const body = `${what} SLA "${s.policy_name}" is ${overdueMin} min past its target.`;

        if (s.owner_id) {
          await this.notifier.notify({
            userId: Number(s.owner_id), type: 'sla_breach', severity: 'error', title, body,
            link: { type: 'lead', id: Number(s.lead_id) }, meta: { sla_id: Number(s.id), metric: s.metric },
          }, c);
        }
        if (managerIds.length) {
          await this.notifier.notifyMany(managerIds, {
            type: 'sla_breach', severity: 'error', title, body,
            link: { type: 'lead', id: Number(s.lead_id) }, meta: { sla_id: Number(s.id), metric: s.metric },
          }, c);
        }
        await c.query(
          `UPDATE lead SET is_flagged = TRUE, flag_reason = $2, updated_at = now() WHERE id = $1`,
          [Number(s.lead_id), `SLA breached: ${String(s.policy_name).slice(0, 150)}`],
        );
        await c.query(
          `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
           SELECT l.org_id, NULL, 'lead', $1, 'sla_breach', $2::jsonb FROM lead l WHERE l.id = $1`,
          [Number(s.lead_id), JSON.stringify({ sla_id: Number(s.id), metric: s.metric, overdue_minutes: overdueMin })],
        );
        return true;
      });
      if (ok) fired++;
    }
    if (fired) this.log.log(`SLA breaches notified: ${fired}`);
    return fired;
  }
}
