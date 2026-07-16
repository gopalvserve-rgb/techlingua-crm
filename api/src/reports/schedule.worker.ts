import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { isNotConfigured } from '../common/not-configured.exception';
import { entityByKey } from './entities';
import { ReportService } from './report.service';
import { ExportService, MIME, fileNameFor } from './export.service';
import { ScheduleService, nextRunAt, runKeyFor } from './schedule.service';

/**
 * SCHEDULED REPORT DELIVERY — the fifth user of the one worker topology.
 *
 * =============================================================================
 * IT SENDS ONCE. HERE IS EXACTLY WHY.
 * =============================================================================
 *   1. `claim()` takes due schedules with FOR UPDATE SKIP LOCKED, so two API replicas
 *      never hold the same row.
 *   2. `INSERT INTO report_delivery (schedule_id, run_key) ... ON CONFLICT DO NOTHING
 *      RETURNING id` — UNIQUE(schedule_id, run_key). No id back = this PERIOD is already
 *      owned. We stop, and we do not advance the clock (the owner will).
 *   3. The delivery row is written BEFORE the email is queued, so a crash between the
 *      two leaves a `running` row that no later tick will re-claim. One email or none.
 *
 * That is three independent reasons, and it needs to be: "the report arrived twice" is
 * the kind of bug a client notices immediately and never quite forgets.
 *
 * =============================================================================
 * DEGRADING WITHOUT SMTP
 * =============================================================================
 * SMTP is one of the credentials Gopal has not supplied. So before rendering anything,
 * the worker asks ChannelConfigService whether email is configured. If it is not:
 *   · the delivery is recorded as `skipped`, with the reason in the client's own words
 *     ("Email is not configured — add SMTP in Settings › Channels and this will send.");
 *   · the run key IS consumed, so it does not retry every 30 seconds for a week;
 *   · `next_run_at` advances normally, so the day he pastes his SMTP in, the next
 *     morning's report goes out with no deploy and nothing to switch on;
 *   · NOTHING lands in the Error Log. "Not configured" is an expected state, not an
 *     incident — the same rule the capture channels, the calendar and the notifier
 *     already follow.
 */
