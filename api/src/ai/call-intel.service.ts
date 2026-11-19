import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { StorageService } from '../storage/storage.service';
import { staffEvents } from '../notifications/staff-events.service';
import { LlmAdapterService } from './llm-adapter.service';
import { SttAdapterService } from './stt-adapter.service';

/**
 * CALL INTELLIGENCE — client 12 Nov 2026 ("AI Insights … Communication Intelligence: complete
 * this module").
 *
 *   recording (phone app) ──► call_transcript (speech-to-text, the provider the client chose)
 *                         ──► call_insight (one AI read: summary, key points, next steps,
 *                             sentiment, 0–100 quality on the 5-criteria rubric, objections,
 *                             intent, interest, follow-up suggestion) ──► flags + alerts
 *
 * A background tick picks up new recordings; a transcript can also be pasted against a lead
 * (the fallback while recordings are not yet arriving). Every list is RBAC-scoped inside the SQL
 * on the call's counsellor / branch / vertical, like the Calls screen.
 */
export const CI_SCOPE = (a: string): ScopeColumnMap => ({
  owner: `${a}.user_id`, team: `${a}.team_id`, branch: `${a}.branch_id`, vertical: `${a}.vertical_id`, pipeline: `${a}.pipeline_id`, campaign: `${a}.campaign_id`,
});
export interface CiSettings { auto_transcribe: boolean; auto_analyse: boolean; language: string; min_duration_s: number; monthly_minutes_limit: number; flag_quality_below: number }
const DEFAULTS: CiSettings = { auto_transcribe: true, auto_analyse: true, language: 'auto', min_duration_s: 15, monthly_minutes_limit: 0, flag_quality_below: 50 };
export const INTENTS = ['enrol_now', 'considering', 'price_shopping', 'information_only', 'callback_requested', 'not_interested', 'wrong_number', 'other'] as const;
const MIME_BY_EXT: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr', '3gp': 'audio/3gpp', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', mp4: 'audio/mp4' };

/** Parse the model's JSON defensively and normalise every field (never trust it blindly). */
export function parseInsight(text: string, flagBelow = 50) {
  let o: any = {};
  try { const m = String(text ?? '').match(/\{[\s\S]*\}/); o = m ? JSON.parse(m[0]) : {}; } catch { o = {}; }
  const arr = (v: unknown, n = 12) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n) : []);
  const crit = o.criteria && typeof o.criteria === 'object' ? o.criteria : {};
  const criteria: Record<string, number> = {};
  for (const k of ['greeting', 'needs_identified', 'solution_offered', 'next_step_set', 'politeness']) criteria[k] = Math.max(0, Math.min(20, Math.round(Number(crit[k]) || 0)));
  let total = Number(o.quality_score ?? o.total);
  if (!Number.isFinite(total)) total = Object.values(criteria).reduce((a, b) => a + b, 0);
  total = Math.max(0, Math.min(100, Math.round(total)));
  const sentiment = ['positive', 'neutral', 'negative'].includes(String(o.sentiment)) ? String(o.sentiment) : 'neutral';
  const score = Number.isFinite(Number(o.sentiment_score)) ? Math.max(-1, Math.min(1, Number(o.sentiment_score))) : null;
  const objections = arr(o.objections, 8);
  const handled = o.objections_handled === true || o.objections_handled === 'true';
  const intent = (INTENTS as readonly string[]).includes(String(o.intent)) ? String(o.intent) : 'other';
  const interest = ['high', 'medium', 'low'].includes(String(o.interest_level)) ? String(o.interest_level) : null;
  const reasons: string[] = [];
  if (total < flagBelow) reasons.push(`Quality ${total}/100 is below ${flagBelow}`);
  if (sentiment === 'negative') reasons.push('Negative sentiment');
  if (objections.length && !handled) reasons.push('Objection not handled');
  return {
    summary: String(o.summary ?? '').trim().slice(0, 4000) || null,
    key_points: arr(o.key_points), next_steps: arr(o.next_steps), sentiment, sentiment_score: score,
    quality_score: total, criteria, coaching: String(o.coaching ?? '').trim().slice(0, 1500) || null,
    objections, intent, interest_level: interest, follow_up: String(o.follow_up_suggestion ?? '').trim().slice(0, 500) || null,
    flagged: reasons.length > 0, flag_reasons: reasons,
  };
}

