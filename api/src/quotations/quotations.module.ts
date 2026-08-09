import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { TemplatesModule } from '../templates/templates.module';
import { QuotationController } from './quotation.controller';
import { QuotationExpiryWorker } from './quotation.worker';
import { QuotationService } from './quotation.service';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule, TemplatesModule, FinanceModule],
  controllers: [QuotationController],
  providers: [QuotationService, QuotationExpiryWorker],
  exports: [QuotationService],
})
export class QuotationsModule {}
