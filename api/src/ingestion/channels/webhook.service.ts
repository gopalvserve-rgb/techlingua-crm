import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import { safeEqual } from '../../common/crypto.util';
import { IngestChannel, IngestOutcome, IngestPayload, IngestValidationError } from '../ingestion.types';
import { LeadIngestionService } from '../lead-ingestion.service';
import { ChannelRow, ChannelService } from './channel.service';
import { RateLimiter } from './rate-limit.util';
import { SheetNotConfiguredError, SheetsClient, HttpFn } from './sheets.client';
import {
  extraFields, formToPayload, googleToPayload, metaToPayload, parseFieldMap, sheetRowToPayload,
  PROVIDERS,
} from './providers';

/** the public route family a provider serves (meta|google|form|push|null). */
const PROVIDER_ENDPOINT = (provider: string): string | null => PROVIDERS[provider]?.endpoint ?? null;

/** Everything the controller knows about the raw HTTP request. */
export interface ReqMeta {
  ip?: string;
  origin?: string;
  signature?: string;
  rawBody?: Buffer;
  /** optional shared secret a push caller sent (X-Webhook-Key header / ?key= / body key) */
  apiKey?: string;
}

/** What a controller turns into an HTTP response. */
export interface WebhookResult {
  http: number;                       // the status code the PROVIDER must receive
  body: unknown;
  event_id?: number | null;
  outcomes?: IngestOutcome[];
}

export class WebhookRejected extends Error {
  constructor(readonly http: number, message: string) { super(message); }
}

const DEFAULT_GRAPH = 'v21.0';
const FORM_DEFAULT_LIMIT = 60;        // submissions / minute / public key
const IP_DIVISOR = 10;                // a single IP gets a tenth of the key's budget
const HARD_WEBHOOK_LIMIT = 600;       // per key per minute for Meta/Google (they burst)

/**
 * THE FOUR CAPTURE CHANNELS.
 *
 * Every one of them ends in the SAME call — `LeadIngestionService.ingest()` with
 * an `IngestContext` carrying the channel, the campaign, the source and an
 * `external_key`. That is what buys, for free and identically on all four:
 *   · idempotency  — the (source_id, dedupe_key) ledger means a REPLAY of a Meta
 *                    delivery, a Google retry, a double-submitted form or a
 *                    re-read sheet row can never create a second lead;
 *   · duplicates   — the NeoDove §4 action configured on the campaign;
 *   · distribution — the campaign's round-robin / conditional / on-demand engine;
 *   · audit        — lead_activity + audit_log rows for a lead nobody typed.
 *
 * Everything above the ingest() call is protocol: verify the sender, log the raw
 * payload durably, map the provider's field names onto CRM fields.
 *
 * RESPONSE-CODE POLICY (deliberate, per provider):
 *   · signature / key INVALID -> 401. We never accept an unsigned payload, and a
 *     401 is a configuration error the client must fix — retrying cannot help.
 *   · signature VALID but ingestion failed -> 200 + a `failed` event row. Meta and
 *     Google retry non-2xx for hours and eventually disable the subscription; the
 *     payload is already stored verbatim in `webhook_event`, so we take the lead
 *     off their hands and surface the failure in our own UI instead.
 */
@Injectable()
export class WebhookService {
  private readonly log = new Logger('WebhookService');
  readonly limiter = new RateLimiter();
  readonly sheets = new SheetsClient();
  /** overridable in tests — the Graph API call */
  http: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

  constructor(
    private readonly db: DatabaseService,
    private readonly channels: ChannelService,
    private readonly ingestion: LeadIngestionService,
  ) {}

  // ================================================================== META ===

