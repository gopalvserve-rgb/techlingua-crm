import { Module } from '@nestjs/common';
import { NotificationEventService } from './notification-event.service';
import { NotificationEventController } from './notification-event.controller';
import { TemplatesModule } from '../templates/templates.module';
import { MessagingModule } from '../messaging/messaging.module';

/**
 * The curated, event-driven layer over the notifier/messaging stack. It renders the mapped
 * template (TemplatesModule) and queues it through the durable send log (MessagingModule),
 * so it grows no second send path.
 */
@Module({
  imports: [TemplatesModule, MessagingModule],
  controllers: [NotificationEventController],
  providers: [NotificationEventService],
  exports: [NotificationEventService],
})
export class NotificationEventsModule {}
