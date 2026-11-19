import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocTemplateController } from './doc-template.controller';
import { DocTemplateService } from './doc-template.service';
import { DocBuilderService } from './doc-builder.service';
import { DocBuilderController, DocVerifyController } from './doc-builder.controller';

/** Global so the PDF/ID generators (fees, invoices, students, HR) can inject DocTemplateService.
 *  12 Nov 2026: + the document builder (Template Management) and the public QR verification. */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [DocTemplateController, DocBuilderController, DocVerifyController],
  providers: [DocTemplateService, DocBuilderService],
  exports: [DocTemplateService, DocBuilderService],
})
export class DocTemplatesModule {}
