import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { ConnectionTestService, HttpFn } from './connection-test.service';

const defaultHttp: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

/** One number of the connected WhatsApp Business Account, as stored in `config.numbers`. */
export interface WaNumber {
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  waba_id: string;
  /** Meta's own status string, verbatim (CONNECTED / PENDING / FLAGGED …); '' = never synced */
  status: string;
  quality_rating: string;
  code_verification_status: string;
  name_status: string;
  /** free text the admin types — "Sales line" */
  label: string;
  is_default: boolean;
}

export interface WaAccountPayload {
  connected: boolean;
  accounts: Array<{
    config_id: number; vertical_id: number | null; vertical_name: string | null;
    waba_id: string; phone_number_id: string; display_phone_number: string;
    verify_token: string; is_active: boolean;
  }>;
  numbers: Array<WaNumber & { config_id: number }>;
  webhook: { callback_path: string; last_inbound_at: string | null; events_24h: number; healthy: boolean };
}

const PHONE_FIELDS = 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status,name_status';
/** "Receiving" = Meta reached us within this window. A quiet weekend must not read as broken. */
const HEALTHY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ENGAGEMENT › WHATSAPP ACCOUNT — the numbers table, Verify / Register / Disconnect and
 * webhook health.
 *
 * STORAGE: nothing new. Everything lives on the ONE WhatsApp `channel_config` row and is
 * written through `ChannelConfigService.save()` like every other credential:
 *   - `config.numbers`            the WABA's numbers + the admin's labels (a SYSTEM-MANAGED
 *                                 key — see `MsgProviderSpec.systemConfig` — so a generic
 *                                 Settings save can neither set nor wipe it)
 *   - `config.phone_number_id`    THE DEFAULT. This is the exact field the Sprint-4 sender
 *                                 (`MetaWhatsAppTransport`) posts to, so "is default" is
 *                                 DERIVED from it on every read. There is no second flag
 *                                 that could disagree with what actually sends.
 *
 * Every Graph call goes through the injected `http`, so the specs never touch a network.
 * No response ever carries a token; the only readable secret is the verify token, which
 * the admin must paste into Meta (same rule as `ChannelConfigService.present`).
 */
@Injectable()
export class WhatsAppAccountService {
  private readonly log = new Logger('WhatsAppAccount');

  constructor(
    private readonly db: DatabaseService,
    private readonly configs: ChannelConfigService,
    private readonly tester: ConnectionTestService,
    private readonly http: HttpFn = defaultHttp,
  ) {}

  // ------------------------------------------------------------------ read

  /** The whole screen in one call — and no Graph call, so it renders instantly. */
  async account(): Promise<WaAccountPayload> {
    const rows = (await this.configs.list('whatsapp')).filter((r: any) => r.provider === 'meta_cloud');
    // A row that only holds the Meta app (App ID + secret) is NOT a connection yet.
    const linked = rows.filter((r: any) => String(r.config?.phone_number_id ?? '') || String(r.config?.waba_id ?? ''));
    const accounts = linked.map((r: any) => ({
      config_id: Number(r.id),
      vertical_id: r.vertical_id ?? null,
      vertical_name: r.vertical_name ?? null,
      waba_id: String(r.config?.waba_id ?? ''),
      phone_number_id: String(r.config?.phone_number_id ?? ''),
      display_phone_number: String(r.config?.display_phone_number ?? ''),
      verify_token: String(r.verify_token ?? ''),
      is_active: !!r.is_active,
    }));
    const numbers = linked.flatMap((r: any) => numbersOf(r.config ?? {}).map((n) => ({ ...n, config_id: Number(r.id) })));
    return {
      connected: linked.some((r: any) => r.status === 'connected'),
      accounts,
      numbers,
      webhook: await this.webhookHealth(),
    };
  }

  /**
   * Webhook health from `wa_webhook_event` (migration 119) — one row per verified POST
   * Meta makes to /api/webhooks/whatsapp. A missing table (migration not applied yet)
   * reads as "nothing received", never as a 500.
   */
  private async webhookHealth(): Promise<WaAccountPayload['webhook']> {
    const out = { callback_path: '/api/webhooks/whatsapp', last_inbound_at: null as string | null, events_24h: 0, healthy: false };
    try {
      const r = await this.db.one<{ last_inbound_at: string | Date | null; events_24h: string | number }>(
        `SELECT max(received_at) AS last_inbound_at,
                count(*) FILTER (WHERE received_at >= now() - INTERVAL '24 hours') AS events_24h
           FROM wa_webhook_event
          WHERE received_at >= now() - INTERVAL '30 days'`,
      );
      if (r?.last_inbound_at) {
        const at = new Date(r.last_inbound_at);
        out.last_inbound_at = at.toISOString();
        out.healthy = Date.now() - at.getTime() <= HEALTHY_WINDOW_MS;
      }
      out.events_24h = Number(r?.events_24h ?? 0);
    } catch (e) {
      this.log.warn(`webhook health unavailable: ${(e as Error).message}`);
    }
    return out;
  }

