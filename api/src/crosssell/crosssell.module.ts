import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { TemplatesModule } from '../templates/templates.module';
import { CrossSellController } from './crosssell.controller';
import { CrossSellService } from './crosssell.service';
import { CrossSellOpportunityService } from './opportunity.service';

@Module({
  imports: [DatabaseModule, RbacModule, IngestionModule, TemplatesModule],
  controllers: [CrossSellController],
  providers: [CrossSellService, CrossSellOpportunityService],
})
export class CrossSellModule {}
