import { Injectable } from '@nestjs/common';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { MSG_PROVIDERS, MsgChannel } from '../messaging/providers';

/** Injected so tests never touch the network. */
export type HttpFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const defaultHttp: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

export interface TestResult {
  ok: boolean;
  /** short, specific, and in the client's words — this is what the badge says */
  message: string;
  /** the caveat from the provider spec — rendered next to a GREEN result */
  caveat?: string;
  /** what the provider literally answered, for the "details" disclosure */
  detail?: string;
  /** scope honesty — e.g. Cloudflare is verified but not yet serving anything */
  storedOnly?: string;
}

/**
 * "TEST CONNECTION" — a REAL call to the provider, reporting a REAL, SPECIFIC result.
 *
 * The rule this service exists to enforce: **a green tick must never claim more than it
 * knows.** Every provider spec carries a `testCaveat` and we render it verbatim next to a
 * pass, because the Tester proved MSG91 answers `type:success` to a bogus auth key — a
 * naive "✅ Connected" there would be a lie the client would act on.
 *
 * Nothing in here mutates anything at the provider: reads only, no payments, no messages.
 * (The three SENDING channels are tested by actually sending — that lives in the
 * controller, because a delivered message is a stronger proof than any probe.)
 */
@Injectable()
export class ConnectionTestService {
  constructor(
    private readonly configs: ChannelConfigService,
    private readonly http: HttpFn = defaultHttp,
  ) {}

  /**
   * Probe the stored credential for a channel. Throws NotConfiguredException (=> a clean
   * 503 naming the missing fields) when there is nothing to test — never a 500, and never
   * an Error-Log row.
   */
  async probe(channel: MsgChannel, verticalId?: number | null, provider?: string | null): Promise<TestResult> {
    // `provider` matters on a multi-provider channel (`ai`) — see DEF-S5-04. Elsewhere it
    // is null and the (channel, vertical) row is the only one there is.
    const cfg = await this.configs.require(channel, verticalId, provider);
    const spec = MSG_PROVIDERS[cfg.provider];
    const caveat = spec?.testCaveat;

    if (spec?.test === 'none') {
      return {
        ok: true,
        message: `${spec.label}: credentials stored. They cannot be verified until you press Connect account and grant consent.`,
        caveat: spec.storedOnly,
      };
    }

    let out: TestResult;
    try {
      out = await this.dispatch(cfg);
    } catch (e) {
      // A network/DNS failure is a real, reportable answer — not a crash.
      out = { ok: false, message: `Could not reach ${spec?.label ?? cfg.provider}: ${(e as Error).message}` };
    }
    if (out.ok && caveat) out.caveat = caveat;
    if (spec?.storedOnly) out.storedOnly = spec.storedOnly;
    await this.configs.recordTest(cfg.id, out.ok, out.ok ? null : out.message);
    return out;
  }

  private dispatch(cfg: ResolvedConfig): Promise<TestResult> {
    switch (cfg.provider) {
      case 'meta_cloud': return this.whatsapp(cfg);
      case 'razorpay': return this.razorpay(cfg);
      case 'cloudflare': return this.cloudflare(cfg);
      case 'deepseek': return this.deepseek(cfg);
      case 'gemini': return this.gemini(cfg);
      default:
        return Promise.resolve({ ok: false, message: `No connection test exists for "${cfg.provider}".` });
    }
  }

  // --------------------------------------------------------------- probes

  /** Reads the phone number back from Meta — proves the token AND the phone id together. */
  private async whatsapp(cfg: ResolvedConfig): Promise<TestResult> {
    const v = String(cfg.config.api_version ?? 'v21.0');
    const pid = String(cfg.config.phone_number_id ?? '');
    const r = await this.http(
      `https://graph.facebook.com/${v}/${encodeURIComponent(pid)}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${cfg.secrets.access_token}` } },
    );
    const body = await r.text();
    const j = safeJson(body);
    if (!r.ok || j?.error) {
      return { ok: false, message: `Meta rejected the token: ${j?.error?.message ?? `HTTP ${r.status}`}`, detail: body.slice(0, 400) };
    }
    const num = j?.display_phone_number ?? pid;
    const name = j?.verified_name ? ` (${j.verified_name})` : '';
    return { ok: true, message: `Connected to WhatsApp number ${num}${name}. Quality rating: ${j?.quality_rating ?? 'unknown'}.`, detail: body.slice(0, 400) };
  }

  /** Basic-auth read of a trivially small list. Creates nothing, charges nothing. */
  private async razorpay(cfg: ResolvedConfig): Promise<TestResult> {
    const auth = Buffer.from(`${String(cfg.config.key_id ?? '')}:${cfg.secrets.key_secret ?? ''}`).toString('base64');
    const r = await this.http('https://api.razorpay.com/v1/payments?count=1', { headers: { Authorization: `Basic ${auth}` } });
    const body = await r.text();
    if (r.status === 401) return { ok: false, message: 'Razorpay rejected the Key ID / Key Secret (401 Unauthorized).', detail: body.slice(0, 300) };
    if (!r.ok) return { ok: false, message: `Razorpay answered HTTP ${r.status}.`, detail: body.slice(0, 300) };
    const mode = String(cfg.config.key_id ?? '').startsWith('rzp_live') ? 'LIVE' : 'TEST';
    return { ok: true, message: `Razorpay accepted these keys (${mode} mode).`, detail: body.slice(0, 300) };
  }

  /** Cloudflare's own token-verify endpoint — exactly what it is for. */
  private async cloudflare(cfg: ResolvedConfig): Promise<TestResult> {
    const r = await this.http('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${cfg.secrets.api_token}` },
    });
    const body = await r.text();
    const j = safeJson(body);
    if (!r.ok || j?.success === false) {
      const err = j?.errors?.[0]?.message ?? `HTTP ${r.status}`;
      return { ok: false, message: `Cloudflare rejected the API token: ${err}`, detail: body.slice(0, 300) };
    }
    const status = j?.result?.status ?? 'active';
    return {
      ok: true,
      message: `Cloudflare API token is valid (status: ${status}). Bucket "${cfg.config.r2_bucket}" on zone "${cfg.config.zone}" saved.`,
      detail: body.slice(0, 300),
    };
  }

  private async deepseek(cfg: ResolvedConfig): Promise<TestResult> {
    const base = String(cfg.config.base_url ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    const r = await this.http(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.secrets.api_key}` } });
    const body = await r.text();
    if (r.status === 401) return { ok: false, message: 'DeepSeek rejected the API key (401 Unauthorized).', detail: body.slice(0, 300) };
    if (!r.ok) return { ok: false, message: `DeepSeek answered HTTP ${r.status}.`, detail: body.slice(0, 300) };
    return { ok: true, message: 'DeepSeek accepted the API key.', detail: body.slice(0, 300) };
  }

  private async gemini(cfg: ResolvedConfig): Promise<TestResult> {
    const r = await this.http(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.secrets.api_key ?? '')}`,
    );
    const body = await r.text();
    const j = safeJson(body);
    if (!r.ok || j?.error) {
      return { ok: false, message: `Google rejected the Gemini key: ${j?.error?.message ?? `HTTP ${r.status}`}`, detail: body.slice(0, 300) };
    }
    return { ok: true, message: `Gemini accepted the API key (${(j?.models ?? []).length} models available).`, detail: body.slice(0, 300) };
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
