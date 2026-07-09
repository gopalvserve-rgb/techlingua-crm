import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { redact } from '../common/redact';

/**
 * Error Log module — capture, grouping and resolve workflow for the
 * Administration › Error Logs screen ("show all errors, issues and highlight bugs").
 *
 * Capture policy (enforced by classify()):
 *   5xx            -> level 'error'   (bugs — stack persisted)
 *   409 / 400      -> level 'warning' (issues — validation/conflict, no stack noise)
 *   401 / 403 / 404 -> NOT logged     (auth/permission/existence noise)
 *
 * The writer is strictly fail-safe & fire-and-forget: capture() never throws and
 * never blocks the response it is recording.
 */

export type ErrLevel = 'error' | 'warning';

export const MAX_STACK = 4000;
export const MAX_MESSAGE = 2000;
export const MAX_PATH = 300;

/** HTTP status -> log level; null = do not log (noise). */
export function classify(status: number): ErrLevel | null {
  if (status >= 500) return 'error';
  if (status === 409 || status === 400) return 'warning';
  return null;
}

/** '/api/leads/123/notes' -> '/api/leads/:id/notes' (ids collapse so groups are stable). */
export function normalizePath(path?: string | null): string {
  return String(path ?? '')
    .split('?')[0]
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .slice(0, MAX_PATH);
}

/** Message normalised for grouping: digits & quoted values collapsed, case-folded. */
export function normalizeMessage(message?: string | null): string {
  return String(message ?? '')
    .replace(/'[^']*'/g, "'*'")
    .replace(/"[^"]*"/g, '"*"')
    .replace(/\d+/g, '#')
    .toLowerCase()
    .trim()
    .slice(0, 300);
}

/** Stable group key: same root cause -> same fingerprint across occurrences. */
export function fingerprintOf(source: string, path?: string | null, message?: string | null): string {
  return createHash('sha256')
    .update(`${source}|${normalizePath(path)}|${normalizeMessage(message)}`)
    .digest('hex')
    .slice(0, 40);
}

export function truncStack(stack?: string | null): string | null {
  if (!stack) return null;
  const s = String(stack);
  return s.length > MAX_STACK ? s.slice(0, MAX_STACK) + '\n… [truncated]' : s;
}

export interface CaptureInput {
  source: 'api' | 'web';
  level: ErrLevel;
  statusCode?: number | null;
  method?: string | null;
  path?: string | null;
  message: string;
  stack?: string | null;
  userId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: unknown;
}

export interface ListFilters {
  source?: string; level?: string; status?: string; status_code?: number;
  q?: string; from?: string; to?: string; fingerprint?: string;
  grouped?: boolean; limit?: number; offset?: number;
}

