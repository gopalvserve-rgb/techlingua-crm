import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { NotificationEventService } from './notification-event.service';

interface Me { id: number }

/**
 * NOTIFICATION EVENTS configuration API. Read is wide (managers see what fires); the
 * per-channel toggle + template mapping is admin/marketing only (RBAC on the routes).
 */
@Controller('notification-events')
export class NotificationEventController {
  constructor(private readonly svc: NotificationEventService) {}

  @Get()
  @RequirePermission('notification_event.read')
  list(@Query('category') category?: string, @Query('channel') channel?: string, @Query('enabled') enabled?: string) {
    return this.svc.list({ category, channel, enabled });
  }

  @Get('catalog')
  @RequirePermission('notification_event.read')
  catalog() { return this.svc.catalog(); }

  @Get(':key')
  @RequirePermission('notification_event.read')
  get(@Param('key') key: string) { return this.svc.get(key); }

  @Patch(':key')
  @RequirePermission('notification_event.update')
  update(@Param('key') key: string, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.updateConfig(key, dto, Number(me.id));
  }
}
