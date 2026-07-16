import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { SettingsService } from '../common/settings.service';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [MessagingModule],
  controllers: [CalendarController],
  providers: [CalendarService, SettingsService],
  exports: [CalendarService],
})
export class CalendarModule {}
