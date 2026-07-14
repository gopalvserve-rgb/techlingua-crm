import { Module, forwardRef } from '@nestjs/common';
import { TemplateService } from './template.service';
import { TemplateController } from './template.controller';
import { MessagingModule } from '../messaging/messaging.module';

/** forwardRef: see the note in messaging.module.ts — templates send, sends render. */
@Module({
  imports: [forwardRef(() => MessagingModule)],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplatesModule {}
