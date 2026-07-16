import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { isNotConfigured } from '../common/not-configured.exception';
import { MessagingService } from '../messaging/messaging.service';

/**
 * THE CHANNEL-AGNOSTIC NOTIFIER — the seam Sprint 4 plugs WhatsApp / SMS / Email into.
 *
 * Callers (reminders, escalations, SLA breaches, assignments) describe WHAT happened
 * and WHO must know. They never name a channel. The notifier fans the message out to
 * every channel enabled in `app_setting.notification_channels`:
 *
 *   in_app   -> ALWAYS ON, writes a `notification` row (the bell). Never fails.
 *   email    -> Sprint 4 (per-vertical SMTP)      \  registered but DISABLED — and if a
 *   sms      -> Sprint 4 (third-party gateway)     >  channel is switched on before its
 *   whatsapp -> Sprint 4 (Meta)                   /   credentials exist it degrades with
 *                                                     NotConfiguredException, logged, never thrown.
 *
 * Adding a channel = one entry in CHANNELS. No caller changes.
 */

// Sprint 5 adds 'approval' — an enrolment waiting on a manager. It is a first-class
// type (not 'system') precisely so the notification MATRIX can route it: a client who
// switches approvals on will want the approver emailed, not just belled.
export type NotificationType = 'reminder' | 'escalation' | 'assignment' | 'sla_breach' | 'handout' | 'approval' | 'system';

export interface NotifyMessage {
  /** the user who must know */
  userId: number;
  type: NotificationType;
  severity?: 'info' | 'warn' | 'error';
  title: string;
  body?: string;
  /** deep link back into the app */
  link?: { type: 'lead' | 'follow_up' | 'calendar'; id: number };
  meta?: Record<string, unknown>;
}

/** What a channel is handed. `messaging` is absent only in the in-memory test double. */
export interface NotifyContext {
  db: DatabaseService;
  orgId: number;
  client?: PoolClient;
  messaging?: { queue(m: Record<string, unknown>): Promise<unknown> };
}

/** A delivery channel. `send` must be idempotent-safe and must never throw. */
export interface NotifyChannel {
  key: 'in_app' | 'email' | 'sms' | 'whatsapp';
  label: string;
  send(msg: NotifyMessage, ctx: NotifyContext): Promise<void>;
}

/** in-app — the bell. The only channel live today; the others land in Sprint 4. */
const IN_APP: NotifyChannel = {
  key: 'in_app',
  label: 'In-app notification',
  async send(msg, { db, orgId, client }) {
    const sql = `INSERT INTO notification (org_id, user_id, type, severity, title, body, link_type, link_id, meta)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`;
    const params = [
      orgId, msg.userId, msg.type, msg.severity ?? 'info', msg.title.slice(0, 200), msg.body ?? null,
      msg.link?.type ?? null, msg.link?.id ?? null, JSON.stringify(msg.meta ?? {}),
    ];
    if (client) await client.query(sql, params as any[]);
    else await db.query(sql, params);
  },
};

/**
 * SPRINT 4 — the three placeholders are now REAL.
 *
 * Each one resolves the STAFF member's own address (email / mobile) and hands the message
 * to MessagingService, which owns the queue, the rate limit, the retry, the opt-out check
 * and the durable send log. The notifier therefore did not grow a second sending path: a
 * reminder email and a journey's marketing email are the same row in the same table, sent
 * by the same worker, visible on the same screen.
 *
 * They are still DISABLED by default (`notification_matrix`), and if the admin switches one
 * on before its credentials exist, MessagingService writes a `failed / not_configured` row
 * and the notifier swallows it — the bell still rings, the Error Log stays clean.
 */
const staffChannel = (key: 'email' | 'sms' | 'whatsapp', label: string): NotifyChannel => ({
  key, label,
  async send(msg, { db, messaging }) {
    if (!messaging) return;   // the in-memory test double has no messaging
    const u = await db.one<{ email: string | null; mobile: string | null; name: string }>(
      `SELECT email, mobile, name FROM "user" WHERE id = $1`, [msg.userId],
    );
    const to = key === 'email' ? u?.email : u?.mobile;
    // a staff member with no mobile on file is not an error — just not reachable this way
    if (!to) return;
    const text = msg.body ? `${msg.title} — ${msg.body}` : msg.title;
    await messaging.queue({
      channel: key,
      to,
      user_id: msg.userId,
      subject: key === 'email' ? msg.title : null,
      body: key === 'email' ? `<p>${text}</p>` : text,
      lead_id: msg.link?.type === 'lead' ? msg.link.id : null,
      // a notification to STAFF is not marketing: it must not be deferred to business
      // hours (an SLA breach at 21:00 matters at 21:00) and must not hit the lead cap.
      guarded: false,
    });
  },
});

