import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

/** NotificationsModule for the announcement bell — the SPRINT-3 notifier, not a second
 *  one. An announcement is not special enough to deserve its own delivery mechanism. */
@Module({
  imports: [DatabaseModule, RbacModule, NotificationsModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
