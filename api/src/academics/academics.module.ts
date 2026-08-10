import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AssessmentController } from './assessment.controller';
import { AssessmentService } from './assessment.service';
import { CourseworkController } from './coursework.controller';
import { CourseworkService } from './coursework.service';

/**
 * Phase 2 ERP Batch 1 — Academics core: batch transfer + waitlist, attendance (with parent
 * absence alerts via MessagingModule), tests & scores, and assignments (coursework).
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule, NotificationEventsModule],
  controllers: [TransferController, AttendanceController, AssessmentController, CourseworkController],
  providers: [TransferService, AttendanceService, AssessmentService, CourseworkService],
})
export class AcademicsModule {}