@Injectable()
export class ScheduleWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ScheduleWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 30_000;
  static readonly BATCH = 5;

  constructor(
    private readonly db: DatabaseService,
    private readonly schedules: ScheduleService,
    private readonly reports: ReportService,
    private readonly exports: ExportService,
    private readonly messaging: MessagingService,
    private readonly configs: ChannelConfigService,
  ) {}

  onModuleInit() {
    if (process.env.SCHEDULE_WORKER === '0') { this.log.warn('schedule worker disabled (SCHEDULE_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, ScheduleWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('report schedule worker started (postgres queue, in-process)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const ids = await this.claim(ScheduleWorker.BATCH, now);
      let done = 0;
      for (const id of ids) { if (await this.runSchedule(id, now)) done++; }
      return done;
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async claim(n: number, now: Date): Promise<number[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT s.id FROM report_schedule s
        WHERE s.is_active AND s.deleted_at IS NULL
          AND s.next_run_at IS NOT NULL AND s.next_run_at <= $1
        ORDER BY s.next_run_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, n],
    );
    return rows.map((r) => Number(r.id));
  }

  /**
   * Run ONE schedule. Public so schedule.spec.ts can drive it twice and prove it sends once.
   *
   * ============================================================================
   * DEF-S6-03 — `advance` IS NOT AN OPTIONAL EXTRA. IT IS THE BUG THE LIVE SMOKE FOUND.
   * ============================================================================
   * This method used to advance `next_run_at` on EVERY run, including a manual "Send
   * now". Live, that meant:
   *
   *   press Send now  -> delivers period 2026-07-17, next_run_at := the 18th
   *   press it again  -> dueAt is now the 18th, so the run key is 2026-07-18 — A
   *                      DIFFERENT PERIOD — so the idempotency gate lets it straight
   *                      through and it "delivers" a day that has not happened yet.
   *
   * Four presses produced four delivery rows (the 17th, 18th, 19th, 20th) AND pushed the
   * client's daily 08:00 report four days into the future, where it would silently not
   * arrive. Every unit test passed, because each one RESET `next_run_at` by hand between
   * the two calls — which is precisely the thing the real code does not do.
   *
   * So: only the TIMER advances the clock. A manual run delivers the CURRENT period and
   * leaves the schedule alone — which also makes "Send now" idempotent for free (the
   * second press hits the same run key and is declined), and means pressing it does not
   * cause a second copy at 08:00.
   */
  async runSchedule(id: number, now: Date = new Date(), opts: { advance?: boolean } = {}): Promise<boolean> {
    const advanceClock = opts.advance !== false;
    const s = await this.db.one<any>(
      `SELECT s.*, r.name AS report_name, r.entity, r.config
         FROM report_schedule s JOIN report_definition r ON r.id = s.report_id
        WHERE s.id = $1 AND s.deleted_at IS NULL AND r.deleted_at IS NULL`, [id],
    );
    if (!s) return false;

    const dueAt = s.next_run_at ? new Date(s.next_run_at) : now;
    const runKey = runKeyFor(s.frequency, dueAt);

    // ---- THE IDEMPOTENCY GATE. Everything below happens at most once per period.
    const claimed = await this.db.one<{ id: string }>(
      `INSERT INTO report_delivery (schedule_id, run_key, status)
       VALUES ($1, $2, 'running')
       ON CONFLICT (schedule_id, run_key) DO NOTHING
       RETURNING id`,
      [id, runKey],
    );
    if (!claimed) {
      // Somebody already owns this period. Do NOT advance the clock — the owner does.
      this.log.debug(`schedule ${id}: ${runKey} already delivered/claimed`);
      return false;
    }
    const deliveryId = Number(claimed.id);

    try {
      const recipients = await this.schedules.recipientsOf(s);
      const withEmail = recipients.filter((r) => r.email);

      if (!withEmail.length) {
        await this.finish(deliveryId, 'skipped', {
          error: recipients.length
            ? `None of the ${recipients.length} recipient(s) has an email address on their user record.`
            : 'This schedule has no recipients.',
          recipients: recipients.map((r) => r.name),
        });
        if (advanceClock) await this.advance(s, dueAt);
        return true;
      }

      // ---- DEGRADE CLEANLY. Ask BEFORE rendering: there is no point spending a second
      // building a spreadsheet nobody can be sent.
      try {
        await this.configs.require('email', null);
      } catch (e) {
        if (!isNotConfigured(e)) throw e;
        await this.finish(deliveryId, 'skipped', {
          error: 'Email is not configured — add your SMTP details in Settings › Channels and this report will send on its next run. Nothing else needs changing.',
          recipients: withEmail.map((r) => r.name),
        });
        if (advanceClock) await this.advance(s, dueAt);
        return true;
      }

      const entity = entityByKey(s.entity);
      if (!entity) throw new Error(`This report points at "${s.entity}", which no longer exists.`);

      // RENDERED IN THE SCHEDULE OWNER'S SCOPE (`run_as_user_id`), not the recipient's.
      // The schedule form says this in words before the client presses Save. It has to:
      // a Branch Manager scheduling his branch report to a counsellor is putting branch
      // rows in that counsellor's inbox, which is his call to make — but it must be a
      // decision, not a surprise.
      const out = await this.reports.execute(entity, s.config ?? {}, { id: Number(s.run_as_user_id) });
      const buffer = this.exports.build(s.format, s.report_name, out);
      const filename = fileNameFor(s.report_name, s.format);

      const period = ({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' } as any)[s.frequency];
      const messageIds: number[] = [];
      for (const r of withEmail) {
        const q = await this.messaging.queue({
          channel: 'email',
          to: r.email!,
          subject: `${period} report: ${s.report_name}`,
          body: `<p>Hello ${escapeHtml(r.name)},</p>`
            + `<p>Your ${period.toLowerCase()} report <b>${escapeHtml(s.report_name)}</b> is attached.</p>`
            + `<p><b>${out.row_count}</b> row${out.row_count === 1 ? '' : 's'} &middot; generated ${new Date().toLocaleString('en-IN')}.</p>`
            + `<p style="color:#6b7280;font-size:12px">${escapeHtml(out.scope.note)}</p>`
            + `<p style="color:#6b7280;font-size:12px">Sent automatically by the Tech Lingua CRM. `
            + `To stop or change this, open Analytics &amp; Reports &rsaquo; Scheduled Delivery.</p>`,
          user_id: r.user_id,
          attachments: [{ filename, content: buffer, contentType: MIME[s.format as 'xlsx'] }],
          // NOT `guarded`. Business hours are for MARKETING messages to customers. A
          // report the client scheduled for 08:00 must arrive at 08:00, not be deferred
          // to the start of the working day by a rule written for WhatsApp blasts.
          dedupe_key: `report-${id}-${runKey}-${r.user_id}`,
          actor_id: Number(s.run_as_user_id),
        });
        messageIds.push(q.id);
      }

      await this.finish(deliveryId, 'sent', {
        recipients: withEmail.map((r) => r.name),
        message_ids: messageIds, file_name: filename, row_count: out.row_count,
      });
      if (advanceClock) await this.advance(s, dueAt);
      return true;
    } catch (e) {
      // A FAILED RUN IS RECORDED WITH ITS REASON AND THE CLOCK STILL ADVANCES. A schedule
      // that stops for ever because one Tuesday's query threw is worse than one that
      // misses a Tuesday: the client would not notice until he needed the report.
      await this.finish(deliveryId, 'failed', { error: (e as Error).message?.slice(0, 500) ?? 'Unknown error' });
      if (advanceClock) await this.advance(s, dueAt);
      this.log.error(`schedule ${id} failed: ${(e as Error).message}`);
      return true;
    }
  }

  private async finish(deliveryId: number, status: string, extra: {
    error?: string; recipients?: string[]; message_ids?: number[]; file_name?: string; row_count?: number;
  }) {
    await this.db.query(
      `UPDATE report_delivery
          SET status = $2, error = $3, recipients = $4::jsonb, message_ids = $5::jsonb,
              file_name = $6, row_count = $7, finished_at = now()
        WHERE id = $1`,
      [deliveryId, status, extra.error ?? null, JSON.stringify(extra.recipients ?? []),
        JSON.stringify(extra.message_ids ?? []), extra.file_name ?? null, extra.row_count ?? null],
    );
  }

  /** Advance from THE DUE TIME, not from now: a run that starts 40 seconds late must not
   *  drift the schedule 40 seconds later every day until the "8am report" arrives at noon. */
  private async advance(s: any, dueAt: Date) {
    const next = nextRunAt(s, dueAt);
    await this.db.query(
      `UPDATE report_schedule SET last_run_at = now(), next_run_at = $2, updated_at = now() WHERE id = $1`,
      [Number(s.id), next],
    );
  }
}

const escapeHtml = (s: string) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
