import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MessagingService } from '../messaging/messaging.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { maskSecret } from '../common/crypto.util';
import { composeNimbusUrl, isUnicodeSms } from '../messaging/transports';
import {
  resolveDltBody, normaliseMapping, pickTemplate, markerKinds, SMS_VARIABLES, SAMPLE_VARS, EXTRA_TRIGGERS, triggerAliases,
} from './sms-template.engine';

/**
 * THE SMS TEMPLATE MASTER + THE NIMBUS AUTO-SEND.
 *
 * Two jobs:
 *   1. CRUD for the admin-managed, Branch+Vertical-scoped DLT SMS templates.
 *   2. autoSendCreation(leadId): on a NEW lead (from ANY channel — hooked in the ONE
 *      shared ingestion path), find the active template whose Branch+Vertical match the
 *      lead's, resolve its {#var#} markers in order (default [name, course]) and send it
 *      through the existing MessagingService (channel 'sms') — idempotently, opt-out
 *      honoured, degrading cleanly to 'not_configured' when Nimbus has no credentials.
 */
@Injectable()
export class SmsTemplateService {
  private readonly log = new Logger('SmsTemplate');

  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly configs: ChannelConfigService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  // ------------------------------------------------------------------- reads

  async list(f: { branch_id?: number; vertical_id?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = ['t.deleted_at IS NULL'];
    if (f.branch_id) { params.push(Number(f.branch_id)); where.push(`t.branch_id = $${params.length}`); }
    if (f.vertical_id) { params.push(Number(f.vertical_id)); where.push(`t.vertical_id = $${params.length}`); }
    return this.db.query<any>(
      `SELECT t.*, b.name AS branch_name, v.name AS vertical_name,
              COALESCE(e.name, CASE t.trigger_event WHEN 'manual' THEN 'Manual / campaign' WHEN 'login_otp' THEN 'Login OTP' ELSE t.trigger_event END) AS trigger_name
         FROM sms_template t
         LEFT JOIN branch b   ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN notification_event e ON e.event_key = CASE t.trigger_event WHEN 'lead_created' THEN 'new_lead_created' ELSE t.trigger_event END
        WHERE ${where.join(' AND ')}
        ORDER BY t.branch_id NULLS FIRST, t.vertical_id NULLS FIRST, t.name`,
      params,
    );
  }

  async get(id: number) {
    const row = await this.db.one<any>(
      `SELECT t.*, b.name AS branch_name, v.name AS vertical_name
         FROM sms_template t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [id],
    );
    if (!row) throw new NotFoundException('SMS template not found');
    return row;
  }

  /**
   * What the SMS Templates form offers (23 Nov 2026 — "make it dynamic"): every notification
   * event (whether the CRM fires it today), plus manual and Login OTP; and every field a
   * marker can be filled from.
   */
  async meta() {
    const events = await this.db.query<{ event_key: string; name: string; category: string; trigger_status: string }>(
      `SELECT event_key, name, category, trigger_status FROM notification_event ORDER BY sort_order, event_key`);
    return {
      triggers: [
        ...events.map((e) => ({ key: e.event_key, name: e.name, category: e.category, wired: e.trigger_status === 'wired' })),
        ...EXTRA_TRIGGERS.map((t) => ({ ...t, category: 'Other', wired: t.key === 'login_otp' })),
      ],
      variables: SMS_VARIABLES,
    };
  }

  private async assertTrigger(trigger: string) {
    if (trigger === 'lead_created' || EXTRA_TRIGGERS.some((t) => t.key === trigger)) return;
    const ok = await this.db.one(`SELECT 1 AS ok FROM notification_event WHERE event_key = $1`, [trigger]);
    if (!ok) throw new BadRequestException(`Unknown event "${trigger}" for an SMS template.`);
  }

  // ------------------------------------------------------------------ writes

  private clean(dto: any) {
    const header = String(dto?.header ?? '').trim();
    const name = String(dto?.name ?? '').trim();
    const body = String(dto?.body ?? '').trim();
    if (!header) throw new BadRequestException('A DLT Header (sender) is required.');
    if (!name) throw new BadRequestException('A template name is required.');
    if (!body) throw new BadRequestException('A template body is required.');
    return {
      header: header.slice(0, 24),
      name: name.slice(0, 160),
      body,
      branch_id: dto?.branch_id ? Number(dto.branch_id) : null,
      vertical_id: dto?.vertical_id ? Number(dto.vertical_id) : null,
      dlt_template_id: dto?.dlt_template_id ? String(dto.dlt_template_id).trim().slice(0, 40) : null,
      entity_id: dto?.entity_id ? String(dto.entity_id).trim().slice(0, 40) : null,
      var_mapping: JSON.stringify(normaliseMapping(dto?.var_mapping)),
      unicode: dto?.unicode === true ? true : dto?.unicode === false ? false : null,
      trigger_event: String(dto?.trigger_event || 'new_lead_created').trim().slice(0, 40),
      is_active: dto?.is_active === false ? false : true,
    };
  }

  async create(dto: any, actorId: number) {
    const c = this.clean(dto);
    await this.assertTrigger(c.trigger_event);
    const orgId = await this.orgId();
    const row = await this.db.one<any>(
      `INSERT INTO sms_template
         (org_id, header, name, body, branch_id, vertical_id, dlt_template_id, entity_id,
          var_mapping, unicode, trigger_event, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)
       RETURNING *`,
      [orgId, c.header, c.name, c.body, c.branch_id, c.vertical_id, c.dlt_template_id, c.entity_id,
        c.var_mapping, c.unicode, c.trigger_event, c.is_active, actorId],
    );
    return this.get(Number(row!.id));
  }

  async update(id: number, dto: any, actorId: number) {
    await this.get(id);
    const c = this.clean(dto);
    await this.assertTrigger(c.trigger_event);
    await this.db.query(
      `UPDATE sms_template
          SET header=$2, name=$3, body=$4, branch_id=$5, vertical_id=$6, dlt_template_id=$7,
              entity_id=$8, var_mapping=$9::jsonb, unicode=$10, trigger_event=$11,
              is_active=$12, updated_at=now(), updated_by=$13
        WHERE id=$1 AND deleted_at IS NULL`,
      [id, c.header, c.name, c.body, c.branch_id, c.vertical_id, c.dlt_template_id, c.entity_id,
        c.var_mapping, c.unicode, c.trigger_event, c.is_active, actorId],
    );
    return this.get(id);
  }

  async remove(id: number, actorId: number) {
    await this.get(id);
    await this.db.query(
      `UPDATE sms_template SET deleted_at=now(), deleted_by=$2, is_active=FALSE WHERE id=$1`,
      [id, actorId],
    );
    return { id, deleted: true };
  }

  // -------------------------------------------------------- lead data + match

  /**
   * The values a marker mapping can reference (SMS_VARIABLES): the lead (or the student, for
   * student events), their counsellor, their vertical's call-back number and name, plus any
   * values the event itself supplies (date, time, discount …), which win.
   */
  async varsForLead(leadId: number, extra?: Record<string, unknown> | null, studentId?: number | null): Promise<{ lead: any; vars: Record<string, unknown> } | null> {
    const l = await this.db.one<any>(
      `SELECT l.id, l.full_name, l.phone, l.whatsapp_phone, l.branch_id, l.vertical_id,
              COALESCE(c.name, l.course_text) AS course, u.name AS counsellor, u.phone AS counsellor_phone,
              v.phone AS vertical_phone, COALESCE(NULLIF(v.display_name, ''), v.name) AS institute,
              b.name AS branch_name, b.contact_number AS branch_phone
         FROM lead l
         LEFT JOIN m_course c ON c.id = l.course_id
         LEFT JOIN "user" u ON u.id = l.owner_id
         LEFT JOIN vertical v ON v.id = l.vertical_id
         LEFT JOIN branch b ON b.id = l.branch_id
        WHERE l.id = $1 AND l.deleted_at IS NULL`, [leadId],
    );
    if (!l) return null;
    let name = l.full_name; let course = l.course; let phone = l.phone;
    if (studentId) {
      const st = await this.db.one<any>(
        `SELECT s.full_name, s.phone, c.name AS course FROM student s LEFT JOIN m_course c ON c.id = s.course_id
          WHERE s.id = $1 AND s.deleted_at IS NULL`, [studentId]);
      if (st) { name = st.full_name || name; course = st.course || course; phone = st.phone || phone; }
    }
    const vars: Record<string, unknown> = {
      name, first_name: String(name ?? '').trim().split(/\s+/)[0] || null, course,
      counsellor: l.counsellor, counsellor_phone: l.counsellor_phone,
      callback: l.vertical_phone || l.branch_phone || l.counsellor_phone || null,
      institute: l.institute, branch: l.branch_name, phone, whatsapp: l.whatsapp_phone ?? phone,
    };
    for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined && v !== null && String(v).trim() !== '') vars[k] = v;
    return { lead: { ...l, phone, to: phone || l.whatsapp_phone }, vars };
  }

  /**
   * The active template whose Branch+Vertical best match the lead. Most-specific wins:
   * exact (branch,vertical) > (vertical only) > (branch only) > org-wide. Null when none.
   */
  async matchTemplate(orgId: number, branchId: number | null, verticalId: number | null, trigger = 'lead_created') {
    // Fetch the active candidates and pick the best in JS (pure pickTemplate), so the
    // Branch+Vertical match rule is exhaustively unit-tested without a database.
    const candidates = await this.db.query<any>(
      `SELECT * FROM sms_template
        WHERE org_id = $1 AND deleted_at IS NULL AND is_active AND trigger_event = ANY($2::text[])
          AND (branch_id = $3 OR branch_id IS NULL)
          AND (vertical_id = $4 OR vertical_id IS NULL)`,
      [orgId, triggerAliases(trigger), branchId, verticalId],
    );
    return pickTemplate(candidates, branchId, verticalId);
  }

  // ------------------------------------------------------------- the auto-send

  /**
   * Best-effort wrapper for the ingestion hook: a template hiccup must NEVER lose a lead
   * that is already durably stored, and must never throw into the ingest transaction path.
   */
  async safeAutoSend(trigger: string, leadId: number): Promise<void> {
    try {
      if (trigger === 'lead_created') await this.autoSendCreation(leadId);
    } catch (e) {
      this.log.warn(`sms auto-send skipped for lead ${leadId}: ${(e as Error).message}`);
    }
  }

  /**
   * Send the creation SMS for a new lead. Idempotent (a lead gets it once), opt-out
   * honoured, degrades cleanly to a logged 'not_configured' row when Nimbus has no creds.
   */
  async autoSendCreation(leadId: number): Promise<{ status: string; reason?: string; template_id?: number }> {
    const data = await this.varsForLead(leadId);
    if (!data) return { status: 'skipped', reason: 'lead_not_found' };
    const { lead, vars } = data;
    const to = lead.phone || lead.whatsapp_phone;
    if (!to) return { status: 'skipped', reason: 'no_phone' };

    const orgId = await this.orgId();
    const tpl = await this.matchTemplate(orgId, lead.branch_id ? Number(lead.branch_id) : null,
      lead.vertical_id ? Number(lead.vertical_id) : null, 'lead_created');
    if (!tpl) return { status: 'skipped', reason: 'no_matching_template' };

    // idempotency: a lead may only ever get one creation SMS
    const dedupe = `sms_creation:${leadId}`;
    const seen = await this.db.one<{ id: string }>(
      `SELECT id FROM message_log WHERE dedupe_key = $1 LIMIT 1`, [dedupe]);
    if (seen) return { status: 'skipped', reason: 'already_sent', template_id: Number(tpl.id) };

    const rendered = resolveDltBody(tpl.body, normaliseMapping(tpl.var_mapping), vars);
    const res = await this.messaging.sendNow({
      channel: 'sms',
      to,
      body: rendered.text,
      lead_id: leadId,
      branch_id: lead.branch_id ? Number(lead.branch_id) : null,
      vertical_id: lead.vertical_id ? Number(lead.vertical_id) : null,
      sms_sender_id: tpl.header,
      sms_dlt_template_id: tpl.dlt_template_id ?? null,
      dedupe_key: dedupe,
      guarded: true,
    });
    // stamp which sms_template drove the send (message_log.template_id FKs the OTHER table)
    await this.db.query(
      `UPDATE message_log SET provider_response = provider_response || $2::jsonb WHERE id = $1`,
      [res.id, JSON.stringify({ sms_template_id: Number(tpl.id), sms_template_name: tpl.name })],
    ).catch(() => undefined);
    return { status: res.status, reason: res.reason, template_id: Number(tpl.id) };
  }

  /**
   * Send the DLT template for an event (23 Nov 2026 — every notification event, not only the new
   * lead). Returns null when no active template matches the event and the lead's Branch +
   * Vertical, so the caller can fall back to its older template. Idempotent on `dedupe_key`.
   */
  async sendForEvent(eventKey: string, leadId: number, ctx: { student_id?: number | null; vars?: Record<string, unknown> | null; dedupe_key: string; actor_id?: number | null }) {
    const data = await this.varsForLead(leadId, ctx.vars, ctx.student_id ?? null);
    if (!data) return null;
    const { lead, vars } = data;
    const orgId = await this.orgId();
    const tpl = await this.matchTemplate(orgId, lead.branch_id ? Number(lead.branch_id) : null,
      lead.vertical_id ? Number(lead.vertical_id) : null, eventKey);
    if (!tpl) return null;
    if (!lead.to) return { status: 'skipped', reason: 'no_phone', template_id: Number(tpl.id) };
    const seen = await this.db.one<{ id: string }>(`SELECT id FROM message_log WHERE dedupe_key = $1 LIMIT 1`, [ctx.dedupe_key]);
    if (seen) return { status: 'duplicate', message_id: Number(seen.id), template_id: Number(tpl.id) };
    const rendered = resolveDltBody(tpl.body, normaliseMapping(tpl.var_mapping), vars);
    const res = await this.messaging.queue({
      channel: 'sms', to: lead.to, body: rendered.text, lead_id: leadId,
      branch_id: lead.branch_id ? Number(lead.branch_id) : null,
      vertical_id: lead.vertical_id ? Number(lead.vertical_id) : null,
      sms_sender_id: tpl.header, sms_dlt_template_id: tpl.dlt_template_id ?? null,
      dedupe_key: ctx.dedupe_key, actor_id: ctx.actor_id ?? null, guarded: true,
    });
    await this.db.query(
      `UPDATE message_log SET provider_response = provider_response || $2::jsonb WHERE id = $1`,
      [res.id, JSON.stringify({ sms_template_id: Number(tpl.id), sms_template_name: tpl.name, event: eventKey, missing: rendered.missing })],
    ).catch(() => undefined);
    return { status: res.status, reason: res.reason, message_id: res.id, template_id: Number(tpl.id), missing: rendered.missing };
  }

  // --------------------------------------------------------- manual test send

  /** Send a chosen template to a typed number so the client can test once creds are in. */
  async sendTest(id: number, mobile: string, actorId: number) {
    const tpl = await this.get(id);
    const to = String(mobile ?? '').trim();
    if (!to) throw new BadRequestException('A mobile number is required for the test send.');
    // resolve every marker against a sample so the DLT body is complete
    const sample = { ...SAMPLE_VARS, phone: to, whatsapp: to };
    const rendered = resolveDltBody(tpl.body, normaliseMapping(tpl.var_mapping), sample);
    const res = await this.messaging.sendNow({
      channel: 'sms',
      to,
      body: rendered.text,
      sms_sender_id: tpl.header,
      sms_dlt_template_id: tpl.dlt_template_id ?? null,
      actor_id: actorId,
      guarded: false,
    });
    await this.db.query(
      `UPDATE message_log SET provider_response = provider_response || $2::jsonb WHERE id = $1`,
      [res.id, JSON.stringify({ sms_template_id: Number(tpl.id), sms_template_name: tpl.name, test: true })],
    ).catch(() => undefined);
    return { ...res, resolved_text: rendered.text, missing: rendered.missing };
  }

  // ---------------------------------------------- compose the Nimbus URL (preview)

  /**
   * Show the client the EXACT pushsms URL a template would produce, with the authkey
   * MASKED. Never hits the gateway. Reports cleanly when Nimbus is not yet configured.
   */
  async previewUrl(dto: { id?: number; body?: string; header?: string; dlt_template_id?: string; var_mapping?: unknown; mobile?: string }) {
    let body = String(dto?.body ?? '');
    let header = String(dto?.header ?? '');
    let dlt = String(dto?.dlt_template_id ?? '');
    let mapping = normaliseMapping(dto?.var_mapping);
    if (dto?.id) {
      const tpl = await this.get(Number(dto.id));
      body = tpl.body; header = tpl.header; dlt = tpl.dlt_template_id ?? ''; mapping = normaliseMapping(tpl.var_mapping);
    }
    const rendered = resolveDltBody(body, mapping, SAMPLE_VARS);
    const cfg = await this.configs.resolve('sms', null, 'nimbus');
    const configured = !!cfg && cfg.provider === 'nimbus';
    const unicode = isUnicodeSms(rendered.text);
    const mobile = String(dto?.mobile || '+917827878780').replace(/^\+/, '');
    const maskedUrl = composeNimbusUrl({
      user: configured ? String(cfg!.config.user ?? '') : '<USER>',
      authkey: configured && cfg!.secrets.authkey ? maskSecret(cfg!.secrets.authkey) : '<AUTHKEY>',
      sender: header || (configured ? String(cfg!.config.sender_id ?? '') : '<HEADER>'),
      mobile,
      text: rendered.text,
      entityid: configured ? String(cfg!.config.entityid ?? '') : '<ENTITY_ID>',
      templateid: dlt || '<DLT_TEMPLATE_ID>',
      unicode,
      baseUrl: configured && cfg!.config.base_url ? String(cfg!.config.base_url) : undefined,
    });
    return {
      configured,
      markers: markerKinds(body),
      unicode,
      resolved_text: rendered.text,
      missing: rendered.missing,
      url: maskedUrl,
      note: configured
        ? 'Authkey is masked. This is the exact URL shape that will be sent.'
        : 'Nimbus is not configured yet — placeholders shown for user / authkey / entity id. Add them in Settings › Channels › SMS.',
    };
  }
}
