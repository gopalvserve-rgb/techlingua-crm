import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { MessagingService, InboundWhatsApp } from '../messaging/messaging.service';
import { LlmAdapterService } from '../ai/llm-adapter.service';

/** WhatsBot settings (app_setting 'whatsbot'). */
export interface WhatsBotSettings {
  enabled: boolean;
  welcome_enabled: boolean; welcome_text: string;
  away_enabled: boolean; away_text: string;
  /** IST business hours, 'HH:MM' */
  open_from: string; open_to: string;
  /** working days, 0 = Sunday … 6 = Saturday */
  open_days: number[];
  max_replies_per_hour: number;
}
/** AI Bot settings (app_setting 'aibot'). */
export interface AiBotSettings {
  enabled: boolean;
  knowledge: string;
  tone: string;
  handover_keywords: string;
  handover_text: string;
  provider: string;
}

export const WHATSBOT_DEFAULTS: WhatsBotSettings = {
  enabled: false,
  welcome_enabled: true,
  welcome_text: 'Hello! Thank you for contacting us. How can we help you today? Reply with "courses", "fees" or "address".',
  away_enabled: false,
  away_text: 'Thank you for your message. Our office is closed right now — our counsellor will reply as soon as we open.',
  open_from: '09:30', open_to: '19:00', open_days: [1, 2, 3, 4, 5, 6],
  max_replies_per_hour: 6,
};
export const AIBOT_DEFAULTS: AiBotSettings = {
  enabled: false,
  knowledge: '',
  tone: 'Friendly, short and professional. Reply in the language the student writes in (English or Hindi).',
  handover_keywords: 'call me, complaint, refund, talk to counsellor, human, agent',
  handover_text: 'Sure — I am connecting you to our counsellor. You will hear from us shortly.',
  provider: '',
};

/** Does `text` hit a rule's keywords? Pure, unit-tested. */
export function ruleMatches(text: string, keywords: string, matchType: string): boolean {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return false;
  const words = String(keywords ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  return words.some((w) => (matchType === 'exact' ? t === w : matchType === 'starts' ? t.startsWith(w) : t.includes(w)));
}

/** Is `now` inside the IST business hours of `s`? Pure, unit-tested. */
export function withinHours(s: Pick<WhatsBotSettings, 'open_from' | 'open_to' | 'open_days'>, now = new Date()): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const day = ist.getUTCDay();
  if (!(s.open_days ?? []).includes(day)) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const toMin = (hhmm: string) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  return mins >= toMin(s.open_from) && mins < toMin(s.open_to);
}

/**
 * WHATSBOT + AI BOT (client, Oct 2026 — these screens were "Phase 2" placeholders).
 *
 * Every inbound WhatsApp message (the Meta webhook hands it to MessagingService, which calls
 * the registered handler) is answered — while the conversation's bot is ON and the bot is
 * enabled — in this order:
 *   1. HAND-OVER  — a hand-over word ("call me", "complaint"…) switches the bot OFF for this
 *                   conversation and tells the student a counsellor will reply.
 *   2. KEYWORD    — the first active WhatsBot rule (by priority) whose keywords match.
 *   3. WELCOME    — the very first message from a number gets the welcome text.
 *   4. AWAY       — outside business hours, the away text (once per 12 hours).
 *   5. AI         — the AI Bot answers from the knowledge the admin wrote (Gemini / DeepSeek).
 * Replies go through the SAME send path as every message (send log, opt-out, cap), are
 * rate-limited per conversation, and every decision is written to wa_bot_log.
 */
