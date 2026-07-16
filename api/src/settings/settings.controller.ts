import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { SettingsService } from '../common/settings.service';
import { DatabaseService } from '../database/database.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { CHANNEL_LABEL, MSG_PROVIDERS, MsgChannel } from '../messaging/providers';
import { ConnectionTestService } from './connection-test.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';
import { GROUP_BY_KEY, SETTING_GROUPS } from './settings.registry';

interface Me { id: number; name: string; email?: string }

/**
 * ADMINISTRATION › SETTINGS — the whole settings framework behind `settings.read` /
 * `settings.update`, which migration 026 grants to Super Admin and Organization Admin
 * ONLY. Credentials live here; a Branch Manager must not be able to read them, and this
 * is where that is enforced.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly db: DatabaseService,
    private readonly configs: ChannelConfigService,
    private readonly messaging: MessagingService,
    private readonly tester: ConnectionTestService,
    private readonly signup: WhatsAppSignupService,
  ) {}

  /** The registry + every group's current value — one call renders the whole screen. */
  @Get()
  @RequirePermission('settings.read')
  async all() {
    const values: Record<string, unknown> = {};
    for (const g of SETTING_GROUPS) {
      if (g.editor === 'channels') continue;
      const row = await this.db.one<{ value: unknown }>(`SELECT value FROM app_setting WHERE key = $1`, [g.key]);
      values[g.key] = row?.value ?? {};
    }
    return {
      groups: SETTING_GROUPS,
      values,
      providers: this.configs.providers(),
      channels: await this.configs.list(),
    };
  }

  @Get('channels')
  @RequirePermission('settings.read')
  channels(@Query('channel') channel?: string) {
    return this.configs.list(channel);
  }

  /** Update one settings group. Unknown keys are refused — no arbitrary JSON blobs. */
  @Post(':key')
  @RequirePermission('settings.update')
  async save(@Param('key') key: string, @Body() dto: any, @CurrentUser() me: Me) {
    const group = GROUP_BY_KEY[key];
    if (!group) throw new BadRequestException(`Unknown setting "${key}"`);
    if (group.readonly) throw new BadRequestException(`"${group.label}" is edited on ${group.managedOn}.`);
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw new BadRequestException('Expected an object');
    await this.settings.set(key, dto as Record<string, unknown>, Number(me.id));
    const row = await this.db.one<{ value: unknown }>(`SELECT value FROM app_setting WHERE key = $1`, [key]);
    return { key, value: row?.value ?? {} };
  }

  /** Create / update a channel credential row (SMTP per vertical, WhatsApp, SMS, Razorpay, AI). */
  @Post('channels/save')
  @RequirePermission('settings.update')
  saveChannel(@Body() dto: any, @CurrentUser() me: Me) {
    return this.configs.save(dto, Number(me.id));
  }

  @Delete('channels/:id')
  @RequirePermission('settings.update')
  removeChannel(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.configs.remove(id, Number(me.id));
  }

  /**
   * TEST CONNECTION — one button, two honest behaviours.
   *
   *   'send'  (email/sms/whatsapp-manual) — actually deliver to an address the admin types.
   *   'probe' (whatsapp/razorpay/cloudflare/ai) — call the provider read-only and report
   *           what it said. Creates nothing, charges nothing, sends nothing.
   *
   * Either way the RESULT IS SPECIFIC, and a green result carries the provider's caveat
   * verbatim — because "MSG91 said success" and "the SMS was delivered" are not the same
   * sentence, and the client must not be allowed to read one as the other.
   *
   * A not-configured channel answers with a clean 503 naming exactly what is missing.
   */
  @Post('channels/test')
  @RequirePermission('settings.update')
  async test(@Body() dto: any, @CurrentUser() me: Me) {
    const channel = String(dto?.channel ?? '') as MsgChannel;
    if (!CHANNEL_LABEL[channel]) throw new BadRequestException(`Unknown channel "${channel}".`);
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    // DEF-S5-04: on a multi-provider channel (`ai`) "test the ai channel" is not a
    // question with one answer — DeepSeek and Gemini are two independent credentials. The
    // card sends which one it is; without it we would probe an arbitrary row and report
    // the wrong provider's verdict against the button the admin actually pressed.
    const provider = dto?.provider ? String(dto.provider) : null;
    if (provider && !MSG_PROVIDERS[provider]) throw new BadRequestException(`Unknown provider "${provider}".`);

    // throws NotConfiguredException (503 + the reason) when a credential is missing
    const cfg = await this.configs.require(channel, verticalId, provider);
    const spec = MSG_PROVIDERS[cfg.provider];

    if (spec?.test !== 'send') {
      const out = await this.tester.probe(channel, verticalId, provider);
      return { mode: 'probe', ...out };
    }

    const to = String(dto?.to ?? '').trim();
    if (!to) throw new BadRequestException('Where should the test go? Enter your own email or mobile number.');

    const out = await this.messaging.sendNow({
      channel,
      to,
      // DEF-S4-03 (found by the LIVE smoke): the vertical MUST ride along. Without it the
      // queued row carries vertical_id = NULL, deliver() re-resolves the ORG-WIDE config,
      // and a perfectly-configured per-vertical SMTP reports "not configured" — the client
      // would have concluded his credentials were wrong when they were right.
      vertical_id: verticalId,
      subject: 'Tech Lingua CRM — test message',
      body: channel === 'email'
        ? `<p>This is a test message from the Tech Lingua CRM.</p><p>If you are reading this, ${cfg.provider} is configured correctly.</p>`
        : `Tech Lingua CRM test message. If you got this, ${cfg.provider} is configured correctly.`,
      wa_template_name: dto?.wa_template_name ?? null,
      wa_params: dto?.wa_params ?? [],
      actor_id: Number(me.id),
      guarded: false,
    });
    await this.configs.recordTest(cfg.id, out.status === 'sent', out.status === 'sent' ? null : out.reason);
    return {
      mode: 'send',
      ok: out.status === 'sent',
      message: out.status === 'sent'
        ? `Accepted by ${spec.label} for delivery to ${to}.`
        : (out.reason || `Test ${out.status}`),
      caveat: out.status === 'sent' ? spec.testCaveat : undefined,
      ...out,
    };
  }

  /* ------------------------- WHATSAPP EMBEDDED SIGNUP ------------------------- */

  /**
   * What the browser needs to open Meta's dialog (app id + config id). The app SECRET
   * is never part of this response — the code exchange happens server-side.
   */
  @Get('whatsapp/embedded-signup')
  @RequirePermission('settings.read')
  signupInfo() {
    return this.signup.launchInfo();
  }

  /**
   * The browser posts back Meta's one-time `code` plus the phone_number_id / waba_id it
   * received on the postMessage. We exchange it for a PERMANENT token, store it encrypted
   * and subscribe the webhook. The client never handles a token.
   */
  @Post('whatsapp/embedded-signup')
  @RequirePermission('settings.update')
  signupExchange(@Body() dto: any, @CurrentUser() me: Me) {
    return this.signup.exchange(dto ?? {}, Number(me.id));
  }
}
