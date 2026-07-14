import { Module } from '@nestjs/common';
import { ScoringService } from './scoring.service';
import { ScoringController } from './scoring.controller';
import { SettingsService } from '../common/settings.service';

@Module({
  controllers: [ScoringController],
  providers: [ScoringService, SettingsService],
  exports: [ScoringService, SettingsService],
})
export class ScoringModule {}
