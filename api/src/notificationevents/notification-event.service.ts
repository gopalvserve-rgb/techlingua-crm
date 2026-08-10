import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TemplateService } from '../templates/template.service';
import { MessagingService } from '../messaging/messaging.service';

/**
 * NOTIFICATION EVENTS — a curated, event-driven layer over the Sprint-4 notifier/messaging
 * stack. The client thinks in business EVENTS ("a payment succeeded"), not journeys. This
 * service is the catalog + the per-event/per-channel config + the FIRING path.
 *
 * Firing reuses the EXISTING send path end to end: TemplateService.build() renders the
 * mapped template against the lead's own hierarchy, and MessagingService.queue() applies
 * opt-out / business-hours / daily-cap guardrails, writes the durable message_log row and
 * degrades to a logged `not_configured` attempt when a channel has no credentials yet.
 * Every student carries a lead_id, so student events render through the same lead-centric
 * variable bag — one code path, one send log, one screen.
 */
export const NE_CHANNELS = ['sms', 'email', 'whatsapp'] as const;
export type NeChannel = (typeof NE_CHANNELS)[number];

export interface FireContext {
  lead_id?: number | null;
  student_id?: number | null;
  vertical_id?: number | null;
  /** distinguishes repeatable event-instances (e.g. an installment's due date) for idempotency */
  dedupe?: string | null;
  actor_id?: number | null;
  /** extra merge fields the mapped template may reference ({{amount}}, {{invoice_no}}, {{receipt_no}}, {{due_date}}, {{batch_name}}, {{certificate_no}}, ...). Shallow-merged over the lead's own variable bag at render time. */
  vars?: Record<string, unknown> | null;
}

interface EventRow {
  event_key: string; name: string; trigger_desc: string; category: string;
  recipient: string; trigger_status: string;
  default_sms: boolean; default_email: boolean; default_whatsapp: boolean; sort_order: number;
}

@Injectable()
export class NotificationEventService {
  private readonly log = new Logger('NotificationEvents');

