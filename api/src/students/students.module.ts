import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { FinanceModule } from '../finance/finance.module';
import { MessagingModule } from '../messaging/messaging.module';
import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { BatchController } from './batch.controller';
import { BatchService } from './batch.service';
import { ApprovalService } from '../enrolments/approval.service';
import { SettingsService } from '../common/settings.service';
import { NotificationsModule } from '../notifications/notifications.module';

/** Phase 2 (CRM-level): lead->student conversion, the students directory + dashboard,
 *  and batches bound to Branch->Vertical->Course. */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule, NotificationEventsModule, FinanceModule, MessagingModule, NotificationsModule],
  controllers: [StudentController, BatchController],
  providers: [StudentService, BatchService, ApprovalService, SettingsService],
  exports: [StudentService],
})
export class StudentsModule {}
