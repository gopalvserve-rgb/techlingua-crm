import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { MessagingService } from './messaging.service';
import { SENDING_CHANNELS } from './providers';

/**
 * THE OUTBOUND WORKER — the same topology as ImportWorker and ReminderWorker
 * (decision log #22): an in-process ticker over a Postgres queue, because Railway runs a
 * single `api` service. A third scheduler would be a third thing to reason about; this is
 * the same one, pointed at `message_log`.
 *
 *  · RATE LIMITED PER CHANNEL. `app_setting.message_rate_limits` (default 60/min email &
 *    SMS, 40/min WhatsApp) is enforced by claiming at most `limit * TICK/60s` rows of each
 *    channel per tick. Blowing a provider's rate limit gets an account suspended, and the
 *    client's account is not ours to risk.
 *  · RETRIES WITH BACKOFF (15s, 30s, 60s) on transient failures only — a bad token or an
 *    invalid number is retried zero times, because it will never succeed.
 *  · CRASH-SAFE: rows stuck in `sending` are reclaimed after 5 minutes.
 *  · MULTI-REPLICA SAFE: `FOR UPDATE SKIP LOCKED`, so two API replicas never send twice.
 *
 * Disable with MESSAGE_WORKER=0 (the tests drive tick() directly).
 */
@Injectable()
export class MessageWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MessageWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 5_000;
  static readonly STUCK_AFTER = '5 minutes';
  static readonly DEFAULT_RATES: Record<string, number> = { email: 60, sms: 60, whatsapp: 40 };

  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    if (process.env.MESSAGE_WORKER === '0') { this.log.warn('message worker disabled (MESSAGE_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, MessageWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('outbound message worker started (postgres queue, in-process)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** How many of this channel we may claim this tick (the rate limit, in rows). */
  private async budget(channel: string): Promise<number> {
    const rates = await this.settings.get('message_rate_limits', MessageWorker.DEFAULT_RATES as unknown as Record<string, unknown>);
    const perMinute = Number((rates as Record<string, unknown>)[channel] ?? MessageWorker.DEFAULT_RATES[channel] ?? 60);
    return Math.max(1, Math.floor(perMinute * (MessageWorker.TICK_MS / 60_000)));
  }

  /** One cycle. Public so tests can drive it deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      await this.reclaimStuck();
      for (const channel of SENDING_CHANNELS) {
        const ids = await this.claim(channel, await this.budget(channel));
        for (const id of ids) {
          await this.messaging.deliver(id);
          done++;
        }
      }
      return done;
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return done;
    } finally {
      this.running = false;
    }
  }

  /** Atomically take up to `n` due messages of one channel (multi-replica safe). */
  private async claim(channel: string, n: number): Promise<number[]> {
    const rows = await this.db.query<{ id: string }>(
      `WITH due AS (
         SELECT m.id FROM message_log m
          WHERE m.status = 'queued' AND m.channel = $1 AND m.run_after <= now()
          ORDER BY m.id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE message_log m
          SET status = 'sending', attempts = m.attempts + 1, locked_at = now(), updated_at = now()
         FROM due
        WHERE m.id = due.id
        RETURNING m.id`,
      [channel, n],
    );
    return rows.map((r) => Number(r.id));
  }

  private async reclaimStuck() {
    await this.db.query(
      `UPDATE message_log
          SET status = 'queued', run_after = now(), locked_at = NULL, updated_at = now()
        WHERE status = 'sending' AND locked_at < now() - INTERVAL '${MessageWorker.STUCK_AFTER}'
          AND attempts < ${MessagingService.MAX_ATTEMPTS}`,
    );
    // a row that crashed on its LAST attempt must not spin forever
    await this.db.query(
      `UPDATE message_log
          SET status = 'failed', error = COALESCE(error, 'Send timed out'), updated_at = now()
        WHERE status = 'sending' AND locked_at < now() - INTERVAL '${MessageWorker.STUCK_AFTER}'
          AND attempts >= ${MessagingService.MAX_ATTEMPTS}`,
    );
  }
}
