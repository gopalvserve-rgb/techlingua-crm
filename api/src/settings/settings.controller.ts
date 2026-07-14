import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { SettingsService } from '../common/settings.service';
import { DatabaseService } from '../database/database.service';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { MsgChannel } from '../messaging/providers';
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
   * SEND TEST MESSAGE. The single most useful button on this screen: it proves the
   * credentials work BEFORE a journey uses them on a real lead. A not-configured channel
   * answers with a clean 503 naming exactly what is missing.
   */
  @Post('channels/test')
  @RequirePermission('settings.update')
  async test(@Body() dto: any, @CurrentUser() me: Me) {
    const channel = String(dto?.channel ?? '') as MsgChannel;
    if (!['email', 'sms', 'whatsapp'].includes(channel)) {
      throw new BadRequestException('Only Email, SMS and WhatsApp can be test-sent.');
    }
    const to = String(dto?.to ?? '').trim();
    if (!to) throw new BadRequestException('Where should the test go? Enter your own email or mobile number.');
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;

    // throws NotConfiguredException (503 + the reason) when a credential is missing
    const cfg = await this.configs.require(channel, verticalId);

    const out = await this.messaging.sendNow({
      channel,
      to,
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
    return out;
  }
}
