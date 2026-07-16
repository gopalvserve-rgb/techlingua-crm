import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';

export type HttpFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const defaultHttp: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

export interface SignupResult {
  ok: boolean;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  subscribed: boolean;
  subscribe_error: string | null;
  warning: string | null;
}

/**
 * WHATSAPP EMBEDDED SIGNUP — ported from the tenant-SaaS (`routes/whatsbot.js`,
 * `api_wb_emb_signin`), which is this project's design reference.
 *
 * THE POINT: the client never sees a token. He clicks "Connect WhatsApp", logs in to
 * Meta's own popup, and this service turns the resulting one-time `code` into a
 * PERMANENT credential and stores it — killing the 24-hour-token trap that
 * `CHANNEL_SETUP.md` used to warn him about in three paragraphs.
 *
 * The flow, matching the tenant-SaaS exactly:
 *   browser: FB.login({config_id, response_type:'code'}) -> a one-time OAuth code
 *            + a postMessage (WA_EMBEDDED_SIGNUP) carrying phone_number_id + waba_id
 *   here:    1. code + app_id + app_secret -> GET /oauth/access_token  => PERMANENT token
 *            2. GET /{phone_number_id}                                 => the number's details
 *            3. POST /{waba_id}/subscribed_apps                        => webhook subscribed
 *            4. persist through the SAME ChannelConfigService every manual save uses
 *
 * WHAT IS ADAPTED FOR THIS APP (vs. the multi-tenant SaaS):
 *   - The SaaS reads its Meta app credentials from PLATFORM_FB_APP_ID/SECRET env vars,
 *     shared by every tenant. We are SINGLE-TENANT and settings-driven (a project rule),
 *     so app_id/app_secret come from the client's own `channel_config` row — he can
 *     change them with no deploy.
 *   - No `wa_phones` table and no multi-number fan-out: one org, one WhatsApp number.
 *     The SaaS's "add another number" branch has no meaning here and is not ported.
 *   - No central webhook forwarder: our webhook is this app's own URL.
 *   - Storage goes through ChannelConfigService.save(), so the token is AES-256-GCM
 *     encrypted and masked on read like every other secret — the SaaS stored it raw.
 */
@Injectable()
export class WhatsAppSignupService {
  private readonly log = new Logger('WhatsAppSignup');

  constructor(
    private readonly configs: ChannelConfigService,
    private readonly http: HttpFn = defaultHttp,
  ) {}

  /**
   * What the browser needs before it can open Meta's dialog. Public-ish values only —
   * the app_id ships to the browser by design; the app_secret NEVER leaves this process.
   */
  async launchInfo() {
    const cfg = await this.configs.resolve('whatsapp', null);
    const appId = String(cfg?.config?.app_id ?? '');
    const configId = String(cfg?.config?.config_id ?? '');
    const missing: string[] = [];
    if (!appId) missing.push('Meta App ID');
    if (!configId) missing.push('Embedded Signup Configuration ID');
    if (!cfg?.secrets?.app_secret) missing.push('App secret');
    return {
      app_id: appId,
      config_id: configId,
      graph_version: String(cfg?.config?.api_version ?? 'v21.0'),
      ready: missing.length === 0,
      missing,
      connected: !!cfg?.secrets?.access_token,
      connected_via: String(cfg?.config?.connected_via ?? ''),
      display_phone_number: String(cfg?.config?.display_phone_number ?? ''),
    };
  }

