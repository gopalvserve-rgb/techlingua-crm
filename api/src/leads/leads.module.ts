import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { ScoringModule } from '../scoring/scoring.module';
import { SlaModule } from '../sla/sla.module';
import { LeadsService } from './leads.service';
import { FollowUpsService } from './followups.service';
import { HandoutService } from './handout.service';
import { FollowUpsController, LeadsController } from './leads.controller';
import { HandoutController } from './handout.controller';

@Module({
  imports: [IngestionModule, ScoringModule, SlaModule],
  // HandoutController is mounted BEFORE LeadsController: `GET /leads/handout/...`
  // must not be swallowed by `GET /leads/:id` (the lesson of commit ed9bd07).
  controllers: [HandoutController, LeadsController, FollowUpsController],
  providers: [LeadsService, FollowUpsService, HandoutService],
})
export class LeadsModule {}