  /**
   * GET handshake. Meta calls this once when the Callback URL is saved:
   *   ?hub.mode=subscribe&hub.verify_token=<ours>&hub.challenge=<echo me>
   * Correct token -> 200 with the challenge as the raw body. Anything else -> 403.
   */
  async metaVerify(publicKey: string, q: Record<string, unknown>, meta: ReqMeta): Promise<WebhookResult> {
    const ch = await this.channels.byPublicKey(publicKey, 'meta');
    const mode = String(q['hub.mode'] ?? '');
    const token = String(q['hub.verify_token'] ?? '');
    const challenge = String(q['hub.challenge'] ?? '');

    if (!ch) {
      await this.channels.logEvent({
        provider: 'meta', public_key: publicKey, method: 'GET', ip: meta.ip, raw: q,
        status: 'rejected', reason: 'No Meta channel with that webhook key (deleted or wrong URL)',
      });
      throw new WebhookRejected(404, 'Unknown webhook');
    }
    const expected = this.channels.secretsOf(ch).verify_token ?? '';
    const ok = mode === 'subscribe' && !!expected && safeEqual(token, expected);

    await this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: publicKey, method: 'GET',
      ip: meta.ip, raw: q, signature_ok: ok,
      status: ok ? 'verified' : 'rejected',
      reason: ok
        ? 'Meta webhook verified (GET handshake) — the subscription is live'
        : !expected ? 'Verify token not configured on this channel'
          : mode !== 'subscribe' ? `Unexpected hub.mode "${mode}"`
            : 'hub.verify_token does not match this channel\'s verify token',
    });
    if (!ok) throw new WebhookRejected(403, 'Verification failed');
    return { http: 200, body: challenge };  // MUST be the bare challenge, not JSON
  }

  /** POST — a leadgen change notification, HMAC-signed with the Meta app secret. */
  async metaReceive(publicKey: string, body: any, meta: ReqMeta): Promise<WebhookResult> {
    const t0 = Date.now();
    const ch = await this.channels.byPublicKey(publicKey, 'meta');
    if (!ch) {
      await this.channels.logEvent({
        provider: 'meta', public_key: publicKey, ip: meta.ip, raw: body,
        status: 'rejected', reason: 'No Meta channel with that webhook key',
      });
      throw new WebhookRejected(404, 'Unknown webhook');
    }
    this.assertRate(`meta:${publicKey}`, HARD_WEBHOOK_LIMIT);

    const secrets = this.channels.secretsOf(ch);
    const appSecret = secrets.app_secret ?? '';

    // ---- signature: an unsigned or wrongly-signed payload is NEVER processed ----
    const sig = meta.signature ?? '';
    const raw = meta.rawBody ?? Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const expected = appSecret ? 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') : '';
    const sigOk = !!appSecret && !!sig && safeEqual(sig, expected);

    if (!sigOk) {
      const reason = !appSecret ? 'App secret not configured on this channel — payload rejected'
        : !sig ? 'Missing X-Hub-Signature-256 header — unsigned payloads are never accepted'
          : 'X-Hub-Signature-256 does not match (wrong app secret, or the body was altered)';
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: false, status: 'rejected', reason, duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(401, reason);
    }
    if (!ch.is_active) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: true, status: 'skipped', reason: 'Channel is paused — payload logged, no lead created',
        duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { received: true, ingested: 0 } };
    }

    // ---- payload: entry[].changes[] where field === 'leadgen' -------------------
    const cfgPage = String((ch.config as any)?.page_id ?? '').trim();
    const graph = String((ch.config as any)?.graph_version ?? '').trim() || DEFAULT_GRAPH;
    const fieldMap = parseFieldMap((ch.config as any)?.field_map);
    const changes: any[] = [];
    for (const entry of (body?.entry ?? []) as any[]) {
      for (const c of (entry?.changes ?? []) as any[]) {
        if (String(c?.field ?? '') === 'leadgen' && c?.value) changes.push(c.value);
      }
    }
    if (!changes.length) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: true, status: 'skipped',
        reason: 'Verified, but the payload carried no leadgen change (Meta sends other event types too)',
        duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { received: true, ingested: 0 } };
    }

    const outcomes: IngestOutcome[] = [];
    const notes: string[] = [];
    let firstLead: number | null = null;
    let worst: 'ingested' | 'duplicate' | 'skipped' | 'failed' = 'ingested';

    for (const v of changes) {
      const leadgenId = String(v?.leadgen_id ?? v?.id ?? '');
      try {
        if (cfgPage && v?.page_id && String(v.page_id) !== cfgPage) {
          throw new IngestValidationError(`Payload is for Page ${v.page_id}, this channel is bound to Page ${cfgPage}`);
        }
        // Meta normally sends only the leadgen_id -> fetch the answers from the Graph
        // API. The Lead Ads Testing Tool (and our smoke test) may inline field_data;
        // honour it when present so a test lead needs no extra round trip.
        const fieldData: Array<{ name?: string; values?: unknown[] }> = Array.isArray(v?.field_data)
          ? v.field_data
          : await this.fetchMetaLead(leadgenId, secrets.page_access_token ?? '', graph);

        const payload: IngestPayload = metaToPayload(fieldData, fieldMap);
        payload.external_id = leadgenId || undefined;

        const out = await this.ingestion.ingest(payload, {
          channel: 'webhook' as IngestChannel,
          campaign_id: ch.campaign_id, source_id: ch.source_id,
          actor_id: null, external_key: leadgenId || null, duplicate_policy: 'campaign',
        });
        outcomes.push(out);
        if (out.lead_id && !firstLead) firstLead = out.lead_id;
        notes.push(this.describe(out, leadgenId));
        if (out.status === 'failed') worst = 'failed';
        else if (out.status === 'duplicate' && worst === 'ingested') worst = 'duplicate';
        else if (out.status === 'skipped' && worst === 'ingested') worst = 'skipped';
      } catch (e) {
        worst = 'failed';
        notes.push(`leadgen ${leadgenId || '?'}: ${(e as Error).message}`);
      }
    }

    const eventId = await this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: publicKey, ip: meta.ip,
      raw: body, signature_ok: true,
      status: worst, reason: notes.join(' · ').slice(0, 2000),
      external_key: String(changes[0]?.leadgen_id ?? ''), lead_id: firstLead,
      duration_ms: Date.now() - t0,
    });

    // ALWAYS 200 once the signature checked out: the payload is durably stored, so
    // Meta must not retry (a retry would only re-run an idempotent no-op anyway).
    return { http: 200, body: { received: true, ingested: outcomes.filter((o) => o.status === 'created').length }, event_id: eventId, outcomes };
  }

  /** Graph API: leadgen_id -> the answers the person actually typed. */
  private async fetchMetaLead(leadgenId: string, token: string, graph: string) {
    if (!leadgenId) throw new IngestValidationError('Meta payload carried no leadgen_id');
    if (!token) throw new IngestValidationError('Page access token not configured — cannot fetch the lead from Meta');
    const url = `https://graph.facebook.com/${graph}/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(token)}`;
    const res = await this.http(url);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Meta Graph API returned ${res.status} for leadgen ${leadgenId}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { field_data?: Array<{ name?: string; values?: unknown[] }> };
    if (!json.field_data?.length) throw new IngestValidationError(`Meta returned no field_data for leadgen ${leadgenId}`);
    return json.field_data;
  }

  // ================================================================ GOOGLE ===

  /**
   * Google Ads lead form extension. Google POSTs:
   *   { lead_id, api_version, form_id, campaign_id, gcl_id, is_test, google_key,
   *     user_column_data: [{ column_id, column_name, string_value }, ...] }
   * The shared secret is `google_key`, echoed back in the body — a mismatch is a 401.
   */
  async googleReceive(publicKey: string, body: any, meta: ReqMeta): Promise<WebhookResult> {
    const t0 = Date.now();
    const ch = await this.channels.byPublicKey(publicKey, 'google_ads');
    if (!ch) {
      await this.channels.logEvent({
        provider: 'google_ads', public_key: publicKey, ip: meta.ip, raw: body,
        status: 'rejected', reason: 'No Google Ads channel with that webhook key',
      });
      throw new WebhookRejected(404, 'Unknown webhook');
    }
    this.assertRate(`google:${publicKey}`, HARD_WEBHOOK_LIMIT);

    const expected = this.channels.secretsOf(ch).google_key ?? '';
    const got = String(body?.google_key ?? '');
    const ok = !!expected && !!got && safeEqual(got, expected);
    if (!ok) {
      const reason = !expected ? 'Webhook key not configured on this channel — payload rejected'
        : !got ? 'Payload carried no google_key'
          : 'google_key does not match this channel\'s webhook key';
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'google_ads', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: false, status: 'rejected', reason,
        external_key: String(body?.lead_id ?? ''), duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(401, reason);
    }
    if (!ch.is_active) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'google_ads', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: true, status: 'skipped', reason: 'Channel is paused — payload logged, no lead created',
        external_key: String(body?.lead_id ?? ''), duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { received: true } };
    }

    const leadId = String(body?.lead_id ?? '');
    const isTest = body?.is_test === true || String(body?.is_test ?? '') === 'true';
    const ingestTests = !!(ch.config as any)?.ingest_test_leads;

    if (isTest && !ingestTests) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'google_ads', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: true, status: 'skipped', external_key: leadId,
        reason: 'Google test lead — key verified, no lead created (turn on "Import Google\'s test leads too" to import these)',
        duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { received: true, test: true } };
    }

    const fieldMap = parseFieldMap((ch.config as any)?.field_map);
    const payload = googleToPayload(body?.user_column_data ?? [], fieldMap);
    payload.external_id = leadId || undefined;

    let out: IngestOutcome;
    try {
      out = await this.ingestion.ingest(payload, {
        channel: 'webhook' as IngestChannel,
        campaign_id: ch.campaign_id, source_id: ch.source_id,
        actor_id: null, external_key: leadId || null, duplicate_policy: 'campaign',
      });
    } catch (e) {
      const eid = await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'google_ads', public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: true, status: 'failed', external_key: leadId,
        reason: (e as Error).message, duration_ms: Date.now() - t0,
      });
      // key was valid -> 200 so Google does not disable the webhook; the raw
      // payload is stored and the failure is visible in the channel event log.
      return { http: 200, body: { received: true, error: (e as Error).message }, event_id: eid };
    }

    const eventId = await this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: 'google_ads', public_key: publicKey, ip: meta.ip,
      raw: body, signature_ok: true,
      status: out.status === 'created' ? 'ingested' : out.status === 'failed' ? 'failed' : out.status,
      reason: this.describe(out, leadId), external_key: leadId, lead_id: out.lead_id ?? null,
      duration_ms: Date.now() - t0,
    });
    return { http: 200, body: { received: true }, event_id: eventId, outcomes: [out] };
  }

  // ============================================================== WEBSITE ====

  /** Which origins may post from a browser. Returns the header value, or null. */
  allowedOrigin(ch: ChannelRow, origin?: string): string | null {
    const raw = (ch.config as any)?.allowed_origins;
    const list: string[] = Array.isArray(raw)
      ? raw.map(String)
      : String(raw ?? '').split(/[\s,]+/).filter(Boolean);
    if (!list.length) return null;
    if (list.includes('*')) return '*';
    if (!origin) return null;
    const o = origin.replace(/\/$/, '').toLowerCase();
    const hit = list.find((x) => x.replace(/\/$/, '').toLowerCase() === o);
    return hit ? origin : null;
  }

  /**
   * The public website form endpoint. No auth — hardened instead by:
   *   public key (unguessable URL) · allowed-origin CORS · honeypot · rate limit
   *   per key AND per IP · the ingestion pipeline's own validation.
   */
  async formReceive(publicKey: string, body: any, meta: ReqMeta): Promise<WebhookResult> {
    const t0 = Date.now();
    const ch = await this.channels.byPublicKey(publicKey, 'website');
    if (!ch) {
      await this.channels.logEvent({
        provider: 'website', public_key: publicKey, ip: meta.ip, origin: meta.origin, raw: body,
        status: 'rejected', reason: 'No website channel with that public key',
      });
      throw new WebhookRejected(404, 'Unknown form key');
    }

    // rate limit BEFORE any work: per key, and a tenth of that for a single IP
    const perMin = Number((ch.config as any)?.rate_limit_per_min) || FORM_DEFAULT_LIMIT;
    const ipCap = Math.max(3, Math.floor(perMin / IP_DIVISOR));
    if (!this.limiter.allow(`form:${publicKey}`, perMin) || !this.limiter.allow(`form:${publicKey}:${meta.ip ?? '?'}`, ipCap)) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
        origin: meta.origin, raw: body, status: 'rejected',
        reason: `Rate limit exceeded (${perMin}/min per form, ${ipCap}/min per IP)`, duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(429, 'Too many submissions — please try again in a minute.');
    }

    // browser posts must come from a configured origin (a server-to-server caller
    // sends no Origin header and is allowed through — CORS is a browser control).
    if (meta.origin && !this.allowedOrigin(ch, meta.origin)) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
        origin: meta.origin, raw: body, status: 'rejected',
        reason: `Origin ${meta.origin} is not in this channel's allowed origins`, duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(403, 'This origin is not allowed to submit this form.');
    }
    if (!ch.is_active) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
        origin: meta.origin, raw: body, status: 'skipped', reason: 'Channel is paused — submission logged, no lead created',
        duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { ok: true } };
    }

    // honeypot: a hidden input a human never fills. Answer 200 so the bot learns
    // nothing, but record the drop.
    const hp = String((ch.config as any)?.honeypot_field ?? 'company_website');
    if (hp && String(body?.[hp] ?? '').trim()) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
        origin: meta.origin, raw: body, status: 'rejected',
        reason: `Spam: the honeypot field "${hp}" was filled in`, duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { ok: true } };   // silent drop
    }

    const fieldMap = parseFieldMap((ch.config as any)?.field_map);
    const clean = { ...(body ?? {}) };
    delete clean[hp];
    const payload = formToPayload(clean, fieldMap);

    let out: IngestOutcome;
    try {
      out = await this.ingestion.ingest(payload, {
        channel: 'form' as IngestChannel,
        campaign_id: ch.campaign_id, source_id: ch.source_id,
        actor_id: null,
        // an explicit external id wins; otherwise the pipeline hashes the payload,
        // so an accidental double-submit of the SAME data is a no-op replay.
        external_key: body?.external_id ? String(body.external_id) : null,
        duplicate_policy: 'campaign',
      });
    } catch (e) {
      const permanent = (e as any).permanent === true || (e as any).status === 400;
      const eid = await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
        origin: meta.origin, raw: body, status: 'failed', reason: (e as Error).message,
        duration_ms: Date.now() - t0,
      });
      // a real person is looking at this form -> tell their browser what was wrong
      if (permanent) throw new WebhookRejected(400, (e as Error).message);
      return { http: 200, body: { ok: true }, event_id: eid };
    }

    const eventId = await this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: 'website', public_key: publicKey, ip: meta.ip,
      origin: meta.origin, raw: body, signature_ok: true,
      status: out.status === 'created' ? 'ingested' : out.status === 'failed' ? 'failed' : out.status,
      reason: this.describe(out, null), lead_id: out.lead_id ?? null, duration_ms: Date.now() - t0,
    });
    return { http: 200, body: { ok: true }, event_id: eventId, outcomes: [out] };
  }

  // ================================================================= PUSH =====

  /**
   * THE GENERIC KEYED INBOUND WEBHOOK — Indian marketplaces (IndiaMART, JustDial,
   * TradeIndia, Housing.com, 99acres), Google Form and any Custom / Webhook source.
   *
   * A server-to-server JSON (or form-urlencoded) POST. There is no browser, so no
   * CORS/honeypot — the defence is: the unguessable public key in the URL, a rate
   * limit, an OPTIONAL shared `webhook_key`, and the same durable webhook_event log
   * + LeadIngestionService (dedupe/distribution/idempotency/audit) as every channel.
   */
  async pushReceive(publicKey: string, body: any, meta: ReqMeta): Promise<WebhookResult> {
    const t0 = Date.now();
    const ch = await this.channels.byPublicKey(publicKey);   // any push provider
    if (!ch || PROVIDER_ENDPOINT(ch.provider) !== 'push') {
      await this.channels.logEvent({
        provider: ch?.provider ?? 'webhook', public_key: publicKey, ip: meta.ip, raw: body,
        status: 'rejected', reason: 'No integration with that webhook key (deleted, wrong URL, or not a push integration)',
      });
      throw new WebhookRejected(404, 'Unknown webhook');
    }

    // rate limit BEFORE any work: per key, and a tenth of that per IP
    const perMin = Number((ch.config as any)?.rate_limit_per_min) || FORM_DEFAULT_LIMIT;
    const ipCap = Math.max(3, Math.floor(perMin / IP_DIVISOR));
    if (!this.limiter.allow(`push:${publicKey}`, perMin) || !this.limiter.allow(`push:${publicKey}:${meta.ip ?? '?'}`, ipCap)) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: ch.provider, public_key: publicKey, ip: meta.ip,
        raw: body, status: 'rejected',
        reason: `Rate limit exceeded (${perMin}/min per integration, ${ipCap}/min per IP)`, duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(429, 'Too many submissions — please try again in a minute.');
    }

    // OPTIONAL shared key: enforce ONLY if a value was supplied by the caller.
    const expectedKey = this.channels.secretsOf(ch).webhook_key ?? '';
    const providedKey = String(meta.apiKey ?? (body && (body.key ?? body.secret)) ?? '').trim();
    if (providedKey && expectedKey && !safeEqual(providedKey, expectedKey)) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: ch.provider, public_key: publicKey, ip: meta.ip,
        raw: body, signature_ok: false, status: 'rejected',
        reason: 'Webhook key supplied but does not match this integration\'s key', duration_ms: Date.now() - t0,
      });
      throw new WebhookRejected(401, 'Webhook key does not match.');
    }

    if (!ch.is_active) {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: ch.provider, public_key: publicKey, ip: meta.ip,
        raw: body, status: 'skipped', reason: 'Integration is paused — payload logged, no lead created',
        duration_ms: Date.now() - t0,
      });
      return { http: 200, body: { ok: true, ingested: 0 } };
    }

    const fieldMap = parseFieldMap((ch.config as any)?.field_map);
    // the shared-key fields are transport, never lead data
    const clean: Record<string, unknown> = { ...(body ?? {}) };
    delete clean.key; delete clean.secret;
    const payload = formToPayload(clean, fieldMap);

    // "capture other fields (page / form name) visible to all users" -> onto the note
    if ((ch.config as any)?.capture_extra) {
      const extras = extraFields(clean, fieldMap, ['key', 'secret']);
      if (extras.length) {
        const block = extras.map(([k, v]) => `${k}: ${v}`).join('\n');
        payload.note = payload.note ? `${payload.note}\n${block}` : block;
      }
    }

    let out: IngestOutcome;
    try {
      out = await this.ingestion.ingest(payload, {
        channel: 'webhook' as IngestChannel,
        campaign_id: ch.campaign_id, source_id: ch.source_id,
        actor_id: null,
        external_key: body?.external_id ? String(body.external_id) : (body?.lead_id ? String(body.lead_id) : null),
        duplicate_policy: 'campaign',
      });
    } catch (e) {
      const permanent = (e as any).permanent === true || (e as any).status === 400;
      const eid = await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: ch.provider, public_key: publicKey, ip: meta.ip,
        raw: body, status: 'failed', reason: (e as Error).message, duration_ms: Date.now() - t0,
      });
      if (permanent) throw new WebhookRejected(400, (e as Error).message);
      return { http: 200, body: { ok: true, error: (e as Error).message }, event_id: eid };
    }

    const eventId = await this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: ch.provider, public_key: publicKey, ip: meta.ip,
      raw: body, signature_ok: true,
      status: out.status === 'created' ? 'ingested' : out.status === 'failed' ? 'failed' : out.status,
      reason: this.describe(out, null), lead_id: out.lead_id ?? null, duration_ms: Date.now() - t0,
    });
    return { http: 200, body: { ok: true, lead_id: out.lead_id ?? null }, event_id: eventId, outcomes: [out] };
  }

  // ========================================================== GOOGLE SHEET ===

  /**
   * Poll one sheet. Rows are read from `cursor.last_row + 1` onward, so a row is
   * never read twice; the ingestion ledger (external_key = sheet:<id>:<row>) is the
   * second, authoritative guard if the cursor is ever reset by hand.
   *
   * Credentials are NOT available yet (Gopal has not supplied them). That path is
   * therefore an explicit, first-class state — `SheetNotConfiguredError` -> a
   * `skipped` event with a readable reason and a 503 on a manual pull. Never a crash,
   * never a retry storm, and it starts working the moment the JSON is pasted in.
   */
  async pollSheet(ch: ChannelRow, opts: { manual?: boolean } = {}): Promise<{
    status: 'ingested' | 'skipped' | 'failed';
    read: number; created: number; duplicate: number; skipped: number; failed: number;
    reason: string; last_row: number;
  }> {
    const t0 = Date.now();
    const cfg = (ch.config ?? {}) as any;
    const cursor = (ch.cursor ?? {}) as { last_row?: number };
    let lastRow = Number(cursor.last_row ?? 1) || 1;   // row 1 = headers
    const counts = { read: 0, created: 0, duplicate: 0, skipped: 0, failed: 0 };

    const finish = async (status: 'ingested' | 'skipped' | 'failed', reason: string, lead: number | null = null) => {
      await this.channels.logEvent({
        channel_id: ch.id, org_id: ch.org_id, provider: 'google_sheet', public_key: ch.public_key,
        method: 'POLL', raw: { sheet_id: cfg.sheet_id ?? null, range: cfg.range ?? null, ...counts, manual: !!opts.manual },
        status, reason, lead_id: lead, external_key: `sheet:${cfg.sheet_id ?? '?'}:${lastRow}`,
        duration_ms: Date.now() - t0,
      });
      await this.db.query(
        `UPDATE capture_channel
            SET cursor = $2, next_poll_at = now() + ($3 || ' minutes')::interval, updated_at = now()
          WHERE id = $1`,
        [ch.id, JSON.stringify({ ...cursor, last_row: lastRow }), String(Math.max(1, Number(cfg.poll_minutes) || 15))],
      );
      return { status, ...counts, reason, last_row: lastRow };
    };

    if (!ch.is_active) return finish('skipped', 'Channel is paused');

    let values: string[][];
    try {
      values = await this.sheets.readValues(String(cfg.sheet_id ?? ''), String(cfg.range ?? 'A:Z'), this.channels.secretsOf(ch));
    } catch (e) {
      if (e instanceof SheetNotConfiguredError || (e as any).notConfigured) {
        return finish('skipped', (e as Error).message);   // the "no credentials yet" state
      }
      return finish('failed', (e as Error).message);
    }

    const headers = (values[0] ?? []).map((h) => String(h ?? '').trim());
    if (!headers.length) return finish('skipped', 'The sheet has no header row — row 1 must be the column names.');

    const fieldMap = parseFieldMap(cfg.field_map);
    let firstLead: number | null = null;

    // values[0] is sheet row 1; values[i] is sheet row i+1
    for (let i = 1; i < values.length; i++) {
      const sheetRow = i + 1;
      if (sheetRow <= lastRow) continue;                       // the cursor: never re-read
      const row = values[i] ?? [];
      if (!row.some((c) => String(c ?? '').trim())) { lastRow = sheetRow; continue; }   // blank row
      counts.read++;

      const payload = sheetRowToPayload(headers, row.map((c) => String(c ?? '')), fieldMap);
      const key = `sheet:${cfg.sheet_id}:${sheetRow}`;
      payload.external_id = payload.external_id ?? key;
      try {
        const out = await this.ingestion.ingest(payload, {
          channel: 'sheet' as IngestChannel,
          campaign_id: ch.campaign_id, source_id: ch.source_id,
          actor_id: null, external_key: key, duplicate_policy: 'campaign',
        });
        if (out.status === 'created') counts.created++;
        else if (out.status === 'duplicate') counts.duplicate++;
        else if (out.status === 'skipped') counts.skipped++;
        else counts.failed++;
        if (out.lead_id && !firstLead) firstLead = out.lead_id;
      } catch (e) {
        counts.failed++;
        this.log.warn(`sheet row ${sheetRow} failed: ${(e as Error).message}`);
      }
      // advance ONLY after the row has been dealt with (created, deduped or failed —
      // a failed row is recorded in the event log, and the sheet is the system of
      // record, so we do not block the cursor on it forever).
      lastRow = sheetRow;
    }

    if (!counts.read) return finish('skipped', 'No new rows since the last check.');
    return finish(
      counts.failed && !counts.created ? 'failed' : 'ingested',
      `Read ${counts.read} new row(s): ${counts.created} created · ${counts.duplicate} duplicate · ${counts.skipped} already imported · ${counts.failed} failed`,
      firstLead,
    );
  }

  // ================================================================ helpers ===

  private assertRate(key: string, limit: number) {
    if (!this.limiter.allow(key, limit)) throw new WebhookRejected(429, 'Too many requests');
  }

  private describe(out: IngestOutcome, externalKey: string | null): string {
    const id = externalKey ? `${externalKey}: ` : '';
    switch (out.status) {
      case 'created': return `${id}lead #${out.lead_id} created${out.owner_id ? ` and assigned to user #${out.owner_id}` : ' (unassigned — on-demand campaign)'}`;
      case 'duplicate': return `${id}duplicate of lead #${out.duplicate_of} — campaign rule "${out.action}" applied${out.merged ? ' (merged into the existing lead)' : ''}${out.reopened ? ' and re-opened' : ''}`;
      case 'skipped': return `${id}${out.reason ?? 'already ingested — idempotent replay, no second lead'}`;
      default: return `${id}${out.reason ?? 'failed'}`;
    }
  }
}
