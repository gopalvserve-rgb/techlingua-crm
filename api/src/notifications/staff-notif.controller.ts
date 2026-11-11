import { Body, Controller, Get, NotFoundException, Param, Patch, Put } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { StaffEventsService } from './staff-events.service';

/**
 * Administration › Notification Settings (client 11 Nov 2026) — the per-event staff
 * notification rules + the module / channel master switches. Read with
 * notification_event.read, change with notification_event.manage (the same permission the
 * customer-facing Notification Events screen uses).
 */
@Controller('notification-settings')
export class StaffNotifController {
  constructor(private readonly staff: StaffEventsService) {}

  @Get() @RequirePermission('notification_event.read')
  list() { return this.staff.listRules(); }

  @Put('global') @RequirePermission('notification_event.manage')
  saveGlobal(@Body() dto: any, @CurrentUser() u: { id: number }) { return this.staff.saveGlobal(dto, u.id); }

  @Patch(':key') @RequirePermission('notification_event.manage')
  async saveRule(@Param('key') key: string, @Body() dto: any, @CurrentUser() u: { id: number }) {
    const r = await this.staff.saveRule(key, dto, u.id);
    if (!r) throw new NotFoundException('Unknown notification event');
    return r;
  }
}
