import { Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';

type U = { id: number };

/**
 * The notification CENTRE (the bell). Every route is hard-scoped to the caller's own
 * user_id inside the SQL — there is no parameter by which one user reads another's
 * notifications, so `notification.read` is granted at 'own' scope to every role.
 */
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get() @RequirePermission('notification.read')
  list(@CurrentUser() u: U, @Query('unread') unread?: string, @Query('limit') limit?: string) {
    return this.notifications.list(u.id, {
      unread: unread === '1' || unread === 'true',
      limit: Number(limit) || 30,
    });
  }

  /** The bell's badge. */
  @Get('count') @RequirePermission('notification.read')
  count(@CurrentUser() u: U) { return this.notifications.unreadCount(u.id); }

  @Patch(':id/read') @RequirePermission('notification.read')
  markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.notifications.markRead(id, u.id);
  }

  @Post('read-all') @RequirePermission('notification.read')
  markAll(@CurrentUser() u: U) { return this.notifications.markAllRead(u.id); }
}
