import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { FeeController } from './fee.controller';
import { FeeService } from './fee.service';
import { PlansModule } from '../paymentplans/plans.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [DatabaseModule, RbacModule, PlansModule, NotificationEventsModule, MessagingModule],
  controllers: [FeeController],
  providers: [FeeService],
  exports: [FeeService],
})
export class FeesModule {}
