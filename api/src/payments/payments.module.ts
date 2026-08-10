import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeesModule } from '../fees/fees.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { RazorpayWebhookController } from './razorpay-webhook.controller';

/**
 * PHASE 3 BATCH 3 — Razorpay online collection (per vertical) + partial payments +
 * auto-receipts. Reuses FeeService.collect (the one money path), ChannelConfigService
 * (the per-vertical encrypted Razorpay key) and NotifierService (payment success/failed).
 */
@Module({
  imports: [DatabaseModule, RbacModule, MessagingModule, NotificationsModule, FeesModule, NotificationEventsModule],
  controllers: [PaymentController, RazorpayWebhookController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentsModule {}
