import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { ResolvedScope } from '../rbac/rbac.types';
import { MessagingService, QueueMessage } from '../messaging/messaging.service';
import { MsgChannel } from '../messaging/providers';
import {
  RenderedTemplate, SAMPLE_VARS, TemplateVars, VARIABLE_CATALOG, renderTemplate, variablesOf,
} from './template.engine';
import { toDateString } from '../common/date.util';

const CHANNELS: MsgChannel[] = ['whatsapp', 'sms', 'email'];

/**
 * Template CRUD + the two things templates exist for:
 *   · `varsForLead()` — turn a lead + its hierarchy into the variable bag
 *   · `build()`       — render a template for a lead into a ready-to-queue message
 *
 * The rendering itself is the PURE engine (template.engine.ts), so the live preview in the
 * UI and the real send call the identical code path. A preview that lies is worse than no
 * preview.
 */
@Injectable()
export class TemplateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly messaging: MessagingService,
    private readonly resolver: ScopeResolverService,
  ) {}

  catalog() {
    return { variables: VARIABLE_CATALOG, channels: CHANNELS, sample: SAMPLE_VARS };
  }

  // ------------------------------------------------------------------- CRUD

  async list(f: { channel?: string; vertical_id?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = ['t.deleted_at IS NULL'];
    if (f.channel) { params.push(f.channel); where.push(`t.channel = $${params.length}`); }
    if (f.vertical_id) {
      params.push(Number(f.vertical_id));
      // a vertical sees ITS templates plus the org-wide ones (vertical_id IS NULL)
      where.push(`(t.vertical_id = $${params.length} OR t.vertical_id IS NULL)`);
    }
    return this.db.query<any>(
      `SELECT t.*, v.name AS vertical_name,
              (SELECT COUNT(*)::int FROM message_log m WHERE m.template_id = t.id) AS used_count
         FROM message_template t
         LEFT JOIN vertical v ON v.id = t.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.channel, t.name`,
      params,
    );
  }

  async get(id: number) {
    const row = await this.db.one<any>(
      `SELECT t.*, v.name AS vertical_name FROM message_template t
         LEFT JOIN vertical v ON v.id = t.vertical_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [id],
    );
    if (!row) throw new NotFoundException('template not found');
    return row;
  }

  private validate(dto: any) {
    const channel = String(dto?.channel ?? '');
    if (!CHANNELS.includes(channel as MsgChannel)) throw new BadRequestException('Choose a channel: WhatsApp, SMS or Email.');
    if (!String(dto?.name ?? '').trim()) throw new BadRequestException('Give the template a name.');
    if (channel === 'email' && !String(dto?.subject ?? '').trim()) {
      throw new BadRequestException('An email template needs a subject line.');
    }
    if (channel === 'whatsapp' && !String(dto?.wa_template_name ?? '').trim()) {
      // Meta will not deliver an un-approved template; catching it here beats a 400 from
      // Graph at 2am with the lead already marked "contacted".
      throw new BadRequestException('A WhatsApp template needs the template NAME approved in Meta.');
    }
    if (!String(dto?.body ?? '').trim()) throw new BadRequestException('The message body cannot be empty.');
    return channel as MsgChannel;
  }

  private waParams(dto: any): string[] {
    const raw = dto?.wa_params;
    if (Array.isArray(raw)) return raw.map((x) => String(x));
    if (typeof raw === 'string' && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
  }

  async create(dto: any, actorId: number) {
    const channel = this.validate(dto);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const waParams = this.waParams(dto);
    const vars = variablesOf(dto?.body, dto?.subject, ...waParams);
    return this.db.one<any>(
      `INSERT INTO message_template
         (org_id, channel, name, code, vertical_id, subject, body,
          wa_template_name, wa_language, wa_params, sms_sender_id, sms_dlt_template_id,
          variables, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$15)
       RETURNING *`,
      [
        Number(org!.id), channel, String(dto.name).trim(), dto?.code ? String(dto.code).trim() : null,
        dto?.vertical_id ? Number(dto.vertical_id) : null,
        dto?.subject ? String(dto.subject) : null, String(dto.body),
        dto?.wa_template_name ? String(dto.wa_template_name).trim() : null,
        dto?.wa_language ? String(dto.wa_language) : 'en',
        JSON.stringify(waParams),
        dto?.sms_sender_id ? String(dto.sms_sender_id) : null,
        dto?.sms_dlt_template_id ? String(dto.sms_dlt_template_id) : null,
        JSON.stringify(vars),
        dto?.is_active === false ? false : true, actorId,
      ],
    );
  }

  async update(id: number, dto: any, actorId: number) {
    const existing = await this.get(id);
    const merged = { ...existing, ...dto, channel: dto?.channel ?? existing.channel };
    const channel = this.validate(merged);
    const waParams = dto?.wa_params === undefined ? (existing.wa_params ?? []) : this.waParams(dto);
    const vars = variablesOf(merged.body, merged.subject, ...waParams);
    return this.db.one<any>(
      `UPDATE message_template
          SET channel = $2, name = $3, code = $4, vertical_id = $5, subject = $6, body = $7,
              wa_template_name = $8, wa_language = $9, wa_params = $10::jsonb,
              sms_sender_id = $11, sms_dlt_template_id = $12, variables = $13::jsonb,
              is_active = $14, updated_at = now(), updated_by = $15
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [
        id, channel, String(merged.name).trim(), merged.code ? String(merged.code).trim() : null,
        merged.vertical_id ? Number(merged.vertical_id) : null,
        merged.subject ? String(merged.subject) : null, String(merged.body),
        merged.wa_template_name ? String(merged.wa_template_name).trim() : null,
        merged.wa_language ? String(merged.wa_language) : 'en',
        JSON.stringify(waParams),
        merged.sms_sender_id ? String(merged.sms_sender_id) : null,
        merged.sms_dlt_template_id ? String(merged.sms_dlt_template_id) : null,
        JSON.stringify(vars),
        merged.is_active === false ? false : true, actorId,
      ],
    );
  }

  async remove(id: number, actorId: number) {
    await this.get(id);
    await this.db.query(
      `UPDATE message_template SET deleted_at = now(), deleted_by = $2, is_active = FALSE WHERE id = $1`,
      [id, actorId],
    );
    return { id, deleted: true };
  }

  // -------------------------------------------------------------- variables

  /**
   * THE VARIABLE BAG. Built from the lead JOINed to its whole path, so
   * {{branch}} / {{vertical}} / {{campaign}} / {{counsellor}} are the lead's OWN
   * hierarchy — never a global default that would be wrong for half the org.
   */
  async varsForLead(leadId: number): Promise<TemplateVars & { _lead: any }> {
    const l = await this.db.one<any>(
      `SELECT l.id, l.full_name, l.phone, l.whatsapp_phone, l.email, l.score, l.temperature,
              l.priority, l.dob, l.next_follow_up_at, l.vertical_id, l.branch_id, l.campaign_id,
              b.name AS branch, v.name AS vertical, p.name AS pipeline, ca.name AS campaign,
              s.name AS source, st.name AS stage, c.name AS course,
              -- DEF-S4-01 (found by the LIVE smoke, not by a unit test): the masters are a
              -- GENERIC table (id, name, code, meta JSONB) - there is no m_course.fee column.
              -- The fee lives in meta.fee, which is where the Course form writes it and where
              -- the lead sheet fee auto-fetch reads it. Pinned by template-sql-schema.spec.ts.
              (c.meta->>'fee') AS course_fee,
              u.name AS counsellor, city.name AS city, o.name AS org
         FROM lead l
         JOIN organisation o ON o.id = l.org_id
         JOIN branch b   ON b.id = l.branch_id
         JOIN vertical v ON v.id = l.vertical_id
         JOIN pipeline p ON p.id = l.pipeline_id
         JOIN campaign ca ON ca.id = l.campaign_id
         JOIN source s   ON s.id = l.source_id
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
         LEFT JOIN m_course c ON c.id = l.course_id
         LEFT JOIN "user" u ON u.id = l.owner_id
         LEFT JOIN city ON city.id = l.city_id
        WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [leadId],
    );
    if (!l) throw new NotFoundException('lead not found');
    const d = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : null);
    return {
      _lead: l,
      lead: {
        name: l.full_name, phone: l.phone, email: l.email, whatsapp: l.whatsapp_phone ?? l.phone,
        city: l.city, score: l.score, temperature: l.temperature, priority: l.priority,
        // DEF-S16-02 (third instance, and the only customer-visible one): `lead.dob` is a
        // DATE column (migration 026), so this was `String(aDate).slice(0, 10)` ->
        // "Mon Aug 31" inside a real message. Found by sweeping the pattern, not the site.
        dob: toDateString(l.dob) ?? null,
      },
      course: l.course, course_fee: l.course_fee,
      counsellor: l.counsellor, branch: l.branch, vertical: l.vertical, pipeline: l.pipeline,
      campaign: l.campaign, source: l.source, stage: l.stage, org: l.org,
      today: new Date().toLocaleDateString('en-IN'),
      next_follow_up: d(l.next_follow_up_at),
    };
  }

  /** Live preview — the SAME renderTemplate() the real send uses. */
  async preview(dto: any) {
    const t = dto?.template_id ? await this.get(Number(dto.template_id)) : dto;
    const vars: TemplateVars = dto?.lead_id ? await this.varsForLead(Number(dto.lead_id)) : SAMPLE_VARS;
    const rendered = renderTemplate(
      { ...t, wa_params: Array.isArray(t?.wa_params) ? t.wa_params : this.waParams(t) },
      vars,
    );
    return { ...rendered, sample: !dto?.lead_id, variables: variablesOf(t?.body, t?.subject) };
  }

  // ----------------------------------------------------- send / bulk / retry

  /** Which address this channel uses for this lead. */
  static recipient(channel: string, lead: any): string | null {
    if (channel === 'email') return lead.email ?? null;
    if (channel === 'whatsapp') return lead.whatsapp_phone || lead.phone || null;
    return lead.phone ?? null;
  }

  /**
   * Turn `{lead_id, template_id}` (or a free-typed body) into a queue-ready message.
   * The lead's VERTICAL rides along, and that is what selects the per-vertical SMTP row.
   */
  async build(dto: any): Promise<QueueMessage> {
    const channel = String(dto?.channel ?? '') as MsgChannel;
    if (!dto?.lead_id && !dto?.to) throw new BadRequestException('Send to a lead, or give a recipient.');

    let vars: TemplateVars = SAMPLE_VARS;
    let lead: any = null;
    if (dto?.lead_id) {
      const v = await this.varsForLead(Number(dto.lead_id));
      lead = v._lead; vars = v;
    }

    const tpl = dto?.template_id ? await this.get(Number(dto.template_id)) : null;
    const ch = (tpl?.channel ?? channel) as MsgChannel;
    if (!CHANNELS.includes(ch)) throw new BadRequestException('Choose a channel.');

    const rendered: RenderedTemplate = tpl
      ? renderTemplate({ ...tpl, wa_params: tpl.wa_params ?? [] }, vars)
      : renderTemplate({ channel: ch, subject: dto?.subject, body: dto?.body ?? '', wa_params: [] }, vars);

    const to = dto?.to ?? (lead ? TemplateService.recipient(ch, lead) : null);
    if (!to) {
      throw new BadRequestException(
        ch === 'email' ? 'This lead has no email address.' : 'This lead has no mobile number.',
      );
    }

    return {
      channel: ch,
      to: String(to),
      subject: rendered.subject,
      body: rendered.body,
      lead_id: lead ? Number(lead.id) : null,
      template_id: tpl ? Number(tpl.id) : null,
      vertical_id: lead ? Number(lead.vertical_id) : (dto?.vertical_id ? Number(dto.vertical_id) : null),
      branch_id: lead ? Number(lead.branch_id) : null,
      campaign_id: lead ? Number(lead.campaign_id) : null,
      wa_template_name: rendered.wa_template_name,
      wa_language: rendered.wa_language,
      wa_params: rendered.wa_params,
      sms_sender_id: rendered.sms_sender_id,
      sms_dlt_template_id: rendered.sms_dlt_template_id,
    };
  }

  /**
   * BULK: a template + an audience filter. The audience is resolved through the CALLER'S
   * scope, so a Branch Manager physically cannot blast another branch's leads.
   */
  async bulk(dto: any, scope: ResolvedScope, actorId: number) {
    const tpl = await this.get(Number(dto?.template_id));
    const params: unknown[] = [];
    const where: string[] = [
      this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params),
      'l.deleted_at IS NULL', 'l.is_active',
    ];
    const inList = (col: string, vals: unknown) => {
      const arr = (Array.isArray(vals) ? vals : [vals]).map(Number).filter(Boolean);
      if (!arr.length) return;
      params.push(arr); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    if (dto?.campaign_ids) inList('l.campaign_id', dto.campaign_ids);
    if (dto?.source_ids) inList('l.source_id', dto.source_ids);
    if (dto?.stage_ids) inList('l.stage_id', dto.stage_ids);
    if (dto?.branch_ids) inList('l.branch_id', dto.branch_ids);
    if (dto?.vertical_ids) inList('l.vertical_id', dto.vertical_ids);
    if (dto?.temperature) { params.push(String(dto.temperature)); where.push(`l.temperature = $${params.length}`); }

    const leads = await this.db.query<any>(
      `SELECT l.id FROM lead l WHERE ${where.join(' AND ')} ORDER BY l.id LIMIT 5000`, params,
    );
    let queued = 0; let skipped = 0; let failed = 0;
    for (const row of leads) {
      try {
        const msg = await this.build({ lead_id: Number(row.id), template_id: tpl.id });
        // a blast IS automation: guardrails (opt-out, daily cap, business hours) apply.
        const out = await this.messaging.queue({ ...msg, actor_id: actorId, guarded: true });
        if (out.status === 'skipped') skipped++; else queued++;
      } catch {
        failed++;   // no email address on the lead, etc. — counted, never fatal
      }
    }
    return { audience: leads.length, queued, skipped, failed };
  }

  /** Re-queue a failed message — what the client presses after pasting a credential. */
  async retry(id: number) {
    const row = await this.db.one<any>(
      `UPDATE message_log
          SET status = 'queued', attempts = 0, run_after = now(), error = NULL,
              not_configured = FALSE, locked_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('failed','skipped')
        RETURNING id, status`,
      [id],
    );
    if (!row) throw new BadRequestException('Only a failed or skipped message can be retried.');
    return row;
  }
}
