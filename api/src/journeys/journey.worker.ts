import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { JourneyService } from './journey.service';
import { triggerKey } from './journey.engine';

/**
 * THE JOURNEY WORKER. Same topology again (in-process ticker over Postgres).
 *
 * Two jobs:
 *  1. TIME-BASED TRIGGERS — `no_response`, `fee_due` and `birthday` have no event to hook:
 *     nobody TOUCHES a lead that has gone quiet. So they are SWEPT. This is what makes
 *     "no response for 3 days -> WhatsApp" actually happen with the client asleep.
 *  2. RESUMING PARKED RUNS — a `wait` step sets `next_run_at`; this picks them back up,
 *     so a 3-day nurture sequence survives restarts, deploys and replica changes.
 *
 * Idempotency is NOT this worker's problem: it calls `fire()`, and the unique index on
 * (journey, lead, trigger_key) decides whether anything happens. Sweeping the same lead
 * every 60 seconds for a whole day therefore produces exactly ONE message — which is why
 * the sweep can be dumb and frequent instead of clever and fragile.
 *
 * Disable with JOURNEY_WORKER=0 (tests drive tick() directly).
 */
@Injectable()
export class JourneyWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('JourneyWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  static readonly TICK_MS = 60_000;
  static readonly BATCH = 100;

  constructor(private readonly db: DatabaseService, private readonly journeys: JourneyService) {}

  onModuleInit() {
    if (process.env.JOURNEY_WORKER === '0') { this.log.warn('journey worker disabled (JOURNEY_WORKER=0)'); return; }
    this.timer = setInterval(() => { void this.tick(); }, JourneyWorker.TICK_MS);
    this.timer.unref?.();
    this.log.log('journey worker started (time triggers + parked runs)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<{ resumed: number; fired: number }> {
    if (this.running) return { resumed: 0, fired: 0 };
    this.running = true;
    try {
      const resumed = await this.resume();
      const fired = (await this.sweepNoResponse()) + (await this.sweepFeeDue()) + (await this.sweepBirthdays());
      return { resumed, fired };
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
      return { resumed: 0, fired: 0 };
    } finally {
      this.running = false;
    }
  }

  /** Runs parked by a `wait` step whose time has come. */
  async resume(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `WITH due AS (
         SELECT r.id FROM journey_run r
          WHERE r.status = 'pending' AND r.next_run_at <= now()
          ORDER BY r.id LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE journey_run r SET locked_at = now(), updated_at = now()
         FROM due WHERE r.id = due.id
       RETURNING r.id`,
      [JourneyWorker.BATCH],
    );
    for (const r of rows) await this.journeys.execute(Number(r.id));
    return rows.length;
  }

  /**
   * NO RESPONSE FOR N DAYS. One journey may say 3 days and another 7, so we sweep per
   * distinct `days` value rather than assuming one policy.
   */
  async sweepNoResponse(): Promise<number> {
    const journeys = await this.db.query<any>(
      `SELECT id, trigger_config FROM journey
        WHERE trigger_type = 'no_response' AND status = 'active' AND deleted_at IS NULL`,
    );
    let fired = 0;
    for (const j of journeys) {
      const days = Math.max(1, Number(j.trigger_config?.days ?? 3));
      // "no response" = no activity AND still open (not won/lost). A lost lead that gets
      // chased is the sort of thing that makes a client turn automation off.
      const leads = await this.db.query<{ id: string }>(
        `SELECT l.id
           FROM lead l
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE l.deleted_at IS NULL AND l.is_active
            AND COALESCE(st.stage_type, 'open') NOT IN ('won','lost')
            AND COALESCE(l.last_activity_at, l.created_at) <= now() - ($1 || ' days')::interval
          ORDER BY l.id
          LIMIT $2`,
        [String(days), JourneyWorker.BATCH],
      );
      for (const l of leads) {
        const ids = await this.journeys.fire('no_response', Number(l.id), { days });
        fired += ids.length;
      }
    }
    return fired;
  }

  /**
   * FEE DUE. Phase-1 has no invoice table (Sprint 5 / Phase 3 brings it), so the due date
   * is read from the lead's custom fields — `custom_fields.fee_due_date`, which the client
   * can already populate today via a Custom Field. When invoices land, this ONE query
   * changes and every fee-due journey the client has built keeps working unchanged.
   */
  async sweepFeeDue(): Promise<number> {
    const journeys = await this.db.query<any>(
      `SELECT id, trigger_config FROM journey
        WHERE trigger_type = 'fee_due' AND status = 'active' AND deleted_at IS NULL`,
    );
    let fired = 0;
    for (const j of journeys) {
      const before = Math.max(0, Number(j.trigger_config?.days_before ?? 3));
      const leads = await this.db.query<{ id: string; due: string }>(
        `SELECT l.id, (l.custom_fields->>'fee_due_date') AS due
           FROM lead l
          WHERE l.deleted_at IS NULL AND l.is_active
            AND l.custom_fields ? 'fee_due_date'
            AND (l.custom_fields->>'fee_due_date') ~ '^\\d{4}-\\d{2}-\\d{2}'
            AND (l.custom_fields->>'fee_due_date')::date = (current_date + ($1 || ' days')::interval)::date
          ORDER BY l.id LIMIT $2`,
        [String(before), JourneyWorker.BATCH],
      );
      for (const l of leads) {
        // keyed on the DUE DATE, so a lead is reminded once per due date, not once per sweep
        const ids = await this.journeys.fire('fee_due', Number(l.id), { date: new Date(`${l.due}T00:00:00Z`) });
        fired += ids.length;
      }
    }
    return fired;
  }

  /** BIRTHDAY — month/day match, keyed on the year, so it fires once a year per lead. */
  async sweepBirthdays(): Promise<number> {
    const journeys = await this.db.query<any>(
      `SELECT id, trigger_config FROM journey
        WHERE trigger_type = 'birthday' AND status = 'active' AND deleted_at IS NULL`,
    );
    let fired = 0;
    for (const j of journeys) {
      const before = Math.max(0, Number(j.trigger_config?.days_before ?? 0));
      const leads = await this.db.query<{ id: string }>(
        `SELECT l.id FROM lead l
          WHERE l.deleted_at IS NULL AND l.is_active AND l.dob IS NOT NULL
            AND to_char(l.dob, 'MM-DD')
                = to_char((current_date + ($1 || ' days')::interval)::date, 'MM-DD')
          ORDER BY l.id LIMIT $2`,
        [String(before), JourneyWorker.BATCH],
      );
      for (const l of leads) {
        const ids = await this.journeys.fire('birthday', Number(l.id), {});
        fired += ids.length;
      }
    }
    return fired;
  }

  /** Exposed for the tests: the key a sweep would produce (documents the contract). */
  static keyFor = triggerKey;
}
