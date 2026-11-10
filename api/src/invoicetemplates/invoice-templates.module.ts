import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InvoiceTemplateController } from './invoice-template.controller';
import { InvoiceTemplateService } from './invoice-template.service';

/**
 * FEE INVOICE TEMPLATE BUILDER (client 5 Nov 2026). Global so InvoiceService can render an
 * invoice with its template without importing this module (which itself imports InvoicesModule
 * for the scope-checked "preview with a real invoice").
 */
@Global()
@Module({
  imports: [DatabaseModule, RbacModule, InvoicesModule],
  controllers: [InvoiceTemplateController],
  providers: [InvoiceTemplateService],
  exports: [InvoiceTemplateService],
})
export class InvoiceTemplatesModule {}
