import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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

export const SMS_NOT_CONFIGURED_MSG = 'SMS gateway not configured — add SMS API in Settings';

class NotConfiguredProvider implements SmsProvider {
  readonly name = 'not_configured';
  async send(): Promise<void> {
    throw new ServiceUnavailableException(SMS_NOT_CONFIGURED_MSG);
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

/** Real gateways plug in here once the client supplies one (settings-driven). */
type ProviderFactory = (cfg: Record<string, unknown>) => SmsProvider;
const PROVIDERS: Record<string, ProviderFactory> = {
  dev: () => new DevSmsProvider(),
  // e.g. msg91: (cfg) => new Msg91Provider(cfg), twilio: (cfg) => new TwilioProvider(cfg)
};

@Injectable()
export class SmsService {
  constructor(private readonly db: DatabaseService) {}

  /** Resolve the active provider (env dev flag > settings row > not_configured). */
  async provider(): Promise<SmsProvider> {
    if (process.env.SMS_DEV_MODE === '1') return new DevSmsProvider();
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
