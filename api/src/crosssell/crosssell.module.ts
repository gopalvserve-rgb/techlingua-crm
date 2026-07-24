import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { CrossSellController } from './crosssell.controller';
import { CrossSellService } from './crosssell.service';

@Module({
  imports: [DatabaseModule, RbacModule, IngestionModule],
  controllers: [CrossSellController],
  providers: [CrossSellService],
})
export class CrossSellModule {}
