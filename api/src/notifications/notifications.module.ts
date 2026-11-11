import { Global, Module } from '@nestjs/common';
import { StaffEventsService } from './staff-events.service';
import { StaffNotifController } from './staff-notif.controller';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotifierService } from './notifier.service';
import { ManagerResolverService } from './manager-resolver.service';
import { ReminderWorker } from './reminder.worker';
import { ScoringModule } from '../scoring/scoring.module';
import { MessagingModule } from '../messaging/messaging.module';

/**
 * Notifications + the Sprint-3 sweeps (reminders · overdue escalation · SLA breaches ·
 * score ageing). The worker is in-process on the API, exactly like the Sprint-2
 * ingestion worker — one topology, not two (decision log #22).
 */
// client 11 Nov 2026 — @Global so every module (fees, admissions, academics …) can fire staff events.
@Global()
@Module({
  // Sprint 4: the notifier's email/sms/whatsapp channels queue through MessagingService,
  // so a reminder email and a journey's email are the same row, the same worker, one log.
  imports: [ScoringModule, MessagingModule],
  controllers: [NotificationController, StaffNotifController],
  providers: [NotificationService, NotifierService, ManagerResolverService, ReminderWorker, StaffEventsService],
  exports: [NotificationService, NotifierService, ManagerResolverService, StaffEventsService],
})
export class NotificationsModule {}
