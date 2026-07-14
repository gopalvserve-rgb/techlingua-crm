import { Module } from '@nestjs/common';
import { CaptureService } from './capture.service';
import { ReferralController, WalkInController } from './capture.controller';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ScoringModule } from '../scoring/scoring.module';
import { SlaModule } from '../sla/sla.module';

@Module({
  imports: [IngestionModule, ScoringModule, SlaModule],
  controllers: [WalkInController, ReferralController],
  providers: [CaptureService],
  exports: [CaptureService],
})
export class CaptureModule {}
