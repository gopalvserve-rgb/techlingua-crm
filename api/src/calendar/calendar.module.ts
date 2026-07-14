import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { SettingsService } from '../common/settings.service';

@Module({
  controllers: [CalendarController],
  providers: [CalendarService, SettingsService],
  exports: [CalendarService],
})
export class CalendarModule {}
