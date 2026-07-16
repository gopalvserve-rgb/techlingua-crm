import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalService } from './approval.service';
import { EnrolmentController } from './enrolment.controller';
import { EnrolmentService } from './enrolment.service';

@Module({
  imports: [DatabaseModule, RbacModule, NotificationsModule],
  controllers: [EnrolmentController],
  providers: [EnrolmentService, ApprovalService],
  exports: [EnrolmentService, ApprovalService],
})
export class EnrolmentsModule {}
