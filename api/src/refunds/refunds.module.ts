import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NumberingModule } from '../numbering/numbering.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { SettingsService } from '../common/settings.service';
import { RefundService } from './refund.service';
import { RefundController } from './refund.controller';

/**
 * PHASE 3 BATCH 4 — Refunds with an approval hierarchy. Reuses the enrolment optional-
 * approval PATTERN (a policy in one app_setting row via SettingsService — provided here as
 * it is NOT global — the SAME NotifierService, the SAME self-approval bar) and the numbering
 * series (REF-, per branch/vertical, reset per Indian FY). Approved refunds net down the
 * collection everywhere (revenue view, finance dashboard, collection reports).
 */
@Module({
  imports: [DatabaseModule, RbacModule, NotificationsModule, NumberingModule, NotificationEventsModule],
  controllers: [RefundController],
  providers: [RefundService, SettingsService],
  exports: [RefundService],
})
export class RefundsModule {}
