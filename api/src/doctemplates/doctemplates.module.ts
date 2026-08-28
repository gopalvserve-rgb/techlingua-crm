import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DocTemplateController } from './doc-template.controller';
import { DocTemplateService } from './doc-template.service';

/** Global so the PDF/ID generators (fees, invoices, students, HR) can inject DocTemplateService. */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [DocTemplateController],
  providers: [DocTemplateService],
  exports: [DocTemplateService],
})
export class DocTemplatesModule {}
