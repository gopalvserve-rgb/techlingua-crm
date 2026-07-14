import { Module } from '@nestjs/common';
import { JourneyService } from './journey.service';
import { JourneyController } from './journey.controller';
import { JourneyWorker } from './journey.worker';
import { MessagingModule } from '../messaging/messaging.module';
import { TemplatesModule } from '../templates/templates.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Automation journeys. Deliberately does NOT import LeadsModule: creating a follow-up is
 * one INSERT, and importing it would make Leads -> Journeys -> Leads a cycle. Journeys
 * depend on messaging, templates and the notifier — never on the modules that FIRE them.
 */
@Module({
  imports: [MessagingModule, TemplatesModule, NotificationsModule],
  controllers: [JourneyController],
  providers: [JourneyService, JourneyWorker],
  exports: [JourneyService],
})
export class JourneysModule {}
