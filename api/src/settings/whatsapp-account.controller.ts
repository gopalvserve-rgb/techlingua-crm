import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { WhatsAppAccountService } from './whatsapp-account.service';

interface Me { id: number; name: string }

/**
 * ENGAGEMENT › WHATSAPP ACCOUNT. Same gate as the rest of Settings: `settings.read` to
 * look, `settings.update` to change anything — Super Admin / Organization Admin only
 * (migration 026). The verify token rides on the read, so the read is admin-only too.
 */
@Controller('settings/whatsapp/account')
export class WhatsAppAccountController {
  constructor(private readonly account: WhatsAppAccountService) {}

  /** Numbers, the connected card and webhook health — from storage, no Graph call. */
  @Get()
  @RequirePermission('settings.read')
  get() {
    return this.account.account();
  }

  /** "Sync from Meta" — re-pull the WABA's numbers; labels and the default survive. */
  @Post('sync')
  @RequirePermission('settings.update')
  sync(@Body() dto: any, @CurrentUser() me: Me) {
    return this.account.sync(Number(dto?.config_id), Number(me.id));
  }

  /** Edit a label / "Set default" (which re-points the sender). */
  @Post('number')
  @RequirePermission('settings.update')
  number(@Body() dto: any, @CurrentUser() me: Me) {
    return this.account.updateNumber(dto ?? {}, Number(me.id));
  }

  /** "Register phone" — Cloud API registration with the 6-digit PIN. */
  @Post('register')
  @RequirePermission('settings.update')
  register(@Body() dto: any) {
    return this.account.register(dto ?? {});
  }

  /** "Verify" — a read-only probe. It records a test result, so it is a write permission. */
  @Post('verify')
  @RequirePermission('settings.update')
  verify(@Body() dto: any) {
    return this.account.verify(Number(dto?.config_id));
  }

  /** Remove one number, or disconnect WhatsApp entirely. */
  @Post('disconnect')
  @RequirePermission('settings.update')
  disconnect(@Body() dto: any, @CurrentUser() me: Me) {
    return this.account.disconnect(dto ?? {}, Number(me.id));
  }
}
