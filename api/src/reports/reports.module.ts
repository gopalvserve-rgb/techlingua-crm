import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { StandardReportService } from './standard.service';
import { ExportService } from './export.service';
import { ExportWorker } from './export.worker';
import { ScheduleService } from './schedule.service';
import { ScheduleWorker } from './schedule.worker';

/**
 * Analytics & Reports.
 *
 * MessagingModule is imported for the SCHEDULED DELIVERY path only — a report email is
 * queued through the ONE Sprint-4 pipeline (same table, same worker, same rate limit,
 * same send log, same "not configured" behaviour). There is no second mailer here.
 *
 * The provider list is the thing app-wiring.spec.ts compiles for real. Sprint 5's live
 * smoke found the API CRASHING ON BOOT because EnrolmentsModule forgot to provide
 * SettingsService, and no spec caught it — every one of them built its service by hand
 * with doubles, so the Nest INJECTOR, the actual broken thing, was never exercised.
 * That test now compiles the real AppModule, which is why this list gets to be boring.
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule],
  controllers: [ReportController],
  providers: [ReportService, StandardReportService, ExportService, ExportWorker, ScheduleService, ScheduleWorker],
  exports: [ReportService, StandardReportService],
})
export class ReportsModule {}
