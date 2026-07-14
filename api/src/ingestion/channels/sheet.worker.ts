import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ChannelRow } from './channel.service';
import { WebhookService } from './webhook.service';

/**
 * The Google-Sheet poller. Same topology as ImportWorker (decision log #22):
 * in-process, Postgres-scheduled, multi-replica-safe.
 *
 * `capture_channel.next_poll_at` IS the schedule. A tick claims every sheet
 * channel that is due with `FOR UPDATE SKIP LOCKED`, so two API replicas can never
 * poll the same sheet at once, and the cursor + the ingestion ledger mean even if
 * they did, no row could be ingested twice.
 *
 * A channel with no Google credentials (today: all of them) is NOT an error — the
 * poll records a `skipped` event with "not configured" and re-schedules. It starts
 * producing leads the moment Gopal pastes the JSON into Settings; no deploy needed.
 */
@Injectable()
export class SheetWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SheetWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 60_000;   // the finest poll granularity is 1 minute
  static readonly BATCH = 5;          // sheets per tick

  constructor(private readonly db: DatabaseService, private readonly hooks: WebhookService) {}

  onModuleInit() {
    if (process.env.INGEST_WORKER === '0') { this.log.warn('sheet poller disabled (INGEST_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, SheetWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('google-sheet poller started (postgres schedule, in-process)');
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** One poll cycle. Public so tests drive it deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.claim(SheetWorker.BATCH);
      for (const ch of due) {
        try {
          await this.hooks.pollSheet(ch);
        } catch (e) {
          // pollSheet already logs; this is the belt-and-braces guard that keeps
          // one broken sheet from killing the tick (and the API process).
          this.log.error(`sheet channel #${ch.id} poll failed: ${(e as Error).message}`);
          await this.db.query(
            `UPDATE capture_channel
                SET last_error = $2, next_poll_at = now() + INTERVAL '15 minutes'
              WHERE id = $1`,
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
   * Claim the due sheets. `next_poll_at` is pushed forward immediately so a
   * concurrent replica (or a slow poll) cannot double-schedule; pollSheet() sets
   * the real next time when it finishes.
   */
  private async claim(n: number): Promise<ChannelRow[]> {
    return this.db.query<any>(
      `WITH due AS (
         SELECT c.id FROM capture_channel c
          WHERE c.provider = 'google_sheet' AND c.is_active AND c.deleted_at IS NULL
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
      [n],
    );
  }
}
