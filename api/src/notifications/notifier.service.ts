import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { isNotConfigured } from '../common/not-configured.exception';

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

export type NotificationType = 'reminder' | 'escalation' | 'assignment' | 'sla_breach' | 'handout' | 'system';

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

/** A delivery channel. `send` must be idempotent-safe and must never throw. */
export interface NotifyChannel {
  key: 'in_app' | 'email' | 'sms' | 'whatsapp';
  label: string;
  send(msg: NotifyMessage, ctx: { db: DatabaseService; orgId: number; client?: PoolClient }): Promise<void>;
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
 * Sprint-4 placeholders. They are REGISTERED (so the settings screen can list them
 * and the admin can flip them on) but they raise NotConfiguredException until the
 * client's credentials arrive — the SMS-gateway / Google-Sheet precedent exactly.
 */
const notYet = (key: NotifyChannel['key'], label: string, needs: string): NotifyChannel => ({
  key, label,
  async send() {
    const e = new Error(`${label} is not configured — ${needs}`) as Error & { notConfigured?: boolean };
    e.notConfigured = true;
    throw e;
  },
});

export const CHANNELS: NotifyChannel[] = [
  IN_APP,
  notYet('email', 'Email', 'add per-vertical SMTP details in Settings (Sprint 4)'),
  notYet('sms', 'SMS', 'add the SMS gateway API in Settings (Sprint 4)'),
  notYet('whatsapp', 'WhatsApp', 'connect Meta WhatsApp in Settings (Sprint 4)'),
];

@Injectable()
export class NotifierService {
  private readonly log = new Logger('Notifier');

  constructor(private readonly db: DatabaseService, private readonly settings: SettingsService) {}

  async enabledChannels(): Promise<Record<string, boolean>> {
    return this.settings.get('notification_channels', {
      in_app: true, email: false, sms: false, whatsapp: false,
    }) as unknown as Promise<Record<string, boolean>>;
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
    const orgId = await this.orgId(client);
    for (const ch of CHANNELS) {
      if (!enabled[ch.key]) continue;
      try {
        await ch.send(msg, { db: this.db, orgId, client });
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
