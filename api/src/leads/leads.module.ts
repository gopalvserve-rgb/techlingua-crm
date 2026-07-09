import { Module } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { FollowUpsService } from './followups.service';
import { FollowUpsController, LeadsController } from './leads.controller';

@Module({
  controllers: [LeadsController, FollowUpsController],
  providers: [LeadsService, FollowUpsService],
})
export class LeadsModule {}
