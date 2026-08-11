import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { isNotConfigured } from '../common/not-configured.exception';
import { normalizePhone } from '../common/phone.util';
import { ChannelConfigService } from './channel-config.service';
import { MsgChannel, SENDING_CHANNELS } from './providers';
import { OutboundMessage, PermanentSendError, Transport, transportFor } from './transports';
import { StorageService } from '../storage/storage.service';
import { toDateString } from '../common/date.util';

/**
 * The send log is LEAD data, so it scopes on exactly the LEAD's columns — the same
 * `buildScopeWhere` the lead list uses. A counsellor therefore sees the messages sent to
 * their own leads and nobody else's, by construction rather than by a second rule.
 */
export const MESSAGE_SCOPE_COLS: ScopeColumnMap = {
  owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};

export interface QueueMessage {
  channel: MsgChannel;
  to: string;
  subject?: string | null;
  body: string;
  lead_id?: number | null;
  user_id?: number | null;          // staff recipient (notifier fan-out)
  template_id?: number | null;
  journey_id?: number | null;
  journey_run_id?: number | null;
  vertical_id?: number | null;      // WHICH SMTP is used — per-vertical selection
  branch_id?: number | null;
  campaign_id?: number | null;
  wa_template_name?: string | null;
  wa_language?: string | null;
  wa_params?: string[];
  sms_sender_id?: string | null;
  sms_dlt_template_id?: string | null;
  actor_id?: number | null;
  dedupe_key?: string | null;
  run_after?: Date | null;
  /** EMAIL ONLY (Sprint 6). Stored in `message_attachment`, NOT in the row: bytes in a
   *  JSONB column would bloat every send-log read for the benefit of the one caller that
   *  attaches anything. Deleted with the message (ON DELETE CASCADE). */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** guardrails are for AUTOMATION. A human pressing Send is never silently deferred. */
  guarded?: boolean;
}

export interface GuardrailPolicy {
  respect_business_hours: boolean;
  max_sends_per_lead_per_day: number;
  honour_opt_out: boolean;
}
export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  days: Record<string, string[]>;   // mon: ["09:00","19:00"]; [] = closed
}

