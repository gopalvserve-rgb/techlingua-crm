import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { LlmAdapterService } from '../ai/llm-adapter.service';

export interface DuplicateRuleSettings {
  match_phone: boolean;
  match_email: boolean;
  check_scope: 'global' | 'this_branch' | 'this_vertical' | 'this_campaign';
  on_duplicate: 'ignore' | 'merge' | 'merge_and_reopen' | 'flag' | 'create';
  open_reassign_same_user: boolean;
  highlight: boolean;
}
export const DUP_DEFAULTS: DuplicateRuleSettings = {
  match_phone: true, match_email: false, check_scope: 'this_campaign', on_duplicate: 'merge_and_reopen',
  open_reassign_same_user: true, highlight: true,
};
export interface ComplianceSettings {
  consent_text: string; require_consent: boolean; retention_days: number; recording_note: string;
}
export const COMPLIANCE_DEFAULTS: ComplianceSettings = {
  consent_text: 'I agree to be contacted by phone, SMS, WhatsApp and email about courses and admissions.',
  require_consent: false, retention_days: 0,
  recording_note: 'Calls may be recorded for quality and training purposes.',
};
export interface AiSettings { default_provider: string; monthly_run_limit: number }
export const AI_SETTINGS_DEFAULTS: AiSettings = { default_provider: '', monthly_run_limit: 0 };

const range = (from?: string, to?: string) => {
  const ok = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
  return { from: ok(from) ? from! : null, to: ok(to) ? to! : null };
};

