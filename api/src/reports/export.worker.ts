import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExportService } from './export.service';

/**
 * THE EXPORT WORKER — the FOURTH user of the same topology (ImportWorker,
 * ReminderWorker, MessageWorker, and now this): an in-process ticker over a Postgres
 * queue, because Railway runs a single `api` service. Decision log #22.
 *
 * Multi-replica safe by `FOR UPDATE SKIP LOCKED`, crash-safe by reclaiming rows stuck
 * in `running`, and self-cleaning: an export's bytes live in the row and are swept once
 * it expires, so a table of spreadsheets cannot quietly become the biggest thing in the
 * client's database.
 *
 * Disable with EXPORT_WORKER=0 (the specs drive tick() directly).
 */
@Injectable()
export class ExportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ExportWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;

  static readonly TICK_MS = 2_000;
  static readonly BATCH = 2;          // an export is CPU-bound; two at a time keeps the
                                      // event loop responsive for actual API traffic
  static readonly STUCK_AFTER = '5 minutes';
  static readonly MAX_ATTEMPTS = 2;   // a failing export fails deterministically; a third
                                      // go would just burn the same CPU for the same error

  constructor(private readonly db: DatabaseService, private readonly exports: ExportService) {}

  onModuleInit() {
    if (process.env.EXPORT_WORKER === '0') { this.log.warn('export worker disabled (EXPORT_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, ExportWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('export worker started (postgres queue, in-process)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.reclaimStuck();
      // The sweep is not on every tick: it is a DELETE over a table with bytes in it, and
      // it has nothing to do 99% of the time. Once every ~2 minutes is plenty.
      if (++this.ticks % 60 === 0) await this.sweepExpired();
      const ids = await this.claim(ExportWorker.BATCH);
      let done = 0;
      for (const id of ids) { await this.exports.render(id); done++; }
      return done;
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async claim(n: number): Promise<number[]> {
    const rows = await this.db.query<{ id: string }>(
      `WITH due AS (
         SELECT x.id FROM report_export x
          WHERE x.status = 'queued'
          ORDER BY x.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE report_export x
          SET status = 'running', attempts = x.attempts + 1, locked_at = now()
         FROM due
        WHERE x.id = due.id
        RETURNING x.id`,
      [n],
    );
    return rows.map((r) => Number(r.id));
  }

  private async reclaimStuck() {
    await this.db.query(
      `UPDATE report_export
          SET status = 'queued', locked_at = NULL
        WHERE status = 'running' AND locked_at < now() - INTERVAL '${ExportWorker.STUCK_AFTER}'
          AND attempts < ${ExportWorker.MAX_ATTEMPTS}`,
    );
    // a row that crashed the process on its LAST attempt must not spin forever
    await this.db.query(
      `UPDATE report_export
          SET status = 'failed', error = COALESCE(error, 'The export timed out.'), finished_at = now()
        WHERE status = 'running' AND locked_at < now() - INTERVAL '${ExportWorker.STUCK_AFTER}'
          AND attempts >= ${ExportWorker.MAX_ATTEMPTS}`,
    );
  }

  /** Expired exports lose their BYTES but keep their ROW: "you exported this yesterday,
   *  the file is gone, run it again" is useful; a vanished history is not. */
  private async sweepExpired() {
    await this.db.query(
      `UPDATE report_export SET bytes = NULL WHERE expires_at < now() AND bytes IS NOT NULL`,
    );
    await this.db.query(`DELETE FROM report_export WHERE created_at < now() - INTERVAL '30 days'`);
  }
}
