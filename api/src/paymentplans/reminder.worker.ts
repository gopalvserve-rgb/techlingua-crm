import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { MessagingService } from '../messaging/messaging.service';
import { formatINR } from '../common/money.util';

/**
 * THE FEE-REMINDER SWEEP — Phase 3 Batch 2.
 *
 * Same topology as the Sprint-3 reminder/escalation/SLA worker (docs/dev/08 §22): an
 * in-process ticker over Postgres, SET-BASED, exactly-once BY CONSTRUCTION. It finds
 * installments that are DUE-SOON (X days before), DUE-TODAY, or OVERDUE (Y days after)
 * and sends the student a reminder via the notifier's channels (WhatsApp/SMS/Email).
 *
 * IST, not UTC: "today" is `(now() AT TIME ZONE 'Asia/Kolkata')::date`, so a due date
 * flips overdue at IST midnight — the same clock the dues ageing uses.
 *
 * IDEMPOTENT: each (installment, reminder_key) is CLAIMED with
 *     INSERT INTO installment_reminder (...) ON CONFLICT DO NOTHING RETURNING id
 * inside the transaction, BEFORE the message is queued. If the claim returns nothing the
 * reminder already went out (another replica, or an earlier tick) and we do nothing — so
 * the same "Installment Due Soon / Due Today / Payment Overdue" reminder never spams the
 * customer. reminder_key encodes the stage + offset ('due_soon:3' | 'due_today' |
 * 'overdue:7'), so each CONFIGURED offset fires once per installment.
 *
 * DEGRADES CLEANLY: the message goes through MessagingService.queue, which writes a
 * `failed / not_configured` row (never throws) when the channel has no credentials — the
 * reminder is still claimed and logged, the Error Log stays clean, and the day the client
 * pastes his SMS/WhatsApp/SMTP creds in, reminders simply start being delivered.
 *
 * TIES TO THE EVENTS CATALOG (coming next): the three stages ARE the client's
 * "Installment Due Soon / Due Today / Payment Overdue" automation events. This worker is
 * the mechanism; wiring each stage to a chosen template/channel per the events catalog is
 * a config change on `fee_reminder_config`, no code.
 *
 * Disabled with SPRINT3_WORKER=0 (tests drive tick() directly).
 */

export interface FeeReminderConfig {
  enabled: boolean;
  channels: string[];        // subset of ['whatsapp','sms','email']
  due_soon_days: number[];   // e.g. [3] -> remind 3 days before
  remind_on_due: boolean;    // remind on the due date itself
  overdue_days: number[];    // e.g. [3,7] -> remind 3 and 7 days after
}

export const DEFAULT_FEE_REMINDER: FeeReminderConfig = {
  enabled: true, channels: ['whatsapp', 'sms', 'email'],
  due_soon_days: [3], remind_on_due: true, overdue_days: [3, 7],
};

interface ReminderSpec { stage: 'due_soon' | 'due_today' | 'overdue'; offset: number; key: string; }

