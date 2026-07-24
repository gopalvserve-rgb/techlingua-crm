import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsService } from '../common/settings.service';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule, NotificationsModule],
  controllers: [SupportController],
  providers: [SupportService, SettingsService],
})
export class SupportModule {}
