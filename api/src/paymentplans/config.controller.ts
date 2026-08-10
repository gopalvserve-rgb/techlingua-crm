import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { SettingsService } from '../common/settings.service';
import { DEFAULT_FEE_REMINDER, FeeReminderConfig } from './reminder.worker';

interface Me { id: number }

/**
 * FEE-REMINDER CONFIG — the offsets/channels the auto-reminder sweep uses. Editable with
 * no deploy (it lives in app_setting). Read with payment_plan.read, write with
 * payment_plan.update (admins/accountant/managers).
 */
@Controller('fee-reminders/config')
export class FeeReminderConfigController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission('payment_plan.read')
  async get(): Promise<FeeReminderConfig> {
    return this.settings.get('fee_reminder_config', DEFAULT_FEE_REMINDER as unknown as Record<string, unknown>) as unknown as Promise<FeeReminderConfig>;
  }

  @Put()
  @RequirePermission('payment_plan.update')
  async set(@Body() dto: any, @CurrentUser() me: Me): Promise<FeeReminderConfig> {
    const clean: FeeReminderConfig = {
      enabled: dto?.enabled !== false,
      channels: (Array.isArray(dto?.channels) ? dto.channels : DEFAULT_FEE_REMINDER.channels).filter((x: string) => ['whatsapp', 'sms', 'email'].includes(x)),
      due_soon_days: [...new Set((Array.isArray(dto?.due_soon_days) ? dto.due_soon_days : []).map((n: unknown) => Math.trunc(Number(n))).filter((n: number) => Number.isFinite(n) && n > 0 && n <= 365))] as number[],
      remind_on_due: dto?.remind_on_due !== false,
      overdue_days: [...new Set((Array.isArray(dto?.overdue_days) ? dto.overdue_days : []).map((n: unknown) => Math.trunc(Number(n))).filter((n: number) => Number.isFinite(n) && n > 0 && n <= 3650))] as number[],
    };
    await this.settings.set('fee_reminder_config', clean as unknown as Record<string, unknown>, me.id);
    return clean;
  }
}