export const DEFAULT_GUARDRAILS: GuardrailPolicy = {
  respect_business_hours: true, max_sends_per_lead_per_day: 3, honour_opt_out: true,
};
export const DEFAULT_HOURS: BusinessHours = {
  enabled: true, timezone: 'Asia/Kolkata',
  days: { mon: ['09:00', '19:00'], tue: ['09:00', '19:00'], wed: ['09:00', '19:00'], thu: ['09:00', '19:00'], fri: ['09:00', '19:00'], sat: ['09:00', '19:00'], sun: [] },
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * BUSINESS HOURS — a PURE function so it is testable without a clock.
 *
 * Returns the moment the message may go out: `at` if we are already inside the working
 * window, otherwise the next window's opening time. Holidays are whole closed days.
 * Deliberately NOT "drop the message": a birthday wish that arrives at 09:00 tomorrow is
 * right; one that never arrives is a bug.
 */
export function nextSendableTime(
  at: Date, hours: BusinessHours, holidays: string[] = [], tzOffsetMinutes = 330,
): Date {
  if (!hours?.enabled) return at;
  const toLocal = (d: Date) => new Date(d.getTime() + tzOffsetMinutes * 60_000);
  const toUtc = (d: Date) => new Date(d.getTime() - tzOffsetMinutes * 60_000);
  const holidaySet = new Set(holidays.map((h) => toDateString(h)).filter(Boolean) as string[]);

  let local = toLocal(at);
  for (let i = 0; i < 14; i++) {   // a fortnight of closed days would be a configuration error
    const key = DAY_KEYS[local.getUTCDay()];
    const iso = local.toISOString().slice(0, 10);
    const win = hours.days?.[key] ?? [];
    const closed = win.length < 2 || holidaySet.has(iso);
    if (!closed) {
      const [oh, om] = String(win[0]).split(':').map(Number);
      const [ch, cm] = String(win[1]).split(':').map(Number);
      const open = new Date(local); open.setUTCHours(oh, om, 0, 0);
      const close = new Date(local); close.setUTCHours(ch, cm, 0, 0);
      if (local < open) return toUtc(open);
      if (local < close) return at;             // we are inside the window: send now
    }
    // roll to 00:00 of the next local day and retry
    const next = new Date(local);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    local = next;
  }
  return at;   // never lose a message to a mis-configured week
}

/**
 * THE OUTBOUND PIPELINE.
 *
 *  queue()  -> guardrails (opt-out / daily cap / business hours) -> a `message_log` row.
 *              The row IS the queue entry AND the audit record. One table, one truth.
 *  deliver()-> resolve the config for THIS message's vertical, hand it to the transport,
 *              write back status + provider id + the provider's own response.
 *
 * Nothing here retries or ticks — MessageWorker owns that, exactly as ImportWorker owns
 * the ingestion queue. This service is what a controller, a journey or the notifier calls.
 */
@Injectable()
export class MessagingService {
  private readonly log = new Logger('Messaging');

  constructor(
    private readonly db: DatabaseService,
    private readonly configs: ChannelConfigService,
    private readonly settings: SettingsService,
    private readonly resolver?: ScopeResolverService,
    private readonly storage?: StorageService,
  ) {}

  // ------------------------------------------------------------- guardrails

  async guardrails(): Promise<GuardrailPolicy> {
    return this.settings.get('journey_guardrails', DEFAULT_GUARDRAILS as unknown as Record<string, unknown>) as unknown as Promise<GuardrailPolicy>;
  }
  async businessHours(): Promise<BusinessHours> {
    return this.settings.get('business_hours', DEFAULT_HOURS as unknown as Record<string, unknown>) as unknown as Promise<BusinessHours>;
  }
  async holidays(): Promise<string[]> {
    const row = await this.settings.get('holidays', { dates: [] as unknown[] });
    const list = Array.isArray(row.dates) ? row.dates : [];
    return list.map((d) => (typeof d === 'string' ? d : String((d as { date?: string })?.date ?? ''))).filter(Boolean);
  }

  /** Normalise a recipient into the identity the opt-out list is keyed on. */
  static identity(channel: string, to: string): string {
    if (channel === 'email') return String(to).trim().toLowerCase();
    return normalizePhone(String(to)) ?? String(to).trim();
  }

  async isOptedOut(channel: string, to: string): Promise<boolean> {
    const ident = MessagingService.identity(channel, to);
    if (!ident) return false;
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM opt_out WHERE identifier = $1 AND channel IN ($2, 'all') LIMIT 1`, [ident, channel],
    );
    return !!row;
  }

  /** Today's non-skipped sends to this lead — the daily-cap guardrail. */
  private async sendsToday(leadId: number): Promise<number> {
    const r = await this.db.one<{ ct: number }>(
      `SELECT COUNT(*)::int AS ct FROM message_log
        WHERE lead_id = $1 AND status <> 'skipped' AND created_at >= date_trunc('day', now())`,
      [leadId],
    );
    return r?.ct ?? 0;
  }

  // ------------------------------------------------------------------ queue

  /**
   * Enqueue a message. ALWAYS writes a row — even when a guardrail stops it, because
   * "we deliberately did not message this person, and here is why" is the single most
   * useful line in a send log.
   */
  async queue(msg: QueueMessage): Promise<{ id: number; status: string; reason?: string }> {
    if (!SENDING_CHANNELS.includes(msg.channel)) throw new BadRequestException(`"${msg.channel}" is not a sending channel`);
    if (!msg.to) throw new BadRequestException('No recipient — the lead has no phone/email for this channel.');

    const orgId = await this.orgId();
    const g = await this.guardrails();
    let status: 'queued' | 'skipped' = 'queued';
    let reason: string | undefined;
    let runAfter = msg.run_after ?? new Date();

    // 1) CONSENT — always honoured, for automation AND for a human pressing Send.
    //    (An opt-out that a counsellor can click past is not an opt-out.)
    if (g.honour_opt_out !== false && await this.isOptedOut(msg.channel, msg.to)) {
      status = 'skipped';
      reason = `Opted out of ${msg.channel} — not sent`;
    }

    // 2) DAILY CAP + 3) BUSINESS HOURS apply to AUTOMATION only (`guarded`).
    if (status === 'queued' && msg.guarded) {
      if (msg.lead_id && Number(g.max_sends_per_lead_per_day) > 0) {
        const today = await this.sendsToday(Number(msg.lead_id));
        if (today >= Number(g.max_sends_per_lead_per_day)) {
          status = 'skipped';
          reason = `Daily cap reached (${today}/${g.max_sends_per_lead_per_day} messages to this lead today)`;
        }
      }
      if (status === 'queued' && g.respect_business_hours !== false) {
        const hours = await this.businessHours();
        const holidays = await this.holidays();
        const when = nextSendableTime(runAfter, hours, holidays);
        if (when.getTime() !== runAfter.getTime()) {
          runAfter = when;   // deferred, NOT dropped
        }
      }
    }

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO message_log
         (org_id, channel, lead_id, user_id, template_id, journey_id, journey_run_id,
          vertical_id, branch_id, campaign_id, to_addr, subject, body, status, run_after,
          error, dedupe_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        orgId, msg.channel, msg.lead_id ?? null, msg.user_id ?? null, msg.template_id ?? null,
        msg.journey_id ?? null, msg.journey_run_id ?? null,
        msg.vertical_id ?? null, msg.branch_id ?? null, msg.campaign_id ?? null,
        String(msg.to).slice(0, 255), msg.subject ? String(msg.subject).slice(0, 300) : null, msg.body ?? '',
        status, runAfter, reason ?? null, msg.dedupe_key ?? null, msg.actor_id ?? null,
      ],
    );
    const id = Number(row!.id);

    // ATTACHMENTS (Sprint 6). Written even when the row is `skipped`, so a send log
    // entry saying "opted out" still shows WHAT would have gone.
    const r2On = this.storage ? await this.storage.isConfigured() : false;
    for (const a of msg.attachments ?? []) {
      let r2Key: string | null = null;
      if (r2On && this.storage && a.content) {
        try {
          r2Key = `attachments/${id}/${String(a.filename).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160)}`;
          await this.storage.putObject(r2Key, a.content as Buffer, a.contentType ?? 'application/octet-stream');
        } catch { r2Key = null; }
      }
      await this.db.query(
        `INSERT INTO message_attachment (message_id, filename, content_type, bytes, r2_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, String(a.filename).slice(0, 200), a.contentType ?? 'application/octet-stream', r2Key ? null : a.content, r2Key],
      );
    }

    // the WhatsApp/SMS extras live with the row so the worker needs no second lookup
    if (msg.wa_template_name || (msg.wa_params ?? []).length || msg.sms_sender_id || msg.sms_dlt_template_id) {
      await this.db.query(
        `UPDATE message_log SET provider_response = provider_response || $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({
          _send: {
            wa_template_name: msg.wa_template_name ?? null,
            wa_language: msg.wa_language ?? null,
            wa_params: msg.wa_params ?? [],
            sms_sender_id: msg.sms_sender_id ?? null,
            sms_dlt_template_id: msg.sms_dlt_template_id ?? null,
          },
        })],
      );
    }
    return { id, status, reason };
  }

  // ---------------------------------------------------------------- deliver

  /**
   * Send ONE queued row. Called by the worker (and by `sendNow` for a test message).
   * Returns the new status. Throws nothing the caller must handle — every outcome is
   * written to the row, which is the whole point of a durable send log.
   */
  async deliver(id: number, transports: (p: string) => Transport | null = transportFor): Promise<string> {
    const row = await this.db.one<any>(`SELECT * FROM message_log WHERE id = $1`, [id]);
    if (!row) return 'missing';

    const send = (row.provider_response?._send ?? {}) as Record<string, unknown>;
    // A second query, and only when the channel can carry one. The send log is read on
    // every screen; the attachment is read once, at the moment of sending.
    const atts = row.channel === 'email'
      ? await this.db.query<any>(
        `SELECT filename, content_type, bytes, r2_key FROM message_attachment WHERE message_id = $1 ORDER BY id`, [id],
      )
      : [];
    for (const a of atts) {
      if (a.r2_key && this.storage) {
        try { a.bytes = (await this.storage.getObject(String(a.r2_key))).body; } catch { /* leave null; mailer skips */ }
      }
    }
    const msg: OutboundMessage = {
      to: row.to_addr,
      subject: row.subject,
      body: row.body ?? '',
      wa_template_name: (send.wa_template_name as string) ?? null,
      wa_language: (send.wa_language as string) ?? null,
      wa_params: (send.wa_params as string[]) ?? [],
      sms_sender_id: (send.sms_sender_id as string) ?? null,
      sms_dlt_template_id: (send.sms_dlt_template_id as string) ?? null,
      attachments: atts.map((a) => ({
        filename: a.filename, content: Buffer.from(a.bytes), contentType: a.content_type,
      })),
    };

    try {
      // PER-VERTICAL SMTP SELECTION happens right here: the message carries the lead's
      // vertical, and require() resolves the vertical's SMTP row, falling back to the
      // org-wide one. Nothing else in the system needs to know about it.
      const cfg = await this.configs.require(row.channel, row.vertical_id ? Number(row.vertical_id) : null);
      const transport = transports(cfg.provider);
      if (!transport) throw new PermanentSendError(`No transport for provider "${cfg.provider}"`);

      const out = await transport.send(msg, cfg);
      await this.db.query(
        `UPDATE message_log
            SET status = 'sent', provider = $2, provider_message_id = $3,
                provider_response = provider_response || $4::jsonb,
                error = NULL, not_configured = FALSE, sent_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, cfg.provider, out.provider_message_id ?? null, JSON.stringify({ result: out.response })],
      );
      return 'sent';
    } catch (e) {
      const err = e as Error & { permanent?: boolean; response?: Record<string, unknown> };
      const notCfg = isNotConfigured(e);
      // "not configured" is PERMANENT (retrying cannot invent a credential) but it is not
      // an incident: flagged so the UI shows amber and the Error Log stays clean.
      const permanent = notCfg || err.permanent === true;
      const attempts = Number(row.attempts ?? 0);
      const MAX = MessagingService.MAX_ATTEMPTS;

      if (!permanent && attempts < MAX) {
        const backoff = Math.pow(2, attempts) * 15;   // 15s, 30s, 60s
        await this.db.query(
          `UPDATE message_log
              SET status = 'queued', error = $2, run_after = now() + ($3 || ' seconds')::interval,
                  locked_at = NULL, updated_at = now()
            WHERE id = $1`,
          [id, err.message, String(backoff)],
        );
        return 'retry';
      }
      await this.db.query(
        `UPDATE message_log
            SET status = 'failed', error = $2, not_configured = $3,
                provider_response = provider_response || $4::jsonb, updated_at = now()
          WHERE id = $1`,
        [id, err.message, notCfg, JSON.stringify({ error: err.response ?? {} })],
      );
      if (!notCfg) this.log.warn(`message ${id} failed: ${err.message}`);
      return 'failed';
    }
  }

  static readonly MAX_ATTEMPTS = 3;

  /** Queue + deliver immediately — the "Send test message" button and the lead sheet. */
  async sendNow(msg: QueueMessage): Promise<{ id: number; status: string; reason?: string }> {
    const q = await this.queue(msg);
    if (q.status === 'skipped') return q;
    await this.db.query(`UPDATE message_log SET status = 'sending', attempts = attempts + 1, locked_at = now() WHERE id = $1`, [q.id]);
    const status = await this.deliver(q.id);
    const row = await this.db.one<{ error: string | null }>(`SELECT error FROM message_log WHERE id = $1`, [q.id]);
    return { id: q.id, status, reason: row?.error ?? undefined };
  }

  // ------------------------------------------------------------------ reads

  async list(scope: ResolvedScope, userId: number, f: { channel?: string; status?: string; lead_id?: number; limit?: number }) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (this.resolver) {
      const leadWhere = this.resolver.buildScopeWhere(scope, MESSAGE_SCOPE_COLS, params);
      // A message to a STAFF member (the notifier fan-out) has no lead, so it cannot be
      // lead-scoped: it is visible to its recipient, and — because `buildScopeWhere`
      // returns `1=1` for an org-wide grant — to an admin.
      params.push(userId);
      const mine = `$${params.length}`;
      where.push(`((m.lead_id IS NULL AND (m.user_id = ${mine} OR ${scope.all ? 'TRUE' : 'FALSE'}))`
        + ` OR (m.lead_id IS NOT NULL AND (${leadWhere})))`);
    }
    if (f.channel) { params.push(f.channel); where.push(`m.channel = $${params.length}`); }
    if (f.status) { params.push(f.status); where.push(`m.status = $${params.length}`); }
    if (f.lead_id) { params.push(Number(f.lead_id)); where.push(`m.lead_id = $${params.length}`); }
    params.push(Math.min(Number(f.limit) || 100, 500));

    return this.db.query<any>(
      `SELECT m.id, m.channel, m.provider, m.status, m.to_addr, m.subject, m.body,
              m.error, m.not_configured, m.attempts, m.provider_message_id,
              m.created_at, m.sent_at, m.delivered_at, m.run_after,
              m.lead_id, l.full_name AS lead_name,
              m.template_id, t.name AS template_name,
              m.journey_id, j.name AS journey_name, m.journey_run_id,
              m.user_id, u.name AS user_name,
              m.vertical_id, v.name AS vertical_name
         FROM message_log m
         LEFT JOIN lead l ON l.id = m.lead_id
         LEFT JOIN message_template t ON t.id = m.template_id
         LEFT JOIN journey j ON j.id = m.journey_id
         LEFT JOIN "user" u ON u.id = m.user_id
         LEFT JOIN vertical v ON v.id = m.vertical_id
        WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    let leadWhere = 'TRUE';
    if (this.resolver) leadWhere = this.resolver.buildScopeWhere(scope, MESSAGE_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT m.channel, m.status, COUNT(*)::int AS ct
         FROM message_log m
         LEFT JOIN lead l ON l.id = m.lead_id
        WHERE m.created_at > now() - INTERVAL '30 days'
          AND (m.lead_id IS NULL OR (${leadWhere}))
        GROUP BY m.channel, m.status`,
      params,
    );
    const status = await this.configs.status();
    return { counts: rows, channels: status };
  }

  // --------------------------------------------------------------- opt-outs

  async optOuts(limit = 200) {
    return this.db.query<any>(
      `SELECT o.id, o.channel, o.identifier, o.reason, o.source, o.created_at,
              o.lead_id, l.full_name AS lead_name
         FROM opt_out o
         LEFT JOIN lead l ON l.id = o.lead_id
        ORDER BY o.created_at DESC LIMIT $1`,
      [Math.min(Number(limit) || 200, 500)],
    );
  }

  /** Idempotent: a second STOP from the same number is a no-op, not a 409. */
  async optOut(dto: { channel: string; identifier: string; lead_id?: number | null; reason?: string; source?: string }, actorId?: number | null) {
    const channel = String(dto?.channel || 'all');
    const ident = MessagingService.identity(channel, String(dto?.identifier ?? ''));
    if (!ident) throw new BadRequestException('An opt-out needs a phone number or an email address.');
    const orgId = await this.orgId();
    const row = await this.db.one<any>(
      `INSERT INTO opt_out (org_id, channel, identifier, lead_id, reason, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id, channel, identifier) DO UPDATE SET reason = COALESCE(EXCLUDED.reason, opt_out.reason)
       RETURNING *`,
      [orgId, channel, ident, dto.lead_id ?? null, dto.reason ?? null, dto.source ?? 'manual', actorId ?? null],
    );
    // mirror onto the lead so the counsellor SEES it on the lead sheet, not only in a list
    if (dto.lead_id) {
      await this.db.query(
        `UPDATE lead SET consent = consent || $2::jsonb, updated_at = now() WHERE id = $1`,
        [Number(dto.lead_id), JSON.stringify({ [`opt_out_${channel}`]: true, opt_out_at: new Date().toISOString() })],
      );
    }
    return row;
  }

  async optIn(id: number) {
    const row = await this.db.one<any>(`DELETE FROM opt_out WHERE id = $1 RETURNING id, lead_id, channel`, [id]);
    if (row?.lead_id) {
      await this.db.query(
        `UPDATE lead SET consent = consent - $2 WHERE id = $1`, [Number(row.lead_id), `opt_out_${row.channel}`],
      );
    }
    return { id, deleted: true };
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }
}
