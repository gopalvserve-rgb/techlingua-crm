import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from '../common/settings.service';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [MessagingModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
