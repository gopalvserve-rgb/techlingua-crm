import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { AiModule } from '../ai/ai.module';
import { PlansModule } from '../paymentplans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { BotsService } from './bots.service';
import { ScholarshipService } from './scholarship.service';
import { SharedDocsService } from './shared-docs.service';
import { PayrollService } from './payroll.service';
import { InsightsService } from './insights.service';
import {
  BotsController, InsightsController, PayrollController, ScholarshipController, SharedDocsController,
} from './completion.controller';

/**
 * MODULE COMPLETION (client, Oct 2026 — "many modules still show Phase 2 pending"). The screens
 * that were design placeholders, made working: WhatsBot + AI Bot, Scholarships, Shared
 * Documents, Salary, Keyword Tracking / AI Usage / AI Settings, Forecasting, Duplicate Rules
 * and Compliance. Migration 125.
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule, AiModule, PlansModule, StorageModule],
  controllers: [BotsController, ScholarshipController, SharedDocsController, PayrollController, InsightsController],
  providers: [BotsService, ScholarshipService, SharedDocsService, PayrollService, InsightsService],
})
export class CompletionModule {}