  // ----------------------------------------------------------------- writes

  /** Re-pull the WABA's numbers from Meta; labels and the default survive. */
  async sync(configId: number, actorId: number) {
    const cfg = await this.own(configId);
    const wabaId = String(cfg.config.waba_id ?? '');
    const token = cfg.secrets.access_token ?? '';
    if (!wabaId || !token) {
      throw new BadRequestException(
        'Nothing to sync yet — this connection has no WhatsApp Business Account ID or access token. Press Connect another number first.',
      );
    }
    const j = await this.graph(
      cfg, `/${encodeURIComponent(wabaId)}/phone_numbers?fields=${PHONE_FIELDS}&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
      'Meta rejected the sync',
    );
    const prior = new Map(numbersOf(cfg.config).map((n) => [n.phone_number_id, n]));
    const fresh: WaNumber[] = (Array.isArray(j?.data) ? j.data : [])
      .filter((d: any) => d?.id)
      .map((d: any) => ({
        phone_number_id: String(d.id),
        display_phone_number: String(d.display_phone_number ?? ''),
        verified_name: String(d.verified_name ?? ''),
        waba_id: wabaId,
        status: String(d.status ?? ''),
        quality_rating: String(d.quality_rating ?? ''),
        code_verification_status: String(d.code_verification_status ?? ''),
        name_status: String(d.name_status ?? ''),
        label: prior.get(String(d.id))?.label ?? '',
        is_default: false,
      }));

    // THE DEFAULT IS WHAT THE SENDER USES. Keep it if Meta still lists it; adopt the first
    // number only when there was no default at all (signup finished before Meta provisioned
    // the phone). A default Meta does NOT list is left alone and reported — silently
    // re-pointing every outgoing message to another number is not a sync's decision.
    let defaultId = String(cfg.config.phone_number_id ?? '');
    let warning: string | null = null;
    if (!defaultId && fresh.length) defaultId = fresh[0].phone_number_id;
    else if (defaultId && fresh.length && !fresh.some((n) => n.phone_number_id === defaultId)) {
      warning = `The default sending number (ID ${defaultId}) is not listed under WhatsApp Business Account ${wabaId}. Pick a default from the list below.`;
    }
    await this.persist(cfg, fresh, defaultId, actorId);
    return { ok: true, synced: fresh.length, warning, ...(await this.account()) };
  }

  /** Edit a label and / or make this number the default sender. */
  async updateNumber(
    dto: { config_id?: unknown; phone_number_id?: unknown; label?: unknown; is_default?: unknown },
    actorId: number,
  ) {
    const cfg = await this.own(Number(dto?.config_id));
    const pid = String(dto?.phone_number_id ?? '').trim();
    const list = numbersOf(cfg.config);
    const hit = list.find((n) => n.phone_number_id === pid);
    if (!pid || !hit) throw new NotFoundException('That number is not part of this WhatsApp connection — press Sync from Meta and try again.');

    if (dto?.label !== undefined && dto?.label !== null) hit.label = String(dto.label).trim().slice(0, 60);
    let defaultId = String(cfg.config.phone_number_id ?? '');
    if (dto?.is_default === true) defaultId = pid;
    else if (dto?.is_default === false && defaultId === pid) {
      throw new BadRequestException('One number must stay the default — press Set default on another number instead.');
    }
    await this.persist(cfg, list, defaultId, actorId);
    return { ok: true, ...(await this.account()) };
  }

  /** Cloud API registration: POST /{phone_number_id}/register { messaging_product, pin }. */
  async register(dto: { config_id?: unknown; phone_number_id?: unknown; pin?: unknown }) {
    const pin = String(dto?.pin ?? '').trim();
    if (!/^\d{6}$/.test(pin)) throw new BadRequestException('The PIN must be exactly 6 digits (your two-step verification PIN — 000000 if you never set one).');
    const cfg = await this.own(Number(dto?.config_id));
    const pid = String(dto?.phone_number_id ?? '').trim();
    if (!pid || !numbersOf(cfg.config).some((n) => n.phone_number_id === pid)) {
      throw new NotFoundException('That number is not part of this WhatsApp connection — press Sync from Meta and try again.');
    }
    const token = cfg.secrets.access_token ?? '';
    if (!token) throw new BadRequestException('This connection has no access token — press Connect another number first.');
    await this.graph(cfg, `/${encodeURIComponent(pid)}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    }, 'Meta refused to register the number');
    return { ok: true, phone_number_id: pid, message: 'Registered with the WhatsApp Cloud API. Press Sync from Meta to refresh its status.' };
  }

  /** Read-only probe — the same one Settings › Test connection runs. */
  async verify(configId: number) {
    await this.own(configId);
    const out = await this.tester.probe('whatsapp', null, 'meta_cloud');
    return { ok: out.ok, detail: out.message, caveat: out.caveat ?? null };
  }

  /**
   * Remove ONE number (when others remain) or disconnect WhatsApp entirely.
   *
   * A full disconnect soft-deletes the row through `configs.remove()` so the audit trail
   * (deleted_at / deleted_by) is intact — and then re-saves ONLY the Meta app (App ID,
   * Configuration ID, App secret, verify token) as a fresh row through the same
   * `configs.save()`. That row is not a WhatsApp connection (no token, no number), but
   * Facebook Lead Ads login reads its App ID + secret from the `meta_cloud` row, and the
   * verify token is already pasted into Meta. Deleting those with the number would break
   * a feature the admin never asked to touch.
   */
  async disconnect(dto: { config_id?: unknown; remove_number?: unknown }, actorId: number) {
    const cfg = await this.own(Number(dto?.config_id));
    const removeId = String(dto?.remove_number ?? '').trim();
    const list = numbersOf(cfg.config);

    if (removeId) {
      if (!list.some((n) => n.phone_number_id === removeId)) {
        throw new NotFoundException('That number is not part of this WhatsApp connection.');
      }
      const rest = list.filter((n) => n.phone_number_id !== removeId);
      if (rest.length) {
        let defaultId = String(cfg.config.phone_number_id ?? '');
        let newDefault: string | null = null;
        if (defaultId === removeId) {
          defaultId = (rest.find((n) => n.status.toUpperCase() === 'CONNECTED') ?? rest[0]).phone_number_id;
          newDefault = defaultId;
        }
        await this.persist(cfg, rest, defaultId, actorId);
        return { ok: true, mode: 'number_removed' as const, removed: removeId, new_default: newDefault, warning: null, ...(await this.account()) };
      }
      // the last number: removing it IS disconnecting — fall through
    }

    // best-effort: tell Meta to stop calling us. A failure here must not strand the admin
    // with a connection he cannot remove.
    let warning: string | null = null;
    const wabaId = String(cfg.config.waba_id ?? '');
    const token = cfg.secrets.access_token ?? '';
    if (wabaId && token) {
      try {
        await this.graph(cfg, `/${encodeURIComponent(wabaId)}/subscribed_apps`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        }, 'Meta would not unsubscribe the webhook');
      } catch (e) {
        warning = `${(e as Error).message}. WhatsApp is disconnected here, but Meta may keep calling the webhook until you remove the app from the WhatsApp Business Account in Meta Business Settings.`;
        this.log.warn(`disconnect: unsubscribe failed for WABA ${wabaId}: ${(e as Error).message}`);
      }
    }

    await this.configs.remove(cfg.id, actorId);

    const keepConfig: Record<string, unknown> = {};
    for (const k of ['app_id', 'config_id', 'api_version', 'default_language']) {
      if (cfg.config[k] !== undefined && cfg.config[k] !== null && cfg.config[k] !== '') keepConfig[k] = cfg.config[k];
    }
    const keepSecrets: Record<string, string> = {};
    for (const k of ['app_secret', 'verify_token']) if (cfg.secrets[k]) keepSecrets[k] = cfg.secrets[k];
    let appKept = false;
    if (keepConfig.app_id || keepSecrets.app_secret) {
      try {
        await this.configs.save({
          provider: cfg.provider, channel: 'whatsapp', vertical_id: cfg.vertical_id,
          config: keepConfig, secrets: keepSecrets, is_active: true,
        }, actorId);
        appKept = true;
      } catch (e) {
        this.log.warn(`disconnect: could not re-save the Meta app: ${(e as Error).message}`);
        warning = [warning, 'Your Meta App ID / secret could not be kept — re-enter them in Administration › Settings before reconnecting.'].filter(Boolean).join(' ');
      }
    }
    return { ok: true, mode: 'disconnected' as const, removed: removeId || null, new_default: null, meta_app_kept: appKept, warning, ...(await this.account()) };
  }

  // ---------------------------------------------------------------- helpers

  /** The decrypted WhatsApp row — and proof the caller is acting on the one that exists. */
  private async own(configId: number): Promise<ResolvedConfig> {
    if (!Number.isFinite(configId) || configId <= 0) throw new BadRequestException('config_id is required.');
    const cfg = await this.configs.resolve('whatsapp', null);
    if (!cfg || cfg.id !== configId || cfg.provider !== 'meta_cloud') {
      throw new NotFoundException('This WhatsApp connection no longer exists — refresh the page.');
    }
    return cfg;
  }

  /** Write the numbers + the sender's fields through the ONE storage path. */
  private async persist(cfg: ResolvedConfig, list: WaNumber[], defaultId: string, actorId: number) {
    const numbers = list.map((n) => ({ ...n, is_default: n.phone_number_id === defaultId }));
    const def = numbers.find((n) => n.is_default);
    const config: Record<string, unknown> = {};
    if (def) {
      // exactly what MetaWhatsAppTransport posts to, and what the chat's "Sending from" shows
      config.phone_number_id = def.phone_number_id;
      if (def.display_phone_number) config.display_phone_number = def.display_phone_number;
      if (def.verified_name) config.verified_name = def.verified_name;
    }
    await this.configs.save(
      { provider: cfg.provider, channel: 'whatsapp', vertical_id: cfg.vertical_id, config },
      actorId, { system: { numbers } },
    );
  }

  /** One Graph call; a Meta rejection becomes a readable 400, never a raw 500. */
  private async graph(cfg: ResolvedConfig, path: string, init: any, what: string): Promise<any> {
    const version = String(cfg.config.api_version ?? 'v21.0');
    let r: { ok: boolean; status: number; text(): Promise<string> };
    try {
      r = await this.http(`https://graph.facebook.com/${version}${path}`, init);
    } catch (e) {
      throw new BadRequestException(`${what}: could not reach Meta (${(e as Error).message}).`);
    }
    const j = safeJson(await r.text());
    if (!r.ok || j?.error) {
      const m = j?.error?.error_user_msg || j?.error?.message || `HTTP ${r.status}`;
      throw new BadRequestException(`${what}: ${m}`);
    }
    return j ?? {};
  }
}

