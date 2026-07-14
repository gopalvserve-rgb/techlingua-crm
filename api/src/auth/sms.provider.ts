import { Injectable } from '@nestjs/common';
import { NotConfiguredException } from '../common/not-configured.exception';
import { DatabaseService } from '../database/database.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { missingRequirements } from '../messaging/providers';

/**
 * Pluggable SMS gateway abstraction (client update #1 — OTP login).
 *
 * The client has NOT provided an SMS gateway yet, so the default provider is
 * `not_configured`: any send throws a clear 503 the UI surfaces verbatim.
 * Provider selection order:
 *   1. env SMS_DEV_MODE=1            -> dev/test provider (logs the code server-side
 *                                       for QA; NEVER set in production)
 *   2. app_setting key 'sms_provider' -> { "provider": "<name>", ...credentials }
 *      (Settings-driven per project rules; real gateways register in PROVIDERS)
 *   3. otherwise                      -> not_configured (503)
 */
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, message: string): Promise<void>;
}

export const SMS_NOT_CONFIGURED_MSG = 'SMS gateway not configured — add the SMS API in Administration › Settings › Channels';

class NotConfiguredProvider implements SmsProvider {
  readonly name = 'not_configured';
  async send(): Promise<void> {
    throw new NotConfiguredException(SMS_NOT_CONFIGURED_MSG);
  }
}

/** Dev/QA only: logs the message server-side instead of sending. */
class DevSmsProvider implements SmsProvider {
  readonly name = 'dev';
  async send(to: string, message: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[SMS_DEV_MODE] to=${to} :: ${message}`);
  }
}

/** Legacy Sprint-2 factories (the `app_setting.sms_provider` row). Kept for back-compat. */
type ProviderFactory = (cfg: Record<string, unknown>) => SmsProvider;
const PROVIDERS: Record<string, ProviderFactory> = {
  dev: () => new DevSmsProvider(),
};

/**
 * SPRINT-4 CONSOLIDATION — the OTP gateway and the bulk-SMS gateway are ONE gateway.
 *
 * The Sprint-2 seam here (`app_setting.sms_provider`) never got a real provider, because
 * the client never sent one. Sprint 4 gives SMS a proper home — `channel_config`
 * (channel='sms'), configured in Administration › Settings with an encrypted key — and
 * this service now reads THAT first. So the moment Gopal pastes his SMS credentials in to
 * send a campaign, **OTP login starts working too**, from the same row, with no deploy and
 * nothing else to configure. The old app_setting row is still honoured if it exists, so
 * nothing that worked before stops working.
 */
class ChannelConfigSmsProvider implements SmsProvider {
  constructor(readonly name: string, private readonly send_: (to: string, msg: string) => Promise<void>) {}
  async send(to: string, message: string): Promise<void> { await this.send_(to, message); }
}

@Injectable()
export class SmsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly configs?: ChannelConfigService,
    private readonly messaging?: MessagingService,
  ) {}

  /**
   * Resolve the active provider:
   *   1. SMS_DEV_MODE=1              -> dev provider (QA only, never production)
   *   2. channel_config(channel=sms) -> THE Sprint-4 gateway (shared with bulk SMS)
   *   3. app_setting.sms_provider    -> the legacy Sprint-2 row
   *   4. otherwise                   -> not_configured (a clean 503, no Error-Log noise)
   */
  async provider(): Promise<SmsProvider> {
    if (process.env.SMS_DEV_MODE === '1') return new DevSmsProvider();

    if (this.configs && this.messaging) {
      const cfg = await this.configs.resolve('sms', null);
      if (cfg && missingRequirements(cfg.provider, cfg.config, Object.keys(cfg.secrets)).length === 0) {
        return new ChannelConfigSmsProvider(cfg.provider, async (to, message) => {
          // an OTP goes through the SAME send log as everything else, so "did the OTP go
          // out?" is answerable on a screen instead of in the server logs.
          const out = await this.messaging!.sendNow({ channel: 'sms', to, body: message, guarded: false });
          if (out.status !== 'sent') throw new Error(out.reason || 'SMS gateway rejected the message');
        });
      }
    }

    const row = await this.db.one<{ value: { provider?: string } & Record<string, unknown> }>(
      `SELECT value FROM app_setting WHERE key = 'sms_provider'`,
    );
    const name = row?.value?.provider;
    const factory = name ? PROVIDERS[name] : undefined;
    if (factory) return factory(row!.value);
    return new NotConfiguredProvider();
  }

  async send(toE164: string, message: string): Promise<{ provider: string }> {
    const p = await this.provider();
    await p.send(toE164, message);
    return { provider: p.name };
  }
}
