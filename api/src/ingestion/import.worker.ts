import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService, IngestTarget } from './lead-ingestion.service';
import { IngestPayload, IngestValidationError } from './ingestion.types';

/**
 * IN-PROCESS INGESTION WORKER (decision log 14 Jul 2026).
 *
 * The queue is Postgres (`import_job`), not Redis/BullMQ: Railway runs a single
 * `api` service, so a separate worker process is not deployable today, and a
 * Postgres queue is durable across restarts with no extra infrastructure.
 * Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so this stays correct if the
 * API is scaled to several replicas, and the worker can be lifted out into its
 * own process (or swapped for BullMQ) behind the same table without touching
 * LeadIngestionService.
 *
 * Guarantees:
 *  - rate-limited: BATCH_SIZE jobs per tick (protects the DB from source bursts)
 *  - retries with exponential backoff on transient errors (max MAX_ATTEMPTS)
 *  - permanent (validation) errors are NOT retried
 *  - every terminal failure lands in `import_error` — nothing is ever dropped
 *  - crash-safe: jobs stuck in `running` are reclaimed after STUCK_AFTER
 */
@Injectable()
export class ImportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ImportWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 1000;
  static readonly BATCH_SIZE = 25;       // rate limit: rows per tick
  static readonly MAX_ATTEMPTS = 3;
  static readonly STUCK_AFTER = '5 minutes';

  constructor(private readonly db: DatabaseService, private readonly ingestion: LeadIngestionService) {}

  onModuleInit() {
    if (process.env.INGEST_WORKER === '0') { this.log.warn('ingestion worker disabled (INGEST_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, ImportWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('ingestion worker started (postgres queue, in-process)');
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** One poll cycle. Public so tests can drive it deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;      // never overlap ticks
    this.running = true;
    try {
      await this.reclaimStuck();
      const jobs = await this.claim(ImportWorker.BATCH_SIZE);
      const targets = new Map<string, IngestTarget>();
      for (const job of jobs) {
        try {
          const key = `${job.campaign_id}:${job.source_id}`;
          if (!targets.has(key)) targets.set(key, await this.ingestion.loadTarget(Number(job.campaign_id), Number(job.source_id)));
          await this.run(job, targets.get(key)!);
        } catch (e) {
          await this.fail(job, e as Error);
        }
      }
      await this.settleBatches();
      return jobs.length;
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Atomically take up to `n` due jobs (multi-instance safe). */
  private async claim(n: number): Promise<any[]> {
    return this.db.query(
      `WITH due AS (
         SELECT j.id FROM import_job j
          WHERE j.status = 'queued' AND j.run_after <= now()
          ORDER BY j.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE import_job j
          SET status = 'running', attempts = j.attempts + 1, locked_at = now(), updated_at = now()
         FROM due, import_batch b
        WHERE j.id = due.id AND b.id = j.batch_id
        RETURNING j.id, j.batch_id, j.row_num, j.payload, j.raw, j.dedupe_key, j.attempts,
                  b.campaign_id, b.source_id, b.created_by`,
      [n],
    );
  }

  private async reclaimStuck() {
    await this.db.query(
      `UPDATE import_job SET status = 'queued', run_after = now(), updated_at = now()
        WHERE status = 'running' AND locked_at < now() - INTERVAL '${ImportWorker.STUCK_AFTER}'
          AND attempts < ${ImportWorker.MAX_ATTEMPTS}`,
    );
    await this.db.query(
      `UPDATE import_batch SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE status = 'queued'
          AND EXISTS (SELECT 1 FROM import_job j WHERE j.batch_id = import_batch.id AND j.status <> 'queued')`,
    );
  }

  private async run(job: any, target: IngestTarget) {
    const payload = (job.payload ?? {}) as IngestPayload;
    const out = await this.ingestion.ingest(payload, {
      channel: 'csv',
      campaign_id: Number(job.campaign_id),
      source_id: Number(job.source_id),
      actor_id: job.created_by == null ? null : Number(job.created_by),
      batch_id: Number(job.batch_id),
      duplicate_policy: 'campaign',
    }, target);

    await this.db.query(
      `UPDATE import_job SET status = $2, lead_id = $3, error = $4, updated_at = now() WHERE id = $1`,
      [job.id, out.status, out.lead_id ?? null, out.reason ?? null],
    );
    const col = { created: 'created_count', duplicate: 'duplicate_count', skipped: 'skipped_count', failed: 'failed_count' }[out.status];
    await this.db.query(`UPDATE import_batch SET ${col} = ${col} + 1 WHERE id = $1`, [job.batch_id]);
  }

  /** Transient -> retry with backoff; permanent (or exhausted) -> dead-letter. */
  private async fail(job: any, err: Error) {
    const permanent = err instanceof IngestValidationError || (err as any).permanent === true
      || (err as any).status === 400 || (err as any).status === 404;
    const attempts = Number(job.attempts ?? 1);
    const reason = err.message || 'Unknown error';

    if (!permanent && attempts < ImportWorker.MAX_ATTEMPTS) {
      const backoff = Math.pow(2, attempts) * 5; // 10s, 20s
      await this.db.query(
        `UPDATE import_job SET status = 'queued', run_after = now() + ($2 || ' seconds')::interval,
                error = $3, updated_at = now() WHERE id = $1`,
        [job.id, String(backoff), reason],
      );
      return;
    }
    await this.db.query(
      `UPDATE import_job SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [job.id, reason],
    );
    await this.db.query(
      `INSERT INTO import_error (batch_id, job_id, row_num, raw, reason, attempts)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [job.batch_id, job.id, job.row_num, JSON.stringify(job.raw ?? {}), reason, attempts],
    );
    await this.db.query(`UPDATE import_batch SET failed_count = failed_count + 1 WHERE id = $1`, [job.batch_id]);
  }

  /** Close batches whose queue has drained. */
  private async settleBatches() {
    await this.db.query(
      `UPDATE import_batch b
          SET status = CASE WHEN b.failed_count >= b.total_rows AND b.total_rows > 0 THEN 'failed' ELSE 'done' END,
              finished_at = now()
        WHERE b.status IN ('queued','running')
          AND NOT EXISTS (SELECT 1 FROM import_job j WHERE j.batch_id = b.id AND j.status IN ('queued','running'))`,
    );
  }
}
