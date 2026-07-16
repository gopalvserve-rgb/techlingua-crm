import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { Me, ReportService } from './report.service';
import { ExportFormat, ExportService, fileNameFor } from './export.service';
import { entityByKey } from './entities';

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface ScheduleRow {
  id: number; report_id: number; frequency: Frequency;
  hour_local: number; minute_local: number;
  day_of_week: number | null; day_of_month: number | null;
  format: ExportFormat; run_as_user_id: number; is_active: boolean;
  next_run_at: string | null; last_run_at: string | null;
}

/** IST. The client is in India, every user is in India, and business hours already
 *  assume it (messaging.service DEFAULT_HOURS). One timezone, stated once. */
export const IST_OFFSET_MIN = 330;

/**
 * =============================================================================
 * THE RUN KEY — why a schedule cannot double-send
 * =============================================================================
 * `runKey` names the PERIOD a run belongs to, not the moment it happens:
 *
 *   daily    -> '2026-07-17'
 *   weekly   -> '2026-W29'
 *   monthly  -> '2026-07'
 *
 * `report_delivery` has UNIQUE(schedule_id, run_key), and the worker's FIRST act is to
 * INSERT that row with ON CONFLICT DO NOTHING RETURNING id. No id back means somebody
 * else owns this period — another replica, or a retry after a crash — and we stop.
 *
 * This is the Sprint-4 journey rule, unchanged and for the same reason: a UNIQUE index,
 * never a check-then-insert that races. `SELECT ... WHERE NOT EXISTS` then `INSERT` has
 * a window between the two statements, and "the window is only microseconds" is how you
 * get two identical reports in the client's inbox on the one morning two replicas happen
 * to tick together. The index has no window.
 *
 * It also survives a restart: the row is written BEFORE the email is queued, so a crash
 * mid-send leaves a `running` row that the next tick will not re-claim. The client gets
 * one email or none, never two.
 *
 * PURE, so the tests can prove it without a clock: `nextRunAt` and `runKeyFor` take the
 * current time as an argument.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC instant -> the local (IST) wall-clock parts. */
const local = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
const toUtc = (d: Date) => new Date(d.getTime() - IST_OFFSET_MIN * 60_000);

/** ISO-8601 week number of a local date. */
export function isoWeek(d: Date): [number, number] {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return [year, week];
}

/** The period key for the run DUE at `at` (a UTC instant). */
export function runKeyFor(freq: Frequency, at: Date): string {
  const l = local(at);
  switch (freq) {
    case 'daily':   return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`;
    case 'weekly':  { const [y, w] = isoWeek(l); return `${y}-W${pad(w)}`; }
    case 'monthly': return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}`;
  }
}

/**
 * The next UTC instant this schedule is due, STRICTLY AFTER `from`.
 *
 * "Strictly after" matters: called right after a run, it must return TOMORROW, not today
 * again. A `>=` here is an infinite loop that emails the client every two seconds, and it
 * is exactly the sort of thing that is obvious in a spec and invisible in review.
 */
