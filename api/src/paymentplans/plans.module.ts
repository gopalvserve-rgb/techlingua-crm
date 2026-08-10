import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { PlanService } from './plan.service';
import { PlanController } from './plan.controller';
import { DuesService } from './dues.service';
import { DuesController } from './dues.controller';
import { FeeReminderWorker } from './reminder.worker';
import { FeeReminderConfigController } from './config.controller';

/**
 * PAYMENT PLANS + FEE DUES & AGEING + AUTO REMINDERS — Phase 3 Batch 2.
 *
 * PlanService is EXPORTED so FeesModule can apply/reverse a receipt against the
 * installment schedule inside the collect/delete transaction (no second money path).
 * MessagingModule gives the reminder worker the send queue (WhatsApp/SMS/Email) + the
 * settings store; it degrades cleanly when a channel is unconfigured.
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule],
  controllers: [PlanController, DuesController, FeeReminderConfigController],
  providers: [PlanService, DuesService, FeeReminderWorker],
  exports: [PlanService],
})
export class PlansModule {}