  /**
   * Step 2 of the flow: the browser posts back what Meta gave it. Everything from here
   * is server-side, because it needs the app secret.
   */
  async exchange(
    input: { code?: string; phone_number_id?: string; waba_id?: string },
    actorId: number,
  ): Promise<SignupResult> {
    const code = String(input?.code ?? '').trim();
    if (!code) throw new BadRequestException('Meta did not return an authorisation code. Close the dialog and try Connect WhatsApp again.');

    const cfg = await this.configs.resolve('whatsapp', null);
    const appId = String(cfg?.config?.app_id ?? '');
    const appSecret = cfg?.secrets?.app_secret ?? '';
    // A clean 503 naming the gap, exactly like every other "not configured" path — this
    // is a state we expect, not an error worth an Error-Log row.
    if (!appId || !appSecret) {
      throw new NotConfiguredException(
        'WhatsApp is not configured — missing: Meta App ID, App secret. Add them in Administration › Settings › Channels, then press Connect WhatsApp.',
      );
    }

    const version = String(cfg?.config?.api_version ?? 'v21.0');
    const graph = `https://graph.facebook.com/${version}`;

    // ---- 1. code -> PERMANENT token ---------------------------------------
    // A Login-for-Business config returns a business-integration system-user token.
    // It does NOT expire — that is the entire reason Embedded Signup exists here.
    const url = `${graph}/oauth/access_token`
      + `?client_id=${encodeURIComponent(appId)}`
      + `&client_secret=${encodeURIComponent(appSecret)}`
      + `&code=${encodeURIComponent(code)}`;
    const r = await this.http(url);
    const body = await r.text();
    const j = safeJson(body);
    if (!r.ok || j?.error || !j?.access_token) {
      throw new BadRequestException(`Token exchange failed: ${j?.error?.message ?? `HTTP ${r.status}`}`);
    }
    const accessToken: string = j.access_token;

    // ---- 2. resolve the number ---------------------------------------------
    // The postMessage is the primary source (it is what the SaaS relies on); Meta has
    // shipped several payload shapes, so a missing phone id is a real possibility and
    // must produce a readable message, not a crash.
    let phoneNumberId = String(input?.phone_number_id ?? '').trim();
    let wabaId = String(input?.waba_id ?? '').trim();
    let warning: string | null = null;

    if (!wabaId) {
      // The postMessage did not carry it (Meta has shipped several payload shapes).
      // Ask Meta what this token is actually scoped to rather than guessing — a WRONG
      // waba_id stored here would look connected and fail silently on every send.
      const owned = await this.wabaFromToken(graph, appId, appSecret, accessToken);
      if (owned) wabaId = owned;
    }
    if (!wabaId) {
      throw new BadRequestException(
        'Meta did not tell us which WhatsApp Business Account was selected. Make sure your Login-for-Business configuration has WhatsApp asset selection enabled, then try again.',
      );
    }
    if (!phoneNumberId) {
      const first = await this.firstPhone(graph, accessToken, wabaId);
      if (first) phoneNumberId = first;
      else warning = 'Connected to the WhatsApp Business Account, but Meta has not finished provisioning the phone number yet. Give it a minute and press Test connection.';
    }

    let displayPhone = '';
    let verifiedName = '';
    if (phoneNumberId) {
      const d = await this.phoneDetails(graph, accessToken, phoneNumberId);
      displayPhone = d.display_phone_number;
      verifiedName = d.verified_name;
    }

    // ---- 3. subscribe the webhook -----------------------------------------
    // Without this Meta never calls us and delivery receipts / STOP replies never arrive.
    // Doing it here is what removes the "paste the callback URL into Meta" step.
    let subscribed = true;
    let subscribeError: string | null = null;
    try {
      const sr = await this.http(`${graph}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscribed_fields: ['messages', 'message_template_status_update'] }),
      });
      const sb = await sr.text();
      const sj = safeJson(sb);
      if (!sr.ok || sj?.error) { subscribed = false; subscribeError = sj?.error?.message ?? `HTTP ${sr.status}`; }
    } catch (e) {
      subscribed = false; subscribeError = (e as Error).message;
    }

    // ---- 4. persist through the ONE storage path --------------------------
    // Same service as a manual save => AES-256-GCM at rest, masked on read, audit-safe.
    // The Sprint-4 sender reads exactly this row, so it starts working immediately;
    // nothing about HOW we send changed, only how the credential arrived.
    await this.configs.save({
      provider: 'meta_cloud',
      channel: 'whatsapp',
      vertical_id: null,
      config: {
        ...(cfg?.config ?? {}),
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        display_phone_number: displayPhone,
        verified_name: verifiedName,
        connected_via: 'embedded_signup',
      },
      secrets: { access_token: accessToken },
      is_active: true,
    }, actorId);

    if (!subscribed) {
      this.log.warn(`Embedded Signup connected WABA ${wabaId} but webhook subscribe failed: ${subscribeError}`);
    }
    return {
      ok: true,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      display_phone_number: displayPhone,
      verified_name: verifiedName,
      subscribed,
      subscribe_error: subscribeError,
      warning,
    };
  }

  // ------------------------------------------------------------- graph reads

  /**
   * Meta's documented way to find out which WABA a token was granted for:
   * debug_token -> granular_scopes -> whatsapp_business_management -> target_ids.
   * Used only when the postMessage did not carry the id.
   */
  private async wabaFromToken(graph: string, appId: string, appSecret: string, token: string): Promise<string> {
    try {
      const r = await this.http(
        `${graph}/debug_token?input_token=${encodeURIComponent(token)}`
        + `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
      );
      const j = safeJson(await r.text());
      const scopes: any[] = j?.data?.granular_scopes ?? [];
      const wa = scopes.find((s) => s?.scope === 'whatsapp_business_management')
        ?? scopes.find((s) => s?.scope === 'whatsapp_business_messaging');
      return String(wa?.target_ids?.[0] ?? '');
    } catch { return ''; }
  }

  private async firstPhone(graph: string, token: string, wabaId: string): Promise<string> {
    try {
      const r = await this.http(`${graph}/${encodeURIComponent(wabaId)}/phone_numbers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = safeJson(await r.text());
      return String(j?.data?.[0]?.id ?? '');
    } catch { return ''; }
  }

  private async phoneDetails(graph: string, token: string, phoneNumberId: string) {
    try {
      const r = await this.http(
        `${graph}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = safeJson(await r.text());
      return { display_phone_number: String(j?.display_phone_number ?? ''), verified_name: String(j?.verified_name ?? '') };
    } catch { return { display_phone_number: '', verified_name: '' }; }
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
