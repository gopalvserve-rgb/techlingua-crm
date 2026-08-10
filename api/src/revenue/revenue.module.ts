import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { RevenueService } from './revenue.service';
import { RevenueController } from './revenue.controller';
import { CollectionReportService } from './collection-report.service';
import { CollectionReportController } from './collection-report.controller';

/**
 * PHASE 3 BATCH 4 — Revenue (collection vs accrual) + Collection Reports + Tally export.
 * Collection is net of APPROVED refunds; accrual is the net fee of enrolments recognised
 * in the period. The collection reports reuse RevenueService.collection and export to
 * Excel/CSV/PDF; the Tally export emits Receipt/Payment vouchers as importable XML.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [RevenueController, CollectionReportController],
  providers: [RevenueService, CollectionReportService],
  exports: [RevenueService, CollectionReportService],
})
export class RevenueModule {}