/**
 * The numbers of one config row. `config.numbers` when it has been synced; otherwise the
 * single number Embedded Signup / a manual save stored — so the screen (and the chat's
 * "Sending from") work before anybody has pressed Sync.
 */
export function numbersOf(config: Record<string, unknown>): WaNumber[] {
  const defaultId = String(config?.phone_number_id ?? '');
  const wabaId = String(config?.waba_id ?? '');
  const stored = Array.isArray(config?.numbers) ? (config.numbers as any[]) : [];
  const list: WaNumber[] = stored
    .filter((n) => n && n.phone_number_id)
    .map((n) => ({
      phone_number_id: String(n.phone_number_id),
      display_phone_number: String(n.display_phone_number ?? ''),
      verified_name: String(n.verified_name ?? ''),
      waba_id: String(n.waba_id ?? wabaId),
      status: String(n.status ?? ''),
      quality_rating: String(n.quality_rating ?? ''),
      code_verification_status: String(n.code_verification_status ?? ''),
      name_status: String(n.name_status ?? ''),
      label: String(n.label ?? ''),
      is_default: String(n.phone_number_id) === defaultId,
    }));
  // The number the sender ACTUALLY uses must always be on the list — also when it was
  // connected after the last sync, or when Meta no longer lists it under this WABA.
  if (defaultId && !list.some((n) => n.is_default)) {
    list.push({
      phone_number_id: defaultId,
      display_phone_number: String(config?.display_phone_number ?? ''),
      verified_name: String(config?.verified_name ?? ''),
      waba_id: wabaId, status: '', quality_rating: '', code_verification_status: '', name_status: '',
      label: '', is_default: true,
    });
  }
  // default first — every picker wants it on top
  return list.sort((a, b) => Number(b.is_default) - Number(a.is_default));
}

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