@Injectable()
export class ErrorLogService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Persist one error/issue. Fail-safe: never throws, and the returned promise
   * always resolves (callers may `void` it — fire-and-forget — or await it).
   */
  capture(e: CaptureInput): Promise<number | null> {
    try {
      const fp = fingerprintOf(e.source, e.path, e.message);
      const meta = e.meta == null ? null : JSON.stringify(redact(e.meta));
      return this.db
        .query<{ id: string }>(
          `INSERT INTO error_log (org_id, source, level, status_code, method, path, message, stack,
                                  fingerprint, user_id, ip, user_agent, meta)
           VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1),
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            e.source, e.level, e.statusCode ?? null, e.method?.slice(0, 10) ?? null,
            normalizePath(e.path) || null, String(e.message ?? '').slice(0, MAX_MESSAGE),
            truncStack(e.stack), fp, e.userId ?? null, e.ip?.slice(0, 45) ?? null,
            e.userAgent?.slice(0, 400) ?? null, meta,
          ],
        )
        .then((r) => (r[0] ? Number(r[0].id) : null))
        .catch((err) => {
          console.error('error_log write failed:', err?.message ?? err);
          return null;
        });
    } catch (err) {
      console.error('error_log capture failed:', (err as Error)?.message ?? err);
      return Promise.resolve(null);
    }
  }

  private buildWhere(f: ListFilters, params: unknown[]): string {
    const where: string[] = ['1=1'];
    if (f.source) { params.push(f.source); where.push(`e.source = $${params.length}`); }
    if (f.level) { params.push(f.level); where.push(`e.level = $${params.length}`); }
    if (f.status) { params.push(f.status); where.push(`e.status = $${params.length}`); }
    if (f.status_code) { params.push(f.status_code); where.push(`e.status_code = $${params.length}`); }
    if (f.fingerprint) { params.push(f.fingerprint); where.push(`e.fingerprint = $${params.length}`); }
    if (f.q?.trim()) {
      params.push(`%${f.q.trim()}%`);
      where.push(`(e.path ILIKE $${params.length} OR e.message ILIKE $${params.length})`);
    }
    if (f.from) { params.push(f.from); where.push(`e.occurred_at >= $${params.length}::timestamptz`); }
    if (f.to) { params.push(f.to); where.push(`e.occurred_at < ($${params.length}::date + 1)::timestamptz`); }
    return where.join(' AND ');
  }

  /** Flat events (default) or fingerprint groups (grouped=true). */
  async list(f: ListFilters) {
    const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
    const offset = Math.max(Number(f.offset) || 0, 0);

    if (f.grouped) {
      const params: unknown[] = [];
      const where = this.buildWhere(f, params);
      const total = await this.db.one<{ ct: string }>(
        `SELECT COUNT(DISTINCT e.fingerprint) AS ct FROM error_log e WHERE ${where}`, params);
      params.push(limit, offset);
      const rows = await this.db.query(
        `SELECT e.fingerprint,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE e.status = 'open')::int AS open_count,
                MAX(e.occurred_at) AS last_seen,
                MIN(e.occurred_at) AS first_seen,
                (array_agg(e.id ORDER BY e.occurred_at DESC))[1] AS last_id,
                (array_agg(e.level ORDER BY e.occurred_at DESC))[1] AS level,
                (array_agg(e.source ORDER BY e.occurred_at DESC))[1] AS source,
                (array_agg(e.status_code ORDER BY e.occurred_at DESC))[1] AS status_code,
                (array_agg(e.method ORDER BY e.occurred_at DESC))[1] AS method,
                (array_agg(e.path ORDER BY e.occurred_at DESC))[1] AS path,
                (array_agg(e.message ORDER BY e.occurred_at DESC))[1] AS message,
                (array_agg(u.name ORDER BY e.occurred_at DESC))[1] AS user_name
           FROM error_log e LEFT JOIN "user" u ON u.id = e.user_id
          WHERE ${where}
          GROUP BY e.fingerprint
          ORDER BY MAX(e.occurred_at) DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: Number(total?.ct ?? 0), grouped: true, rows };
    }

    const params: unknown[] = [];
    const where = this.buildWhere(f, params);
    const total = await this.db.one<{ ct: string }>(
      `SELECT COUNT(*) AS ct FROM error_log e WHERE ${where}`, params);
    params.push(limit, offset);
    const rows = await this.db.query(
      `SELECT e.id, e.occurred_at, e.source, e.level, e.status_code, e.method, e.path, e.message,
              e.fingerprint, e.status, e.user_id, e.resolved_at, u.name AS user_name, r.name AS resolved_by_name
         FROM error_log e
         LEFT JOIN "user" u ON u.id = e.user_id
         LEFT JOIN "user" r ON r.id = e.resolved_by
        WHERE ${where}
        ORDER BY e.occurred_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: Number(total?.ct ?? 0), grouped: false, rows };
  }

  /** KPI card + 14-day trend numbers for the Error Logs screen. */
  async summary() {
    const [core] = await this.db.query(
      `SELECT COUNT(*) FILTER (WHERE level = 'error'   AND occurred_at >= CURRENT_DATE)::int AS errors_today,
              COUNT(*) FILTER (WHERE level = 'warning' AND occurred_at >= CURRENT_DATE)::int AS warnings_today,
              COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
              COUNT(*) FILTER (WHERE status = 'open' AND level = 'error')::int AS open_errors,
              COUNT(*) FILTER (WHERE status = 'resolved'
                               AND resolved_at >= date_trunc('week', now()))::int AS resolved_week
         FROM error_log`,
    );
    const top = await this.db.one<{ path: string; ct: number }>(
      `SELECT path, COUNT(*)::int AS ct FROM error_log
        WHERE level = 'error' AND occurred_at >= now() - interval '7 days' AND path IS NOT NULL
        GROUP BY path ORDER BY ct DESC, path LIMIT 1`,
    );
    const trend = await this.db.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE(COUNT(e.id) FILTER (WHERE e.level = 'error'), 0)::int AS errors,
              COALESCE(COUNT(e.id) FILTER (WHERE e.level = 'warning'), 0)::int AS warnings
         FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') AS d(day)
         LEFT JOIN error_log e ON e.occurred_at >= d.day AND e.occurred_at < d.day + interval '1 day'
        GROUP BY d.day ORDER BY d.day`,
    );
    return {
      errors_today: core?.errors_today ?? 0,
      warnings_today: core?.warnings_today ?? 0,
      open_count: core?.open_count ?? 0,
      open_errors: core?.open_errors ?? 0,
      resolved_week: core?.resolved_week ?? 0,
      top_path_7d: top ? { path: top.path, count: Number(top.ct) } : null,
      trend,
    };
  }

  /** Full detail incl. stack + redacted meta. 404 when missing. */
  async get(id: number) {
    const row = await this.db.one(
      `SELECT e.*, u.name AS user_name, r.name AS resolved_by_name
         FROM error_log e
         LEFT JOIN "user" u ON u.id = e.user_id
         LEFT JOIN "user" r ON r.id = e.resolved_by
        WHERE e.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('error_log not found');
    return row;
  }

  /** Resolve / reopen one event (records resolved_by / resolved_at). */
  async setStatus(id: number, status: string, actorId: number) {
    if (status !== 'open' && status !== 'resolved') {
      throw new BadRequestException("status must be 'open' or 'resolved'");
    }
    const row = await this.db.one(
      `UPDATE error_log
          SET status = $2,
              resolved_by = CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END,
              resolved_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
        WHERE id = $1
        RETURNING *`,
      [id, status, status === 'resolved', actorId],
    );
    if (!row) throw new NotFoundException('error_log not found');
    return row;
  }

  /** Bulk resolve/reopen every event sharing a fingerprint (group action). */
  async setGroupStatus(fingerprint: string, status: string, actorId: number) {
    if (!fingerprint?.trim()) throw new BadRequestException('fingerprint is required');
    if (status !== 'open' && status !== 'resolved') {
      throw new BadRequestException("status must be 'open' or 'resolved'");
    }
    const rows = await this.db.query<{ id: string }>(
      `UPDATE error_log
          SET status = $2,
              resolved_by = CASE WHEN $3::boolean THEN $4::bigint ELSE NULL END,
              resolved_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
        WHERE fingerprint = $1 AND status <> $2
        RETURNING id`,
      [fingerprint.trim(), status, status === 'resolved', actorId],
    );
    return { fingerprint: fingerprint.trim(), status, updated: rows.length };
  }
}
