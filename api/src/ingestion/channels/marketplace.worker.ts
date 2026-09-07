import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ChannelRow } from './channel.service';
import { WebhookService } from './webhook.service';

/**
 * The marketplace PULL poller — TradeIndia + IndiaMART (Lead Intake Blueprint §3).
 *
 * Same topology as SheetWorker (decision log #22): in-process, Postgres-scheduled,
 * multi-replica-safe. `capture_channel.next_poll_at` IS the schedule; a tick claims
 * every due pull channel with `FOR UPDATE SKIP LOCKED` so two API replicas can never
 * poll the same account at once, and the ingest ledger (external_key = <source>:<id>)
 * means even if they did, no enquiry could be imported twice.
 *
 * A channel with no vendor credentials yet is NOT an error — the poll records a
 * `skipped` "not configured" event and re-schedules. It starts producing leads the
 * moment the client pastes their TradeIndia keys / IndiaMART CRM key in Settings.
 */
@Injectable()
export class MarketplacePullWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MarketplacePullWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 60_000;   // finest poll granularity is 1 minute
  static readonly BATCH = 5;          // accounts per tick
  static readonly PROVIDERS = ['tradeindia_pull', 'indiamart_pull'];

  constructor(private readonly db: DatabaseService, private readonly hooks: WebhookService) {}

  onModuleInit() {
    if (process.env.INGEST_WORKER === '0') { this.log.warn('marketplace poller disabled (INGEST_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, MarketplacePullWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('marketplace pull poller started (postgres schedule, in-process)');
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** One poll cycle. Public so tests drive it deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.claim(MarketplacePullWorker.BATCH);
      for (const ch of due) {
        try {
          await this.hooks.pollMarketplace(ch);
        } catch (e) {
          this.log.error(`marketplace channel #${ch.id} poll failed: ${(e as Error).message}`);
          await this.db.query(
            `UPDATE capture_channel SET last_error = $2, next_poll_at = now() + INTERVAL '15 minutes' WHERE id = $1`,
            [ch.id, (e as Error).message],
          );
        }
      }
      return due.length;
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim the due pull channels. `next_poll_at` is pushed forward immediately so a
   * concurrent replica (or a slow poll) cannot double-schedule; pollMarketplace()
   * sets the real next time when it finishes.
   */
  private async claim(n: number): Promise<ChannelRow[]> {
    return this.db.query<any>(
      `WITH due AS (
         SELECT c.id FROM capture_channel c
          WHERE c.provider = ANY($2) AND c.is_active AND c.deleted_at IS NULL
            AND (c.next_poll_at IS NULL OR c.next_poll_at <= now())
          ORDER BY c.next_poll_at NULLS FIRST
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE capture_channel c
          SET next_poll_at = now() + INTERVAL '15 minutes'
         FROM due
        WHERE c.id = due.id
        RETURNING c.*`,
      [n, MarketplacePullWorker.PROVIDERS],
    );
  }
}
