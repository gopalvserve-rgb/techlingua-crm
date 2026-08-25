import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FranchiseController } from './franchise.controller';
import { FranchiseService } from './franchise.service';
import { RoyaltyService } from './royalty.service';

/**
 * FRANCHISE & ROYALTY (Phase 4 Batch 1) — franchise records + branch mapping, the
 * franchise scope resolver, the per-franchise dashboard rollup, royalty-plan CRUD
 * and the royalty statement. RbacDataService is @Global, so guards resolve without
 * an extra import; only DatabaseModule is needed here.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FranchiseController],
  providers: [FranchiseService, RoyaltyService],
  exports: [FranchiseService, RoyaltyService],
})
export class FranchiseModule {}
