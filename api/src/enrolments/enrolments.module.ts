import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsService } from '../common/settings.service';
import { NumberingModule } from '../numbering/numbering.module';
import { ApprovalService } from './approval.service';
import { EnrolmentController } from './enrolment.controller';
import { EnrolmentService } from './enrolment.service';
import { FinanceModule } from '../finance/finance.module';
import { PlansModule } from '../paymentplans/plans.module';

/**
 * ApprovalService reads the `enrolment_approvals` policy through SettingsService, which
 * is NOT global — every module that uses it provides it itself (see scoring.module,
 * calendar.module, messaging.module). Omitting it here crashed the API ON BOOT with
 * "Nest can't resolve dependencies of the ApprovalService ... argument SettingsService
 * at index [1]".
 *
 * Worth recording WHY 1025 green unit tests said nothing: every spec constructs its
 * service directly (`new ApprovalService(db, settings, resolver)`) with hand-made
 * doubles, so the Nest INJECTOR — the thing that was broken — was never exercised. Only
 * booting the real container falsifies this, which is precisely the "green unit tests do
 * not catch what only the live app can" lesson from Sprints 3-5. `enrolments.module.spec.ts`
 * now compiles this module for real, so it cannot regress silently.
 */
@Module({
  imports: [DatabaseModule, RbacModule, NotificationsModule, NumberingModule, FinanceModule, PlansModule],
  controllers: [EnrolmentController],
  providers: [EnrolmentService, ApprovalService, SettingsService],
  exports: [EnrolmentService, ApprovalService],
})
export class EnrolmentsModule {}
