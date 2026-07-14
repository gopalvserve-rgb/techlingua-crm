import { Module, forwardRef } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { ChannelConfigService } from './channel-config.service';
import { MessageWorker } from './message.worker';
import { MessagingController, WhatsAppWebhookController } from './messaging.controller';
import { SettingsService } from '../common/settings.service';
import { TemplatesModule } from '../templates/templates.module';

/**
 * The outbound side: WhatsApp (Meta Cloud) · SMS (any gateway) · Email (per-vertical SMTP),
 * their credential store (`channel_config`), the durable send log + queue (`message_log`)
 * and the worker that drains it.
 *
 * `forwardRef` to TemplatesModule: the controller renders templates, and TemplateService
 * queues messages. That is a genuine two-way relationship (a template is only useful
 * because it can be sent; a send is only safe because it was rendered), not a design smell.
 */
@Module({
  imports: [forwardRef(() => TemplatesModule)],
  controllers: [MessagingController, WhatsAppWebhookController],
  providers: [MessagingService, ChannelConfigService, MessageWorker, SettingsService],
  exports: [MessagingService, ChannelConfigService, SettingsService],
})
export class MessagingModule {}
