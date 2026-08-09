import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { ScopeColumnMap } from '../rbac/rbac.types';
import { LlmAdapterService } from './llm-adapter.service';

/** `ai_analysis a` — denormalised lead scope, filtered like every other lead-shaped entity. */
export const AI_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.owner_id', team: 'a.team_id', branch: 'a.branch_id',
  vertical: 'a.vertical_id', pipeline: 'a.pipeline_id', campaign: 'a.campaign_id',
};

export const ANALYSIS_TYPES = ['transcription', 'summary', 'sentiment', 'quality'] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

interface Me { id: number; name?: string }

/**
 * AI COMMUNICATION INTELLIGENCE — credential-gated, working on the TEXT that exists.
 *
 * Telephony / call recording is OUT of scope in this system, so the four capabilities run
 * over lead / follow-up notes, the activity timeline, or a pasted / uploaded transcript:
 *   · transcription — accept a pasted transcript (audio transcription is key-dependent);
 *   · summary       — a concise summary via the configured LLM;
 *   · sentiment     — positive / neutral / negative + rationale;
 *   · quality       — a rubric-scored 0-100 counsellor call-quality score + notes.
 *
 * Everything degrades cleanly: with no DeepSeek / Gemini key the LLM adapter throws
 * NotConfiguredException (503, surfaced as a clean "add a key in Settings" state, never a
 * 500). Results are saved to `ai_analysis` and RBAC-scoped INSIDE the SQL (AI_SCOPE_COLS).
 * A tiny in-memory rate-limiter caps the AI calls per user per minute.
 */
@Injectable()
export class AiService {
  /** userId -> recent call epoch-ms (sliding 60s window). */
  private readonly calls = new Map<number, number[]>();
  private readonly RATE_MAX = 20;
  private readonly RATE_WINDOW_MS = 60_000;

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly llm: LlmAdapterService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private scopeWhere(scope: ResolvedScope, params: unknown[]): string {
    return this.resolver.buildScopeWhere(scope, AI_SCOPE_COLS, params);
  }

  private rateLimit(userId: number): void {
    const now = Date.now();
    const arr = (this.calls.get(userId) ?? []).filter((t) => now - t < this.RATE_WINDOW_MS);
    if (arr.length >= this.RATE_MAX) {
      throw new BadRequestException('Too many AI requests in a short time — please wait a moment and try again.');
    }
    arr.push(now);
    this.calls.set(userId, arr);
  }

  /* --------------------------------------------------------------- status */

  /** Provider configured-flags + whether the module is live. Never a 500, never a secret. */
  async status() {
    const providers = await this.llm.providerStatus();
    return {
      configured: providers.some((p) => p.configured),
      providers,
      hint: 'Add a DeepSeek or Gemini API key in Administration > Settings > Channels > AI to switch on AI insights.',
    };
  }

  /* ------------------------------------------------------------- subjects */

  /** A small, scoped picker of leads/students to analyse. */
  async subjects(scope: ResolvedScope, type: string, q?: string) {
    if (type === 'student') {
      const params: unknown[] = [];
      const where: string[] = ['s.deleted_at IS NULL'];
      // students carry branch/vertical for scope
      const sw = this.resolver.buildScopeWhere(scope, { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' } as ScopeColumnMap, params);
      where.push(sw);
      if (q) { params.push(`%${q}%`); where.push(`(s.full_name ILIKE $${params.length} OR s.student_no ILIKE $${params.length})`); }
      const rows = await this.db.query<any>(
        `SELECT s.id, s.full_name, s.student_no AS ref, s.phone
           FROM student s WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 25`, params).catch(() => []);
      return rows.map((r) => ({ id: Number(r.id), label: r.full_name, ref: r.ref, phone: r.phone }));
    }
    // default: leads
    const params: unknown[] = [];
    const where = ['l.deleted_at IS NULL', this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id', vertical: 'l.vertical_id',
      pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    } as ScopeColumnMap, params)];
    if (q) { params.push(`%${q}%`); where.push(`(l.full_name ILIKE $${params.length} OR l.phone ILIKE $${params.length})`); }
    const rows = await this.db.query<any>(
      `SELECT l.id, l.full_name, l.phone AS ref, l.phone
         FROM lead l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 25`, params);
    return rows.map((r) => ({ id: Number(r.id), label: r.full_name, ref: r.ref, phone: r.phone }));
  }

