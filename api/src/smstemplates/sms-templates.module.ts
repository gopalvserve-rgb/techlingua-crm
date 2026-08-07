import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { SmsTemplateService } from './sms-template.service';
import { SmsTemplateController } from './sms-template.controller';

/**
 * The SMS Template master + the Nimbus auto-send-on-new-lead. Imports MessagingModule to
 * reuse the send pipeline (queue/deliver, opt-out, rate-limit/retry, message_log) and the
 * credential store — the auto-send builds on the existing SMS channel, it does not fork it.
 * Exported so IngestionModule can hook the auto-send in the one shared post-create path.
 */
@Module({
  imports: [MessagingModule],
  controllers: [SmsTemplateController],
  providers: [SmsTemplateService],
  exports: [SmsTemplateService],
})
export class SmsTemplatesModule {}
