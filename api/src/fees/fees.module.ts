import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { FeeController } from './fee.controller';
import { FeeService } from './fee.service';
import { PlansModule } from '../paymentplans/plans.module';
import { NotificationEventsModule } from '../notificationevents/notification-events.module';

@Module({
  imports: [DatabaseModule, RbacModule, PlansModule, NotificationEventsModule],
  controllers: [FeeController],
  providers: [FeeService],
  exports: [FeeService],
})
export class FeesModule {}