  /* ------------------------------------------------------- gather + scope */

  /** Pull the scope + a display label + gathered text for a lead subject. */
  private async leadContext(leadId: number, scope: ResolvedScope): Promise<{ ok: boolean; row?: any; text?: string }> {
    const params: unknown[] = [leadId];
    const sw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id', vertical: 'l.vertical_id',
      pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    } as ScopeColumnMap, params);
    const row = await this.db.one<any>(
      `SELECT l.id, l.full_name, l.owner_id, l.team_id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id
         FROM lead l WHERE l.id = $1 AND l.deleted_at IS NULL AND ${sw}`, params);
    if (!row) return { ok: false };
    const acts = await this.db.query<any>(
      `SELECT type, note, to_char(occurred_at, 'DD Mon YYYY HH24:MI') AS at
         FROM lead_activity WHERE lead_id = $1 AND note IS NOT NULL AND note <> '' ORDER BY occurred_at DESC LIMIT 40`, [leadId]);
    const fus = await this.db.query<any>(
      `SELECT notes, to_char(scheduled_at, 'DD Mon YYYY') AS at
         FROM follow_up WHERE lead_id = $1 AND notes IS NOT NULL AND notes <> '' ORDER BY scheduled_at DESC LIMIT 20`, [leadId]);
    const lines = [
      ...acts.map((a) => `[${a.at}] ${a.type}: ${a.note}`),
      ...fus.map((f) => `[${f.at}] follow-up: ${f.notes}`),
    ];
    return { ok: true, row, text: lines.join('\n') };
  }

  /** Runner's primary assignment scope, used for an ad-hoc transcript (no subject). */
  private async runnerScope(me: Me): Promise<any> {
    const a = await this.db.one<any>(
      `SELECT branch_id, vertical_id, team_id FROM user_assignment
        WHERE user_id = $1 AND is_active ORDER BY id LIMIT 1`, [me.id]).catch(() => null);
    return { branch_id: a?.branch_id ?? null, vertical_id: a?.vertical_id ?? null, team_id: a?.team_id ?? null };
  }

  /* ---------------------------------------------------------------- run */

  /**
   * Run an analysis. Degrades cleanly (503) when no AI key is configured. For a lead subject
   * with no pasted text, the input is gathered from the lead's notes + timeline. Transcription
   * of a pasted transcript is stored as-is (no LLM); audio transcription is key-dependent.
   */
  async analyze(dto: any, me: Me, scope: ResolvedScope) {
    const type = String(dto?.analysis_type ?? '') as AnalysisType;
    if (!ANALYSIS_TYPES.includes(type)) throw new BadRequestException(`Unknown analysis type "${dto?.analysis_type}"`);
    const subjectType = ['lead', 'student', 'transcript'].includes(dto?.subject_type) ? dto.subject_type : 'transcript';
    const subjectId = dto?.subject_id ? Number(dto.subject_id) : null;

    // audio transcription is key-dependent — we accept the pasted-transcript path fully.
    if (dto?.has_audio && type === 'transcription') {
      throw new BadRequestException(
        'Audio transcription needs a transcription-capable provider key. Paste or type the transcript text to analyse it now.');
    }

    let pastedText = String(dto?.input_text ?? '').trim();
    let inputSource: string = dto?.input_source && ['transcript', 'notes', 'activity', 'audio'].includes(dto.input_source)
      ? dto.input_source : 'transcript';
    let subjectLabel: string | null = null;
    let sc = { branch_id: null as number | null, vertical_id: null as number | null, pipeline_id: null as number | null,
      campaign_id: null as number | null, team_id: null as number | null, owner_id: me.id as number | null };

    if (subjectType === 'lead' && subjectId) {
      const ctx = await this.leadContext(subjectId, scope);
      if (!ctx.ok) throw new NotFoundException('lead not found or out of scope');
      subjectLabel = ctx.row.full_name;
      sc = {
        branch_id: ctx.row.branch_id ?? null, vertical_id: ctx.row.vertical_id ?? null,
        pipeline_id: ctx.row.pipeline_id ?? null, campaign_id: ctx.row.campaign_id ?? null,
        team_id: ctx.row.team_id ?? null, owner_id: ctx.row.owner_id ?? me.id,
      };
      if (!pastedText) { pastedText = ctx.text ?? ''; inputSource = 'notes'; }
    } else if (subjectType === 'student' && subjectId) {
      const s = await this.db.one<any>(
        `SELECT id, full_name, branch_id, vertical_id, pipeline_id, campaign_id, team_id, owner_id FROM student WHERE id = $1 AND deleted_at IS NULL`, [subjectId]).catch(() => null);
      if (!s) throw new NotFoundException('student not found');
      subjectLabel = s.full_name;
      sc = { branch_id: s.branch_id ?? null, vertical_id: s.vertical_id ?? null, pipeline_id: s.pipeline_id ?? null, campaign_id: s.campaign_id ?? null, team_id: s.team_id ?? null, owner_id: s.owner_id ?? me.id };
    } else {
      subjectLabel = 'Pasted transcript';
      const rs = await this.runnerScope(me);
      sc = { ...sc, branch_id: rs.branch_id, vertical_id: rs.vertical_id, team_id: rs.team_id, owner_id: me.id };
    }

    if (!pastedText || pastedText.length < 2) {
      throw new BadRequestException('Nothing to analyse — paste a transcript or pick a lead that has notes.');
    }
    // keep the stored input bounded
    const inputText = pastedText.slice(0, 20_000);

    // TRANSCRIPTION of a pasted transcript: no LLM — the transcript IS the input.
    if (type === 'transcription') {
      return this.persist({
        subjectType, subjectId, subjectLabel, type, inputSource, inputText,
        provider: null, model: null, status: 'complete',
        output: { transcript: inputText, note: 'Pasted/typed transcript stored. Audio transcription is key-dependent.' },
        summary_text: null, sentiment: null, quality_score: null, tokens: null, error: null, sc, me,
      });
    }

    // The three LLM-backed capabilities.
    this.rateLimit(me.id);
    const { system, user, json } = this.buildPrompt(type, inputText);
    let result;
    try {
      result = await this.llm.complete({ system, user, json }, dto?.provider ?? null);
    } catch (e: any) {
      // NotConfiguredException bubbles up as a clean 503 (never stored). Other errors -> 400.
      if (e?.notConfigured) throw e;
      throw new BadRequestException(`AI call failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const parsed = this.parse(type, result.text);

    return this.persist({
      subjectType, subjectId, subjectLabel, type, inputSource, inputText,
      provider: result.provider, model: result.model, status: 'complete',
      output: parsed.output, summary_text: parsed.summary_text, sentiment: parsed.sentiment,
      quality_score: parsed.quality_score, tokens: result.tokens, error: null, sc, me,
    });
  }

  private buildPrompt(type: AnalysisType, text: string): { system: string; user: string; json: boolean } {
    if (type === 'summary') {
      return {
        json: true,
        system: 'You are an assistant for an education-counselling CRM in India. Summarise the conversation or notes for a counsellor. Reply ONLY with strict JSON.',
        user: `Summarise the following conversation/notes. Return JSON with keys: "summary" (3-5 sentences), "key_points" (array of short strings), "next_steps" (array of short strings).\n\n---\n${text}`,
      };
    }
    if (type === 'sentiment') {
      return {
        json: true,
        system: 'You classify the sentiment of a prospect/customer conversation for an education CRM. Reply ONLY with strict JSON.',
        user: `Classify the overall sentiment of the following conversation. Return JSON with keys: "sentiment" (one of "positive","neutral","negative"), "score" (number -1 to 1), "rationale" (one short sentence).\n\n---\n${text}`,
      };
    }
    // quality
    return {
      json: true,
      system: 'You are a call-quality reviewer for education counsellors. Score against a fixed rubric. Reply ONLY with strict JSON.',
      user: `Score this counselling conversation against the rubric, each criterion 0-20: "greeting", "needs_identified", "solution_offered", "next_step_set", "politeness". Return JSON with keys: "criteria" (object of the five criterion->number), "total" (0-100, the sum), "notes" (one or two short coaching sentences).\n\n---\n${text}`,
    };
  }

  /** Defensive JSON extraction — the model is asked for JSON but we never trust it blindly. */
  private parse(type: AnalysisType, text: string): { output: any; summary_text: string | null; sentiment: string | null; quality_score: number | null } {
    let obj: any = {};
    try {
      const m = text.match(/\{[\s\S]*\}/);
      obj = m ? JSON.parse(m[0]) : {};
    } catch { obj = {}; }

    if (type === 'summary') {
      const summary = String(obj.summary ?? text ?? '').trim().slice(0, 4000);
      return {
        output: { summary, key_points: Array.isArray(obj.key_points) ? obj.key_points.slice(0, 12) : [], next_steps: Array.isArray(obj.next_steps) ? obj.next_steps.slice(0, 12) : [] },
        summary_text: summary || null, sentiment: null, quality_score: null,
      };
    }
    if (type === 'sentiment') {
      const s = ['positive', 'neutral', 'negative'].includes(String(obj.sentiment)) ? String(obj.sentiment) : 'neutral';
      const rationale = String(obj.rationale ?? '').trim().slice(0, 1000);
      const score = Number.isFinite(Number(obj.score)) ? Number(obj.score) : null;
      return {
        output: { sentiment: s, score, rationale },
        summary_text: rationale || null, sentiment: s, quality_score: null,
      };
    }
    // quality
    const criteria = obj.criteria && typeof obj.criteria === 'object' ? obj.criteria : {};
    let total = Number(obj.total);
    if (!Number.isFinite(total)) {
      total = Object.values(criteria).reduce((a: number, v) => a + (Number(v) || 0), 0);
    }
    total = Math.max(0, Math.min(100, Math.round(total)));
    const notes = String(obj.notes ?? '').trim().slice(0, 2000);
    return {
      output: { criteria, total, notes },
      summary_text: notes || null, sentiment: null, quality_score: total,
    };
  }

  private async persist(a: any) {
    const orgId = await this.orgId();
    const row = await this.db.one<any>(
      `INSERT INTO ai_analysis
         (org_id, subject_type, subject_id, subject_label, analysis_type, input_source, input_ref, input_text,
          provider, model, status, output, summary_text, sentiment, quality_score, tokens, error,
          branch_id, vertical_id, pipeline_id, campaign_id, team_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [orgId, a.subjectType, a.subjectId, a.subjectLabel, a.type, a.inputSource,
        a.subjectLabel ? `${a.subjectType}${a.subjectId ? '#' + a.subjectId : ''}` : null, a.inputText,
        a.provider, a.model, a.status, JSON.stringify(a.output ?? {}), a.summary_text, a.sentiment,
        a.quality_score, a.tokens, a.error,
        a.sc.branch_id, a.sc.vertical_id, a.sc.pipeline_id, a.sc.campaign_id, a.sc.team_id, a.sc.owner_id, a.me.id],
    );
    return this.present(row, true);
  }

  /* --------------------------------------------------------------- list */

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = ['a.deleted_at IS NULL', this.scopeWhere(scope, params)];
    if (f.analysis_type) { params.push(String(f.analysis_type)); where.push(`a.analysis_type = $${params.length}`); }
    if (f.subject_type)  { params.push(String(f.subject_type));  where.push(`a.subject_type = $${params.length}`); }
    if (f.sentiment)     { params.push(String(f.sentiment));     where.push(`a.sentiment = $${params.length}`); }
    if (f.provider)      { params.push(String(f.provider));      where.push(`a.provider = $${params.length}`); }
    if (f.branch_id)     { params.push(Number(f.branch_id));     where.push(`a.branch_id = $${params.length}::bigint`); }
    if (f.vertical_id)   { params.push(Number(f.vertical_id));   where.push(`a.vertical_id = $${params.length}::bigint`); }
    if (f.owner_id)      { params.push(Number(f.owner_id));      where.push(`a.owner_id = $${params.length}::bigint`); }
    if (f.q)             { params.push(`%${f.q}%`);              where.push(`(a.subject_label ILIKE $${params.length} OR a.summary_text ILIKE $${params.length})`); }
    if (f.created_from)  { params.push(String(f.created_from));  where.push(`a.created_at >= $${params.length}::timestamptz`); }
    if (f.created_to)    { params.push(String(f.created_to));    where.push(`a.created_at < ($${params.length}::date + 1)`); }
    params.push(Math.min(Number(f.limit ?? 300), 500));
    const rows = await this.db.query<any>(
      `SELECT a.*, b.name AS branch_name, v.name AS vertical_name, u.name AS owner_name, cu.name AS created_by_name
         FROM ai_analysis a
         LEFT JOIN branch b   ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u   ON u.id = a.owner_id
         LEFT JOIN "user" cu  ON cu.id = a.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`, params);
    return rows.map((r) => this.present(r));
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const sw = this.scopeWhere(scope, params);
    const row = await this.db.one<any>(
      `SELECT a.*, b.name AS branch_name, v.name AS vertical_name, u.name AS owner_name, cu.name AS created_by_name
         FROM ai_analysis a
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u ON u.id = a.owner_id
         LEFT JOIN "user" cu ON cu.id = a.created_by
        WHERE a.id = $1 AND a.deleted_at IS NULL AND ${sw}`, params);
    if (!row) throw new NotFoundException('analysis not found');
    return this.present(row, true);
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const sw = this.scopeWhere(scope, params);
    const agg = await this.db.one<any>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE analysis_type = 'summary')::int AS summaries,
              COUNT(*) FILTER (WHERE analysis_type = 'sentiment')::int AS sentiments,
              COUNT(*) FILTER (WHERE analysis_type = 'quality')::int AS quality,
              COUNT(*) FILTER (WHERE analysis_type = 'transcription')::int AS transcripts,
              COUNT(*) FILTER (WHERE sentiment = 'positive')::int AS positive,
              COUNT(*) FILTER (WHERE sentiment = 'negative')::int AS negative,
              ROUND(AVG(quality_score))::int AS avg_quality
         FROM ai_analysis a WHERE a.deleted_at IS NULL AND ${sw}`, params);
    const recentParams: unknown[] = [];
    const rsw = this.scopeWhere(scope, recentParams);
    const recent = await this.db.query<any>(
      `SELECT a.id, a.subject_label, a.analysis_type, a.sentiment, a.quality_score, a.summary_text, a.created_at
         FROM ai_analysis a WHERE a.deleted_at IS NULL AND ${rsw}
        ORDER BY a.created_at DESC LIMIT 6`, recentParams);
    const status = await this.status();
    return { configured: status.configured, providers: status.providers, counts: agg ?? {}, recent };
  }

  /* --------------------------------------------------------- soft delete */

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.scopeWhere(scope, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT a.id FROM ai_analysis a WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(
      `UPDATE ai_analysis SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'ai_analysis', label: 'AI analysis', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: Me, scope: ResolvedScope) {
    const req = this.idList(raw);
    const ok = await this.inScopeIds(req, scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: req.length - deleted };
  }

  /* ------------------------------------------------------------- present */

  present(r: any, full = false) {
    const out = {
      id: Number(r.id),
      subject_type: r.subject_type,
      subject_id: r.subject_id == null ? null : Number(r.subject_id),
      subject_label: r.subject_label ?? null,
      analysis_type: r.analysis_type,
      input_source: r.input_source,
      provider: r.provider ?? null,
      model: r.model ?? null,
      status: r.status,
      summary_text: r.summary_text ?? null,
      sentiment: r.sentiment ?? null,
      quality_score: r.quality_score == null ? null : Number(r.quality_score),
      tokens: r.tokens == null ? null : Number(r.tokens),
      branch_name: r.branch_name ?? null,
      vertical_name: r.vertical_name ?? null,
      owner_name: r.owner_name ?? null,
      created_by_name: r.created_by_name ?? null,
      created_at: r.created_at,
    };
    if (full) return { ...out, output: r.output ?? {}, input_text: r.input_text ?? null, error: r.error ?? null };
    return out;
  }
}