export const CHANNELS: NotifyChannel[] = [
  IN_APP,
  staffChannel('email', 'Email'),
  staffChannel('sms', 'SMS'),
  staffChannel('whatsapp', 'WhatsApp'),
];

@Injectable()
export class NotifierService {
  private readonly log = new Logger('Notifier');

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly messaging?: MessagingService,
  ) {}

  /** The MASTER switch — a channel off here is off for every event. */
  async enabledChannels(): Promise<Record<string, boolean>> {
    return this.settings.get('notification_channels', {
      in_app: true, email: true, sms: true, whatsapp: true,
    }) as unknown as Promise<Record<string, boolean>>;
  }

  /**
   * THE NOTIFICATION MATRIX (Sprint 4) — which EVENT goes out on which CHANNEL.
   * `notification_channels` remains the master on/off; the matrix decides per event type.
   * Both default to sane values, so a missing row never means "notify nobody".
   */
  async matrix(): Promise<Record<string, Record<string, boolean>>> {
    return this.settings.get('notification_matrix', {
      reminder: { in_app: true, email: false, sms: false, whatsapp: false },
      escalation: { in_app: true, email: true, sms: false, whatsapp: false },
      sla_breach: { in_app: true, email: true, sms: false, whatsapp: false },
      assignment: { in_app: true, email: false, sms: false, whatsapp: false },
      handout: { in_app: true, email: false, sms: false, whatsapp: false },
      // an approval that sits unseen blocks a SALE, so email is on by default —
      // the same reasoning as escalation. (It stays inert until SMTP exists.)
      approval: { in_app: true, email: true, sms: false, whatsapp: false },
      system: { in_app: true, email: false, sms: false, whatsapp: false },
    }) as unknown as Promise<Record<string, Record<string, boolean>>>;
  }

  private async orgId(client?: PoolClient): Promise<number> {
    const sql = `SELECT id FROM organisation ORDER BY id LIMIT 1`;
    const rows = client ? (await client.query(sql)).rows : await this.db.query<{ id: string }>(sql);
    return Number(rows[0].id);
  }

  /**
   * Fan a message out to every enabled channel.
   *
   * Pass `client` to enlist the in-app write in the CALLER'S transaction — that is
   * what makes "escalation fires exactly once" true: the notification row and the
   * `escalated_at` claim commit together, or neither does.
   *
   * A channel that fails NEVER breaks the caller: an unconfigured channel is
   * expected (logged at debug), a genuinely broken one is logged as a warning.
   */
  async notify(msg: NotifyMessage, client?: PoolClient): Promise<void> {
    if (!msg?.userId) return;
    const enabled = await this.enabledChannels();
    const matrix = await this.matrix();
    const forType = matrix[msg.type] ?? {};
    const orgId = await this.orgId(client);
    for (const ch of CHANNELS) {
      // master switch AND the per-event matrix must both say yes. in_app is always on —
      // the bell is the system of record, and a notification nobody can find is no
      // notification at all.
      if (ch.key !== 'in_app' && (!enabled[ch.key] || !forType[ch.key])) continue;
      try {
        await ch.send(msg, { db: this.db, orgId, client, messaging: this.messaging as never });
      } catch (e) {
        if (isNotConfigured(e) || (e as { notConfigured?: boolean })?.notConfigured) {
          this.log.debug(`channel ${ch.key} skipped: ${(e as Error).message}`);
        } else if (ch.key === 'in_app') {
          throw e;   // the bell is the system of record — a failure here must roll the claim back
        } else {
          this.log.warn(`channel ${ch.key} failed: ${(e as Error).message}`);
        }
      }
    }
  }

  /** Same message to several people (owner + manager), de-duplicated. */
  async notifyMany(userIds: Array<number | null | undefined>, msg: Omit<NotifyMessage, 'userId'>, client?: PoolClient) {
    const seen = new Set<number>();
    for (const id of userIds) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      await this.notify({ ...msg, userId: n }, client);
    }
  }
}
