import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { FinanceModule } from '../finance/finance.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { InvoiceService } from './invoice.service';
import { InvoiceController } from './invoice.controller';

/**
 * INVOICES — Phase 3 Batch 1. GST tax invoices raised against an enrolment/fee (or
 * ad-hoc): CGST/SGST vs IGST, HSN/SAC, place of supply, per-branch/vertical FY numbering,
 * branded PDF, RBAC invoice.* + scope.
 */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule, FinanceModule, NotificationEventsModule],
  controllers: [InvoiceController],
  providers: [InvoiceService],
  exports: [InvoiceService],
})
export class InvoicesModule {}