@Injectable()
export class CallIntelService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CallIntelWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  static readonly TICK_MS = 60_000;

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly llm: LlmAdapterService,
    private readonly stt: SttAdapterService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.CALL_INTEL_WORKER === '0' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, CallIntelService.TICK_MS);
    this.timer.unref?.();
    this.log.log('call intelligence worker started (recordings → transcripts → insights)');
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  /* ---------------------------------------------------------------- settings */

  async settings(): Promise<CiSettings> {
    const r = await this.db.one<{ value: any }>(`SELECT value FROM app_setting WHERE key = 'transcription_settings'`).catch(() => null);
    return { ...DEFAULTS, ...(r?.value ?? {}) };
  }

  async saveSettings(dto: any) {
    const cur = await this.settings();
    const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
    const next: CiSettings = {
      auto_transcribe: typeof dto?.auto_transcribe === 'boolean' ? dto.auto_transcribe : cur.auto_transcribe,
      auto_analyse: typeof dto?.auto_analyse === 'boolean' ? dto.auto_analyse : cur.auto_analyse,
      language: ['auto', 'hi', 'en', 'pa', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml'].includes(String(dto?.language)) ? String(dto.language) : cur.language,
      min_duration_s: num(dto?.min_duration_s, 0, 600, cur.min_duration_s),
      monthly_minutes_limit: num(dto?.monthly_minutes_limit, 0, 1_000_000, cur.monthly_minutes_limit),
      flag_quality_below: num(dto?.flag_quality_below, 0, 100, cur.flag_quality_below),
    };
    await this.db.query(`INSERT INTO app_setting (key, value) VALUES ('transcription_settings', $1::jsonb)
                          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
    return next;
  }

  /** What is configured and what is flowing — the banner on every Communication Intelligence screen. */
  async status(scope: ResolvedScope) {
    const sttCfg = await this.stt.active().catch(() => null);
    const llmOk = await this.llm.anyConfigured().catch(() => false);
    const p: unknown[] = []; const w = this.resolver.buildScopeWhere(scope, CI_SCOPE('t'), p);
    const t = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'processing') AS processing,
              count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'failed') AS failed,
              count(*) FILTER (WHERE status = 'skipped') AS skipped,
              COALESCE(round(sum(duration_s) FILTER (WHERE status = 'done' AND processed_at >= date_trunc('month', now())) / 60.0), 0) AS minutes_month
         FROM call_transcript t WHERE t.deleted_at IS NULL AND ${w}`, p);
    const rec = await this.db.one<any>(`SELECT count(*) AS n, count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS n30 FROM lead_recording`);
    const calls = await this.db.one<any>(`SELECT count(*) AS n FROM call_event WHERE created_at >= now() - interval '30 days' AND event <> 'dial_requested'`);
    const p2: unknown[] = []; const w2 = this.resolver.buildScopeWhere(scope, CI_SCOPE('i'), p2);
    const ins = await this.db.one<any>(`SELECT count(*) AS n, count(*) FILTER (WHERE flagged AND reviewed_at IS NULL) AS open_flags FROM call_insight i WHERE ${w2}`, p2);
    const s = await this.settings();
    return {
      stt: { configured: !!sttCfg, provider: sttCfg?.provider ?? null },
      llm: { configured: llmOk },
      settings: s,
      recordings: Number(rec?.n ?? 0), recordings_30d: Number(rec?.n30 ?? 0), calls_30d: Number(calls?.n ?? 0),
      transcripts: { pending: Number(t?.pending ?? 0), processing: Number(t?.processing ?? 0), done: Number(t?.done ?? 0), failed: Number(t?.failed ?? 0), skipped: Number(t?.skipped ?? 0) },
      minutes_this_month: Number(t?.minutes_month ?? 0),
      insights: Number(ins?.n ?? 0), open_flags: Number(ins?.open_flags ?? 0),
    };
  }

  /* --------------------------------------------------------------- the worker */

  async tick(): Promise<{ enqueued: number; transcribed: number; analysed: number }> {
    if (this.running) return { enqueued: 0, transcribed: 0, analysed: 0 };
    this.running = true;
    const out = { enqueued: 0, transcribed: 0, analysed: 0 };
    try {
      const s = await this.settings();
      const sttOn = !!(await this.stt.active().catch(() => null));
      if (s.auto_transcribe && sttOn) out.enqueued = await this.enqueueNew(s.min_duration_s);
      if (sttOn) {
        const under = s.monthly_minutes_limit <= 0 || (await this.minutesThisMonth()) < s.monthly_minutes_limit;
        if (under) {
          const ids = await this.claim(3);
          for (const id of ids) if (await this.transcribeOne(id, s)) out.transcribed++;
        }
      }
      if (s.auto_analyse && (await this.llm.anyConfigured().catch(() => false))) {
        const todo = await this.db.query<{ id: string }>(
          `SELECT t.id FROM call_transcript t WHERE t.status = 'done' AND t.deleted_at IS NULL AND COALESCE(t.transcript, '') <> ''
              AND NOT EXISTS (SELECT 1 FROM call_insight i WHERE i.transcript_id = t.id) ORDER BY t.processed_at LIMIT 3`);
        for (const r of todo) { try { await this.analyse(Number(r.id)); out.analysed++; } catch (e) { this.log.warn(`analyse ${r.id}: ${(e as Error).message}`); } }
      }
    } catch (e) {
      this.log.error(`tick failed: ${(e as Error).message}`);
    } finally { this.running = false; }
    return out;
  }

  private async minutesThisMonth(): Promise<number> {
    const r = await this.db.one<any>(`SELECT COALESCE(sum(duration_s), 0) / 60.0 AS m FROM call_transcript WHERE status = 'done' AND processed_at >= date_trunc('month', now())`);
    return Number(r?.m ?? 0);
  }

  /** New recordings (long enough, with audio) get a pending transcript row. */
  private async enqueueNew(minSeconds: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO call_transcript (org_id, recording_id, call_event_id, lead_id, user_id, branch_id, vertical_id, team_id, pipeline_id, campaign_id, call_at, duration_s, source)
       SELECT r.org_id, r.id, ce.id, COALESCE(r.lead_id, ce.lead_id), COALESCE(r.user_id, ce.user_id), l.branch_id, l.vertical_id, l.team_id, l.pipeline_id, l.campaign_id,
              COALESCE(ce.call_start_at, r.file_mtime, r.created_at), COALESCE(r.duration_s, ce.duration_s), 'auto'
         FROM lead_recording r
         LEFT JOIN LATERAL (SELECT * FROM call_event c WHERE c.recording_id = r.id ORDER BY c.id LIMIT 1) ce ON TRUE
         LEFT JOIN lead l ON l.id = COALESCE(r.lead_id, ce.lead_id)
        WHERE (r.r2_key IS NOT NULL OR r.content IS NOT NULL)
          AND COALESCE(r.duration_s, ce.duration_s, 9999) >= $1
          AND NOT EXISTS (SELECT 1 FROM call_transcript t WHERE t.recording_id = r.id)
        ORDER BY r.id DESC LIMIT 50
       ON CONFLICT (recording_id) DO NOTHING RETURNING id`, [minSeconds]);
    return rows.length;
  }

  private async claim(n: number): Promise<number[]> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE call_transcript SET status = 'processing', attempts = attempts + 1, updated_at = now()
        WHERE id IN (SELECT id FROM call_transcript WHERE status = 'pending' AND recording_id IS NOT NULL AND deleted_at IS NULL
                       AND next_try_at <= now() ORDER BY next_try_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id`, [n]);
    return rows.map((r) => Number(r.id));
  }

  private async audioOf(recordingId: number): Promise<{ buf: Buffer; mime: string; name: string } | null> {
    const r = await this.db.one<any>(`SELECT r2_key, content, mime, file_name FROM lead_recording WHERE id = $1`, [recordingId]);
    if (!r) return null;
    const name = String(r.file_name || `call-${recordingId}.mp3`);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = String(r.mime || MIME_BY_EXT[ext] || 'audio/mpeg');
    if (r.content) return { buf: Buffer.from(r.content), mime, name };
    if (r.r2_key && this.storage) { const o = await this.storage.getObject(String(r.r2_key)); return { buf: o.body, mime, name }; }
    return null;
  }

  async transcribeOne(id: number, s?: CiSettings): Promise<boolean> {
    const set = s ?? await this.settings();
    const t = await this.db.one<any>(`SELECT * FROM call_transcript WHERE id = $1`, [id]);
    if (!t || !t.recording_id) return false;
    try {
      const a = await this.audioOf(Number(t.recording_id));
      if (!a) throw new Error('The recording file is missing.');
      const out = await this.stt.transcribe(a.buf, a.mime, a.name, set.language);
      if (!out.text) {
        await this.db.query(`UPDATE call_transcript SET status = 'skipped', error = 'No speech found in the recording', provider = $2, model = $3, processed_at = now(), updated_at = now() WHERE id = $1`,
          [id, out.provider, out.model]);
        return false;
      }
      await this.db.query(
        `UPDATE call_transcript SET status = 'done', transcript = $2, provider = $3, model = $4, language = $5, error = NULL, processed_at = now(), updated_at = now() WHERE id = $1`,
        [id, out.text.slice(0, 100_000), out.provider, out.model, out.language]);
      return true;
    } catch (e: any) {
      const notConfigured = !!e?.notConfigured;
      const attempts = Number(t.attempts ?? 1);
      const final = notConfigured || attempts >= 3;
      await this.db.query(
        `UPDATE call_transcript SET status = $2, error = $3, next_try_at = now() + ($4 || ' minutes')::interval, updated_at = now() WHERE id = $1`,
        [id, final ? 'failed' : 'pending', String(e?.message ?? e).slice(0, 400), String(10 * attempts)]);
      return false;
    }
  }

  /* --------------------------------------------------------------- analysis */

  /** One AI read of a transcript → call_insight (re-running replaces it). Flags + alerts. */
  async analyse(transcriptId: number) {
    const t = await this.db.one<any>(
      `SELECT t.*, l.full_name AS lead_name, c.name AS course_name, u.name AS user_name
         FROM call_transcript t LEFT JOIN lead l ON l.id = t.lead_id LEFT JOIN m_course c ON c.id = l.course_id LEFT JOIN "user" u ON u.id = t.user_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [transcriptId]);
    if (!t) throw new NotFoundException('Transcript not found');
    if (!String(t.transcript ?? '').trim()) throw new BadRequestException('This call has no transcript yet.');
    const s = await this.settings();
    // the AI Settings monthly run limit counts call analyses too
    const aiRow = await this.db.one<{ value: any }>(`SELECT value FROM app_setting WHERE key = 'ai_settings'`).catch(() => null);
    const limit = Number(aiRow?.value?.monthly_run_limit ?? 0) || 0;
    if (limit > 0) {
      const used = await this.db.one<any>(`SELECT (SELECT count(*) FROM ai_analysis WHERE deleted_at IS NULL AND created_at >= date_trunc('month', now()))
                                               + (SELECT count(*) FROM call_insight WHERE created_at >= date_trunc('month', now())) AS n`);
      if (Number(used?.n ?? 0) >= limit) throw new BadRequestException(`This month's AI run limit (${limit}) is reached — raise it in AI Settings.`);
    }
    const system = 'You review sales calls of an education-counselling institute in India (language courses, IT courses). Calls may mix Hindi and English. Reply ONLY with strict JSON.';
    const user = `Counsellor: ${t.user_name ?? 'counsellor'}. Prospect: ${t.lead_name ?? 'prospect'}${t.course_name ? `, interested in ${t.course_name}` : ''}.
Analyse the call transcript and return JSON with exactly these keys:
"summary" (3-5 sentences in English), "key_points" (array of short strings), "next_steps" (array of short strings),
"sentiment" ("positive"|"neutral"|"negative" — the prospect's), "sentiment_score" (-1 to 1),
"criteria" (object: "greeting","needs_identified","solution_offered","next_step_set","politeness", each 0-20),
"quality_score" (0-100, the sum), "coaching" (one or two short coaching sentences for the counsellor),
"objections" (array of the prospect's objections as short phrases, e.g. "fees too high"), "objections_handled" (true/false),
"intent" (one of ${INTENTS.join(', ')}), "interest_level" ("high"|"medium"|"low"), "follow_up_suggestion" (one sentence).

---
${String(t.transcript).slice(0, 18_000)}`;
    const r = await this.llm.complete({ system, user, json: true, maxTokens: 1200 });
    const x = parseInsight(r.text, s.flag_quality_below);
    const row = await this.db.one<{ id: string; was: boolean }>(
      `INSERT INTO call_insight (org_id, transcript_id, lead_id, user_id, branch_id, vertical_id, team_id, pipeline_id, campaign_id, call_at,
                                 summary, key_points, next_steps, sentiment, sentiment_score, quality_score, criteria, coaching, objections, intent,
                                 interest_level, follow_up, flagged, flag_reasons, provider, model, tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17::jsonb,$18,$19::jsonb,$20,$21,$22,$23,$24::jsonb,$25,$26,$27)
       ON CONFLICT (transcript_id) DO UPDATE SET summary = EXCLUDED.summary, key_points = EXCLUDED.key_points, next_steps = EXCLUDED.next_steps,
         sentiment = EXCLUDED.sentiment, sentiment_score = EXCLUDED.sentiment_score, quality_score = EXCLUDED.quality_score, criteria = EXCLUDED.criteria,
         coaching = EXCLUDED.coaching, objections = EXCLUDED.objections, intent = EXCLUDED.intent, interest_level = EXCLUDED.interest_level,
         follow_up = EXCLUDED.follow_up, flagged = EXCLUDED.flagged, flag_reasons = EXCLUDED.flag_reasons, provider = EXCLUDED.provider,
         model = EXCLUDED.model, tokens = EXCLUDED.tokens, updated_at = now()
       RETURNING id, (xmax <> 0) AS was`,
      [t.org_id, t.id, t.lead_id, t.user_id, t.branch_id, t.vertical_id, t.team_id, t.pipeline_id, t.campaign_id, t.call_at ?? t.created_at,
        x.summary, JSON.stringify(x.key_points), JSON.stringify(x.next_steps), x.sentiment, x.sentiment_score, x.quality_score, JSON.stringify(x.criteria),
        x.coaching, JSON.stringify(x.objections), x.intent, x.interest_level, x.follow_up, x.flagged, JSON.stringify(x.flag_reasons),
        r.provider, r.model, r.tokens]);
    const insightId = Number(row!.id);
    if (!row!.was && t.lead_id && x.summary) {
      await this.db.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note) VALUES ($1,$2,$3,$4,'call_log',$5,$6)`,
        [t.lead_id, t.org_id, t.branch_id, t.user_id, JSON.stringify({ call_insight_id: insightId, quality: x.quality_score, sentiment: x.sentiment }),
          `AI call summary: ${x.summary}`.slice(0, 2000)]).catch(() => undefined);
    }
    const ev = staffEvents();
    if (ev && x.flagged && !row!.was) {
      await ev.emit('call_flagged', { title: `Call flagged — ${t.lead_name ?? 'a call'}`, body: x.flag_reasons.join(' · '), owner_id: t.user_id,
        branch_id: t.branch_id, vertical_id: t.vertical_id, lead_id: t.lead_id, dedupe: `ci:${insightId}` }).catch(() => undefined);
    }
    await this.keywordAlerts(t).catch(() => undefined);
    return { id: insightId, ...x };
  }

  /** Tracked keywords marked "alert" that were said on the call → the counsellor + managers. */
  private async keywordAlerts(t: any) {
    const kws = await this.db.query<any>(`SELECT id, keyword FROM tracked_keyword WHERE deleted_at IS NULL AND is_active AND alert`);
    const text = String(t.transcript ?? '').toLowerCase();
    const ev = staffEvents();
    for (const k of kws) {
      const kw = String(k.keyword).toLowerCase().trim();
      if (!kw || !text.includes(kw)) continue;
      const at = text.indexOf(kw);
      const snippet = String(t.transcript).slice(Math.max(0, at - 60), at + kw.length + 60).replace(/\s+/g, ' ');
      await ev?.emit('call_keyword', { title: `"${k.keyword}" said on a call — ${t.lead_name ?? ''}`.trim(), body: `…${snippet}…`, owner_id: t.user_id,
        branch_id: t.branch_id, vertical_id: t.vertical_id, lead_id: t.lead_id, dedupe: `kw:${k.id}:${t.id}` });
    }
  }

  /* --------------------------------------------------------- manual inputs */

  /** Paste a transcript against a lead (or a logged call) — the path that works before recordings flow. */
  async paste(dto: any, me: { id: number }, scope: ResolvedScope) {
    const text = String(dto?.text ?? '').trim();
    if (text.length < 20) throw new BadRequestException('Paste the conversation (at least a couple of lines).');
    const leadId = dto?.lead_id ? Number(dto.lead_id) : null;
    let lead: any = null;
    if (leadId) {
      const p: unknown[] = [leadId];
      const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p);
      lead = await this.db.one<any>(`SELECT l.* FROM lead l WHERE l.id = $1 AND l.deleted_at IS NULL AND ${w}`, p);
      if (!lead) throw new NotFoundException('Lead not found (or outside your access)');
    }
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO call_transcript (org_id, lead_id, user_id, branch_id, vertical_id, team_id, pipeline_id, campaign_id, call_at, status, source,
                                    transcript, provider, processed_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), 'done', 'paste', $9, 'pasted', now(), $10) RETURNING id`,
      [await this.orgId(), leadId, lead?.owner_id ?? me.id, lead?.branch_id ?? null, lead?.vertical_id ?? null, lead?.team_id ?? null,
        lead?.pipeline_id ?? null, lead?.campaign_id ?? null, text.slice(0, 100_000), me.id]);
    const id = Number(row!.id);
    try { return { transcript_id: id, insight: await this.analyse(id) }; }
    catch (e: any) { if (e?.notConfigured) return { transcript_id: id, insight: null, message: 'Saved. AI is not configured yet, so it was not analysed.' }; throw e; }
  }

  private async transcriptScoped(id: number, scope: ResolvedScope) {
    const p: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, CI_SCOPE('t'), p);
    const t = await this.db.one<any>(`SELECT t.* FROM call_transcript t WHERE t.id = $1 AND t.deleted_at IS NULL AND ${w}`, p);
    if (!t) throw new NotFoundException('Call not found (or outside your access)');
    return t;
  }

  async retry(id: number, scope: ResolvedScope) {
    const t = await this.transcriptScoped(id, scope);
    if (!t.recording_id) throw new BadRequestException('Only a recording can be transcribed again.');
    await this.db.query(`UPDATE call_transcript SET status = 'pending', attempts = 0, error = NULL, next_try_at = now(), updated_at = now() WHERE id = $1`, [id]);
    return { id, queued: true };
  }

  async reanalyse(id: number, scope: ResolvedScope) {
    await this.transcriptScoped(id, scope);
    return this.analyse(id);
  }

  /** Queue one recording by hand (e.g. shorter than the minimum, or before auto is switched on). */
  async enqueueRecording(recordingId: number, me: { id: number }) {
    const r = await this.db.one<any>(`SELECT id FROM lead_recording WHERE id = $1`, [recordingId]);
    if (!r) throw new NotFoundException('Recording not found');
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO call_transcript (org_id, recording_id, call_event_id, lead_id, user_id, branch_id, vertical_id, team_id, pipeline_id, campaign_id, call_at, duration_s, source, created_by)
       SELECT r.org_id, r.id, ce.id, COALESCE(r.lead_id, ce.lead_id), COALESCE(r.user_id, ce.user_id), l.branch_id, l.vertical_id, l.team_id, l.pipeline_id, l.campaign_id,
              COALESCE(ce.call_start_at, r.created_at), COALESCE(r.duration_s, ce.duration_s), 'manual', $2
         FROM lead_recording r LEFT JOIN LATERAL (SELECT * FROM call_event c WHERE c.recording_id = r.id ORDER BY c.id LIMIT 1) ce ON TRUE
         LEFT JOIN lead l ON l.id = COALESCE(r.lead_id, ce.lead_id)
        WHERE r.id = $1
       ON CONFLICT (recording_id) DO UPDATE SET status = 'pending', attempts = 0, next_try_at = now(), updated_at = now()
       RETURNING id`, [recordingId, me.id]);
    return { id: Number(row!.id), queued: true };
  }

  /* ----------------------------------------------------------------- reads */

  async queue(scope: ResolvedScope, f: any = {}) {
    const p: unknown[] = [];
    const where = ['t.deleted_at IS NULL', this.resolver.buildScopeWhere(scope, CI_SCOPE('t'), p)];
    if (f?.status) { p.push(String(f.status).split(',')); where.push(`t.status = ANY($${p.length}::text[])`); }
    return this.db.query<any>(
      `SELECT t.id, t.recording_id, t.lead_id, t.user_id, t.status, t.source, t.provider, t.language, t.duration_s, t.error, t.attempts,
              t.call_at, t.created_at, t.processed_at, left(t.transcript, 160) AS preview, l.full_name AS lead_name, u.name AS user_name,
              (SELECT i.id FROM call_insight i WHERE i.transcript_id = t.id) AS insight_id
         FROM call_transcript t LEFT JOIN lead l ON l.id = t.lead_id LEFT JOIN "user" u ON u.id = t.user_id
        WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 300`, p);
  }

  /** Recordings that have no transcript yet (to queue by hand). */
  async untranscribed(scope: ResolvedScope) {
    const p: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, { owner: 'r.user_id', team: 'l.team_id', branch: 'l.branch_id', vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id' }, p);
    return this.db.query<any>(
      `SELECT r.id, r.file_name, r.duration_s, r.created_at, l.full_name AS lead_name, u.name AS user_name
         FROM lead_recording r LEFT JOIN lead l ON l.id = r.lead_id LEFT JOIN "user" u ON u.id = r.user_id
        WHERE NOT EXISTS (SELECT 1 FROM call_transcript t WHERE t.recording_id = r.id) AND ${w}
        ORDER BY r.id DESC LIMIT 100`, p);
  }

  private insightWhere(scope: ResolvedScope, f: any, p: unknown[]) {
    const where = [this.resolver.buildScopeWhere(scope, CI_SCOPE('i'), p)];
    const nums = (v: unknown) => String(v ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (nums(f?.user_ids).length) { p.push(nums(f.user_ids)); where.push(`i.user_id = ANY($${p.length}::bigint[])`); }
    if (f?.sentiment) { p.push(String(f.sentiment).split(',')); where.push(`i.sentiment = ANY($${p.length}::text[])`); }
    if (f?.intent) { p.push(String(f.intent).split(',')); where.push(`i.intent = ANY($${p.length}::text[])`); }
    if (f?.min_quality !== undefined && f.min_quality !== '') { p.push(Number(f.min_quality)); where.push(`i.quality_score >= $${p.length}`); }
    if (f?.max_quality !== undefined && f.max_quality !== '') { p.push(Number(f.max_quality)); where.push(`i.quality_score <= $${p.length}`); }
    if (f?.flagged === 'true') where.push('i.flagged');
    if (f?.flagged === 'open') where.push('i.flagged AND i.reviewed_at IS NULL');
    if (f?.from) { p.push(f.from); where.push(`i.call_at >= $${p.length}::date`); }
    if (f?.to) { p.push(f.to); where.push(`i.call_at < ($${p.length}::date + 1)`); }
    const q = String(f?.q ?? '').trim();
    if (q) { p.push(`%${q}%`); where.push(`(i.summary ILIKE $${p.length} OR l.full_name ILIKE $${p.length} OR EXISTS (SELECT 1 FROM call_transcript t2 WHERE t2.id = i.transcript_id AND t2.transcript ILIKE $${p.length}))`); }
    return where;
  }

  async insights(scope: ResolvedScope, f: any = {}) {
    const p: unknown[] = [];
    const where = this.insightWhere(scope, f, p);
    return this.db.query<any>(
      `SELECT i.id, i.transcript_id, i.lead_id, i.user_id, i.call_at, i.summary, i.sentiment, i.sentiment_score, i.quality_score, i.objections,
              i.intent, i.interest_level, i.follow_up, i.flagged, i.flag_reasons, i.reviewed_at, i.review_note,
              l.full_name AS lead_name, u.name AS user_name, rv.name AS reviewed_by_name, t.duration_s, t.recording_id, t.source
         FROM call_insight i JOIN call_transcript t ON t.id = i.transcript_id
         LEFT JOIN lead l ON l.id = i.lead_id LEFT JOIN "user" u ON u.id = i.user_id LEFT JOIN "user" rv ON rv.id = i.reviewed_by
        WHERE ${where.join(' AND ')} ORDER BY i.call_at DESC NULLS LAST, i.id DESC LIMIT 300`, p);
  }

  async insight(id: number, scope: ResolvedScope) {
    const p: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, CI_SCOPE('i'), p);
    const r = await this.db.one<any>(
      `SELECT i.*, t.transcript, t.recording_id, t.duration_s, t.provider AS stt_provider, t.language, t.source,
              l.full_name AS lead_name, l.phone AS lead_phone, u.name AS user_name, rv.name AS reviewed_by_name
         FROM call_insight i JOIN call_transcript t ON t.id = i.transcript_id
         LEFT JOIN lead l ON l.id = i.lead_id LEFT JOIN "user" u ON u.id = i.user_id LEFT JOIN "user" rv ON rv.id = i.reviewed_by
        WHERE i.id = $1 AND ${w}`, p);
    if (!r) throw new NotFoundException('Call insight not found (or outside your access)');
    return r;
  }

  async review(id: number, note: string, me: { id: number }, scope: ResolvedScope) {
    await this.insight(id, scope);
    await this.db.query(`UPDATE call_insight SET reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now() WHERE id = $1`,
      [id, me.id, String(note ?? '').trim().slice(0, 500) || null]);
    return this.insight(id, scope);
  }

  /** Call Ratings — per counsellor. */
  async ratings(scope: ResolvedScope, f: any = {}) {
    const p: unknown[] = [];
    const where = this.insightWhere(scope, f, p);
    const rows = await this.db.query<any>(
      `SELECT i.user_id, u.name AS user_name, count(*) AS calls, round(avg(i.quality_score)) AS avg_quality,
              count(*) FILTER (WHERE i.sentiment = 'positive') AS positive, count(*) FILTER (WHERE i.sentiment = 'negative') AS negative,
              count(*) FILTER (WHERE i.flagged) AS flagged,
              round(avg((i.criteria->>'greeting')::numeric), 1) AS greeting, round(avg((i.criteria->>'needs_identified')::numeric), 1) AS needs_identified,
              round(avg((i.criteria->>'solution_offered')::numeric), 1) AS solution_offered, round(avg((i.criteria->>'next_step_set')::numeric), 1) AS next_step_set,
              round(avg((i.criteria->>'politeness')::numeric), 1) AS politeness
         FROM call_insight i LEFT JOIN lead l ON l.id = i.lead_id LEFT JOIN "user" u ON u.id = i.user_id
        WHERE ${where.join(' AND ')} GROUP BY i.user_id, u.name ORDER BY avg(i.quality_score) DESC NULLS LAST`, p);
    return rows.map((r) => ({ ...r, calls: Number(r.calls), avg_quality: r.avg_quality == null ? null : Number(r.avg_quality), positive: Number(r.positive),
      negative: Number(r.negative), flagged: Number(r.flagged), positive_pct: Number(r.calls) ? Math.round((Number(r.positive) * 100) / Number(r.calls)) : null }));
  }

  /** Overview (AI Insights) + quality trend (Quality Monitoring). */
  async overview(scope: ResolvedScope, f: any = {}) {
    const p: unknown[] = [];
    const where = this.insightWhere(scope, f, p).join(' AND ');
    const k = await this.db.one<any>(
      `SELECT count(*) AS calls, round(avg(i.quality_score)) AS avg_quality,
              count(*) FILTER (WHERE i.sentiment = 'positive') AS positive, count(*) FILTER (WHERE i.sentiment = 'neutral') AS neutral,
              count(*) FILTER (WHERE i.sentiment = 'negative') AS negative, count(*) FILTER (WHERE i.flagged) AS flagged,
              count(*) FILTER (WHERE i.flagged AND i.reviewed_at IS NULL) AS open_flags,
              count(*) FILTER (WHERE i.interest_level = 'high') AS hot
         FROM call_insight i LEFT JOIN lead l ON l.id = i.lead_id WHERE ${where}`, p);
    const trend = await this.db.query<any>(
      `SELECT to_char(i.call_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS label, count(*) AS calls, round(avg(i.quality_score)) AS avg_quality
         FROM call_insight i LEFT JOIN lead l ON l.id = i.lead_id WHERE ${where} AND i.call_at >= now() - interval '60 days'
        GROUP BY 1 ORDER BY 1`, p);
    const objections = await this.db.query<any>(
      `SELECT lower(o) AS label, count(*) AS n FROM call_insight i LEFT JOIN lead l ON l.id = i.lead_id, jsonb_array_elements_text(i.objections) o
        WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, p);
    const intents = await this.db.query<any>(
      `SELECT i.intent AS label, count(*) AS n FROM call_insight i LEFT JOIN lead l ON l.id = i.lead_id WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, p);
    const n = (v: unknown) => Number(v ?? 0);
    return {
      kpis: { calls: n(k?.calls), avg_quality: k?.avg_quality == null ? null : n(k.avg_quality), positive: n(k?.positive), neutral: n(k?.neutral),
        negative: n(k?.negative), flagged: n(k?.flagged), open_flags: n(k?.open_flags), hot: n(k?.hot) },
      trend: trend.map((t) => ({ label: t.label, calls: n(t.calls), avg_quality: n(t.avg_quality) })),
      objections: objections.map((o) => ({ label: o.label, value: n(o.n) })),
      intents: intents.map((o) => ({ label: String(o.label ?? 'other').replace(/_/g, ' '), value: n(o.n) })),
    };
  }
}