/**
 * Communication Intelligence (Keyword Tracking · AI Usage · AI Settings), Analytics › Forecasting,
 * Leads › Duplicate Rules and Administration › Compliance (client, Oct 2026 — these screens were
 * placeholders). Everything here reads real data; nothing is a fixed number.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly llm: LlmAdapterService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  // ------------------------------------------------------- keyword tracking
  async keywords() {
    return this.db.query<any>(
      `SELECT id, keyword, category, is_active, created_at FROM tracked_keyword WHERE deleted_at IS NULL ORDER BY lower(keyword)`);
  }

  async addKeyword(dto: any, actorId: number) {
    const kw = String(dto?.keyword ?? '').trim();
    if (kw.length < 2) throw new BadRequestException('A keyword needs at least 2 characters.');
    const dupe = await this.db.one(`SELECT 1 FROM tracked_keyword WHERE lower(keyword) = lower($1) AND deleted_at IS NULL`, [kw]);
    if (dupe) throw new BadRequestException(`"${kw}" is already tracked.`);
    return this.db.one<any>(
      `INSERT INTO tracked_keyword (org_id, keyword, category, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [await this.orgId(), kw.slice(0, 80), dto?.category ? String(dto.category).slice(0, 40) : null, actorId]);
  }

  async updateKeyword(id: number, dto: any) {
    await this.db.query(
      `UPDATE tracked_keyword SET is_active = COALESCE($2, is_active), category = COALESCE($3, category) WHERE id = $1`,
      [id, dto?.is_active === undefined ? null : !!dto.is_active, dto?.category ?? null]);
    return { id, ok: true };
  }

  async removeKeyword(id: number) {
    await this.db.query(`UPDATE tracked_keyword SET deleted_at = now() WHERE id = $1`, [id]);
    return { id, deleted: true };
  }

  /**
   * How often each tracked keyword was MENTIONED in the period — across AI-analysed call
   * transcripts / summaries, lead notes, call dispositions and inbound WhatsApp messages —
   * and by how many leads; plus the latest mentions for one keyword when `keyword_id` is given.
   */
  async keywordReport(f: { from?: string; to?: string; keyword_id?: string }) {
    const { from, to } = range(f.from, f.to);
    const kws = (await this.keywords()).filter((k) => k.is_active);
    const window = (col: string, p: unknown[]) => {
      const w: string[] = [];
      if (from) { p.push(from); w.push(`${col} >= $${p.length}::date`); }
      if (to) { p.push(to); w.push(`${col} < ($${p.length}::date + 1)`); }
      return w.length ? ` AND ${w.join(' AND ')}` : '';
    };
    const rows = [];
    for (const k of kws) {
      const p: unknown[] = [`%${k.keyword}%`];
      const r = await this.db.one<any>(
        `WITH hits AS (
           SELECT 'call' AS src, a.subject_id AS lead_id, a.created_at AS at
             FROM ai_analysis a
            WHERE a.deleted_at IS NULL AND (a.input_text ILIKE $1 OR a.summary_text ILIKE $1)${window('a.created_at', p)}
           UNION ALL
           SELECT CASE WHEN la.type = 'message' THEN 'whatsapp' ELSE 'note' END, la.lead_id, la.occurred_at
             FROM lead_activity la
            WHERE la.note ILIKE $1 AND la.type IN ('note', 'message', 'call_log', 'disposition', 'follow_up')${window('la.occurred_at', p)}
         )
         SELECT count(*) AS mentions, count(DISTINCT lead_id) AS leads,
                count(*) FILTER (WHERE src = 'call') AS calls,
                count(*) FILTER (WHERE src = 'whatsapp') AS whatsapp,
                count(*) FILTER (WHERE src = 'note') AS notes,
                max(at) AS last_at
           FROM hits`, p);
      rows.push({ id: Number(k.id), keyword: k.keyword, category: k.category,
        mentions: Number(r?.mentions ?? 0), leads: Number(r?.leads ?? 0), calls: Number(r?.calls ?? 0),
        whatsapp: Number(r?.whatsapp ?? 0), notes: Number(r?.notes ?? 0), last_at: r?.last_at ?? null });
    }
    rows.sort((a, b) => b.mentions - a.mentions);
    let mentions: any[] = [];
    const focus = kws.find((k) => String(k.id) === String(f.keyword_id ?? ''));
    if (focus) {
      const p: unknown[] = [`%${focus.keyword}%`];
      mentions = await this.db.query<any>(
        `SELECT * FROM (
           SELECT 'Call / AI' AS source, a.subject_id AS lead_id, a.created_at AS at,
                  left(COALESCE(a.summary_text, a.input_text), 240) AS text
             FROM ai_analysis a WHERE a.deleted_at IS NULL AND (a.input_text ILIKE $1 OR a.summary_text ILIKE $1)${window('a.created_at', p)}
           UNION ALL
           SELECT CASE WHEN la.type = 'message' THEN 'WhatsApp' ELSE 'Note' END, la.lead_id, la.occurred_at, left(la.note, 240)
             FROM lead_activity la WHERE la.note ILIKE $1 AND la.type IN ('note', 'message', 'call_log', 'disposition', 'follow_up')${window('la.occurred_at', p)}
         ) m LEFT JOIN LATERAL (SELECT full_name FROM lead WHERE id = m.lead_id) l ON TRUE
         ORDER BY m.at DESC LIMIT 50`, p);
    }
    return { rows, mentions, keyword: focus ?? null };
  }

  // ------------------------------------------------------- AI usage & settings
  async aiUsage(f: { from?: string; to?: string }) {
    const { from, to } = range(f.from, f.to);
    const p: unknown[] = []; const w = ['a.deleted_at IS NULL'];
    if (from) { p.push(from); w.push(`a.created_at >= $${p.length}::date`); }
    if (to) { p.push(to); w.push(`a.created_at < ($${p.length}::date + 1)`); }
    const where = w.join(' AND ');
    const [tot, byType, byProvider, byUser, byDay] = await Promise.all([
      this.db.one<any>(`SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'failed') AS failed, COALESCE(sum(tokens),0) AS tokens,
                               count(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS this_month FROM ai_analysis a WHERE ${where}`, p),
      this.db.query<any>(`SELECT analysis_type AS label, count(*) AS runs, COALESCE(sum(tokens),0) AS tokens FROM ai_analysis a WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, p),
      this.db.query<any>(`SELECT COALESCE(provider,'—') AS label, count(*) AS runs, COALESCE(sum(tokens),0) AS tokens FROM ai_analysis a WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, p),
      this.db.query<any>(`SELECT COALESCE(u.name,'—') AS label, count(*) AS runs, COALESCE(sum(a.tokens),0) AS tokens FROM ai_analysis a LEFT JOIN "user" u ON u.id = a.created_by WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, p),
      this.db.query<any>(`SELECT to_char(date_trunc('day', a.created_at), 'YYYY-MM-DD') AS label, count(*) AS runs FROM ai_analysis a WHERE ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 31`, p),
    ]);
    const bot = await this.db.one<any>(`SELECT count(*) AS n FROM wa_bot_log WHERE kind = 'ai'`).catch(() => ({ n: 0 }));
    const s = await this.aiSettings();
    return {
      runs: Number(tot?.runs ?? 0), failed: Number(tot?.failed ?? 0), tokens: Number(tot?.tokens ?? 0),
      this_month: Number(tot?.this_month ?? 0), ai_bot_replies: Number(bot?.n ?? 0),
      limit: s.monthly_run_limit, byType, byProvider, byUser, byDay,
    };
  }

  async aiSettings(): Promise<AiSettings> {
    return { ...AI_SETTINGS_DEFAULTS, ...(await this.settings.get('ai_settings', AI_SETTINGS_DEFAULTS as unknown as Record<string, unknown>)) } as AiSettings;
  }

  async aiSettingsView() {
    return { settings: await this.aiSettings(), providers: await this.llm.providerStatus().catch(() => []) };
  }

  async saveAiSettings(dto: any, actorId: number) {
    const next: AiSettings = {
      default_provider: ['deepseek', 'gemini', ''].includes(String(dto?.default_provider ?? '')) ? String(dto?.default_provider ?? '') : '',
      monthly_run_limit: Math.max(0, Math.trunc(Number(dto?.monthly_run_limit ?? 0)) || 0),
    };
    await this.settings.set('ai_settings', next as unknown as Record<string, unknown>, actorId);
    return next;
  }

  // ---------------------------------------------------------------- forecast
  /**
   * The forecast: OPEN leads per pipeline × that pipeline's historical win rate (leads won ÷
   * leads won-or-lost over the last 12 months) = expected enrolments; × the pipeline's average
   * net fee = expected revenue. Plus the CASH forecast: unpaid installments falling due per month.
   */
  async forecast() {
    const pipes = await this.db.query<any>(
      `WITH closed AS (
         SELECT l.pipeline_id,
                count(*) FILTER (WHERE st.stage_type = 'won') AS won,
                count(*) FILTER (WHERE st.stage_type IN ('won', 'lost')) AS closed
           FROM lead l JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE l.deleted_at IS NULL AND l.updated_at >= now() - interval '12 months'
          GROUP BY l.pipeline_id
       ), open_leads AS (
         SELECT l.pipeline_id, count(*) AS open_n
           FROM lead l LEFT JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE l.deleted_at IS NULL AND l.is_active AND COALESCE(st.stage_type, 'open') NOT IN ('won', 'lost')
          GROUP BY l.pipeline_id
       ), fee AS (
         SELECT e.pipeline_id, avg(e.net_fee_minor) AS avg_fee
           FROM enrolment e WHERE e.deleted_at IS NULL AND e.status = 'active' AND e.created_at >= now() - interval '12 months'
          GROUP BY e.pipeline_id
       )
       SELECT p.id, p.name AS pipeline, v.name AS vertical, b.name AS branch,
              COALESCE(o.open_n, 0) AS open_leads, COALESCE(c.won, 0) AS won_12m, COALESCE(c.closed, 0) AS closed_12m,
              COALESCE(f.avg_fee, 0) AS avg_fee_minor
         FROM pipeline p
         LEFT JOIN vertical v ON v.id = p.vertical_id
         LEFT JOIN branch b ON b.id = v.branch_id
         LEFT JOIN open_leads o ON o.pipeline_id = p.id
         LEFT JOIN closed c ON c.pipeline_id = p.id
         LEFT JOIN fee f ON f.pipeline_id = p.id
        WHERE p.deleted_at IS NULL
        ORDER BY COALESCE(o.open_n, 0) DESC, p.name`);
    const rows = pipes.map((r) => {
      const rate = Number(r.closed_12m) > 0 ? Number(r.won_12m) / Number(r.closed_12m) : 0;
      const expected = Number(r.open_leads) * rate;
      return { ...r, open_leads: Number(r.open_leads), won_12m: Number(r.won_12m), closed_12m: Number(r.closed_12m),
        win_rate_pct: Math.round(rate * 1000) / 10, expected_enrolments: Math.round(expected * 10) / 10,
        avg_fee_minor: Math.round(Number(r.avg_fee_minor)), expected_revenue_minor: Math.round(expected * Number(r.avg_fee_minor)) };
    });
    const cash = await this.db.query<any>(
      `SELECT to_char(date_trunc('month', i.due_date), 'YYYY-MM') AS month,
              sum(i.amount_minor - i.paid_minor) AS due_minor, count(*) AS installments
         FROM installment i
         JOIN payment_plan pp ON pp.id = i.plan_id AND pp.deleted_at IS NULL AND pp.status = 'active'
        WHERE i.amount_minor > i.paid_minor AND i.due_date >= date_trunc('month', now()) AND i.due_date < date_trunc('month', now()) + interval '6 months'
        GROUP BY 1 ORDER BY 1`);
    const overdue = await this.db.one<any>(
      `SELECT COALESCE(sum(i.amount_minor - i.paid_minor), 0) AS overdue_minor
         FROM installment i JOIN payment_plan pp ON pp.id = i.plan_id AND pp.deleted_at IS NULL AND pp.status = 'active'
        WHERE i.amount_minor > i.paid_minor AND i.due_date < current_date`);
    return {
      pipelines: rows,
      totals: {
        open_leads: rows.reduce((a, r) => a + r.open_leads, 0),
        expected_enrolments: Math.round(rows.reduce((a, r) => a + r.expected_enrolments, 0) * 10) / 10,
        expected_revenue_minor: rows.reduce((a, r) => a + r.expected_revenue_minor, 0),
        overdue_minor: Number(overdue?.overdue_minor ?? 0),
      },
      cash: cash.map((c) => ({ month: c.month, due_minor: Number(c.due_minor), installments: Number(c.installments) })),
    };
  }

  // -------------------------------------------------------- duplicate rules
  async duplicateRules(): Promise<DuplicateRuleSettings> {
    return { ...DUP_DEFAULTS, ...(await this.settings.get('duplicate_rules', DUP_DEFAULTS as unknown as Record<string, unknown>)) } as DuplicateRuleSettings;
  }

  async duplicateRulesView() {
    const rules = await this.duplicateRules();
    const stats = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS checked_30d,
              count(*) FILTER (WHERE outcome = 'duplicate' AND created_at >= now() - interval '30 days') AS duplicates_30d
         FROM lead_ingest_record`).catch(() => null);
    const overrides = await this.db.one<any>(
      `SELECT count(*) AS n FROM campaign WHERE deleted_at IS NULL AND duplicacy_config IS NOT NULL AND duplicacy_config <> '{}'::jsonb`).catch(() => null);
    return { rules, stats: { checked_30d: Number(stats?.checked_30d ?? 0), duplicates_30d: Number(stats?.duplicates_30d ?? 0) },
      campaigns_with_own_rule: Number(overrides?.n ?? 0) };
  }

  async saveDuplicateRules(dto: any, actorId: number) {
    const cur = await this.duplicateRules();
    const scope = ['global', 'this_branch', 'this_vertical', 'this_campaign'].includes(String(dto?.check_scope)) ? dto.check_scope : cur.check_scope;
    const action = ['ignore', 'merge', 'merge_and_reopen', 'flag', 'create'].includes(String(dto?.on_duplicate)) ? dto.on_duplicate : cur.on_duplicate;
    const next: DuplicateRuleSettings = {
      match_phone: true,   // the phone is always the primary key — it cannot be switched off
      match_email: dto?.match_email === undefined ? cur.match_email : !!dto.match_email,
      check_scope: scope, on_duplicate: action,
      open_reassign_same_user: dto?.open_reassign_same_user === undefined ? cur.open_reassign_same_user : !!dto.open_reassign_same_user,
      highlight: dto?.highlight === undefined ? cur.highlight : !!dto.highlight,
    };
    await this.settings.set('duplicate_rules', next as unknown as Record<string, unknown>, actorId);
    // apply to every campaign too, unless asked to keep campaign-specific rules
    let applied = 0;
    if (dto?.apply_to_campaigns) {
      const r = await this.db.query<any>(
        `UPDATE campaign SET duplicacy_config = COALESCE(duplicacy_config, '{}'::jsonb) || $1::jsonb, updated_at = now()
          WHERE deleted_at IS NULL RETURNING id`,
        [JSON.stringify({ check_scope: next.check_scope, on_duplicate: next.on_duplicate, open_reassign_same_user: next.open_reassign_same_user })]);
      applied = r.length;
    }
    return { rules: next, applied_to_campaigns: applied };
  }

  // -------------------------------------------------------------- compliance
  async compliance() {
    const s = { ...COMPLIANCE_DEFAULTS, ...(await this.settings.get('compliance', COMPLIANCE_DEFAULTS as unknown as Record<string, unknown>)) } as ComplianceSettings;
    const n = async (sql: string) => { try { const r = await this.db.one<{ n: string }>(sql); return Number(r?.n ?? 0); } catch { return 0; } };
    const [optOuts, dlt, audit30, deleted, oldDeleted] = await Promise.all([
      n(`SELECT count(*) AS n FROM opt_out`),
      n(`SELECT count(*) AS n FROM sms_template WHERE deleted_at IS NULL AND COALESCE(dlt_template_id,'') <> ''`),
      n(`SELECT count(*) AS n FROM audit_log WHERE created_at >= now() - interval '30 days'`),
      n(`SELECT count(*) AS n FROM lead WHERE deleted_at IS NOT NULL`),
      s.retention_days > 0 ? n(`SELECT count(*) AS n FROM lead WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '${Math.trunc(s.retention_days)} days'`) : Promise.resolve(0),
    ]);
    return { settings: s, stats: { opt_outs: optOuts, dlt_templates: dlt, audit_events_30d: audit30, deleted_leads: deleted, past_retention: oldDeleted } };
  }

  async saveCompliance(dto: any, actorId: number) {
    const cur = (await this.compliance()).settings;
    const next: ComplianceSettings = {
      consent_text: String(dto?.consent_text ?? cur.consent_text).slice(0, 1000),
      require_consent: dto?.require_consent === undefined ? cur.require_consent : !!dto.require_consent,
      retention_days: Math.max(0, Math.min(3650, Math.trunc(Number(dto?.retention_days ?? cur.retention_days)) || 0)),
      recording_note: String(dto?.recording_note ?? cur.recording_note).slice(0, 500),
    };
    await this.settings.set('compliance', next as unknown as Record<string, unknown>, actorId);
    return next;
  }
}
