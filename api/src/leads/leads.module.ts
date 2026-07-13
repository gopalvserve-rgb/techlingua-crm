import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { LeadsService } from './leads.service';
import { FollowUpsService } from './followups.service';
import { FollowUpsController, LeadsController } from './leads.controller';

@Module({
  imports: [IngestionModule],
  controllers: [LeadsController, FollowUpsController],
  providers: [LeadsService, FollowUpsService],
})
export class LeadsModule {}