export function nextRunAt(s: Pick<ScheduleRow, 'frequency' | 'hour_local' | 'minute_local' | 'day_of_week' | 'day_of_month'>, from: Date): Date {
  const l = local(from);
  const at = (y: number, m: number, d: number) => toUtc(new Date(Date.UTC(y, m, d, s.hour_local, s.minute_local, 0, 0)));

  if (s.frequency === 'daily') {
    let c = at(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
    if (c <= from) c = at(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + 1);
    return c;
  }
  if (s.frequency === 'weekly') {
    const want = s.day_of_week ?? 1;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(l); d.setUTCDate(d.getUTCDate() + i);
      if (d.getUTCDay() !== want) continue;
      const c = at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (c > from) return c;
    }
    const d = new Date(l); d.setUTCDate(d.getUTCDate() + 7);
    return at(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  // monthly. day_of_month is capped at 28 by the migration's CHECK — deliberately:
  // "the 31st" is a schedule that silently skips February, and a client who set it would
  // never be told. 28 is the last day EVERY month has.
  const dom = s.day_of_month ?? 1;
  let c = at(l.getUTCFullYear(), l.getUTCMonth(), dom);
  if (c <= from) c = at(l.getUTCFullYear(), l.getUTCMonth() + 1, dom);
  return c;
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportService,
    private readonly exports: ExportService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id ?? 1);
  }

  async list(me: Me, scope: ResolvedScope) {
    const rows = await this.db.query<any>(
      `SELECT s.*, r.name AS report_name, r.entity, u.name AS run_as_name,
              (SELECT count(*) FROM report_delivery d WHERE d.schedule_id = s.id)::int AS runs,
              (SELECT max(d2.started_at) FROM report_delivery d2 WHERE d2.schedule_id = s.id AND d2.status = 'sent') AS last_sent_at
         FROM report_schedule s
         JOIN report_definition r ON r.id = s.report_id
         LEFT JOIN "user" u ON u.id = s.run_as_user_id
        WHERE s.deleted_at IS NULL AND r.deleted_at IS NULL
          AND ($1::boolean OR s.created_by = $2 OR s.run_as_user_id = $2)
        ORDER BY s.id DESC`,
      [scope.all === true, me.id],
    );
    return rows.map((r) => ({
      ...r, id: Number(r.id), report_id: Number(r.report_id),
      recipient_user_ids: r.recipient_user_ids ?? [], recipient_role_ids: r.recipient_role_ids ?? [],
    }));
  }

  async create(dto: any, me: Me, scope: ResolvedScope) {
    const reportId = Number(dto?.report_id);
    if (!reportId) throw new BadRequestException('Pick a report to schedule.');
    await this.reports.get(reportId, me, scope);   // 404 if not visible to them

    const freq = String(dto?.frequency ?? 'daily') as Frequency;
    if (!['daily', 'weekly', 'monthly'].includes(freq)) throw new BadRequestException(`Unknown frequency "${dto?.frequency}".`);
    const format = String(dto?.format ?? 'xlsx');
    if (!['xlsx', 'pdf', 'csv'].includes(format)) throw new BadRequestException(`Unknown format "${format}".`);

    const users: number[] = (dto?.recipient_user_ids ?? []).map(Number).filter(Boolean);
    const roles: number[] = (dto?.recipient_role_ids ?? []).map(Number).filter(Boolean);
    // A schedule with no recipients is a timer that does nothing, and it will sit in the
    // client's list looking like it works.
    if (!users.length && !roles.length) throw new BadRequestException('Choose at least one recipient (a person or a role).');

    const s = {
      frequency: freq,
      hour_local: clamp(dto?.hour_local, 0, 23, 8),
      minute_local: clamp(dto?.minute_local, 0, 59, 0),
      day_of_week: freq === 'weekly' ? clamp(dto?.day_of_week, 0, 6, 1) : null,
      day_of_month: freq === 'monthly' ? clamp(dto?.day_of_month, 1, 28, 1) : null,
    };
    const next = nextRunAt(s as any, new Date());

    const r = await this.db.one<{ id: string }>(
      `INSERT INTO report_schedule
         (org_id, report_id, frequency, hour_local, minute_local, day_of_week, day_of_month,
          format, recipient_user_ids, recipient_role_ids, run_as_user_id, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$11) RETURNING id`,
      [await this.orgId(), reportId, s.frequency, s.hour_local, s.minute_local, s.day_of_week, s.day_of_month,
        format, JSON.stringify(users), JSON.stringify(roles), me.id, next],
    );
    return this.get(Number(r!.id), me, scope);
  }

  async get(id: number, me: Me, scope: ResolvedScope) {
    const rows = await this.list(me, scope);
    const r = rows.find((x) => x.id === id);
    if (!r) throw new NotFoundException('Schedule not found.');
    return r;
  }

  /** PAUSE / RESUME. A real kill switch — the same idea as a journey's. Resuming
   *  recomputes `next_run_at` from NOW, so a schedule paused for a month does not wake
   *  up and immediately fire the four runs it "missed". Nobody wants four reports. */
  async setActive(id: number, active: boolean, me: Me, scope: ResolvedScope) {
    await this.get(id, me, scope);
    const row = await this.db.one<any>(`SELECT * FROM report_schedule WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Schedule not found.');
    const next = active ? nextRunAt(row, new Date()) : null;
    await this.db.query(
      `UPDATE report_schedule SET is_active = $2, next_run_at = $3, updated_at = now() WHERE id = $1`,
      [id, active, next],
    );
    return this.get(id, me, scope);
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    await this.get(id, me, scope);
    await this.db.query(
      `UPDATE report_schedule SET deleted_at = now(), deleted_by = $2, is_active = FALSE WHERE id = $1`, [id, me.id],
    );
    return { id, deleted: true };
  }

  /** DELIVERY HISTORY — success, failure, and the REASON. The client's first question
   *  when a report does not arrive is "did it send?", and the answer must be on the
   *  screen, not in a log file he cannot reach. */
  async history(id: number, me: Me, scope: ResolvedScope) {
    await this.get(id, me, scope);
    const rows = await this.db.query<any>(
      `SELECT d.id, d.run_key, d.status, d.recipients, d.file_name, d.row_count, d.error,
              d.started_at, d.finished_at
         FROM report_delivery d WHERE d.schedule_id = $1
        ORDER BY d.id DESC LIMIT 50`, [id],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  /** Resolve recipients (explicit users + everyone holding a listed role) to addresses. */
  async recipientsOf(s: any): Promise<Array<{ user_id: number; name: string; email: string | null }>> {
    const userIds = (s.recipient_user_ids ?? []).map(Number).filter(Boolean);
    const roleIds = (s.recipient_role_ids ?? []).map(Number).filter(Boolean);
    const rows = await this.db.query<any>(
      `SELECT DISTINCT u.id, u.name, u.email
         FROM "user" u
        WHERE u.deleted_at IS NULL AND u.status = 'active'
          AND (u.id = ANY($1::bigint[])
               OR EXISTS (SELECT 1 FROM user_assignment ua
                           WHERE ua.user_id = u.id AND ua.is_active AND ua.role_id = ANY($2::bigint[])))
        ORDER BY u.name`,
      [userIds, roleIds],
    );
    return rows.map((r) => ({ user_id: Number(r.id), name: r.name, email: r.email }));
  }

  /** "Run now" — the same code path the timer uses, so a client testing his schedule
   *  tests the real thing. It writes its own delivery row with a `manual-<ts>` run key,
   *  which cannot collide with a period key, so a manual test never consumes the
   *  morning's scheduled run. */
  manualRunKey = () => `manual-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};