  constructor(
    private readonly db: DatabaseService,
    private readonly templates: TemplateService,
    private readonly messaging: MessagingService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  /** The raw catalog — all 37 events, ordered. */
  async catalog(): Promise<EventRow[]> {
    return this.db.query<EventRow>(
      `SELECT event_key, name, trigger_desc, category, recipient, trigger_status,
              default_sms, default_email, default_whatsapp, sort_order
         FROM notification_event ORDER BY sort_order, name`,
    );
  }

  /**
   * The screen's data: every event with its ORG-WIDE config (toggles + mapped template per
   * channel, with the template's name for display). Filterable by category / channel / enabled.
   */
  async list(f: { category?: string; channel?: string; enabled?: string } = {}) {
    const rows = await this.db.query<any>(
      `SELECT e.event_key, e.name, e.trigger_desc, e.category, e.recipient, e.trigger_status, e.sort_order,
              e.default_sms, e.default_email, e.default_whatsapp,
              COALESCE(c.sms_enabled, e.default_sms)           AS sms_enabled,
              COALESCE(c.email_enabled, e.default_email)       AS email_enabled,
              COALESCE(c.whatsapp_enabled, e.default_whatsapp) AS whatsapp_enabled,
              c.sms_template_id, c.email_template_id, c.whatsapp_template_id,
              ts.name AS sms_template_name, te.name AS email_template_name, tw.name AS whatsapp_template_name
         FROM notification_event e
         LEFT JOIN notification_event_config c
           ON c.event_key = e.event_key AND c.org_id = $1 AND c.vertical_id IS NULL
         LEFT JOIN message_template ts ON ts.id = c.sms_template_id
         LEFT JOIN message_template te ON te.id = c.email_template_id
         LEFT JOIN message_template tw ON tw.id = c.whatsapp_template_id
        ORDER BY e.sort_order, e.name`,
      [await this.orgId()],
    );
    let out = rows;
    if (f.category) out = out.filter((r) => r.category === f.category);
    if (f.channel && NE_CHANNELS.includes(f.channel as NeChannel)) {
      out = out.filter((r) => r[`${f.channel}_enabled`]);
    }
    if (f.enabled === 'true') out = out.filter((r) => r.sms_enabled || r.email_enabled || r.whatsapp_enabled);
    if (f.enabled === 'false') out = out.filter((r) => !(r.sms_enabled || r.email_enabled || r.whatsapp_enabled));
    return out;
  }

  async get(eventKey: string) {
    const rows = await this.list();
    const row = rows.find((r) => r.event_key === eventKey);
    if (!row) throw new NotFoundException('event not found');
    return row;
  }

  /** The effective config for an event in a vertical: the vertical override, else org-wide, else catalog defaults. */
  async resolve(eventKey: string, verticalId?: number | null) {
    const orgId = await this.orgId();
    const rows = await this.db.query<any>(
      `SELECT c.*, e.default_sms, e.default_email, e.default_whatsapp, e.recipient, e.name
         FROM notification_event e
         LEFT JOIN notification_event_config c
           ON c.event_key = e.event_key AND c.org_id = $1
          AND (c.vertical_id = $2 OR c.vertical_id IS NULL)
        WHERE e.event_key = $3
        ORDER BY c.vertical_id NULLS LAST`,
      [orgId, verticalId ?? null, eventKey],
    );
    if (!rows.length) return null;
    // vertical-specific row sorts first (NULLS LAST); fall back to the catalog defaults if no config row.
    const r = rows[0];
    return {
      event_key: eventKey,
      recipient: r.recipient,
      sms_enabled: r.sms_enabled ?? r.default_sms,
      email_enabled: r.email_enabled ?? r.default_email,
      whatsapp_enabled: r.whatsapp_enabled ?? r.default_whatsapp,
      sms_template_id: r.sms_template_id ?? null,
      email_template_id: r.email_template_id ?? null,
      whatsapp_template_id: r.whatsapp_template_id ?? null,
    };
  }

  /**
   * Save an admin's choice for an event — toggles and/or template mapping. Org-wide by
   * default; pass vertical_id to override for one vertical. A template mapped to a channel
   * must actually BE that channel (a WhatsApp template on the SMS slot is a 400, not a
   * silent mis-send).
   */
  async updateConfig(eventKey: string, dto: any, actorId: number) {
    const ev = await this.db.one<EventRow>(`SELECT * FROM notification_event WHERE event_key = $1`, [eventKey]);
    if (!ev) throw new NotFoundException('event not found');
    const orgId = await this.orgId();
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;

    const tplCheck = async (id: unknown, channel: NeChannel): Promise<number | null> => {
      if (id === undefined) return undefined as unknown as number | null; // "leave as-is"
      if (id === null || id === '') return null;
      const t = await this.db.one<{ channel: string }>(
        `SELECT channel FROM message_template WHERE id = $1 AND deleted_at IS NULL`, [Number(id)],
      );
      if (!t) throw new BadRequestException('template not found');
      if (t.channel !== channel) throw new BadRequestException(`That template is a ${t.channel} template, not ${channel}.`);
      return Number(id);
    };

    const smsTpl = await tplCheck(dto?.sms_template_id, 'sms');
    const emailTpl = await tplCheck(dto?.email_template_id, 'email');
    const waTpl = await tplCheck(dto?.whatsapp_template_id, 'whatsapp');

    // Upsert the config row, then COALESCE-patch only the fields the caller sent.
    await this.db.query(
      `INSERT INTO notification_event_config
         (org_id, event_key, vertical_id, sms_enabled, email_enabled, whatsapp_enabled,
          sms_template_id, email_template_id, whatsapp_template_id, updated_by)
       VALUES ($1,$2,$3::bigint,
               COALESCE($4::boolean, $10::boolean), COALESCE($5::boolean, $11::boolean), COALESCE($6::boolean, $12::boolean),
               $7::bigint,$8::bigint,$9::bigint,$13::bigint)
       ON CONFLICT (org_id, event_key, COALESCE(vertical_id, -1)) DO UPDATE SET
         sms_enabled      = COALESCE($4::boolean, notification_event_config.sms_enabled),
         email_enabled    = COALESCE($5::boolean, notification_event_config.email_enabled),
         whatsapp_enabled = COALESCE($6::boolean, notification_event_config.whatsapp_enabled),
         sms_template_id      = CASE WHEN $14::boolean THEN $7::bigint ELSE notification_event_config.sms_template_id END,
         email_template_id    = CASE WHEN $15::boolean THEN $8::bigint ELSE notification_event_config.email_template_id END,
         whatsapp_template_id = CASE WHEN $16::boolean THEN $9::bigint ELSE notification_event_config.whatsapp_template_id END,
         updated_at = now(), updated_by = $13::bigint`,
      [
        orgId, eventKey, verticalId,
        boolOrNull(dto?.sms_enabled), boolOrNull(dto?.email_enabled), boolOrNull(dto?.whatsapp_enabled),
        smsTpl ?? null, emailTpl ?? null, waTpl ?? null,
        ev.default_sms, ev.default_email, ev.default_whatsapp, actorId,
        smsTpl !== undefined, emailTpl !== undefined, waTpl !== undefined,
      ],
    );
    return this.get(eventKey);
  }

  // ------------------------------------------------------------------ firing

  /**
   * FIRE an event. For each channel that is ENABLED and has a mapped template, render the
   * template against the lead and queue it via MessagingService (guarded = automation, so
   * opt-out / business-hours / daily-cap all apply). Idempotent per event-instance via a
   * deterministic dedupe_key. Never throws to the caller: an event that fails to notify must
   * never roll back the business action that raised it.
   */
  async fire(eventKey: string, ctx: FireContext): Promise<{ event: string; sent: number; skipped: number; results: any[] }> {
    const results: any[] = [];
    let leadId = ctx.lead_id ? Number(ctx.lead_id) : null;
    let verticalId = ctx.vertical_id ? Number(ctx.vertical_id) : null;

    if (!leadId && ctx.student_id) {
      const s = await this.db.one<{ lead_id: string; vertical_id: string }>(
        `SELECT lead_id, vertical_id FROM student WHERE id = $1 AND deleted_at IS NULL`, [Number(ctx.student_id)],
      );
      if (s) { leadId = Number(s.lead_id); verticalId = verticalId ?? Number(s.vertical_id); }
    }
    if (!leadId) return { event: eventKey, sent: 0, skipped: 0, results };

    const cfg = await this.resolve(eventKey, verticalId);
    if (!cfg) return { event: eventKey, sent: 0, skipped: 0, results };

    let sent = 0; let skipped = 0;
    const suffix = ctx.dedupe ? String(ctx.dedupe) : String(leadId);
    for (const channel of NE_CHANNELS) {
      const enabled = (cfg as any)[`${channel}_enabled`];
      const templateId = (cfg as any)[`${channel}_template_id`];
      if (!enabled) continue;
      if (!templateId) { results.push({ channel, status: 'no_template' }); continue; }

      const dedupeKey = `evt:${eventKey}:${channel}:${suffix}`;
      try {
        // idempotency — the same event-instance never fans out twice on the same channel.
        const dup = await this.db.one<{ id: string }>(
          `SELECT id FROM message_log WHERE dedupe_key = $1 LIMIT 1`, [dedupeKey],
        );
        if (dup) { results.push({ channel, status: 'duplicate', message_id: Number(dup.id) }); skipped++; continue; }

        const msg = await this.templates.build({ lead_id: leadId, template_id: Number(templateId), extra_vars: ctx.vars ?? undefined });
        const out = await this.messaging.queue({ ...msg, dedupe_key: dedupeKey, actor_id: ctx.actor_id ?? null, guarded: true });
        results.push({ channel, status: out.status, message_id: out.id, reason: out.reason });
        if (out.status === 'skipped') skipped++; else sent++;
      } catch (e) {
        // no email on the lead, template gone, etc. — counted, never fatal.
        results.push({ channel, status: 'error', error: (e as Error).message });
        skipped++;
      }
    }
    return { event: eventKey, sent, skipped, results };
  }

  /** Best-effort fire for use at trigger points — swallows everything. */
  async safeFire(eventKey: string, ctx: FireContext): Promise<void> {
    try { await this.fire(eventKey, ctx); }
    catch (e) { this.log.warn(`notification event ${eventKey} failed: ${(e as Error).message}`); }
  }
}

function boolOrNull(v: unknown): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return null;
}