@Injectable()
export class FeeReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('FeeReminderWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  static readonly TICK_MS = 300_000;   // due dates are day-grained; 5 min is ample
  static readonly BATCH = 100;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly messaging: MessagingService,
  ) {}

  onModuleInit() {
    if (process.env.SPRINT3_WORKER === '0') { this.log.warn('fee reminder worker disabled (SPRINT3_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, FeeReminderWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('fee-reminder worker started (postgres sweep, in-process, IST)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async config(): Promise<FeeReminderConfig> {
    const c = await this.settings.get('fee_reminder_config', DEFAULT_FEE_REMINDER as unknown as Record<string, unknown>) as unknown as FeeReminderConfig;
    return {
      enabled: c.enabled !== false,
      channels: (Array.isArray(c.channels) ? c.channels : DEFAULT_FEE_REMINDER.channels).filter((x) => ['whatsapp', 'sms', 'email'].includes(x)),
      due_soon_days: (Array.isArray(c.due_soon_days) ? c.due_soon_days : []).map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0),
      remind_on_due: c.remind_on_due !== false,
      overdue_days: (Array.isArray(c.overdue_days) ? c.overdue_days : []).map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n) && n > 0),
    };
  }

  /** The set of reminder specs the config expands to. */
  static specsFor(c: FeeReminderConfig): ReminderSpec[] {
    const specs: ReminderSpec[] = [];
    for (const d of c.due_soon_days) specs.push({ stage: 'due_soon', offset: d, key: `due_soon:${d}` });
    if (c.remind_on_due) specs.push({ stage: 'due_today', offset: 0, key: 'due_today' });
    for (const d of c.overdue_days) specs.push({ stage: 'overdue', offset: d, key: `overdue:${d}` });
    return specs;
  }

  /** One cycle. Public so tests drive it deterministically. Returns count sent. */
  async tick(): Promise<{ sent: number }> {
    if (this.running) return { sent: 0 };
    this.running = true;
    try {
      const c = await this.config();
      if (!c.enabled || !c.channels.length) return { sent: 0 };
      let sent = 0;
      for (const spec of FeeReminderWorker.specsFor(c)) sent += await this.sweepStage(spec, c);
      return { sent };
    } catch (e) {
      this.log.error(`fee-reminder tick failed: ${(e as Error).message}`);
      return { sent: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * `signOffset` is +offset for due_soon (due in the future), 0 for due_today, -offset for
   * overdue (due in the past). Match installments whose due_date equals today ± offset.
   */
  private async sweepStage(spec: ReminderSpec, c: FeeReminderConfig): Promise<number> {
    const signedOffset = spec.stage === 'due_soon' ? spec.offset : spec.stage === 'overdue' ? -spec.offset : 0;
    const rows = await this.db.query<any>(
      `SELECT i.id AS installment_id, i.seq_no, i.due_date,
              (i.amount_minor - i.paid_minor) AS outstanding_minor,
              e.id AS enrolment_id, e.enrolment_no, e.branch_id, e.vertical_id,
              l.id AS lead_id, l.full_name AS student_name, l.phone AS student_phone, l.email AS student_email,
              c.name AS course_name
         FROM installment i
         JOIN payment_plan pp ON pp.id = i.plan_id AND pp.status = 'active' AND pp.deleted_at IS NULL
         JOIN enrolment e ON e.id = i.enrolment_id AND e.deleted_at IS NULL AND e.status = 'active'
         JOIN lead l ON l.id = e.lead_id AND l.deleted_at IS NULL
         LEFT JOIN m_course c ON c.id = e.course_id
        WHERE i.status <> 'waived' AND (i.amount_minor - i.paid_minor) > 0
          AND i.due_date = ((now() AT TIME ZONE 'Asia/Kolkata')::date + ($1 || ' days')::interval)::date
          AND NOT EXISTS (SELECT 1 FROM installment_reminder r
                           WHERE r.installment_id = i.id AND r.reminder_key = $2)
        ORDER BY i.due_date
        LIMIT $3`,
      [String(signedOffset), spec.key, FeeReminderWorker.BATCH],
    );

    let fired = 0;
    for (const r of rows) {
      const ok = await this.db.tx(async (client) => {
        // THE CLAIM — exactly once per (installment, key), across replicas.
        const claim = await client.query(
          `INSERT INTO installment_reminder (installment_id, reminder_key, stage)
           VALUES ($1,$2,$3) ON CONFLICT (installment_id, reminder_key) DO NOTHING RETURNING id`,
          [Number(r.installment_id), spec.key, spec.stage],
        );
        if (!claim.rowCount) return false;
        const reminderId = Number(claim.rows[0].id);

        const dueStr = new Date(String(r.due_date)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const amount = formatINR(Number(r.outstanding_minor));
        const course = r.course_name ? ` for ${r.course_name}` : '';
        const body = spec.stage === 'overdue'
          ? `Dear ${r.student_name}, your fee installment of ${amount}${course} (${r.enrolment_no}) was due on ${dueStr} and is now overdue by ${spec.offset} day(s). Please pay at the earliest to avoid disruption.`
          : spec.stage === 'due_today'
            ? `Dear ${r.student_name}, your fee installment of ${amount}${course} (${r.enrolment_no}) is due today (${dueStr}). Kindly make the payment.`
            : `Dear ${r.student_name}, a reminder that your fee installment of ${amount}${course} (${r.enrolment_no}) is due on ${dueStr}. Kindly arrange the payment.`;

        // fan out to each configured channel that the student is reachable on.
        let firstLogId: number | null = null;
        for (const ch of c.channels) {
          const to = ch === 'email' ? r.student_email : r.student_phone;
          if (!to) continue;   // not reachable on this channel — skip, not an error
          const res = await this.messaging.queue({
            channel: ch as 'whatsapp' | 'sms' | 'email',
            to: String(to),
            subject: ch === 'email' ? `Fee reminder — ${r.enrolment_no}` : null,
            body: ch === 'email' ? `<p>${body}</p>` : body,
            lead_id: Number(r.lead_id),
            vertical_id: Number(r.vertical_id),
            branch_id: Number(r.branch_id),
            // a customer message: honour opt-out + business hours (degrades cleanly when a
            // channel has no credentials — a failed/not_configured row, never a throw).
            guarded: true,
          });
          if (firstLogId == null && res?.id) firstLogId = Number(res.id);
        }
        if (firstLogId != null) {
          await client.query(`UPDATE installment_reminder SET message_log_id = $2 WHERE id = $1`, [reminderId, firstLogId]);
        }
        return true;
      });
      if (ok) fired++;
    }
    if (fired) this.log.log(`fee reminders (${spec.key}) sent: ${fired}`);
    return fired;
  }
}
