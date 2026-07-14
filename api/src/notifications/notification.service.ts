import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * The in-app notification CENTRE (the bell). Notifications are inherently personal:
 * every query is hard-filtered by `user_id = <the caller>` — there is no scope in
 * which one user reads another's bell, so this needs no ScopeResolver branch.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly db: DatabaseService) {}

  async list(userId: number, opts: { unread?: boolean; limit?: number } = {}) {
    const params: unknown[] = [userId];
    let where = `n.user_id = $1`;
    if (opts.unread) where += ` AND n.read_at IS NULL`;
    params.push(Math.min(Number(opts.limit) || 30, 100));
    return this.db.query(
      `SELECT n.id, n.type, n.severity, n.title, n.body, n.link_type, n.link_id, n.meta,
              n.read_at, n.created_at
         FROM notification n
        WHERE ${where}
        ORDER BY n.created_at DESC
        LIMIT $${params.length}`, params,
    );
  }

  async unreadCount(userId: number) {
    const row = await this.db.one<{ ct: number }>(
      `SELECT COUNT(*)::int AS ct FROM notification WHERE user_id = $1 AND read_at IS NULL`, [userId],
    );
    return { unread: row?.ct ?? 0 };
  }

  /** Mark one as read. Scoped by user_id in the WHERE — another user's id simply matches nothing. */
  async markRead(id: number, userId: number) {
    const row = await this.db.one(
      `UPDATE notification SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 RETURNING id, read_at`, [id, userId],
    );
    return row ?? { id, read_at: null };
  }

  async markAllRead(userId: number) {
    const rows = await this.db.query(
      `UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id`, [userId],
    );
    return { marked: rows.length };
  }
}