@Injectable()
export class BotsService implements OnModuleInit {
  private readonly log = new Logger('Bots');

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly messaging: MessagingService,
    private readonly llm: LlmAdapterService,
  ) {}

  onModuleInit() {
    this.messaging.registerInboundHandler((m) => this.handleInbound(m));
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  // ------------------------------------------------------------- settings
  async getSettings() {
    const [wb, ai] = await Promise.all([
      this.settings.get('whatsbot', WHATSBOT_DEFAULTS as unknown as Record<string, unknown>),
      this.settings.get('aibot', AIBOT_DEFAULTS as unknown as Record<string, unknown>),
    ]);
    const providers = await this.llm.providerStatus().catch(() => []);
    return {
      whatsbot: { ...WHATSBOT_DEFAULTS, ...wb } as WhatsBotSettings,
      aibot: { ...AIBOT_DEFAULTS, ...ai } as AiBotSettings,
      ai_configured: providers.some((p) => p.configured),
      providers,
    };
  }

  async saveWhatsBot(dto: any, actorId: number) {
    const cur = (await this.getSettings()).whatsbot;
    const days = Array.isArray(dto?.open_days) ? dto.open_days.map(Number).filter((d: number) => d >= 0 && d <= 6) : cur.open_days;
    const hhmm = (v: unknown, d: string) => (/^\d{1,2}:\d{2}$/.test(String(v ?? '')) ? String(v) : d);
    const next: WhatsBotSettings = {
      enabled: dto?.enabled === undefined ? cur.enabled : !!dto.enabled,
      welcome_enabled: dto?.welcome_enabled === undefined ? cur.welcome_enabled : !!dto.welcome_enabled,
      welcome_text: String(dto?.welcome_text ?? cur.welcome_text).slice(0, 1000),
      away_enabled: dto?.away_enabled === undefined ? cur.away_enabled : !!dto.away_enabled,
      away_text: String(dto?.away_text ?? cur.away_text).slice(0, 1000),
      open_from: hhmm(dto?.open_from, cur.open_from), open_to: hhmm(dto?.open_to, cur.open_to),
      open_days: days,
      max_replies_per_hour: Math.max(1, Math.min(30, Number(dto?.max_replies_per_hour ?? cur.max_replies_per_hour) || 6)),
    };
    await this.settings.set('whatsbot', next as unknown as Record<string, unknown>, actorId);
    return next;
  }

  async saveAiBot(dto: any, actorId: number) {
    const cur = (await this.getSettings()).aibot;
    const next: AiBotSettings = {
      enabled: dto?.enabled === undefined ? cur.enabled : !!dto.enabled,
      knowledge: String(dto?.knowledge ?? cur.knowledge).slice(0, 12000),
      tone: String(dto?.tone ?? cur.tone).slice(0, 500),
      handover_keywords: String(dto?.handover_keywords ?? cur.handover_keywords).slice(0, 500),
      handover_text: String(dto?.handover_text ?? cur.handover_text).slice(0, 1000),
      provider: ['deepseek', 'gemini', ''].includes(String(dto?.provider ?? cur.provider)) ? String(dto?.provider ?? cur.provider) : '',
    };
    if (next.enabled && !(await this.llm.anyConfigured())) {
      throw new BadRequestException('Add a Gemini or DeepSeek API key in Administration › Settings › Channels › AI before switching the AI Bot on.');
    }
    await this.settings.set('aibot', next as unknown as Record<string, unknown>, actorId);
    return next;
  }

  // ---------------------------------------------------------------- rules
  async listRules() {
    return this.db.query<any>(
      `SELECT id, name, keywords, match_type, reply, priority, is_active, hits, created_at, updated_at
         FROM wa_bot_rule WHERE deleted_at IS NULL ORDER BY priority, id`);
  }

  private ruleDto(dto: any) {
    const name = String(dto?.name ?? '').trim();
    const keywords = String(dto?.keywords ?? '').split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    const reply = String(dto?.reply ?? '').trim();
    if (!name) throw new BadRequestException('Give the rule a name.');
    if (!keywords) throw new BadRequestException('Add at least one keyword.');
    if (!reply) throw new BadRequestException('Write the reply the bot sends.');
    const match = ['contains', 'exact', 'starts'].includes(String(dto?.match_type)) ? String(dto.match_type) : 'contains';
    return { name: name.slice(0, 120), keywords, reply: reply.slice(0, 2000), match,
      priority: Number.isFinite(Number(dto?.priority)) ? Math.trunc(Number(dto.priority)) : 100,
      active: dto?.is_active === undefined ? true : !!dto.is_active };
  }

  async createRule(dto: any, actorId: number) {
    const r = this.ruleDto(dto);
    return this.db.one<any>(
      `INSERT INTO wa_bot_rule (org_id, name, keywords, match_type, reply, priority, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [await this.orgId(), r.name, r.keywords, r.match, r.reply, r.priority, r.active, actorId]);
  }

  async updateRule(id: number, dto: any) {
    const cur = await this.db.one<any>(`SELECT * FROM wa_bot_rule WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw new NotFoundException('Rule not found');
    const r = this.ruleDto({ ...cur, ...dto });
    return this.db.one<any>(
      `UPDATE wa_bot_rule SET name=$2, keywords=$3, match_type=$4, reply=$5, priority=$6, is_active=$7, updated_at=now()
        WHERE id=$1 RETURNING *`, [id, r.name, r.keywords, r.match, r.reply, r.priority, r.active]);
  }

  async deleteRule(id: number, actorId: number) {
    await this.db.query(`UPDATE wa_bot_rule SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actorId]);
    return { id, deleted: true };
  }

  async listLog(limit = 100) {
    const rows = await this.db.query<any>(
      `SELECT b.id, b.phone10, b.lead_id, l.full_name AS lead_name, b.kind, b.rule_id, r.name AS rule_name,
              b.inbound_text, b.reply_text, b.status, b.error, b.created_at
         FROM wa_bot_log b
         LEFT JOIN lead l ON l.id = b.lead_id
         LEFT JOIN wa_bot_rule r ON r.id = b.rule_id
        ORDER BY b.created_at DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 100, 1), 500)]);
    const stats = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS replies_24h,
              count(*) FILTER (WHERE kind = 'ai' AND created_at >= now() - interval '24 hours') AS ai_24h,
              count(*) FILTER (WHERE kind = 'handover' AND created_at >= now() - interval '24 hours') AS handovers_24h,
              count(DISTINCT phone10) FILTER (WHERE created_at >= now() - interval '24 hours') AS conversations_24h
         FROM wa_bot_log WHERE kind <> 'skipped'`);
    return { rows, stats: { replies_24h: Number(stats?.replies_24h ?? 0), ai_24h: Number(stats?.ai_24h ?? 0),
      handovers_24h: Number(stats?.handovers_24h ?? 0), conversations_24h: Number(stats?.conversations_24h ?? 0) } };
  }

  /** "Try it": what the bot WOULD answer to `text` — nothing is sent or logged. */
  async simulate(text: string, firstMessage = false) {
    const s = await this.getSettings();
    // rules are tested even while the bot is switched OFF, so they can be tried before going live
    const out = await this.decide(String(text ?? ''), { ...s.whatsbot, enabled: true }, s.aibot,
      { first: firstMessage, awayRecently: false, dryRun: true });
    return { ...out, bot_off: !s.whatsbot.enabled };
  }

  // -------------------------------------------------------------- engine
  /** The reply decision for one inbound text. Pure apart from the rule lookup and the LLM call. */
  private async decide(text: string, wb: WhatsBotSettings, ai: AiBotSettings,
    ctx: { first: boolean; awayRecently: boolean; dryRun?: boolean; leadName?: string | null }):
    Promise<{ kind: 'handover' | 'keyword' | 'welcome' | 'away' | 'ai' | 'none'; reply: string | null; rule_id?: number; error?: string }> {
    if (ai.enabled && ruleMatches(text, ai.handover_keywords, 'contains')) {
      return { kind: 'handover', reply: ai.handover_text || AIBOT_DEFAULTS.handover_text };
    }
    if (wb.enabled) {
      const rules = await this.db.query<any>(
        `SELECT id, keywords, match_type, reply FROM wa_bot_rule
          WHERE deleted_at IS NULL AND is_active ORDER BY priority, id`);
      const hit = rules.find((r) => ruleMatches(text, r.keywords, r.match_type));
      if (hit) return { kind: 'keyword', reply: String(hit.reply), rule_id: Number(hit.id) };
      if (ctx.first && wb.welcome_enabled && wb.welcome_text) return { kind: 'welcome', reply: wb.welcome_text };
      if (wb.away_enabled && wb.away_text && !withinHours(wb) && !ctx.awayRecently) return { kind: 'away', reply: wb.away_text };
    }
    if (ai.enabled && ai.knowledge.trim()) {
      try {
        const r = await this.llm.complete({
          system: [
            'You are the WhatsApp assistant of an education institute. Answer ONLY from the knowledge below.',
            'If the answer is not in the knowledge, say a counsellor will reply shortly — never invent fees, dates or promises.',
            `Tone: ${ai.tone}`, 'Keep the answer under 80 words. Plain text, no markdown.',
            '--- KNOWLEDGE ---', ai.knowledge,
          ].join('\n'),
          user: `${ctx.leadName ? `Student name: ${ctx.leadName}\n` : ''}Message: ${text}`,
          maxTokens: 300,
        }, ai.provider || null);
        const reply = String(r.text ?? '').trim();
        if (reply) return { kind: 'ai', reply: reply.slice(0, 1500) };
      } catch (e) {
        return { kind: 'none', reply: null, error: (e as Error).message.slice(0, 280) };
      }
    }
    return { kind: 'none', reply: null };
  }

  /** The inbound hook — never throws (a bot failure must not break webhook processing). */
  async handleInbound(m: InboundWhatsApp): Promise<void> {
    try {
      const s = await this.getSettings();
      if (!s.whatsbot.enabled && !s.aibot.enabled) return;
      const ph10 = String(m.phone ?? '').replace(/\D/g, '').slice(-10);
      if (ph10.length < 8 || !String(m.text ?? '').trim()) return;
      const orgId = await this.orgId();
      const state = await this.db.one<{ bot_on: boolean }>(
        `SELECT bot_on FROM wa_conversation WHERE org_id = $1 AND phone10 = $2`, [orgId, ph10]);
      if (state && state.bot_on === false) return;   // a human has taken this conversation

      const recent = await this.db.one<any>(
        `SELECT count(*) FILTER (WHERE created_at >= now() - interval '1 hour' AND kind <> 'skipped') AS last_hour,
                count(*) FILTER (WHERE kind = 'away' AND created_at >= now() - interval '12 hours') AS away_12h
           FROM wa_bot_log WHERE org_id = $1 AND phone10 = $2`, [orgId, ph10]);
      if (Number(recent?.last_hour ?? 0) >= s.whatsbot.max_replies_per_hour) {
        await this.logBot(orgId, ph10, m.lead_id ?? null, 'skipped', null, m.text, null, 'skipped', 'reply limit per hour reached');
        return;
      }
      const first = !!m.first_message;
      const d = await this.decide(m.text, s.whatsbot, s.aibot, {
        first, awayRecently: Number(recent?.away_12h ?? 0) > 0, leadName: m.lead_name ?? null,
      });
      if (d.kind === 'none' || !d.reply) {
        if (d.error) await this.logBot(orgId, ph10, m.lead_id ?? null, 'skipped', null, m.text, null, 'failed', d.error);
        return;
      }
      const sent = await this.messaging.waSendSystem(ph10, d.reply, m.lead_id ?? null);
      await this.logBot(orgId, ph10, m.lead_id ?? null, d.kind, d.rule_id ?? null, m.text, d.reply, sent.status, sent.reason ?? null);
      if (d.rule_id) await this.db.query(`UPDATE wa_bot_rule SET hits = hits + 1 WHERE id = $1`, [d.rule_id]);
      if (d.kind === 'handover') {
        await this.db.query(
          `INSERT INTO wa_conversation (org_id, phone10, bot_on) VALUES ($1, $2, FALSE)
           ON CONFLICT (org_id, phone10) DO UPDATE SET bot_on = FALSE, resolved = FALSE, updated_at = now()`, [orgId, ph10]);
        if (m.lead_id) {
          await this.db.query(
            `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note)
             SELECT l.id, l.org_id, l.branch_id, NULL, 'note', $2 FROM lead l WHERE l.id = $1`,
            [m.lead_id, `WhatsApp: the student asked for a counsellor ("${String(m.text).slice(0, 80)}") — bot switched off, please reply from Live Chat.`]);
        }
      }
    } catch (e) {
      this.log.warn(`bot reply failed: ${(e as Error).message}`);
    }
  }

  private async logBot(orgId: number, ph10: string, leadId: number | null, kind: string, ruleId: number | null,
    inbound: string, reply: string | null, status: string | null, error: string | null) {
    await this.db.query(
      `INSERT INTO wa_bot_log (org_id, phone10, lead_id, kind, rule_id, inbound_text, reply_text, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, ph10, leadId, kind, ruleId, String(inbound ?? '').slice(0, 2000), reply, status, error ? String(error).slice(0, 300) : null]);
  }
}
