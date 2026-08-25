import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FranchiseController } from './franchise.controller';
import { FranchiseOpsController } from './franchise-ops.controller';
import { FranchiseService } from './franchise.service';
import { RoyaltyService } from './royalty.service';
import { RoyaltyInvoiceService } from './royalty-invoice.service';
import { AgreementService } from './agreement.service';
import { OnboardingService, TerritoryService } from './franchise-lifecycle.service';

/**
 * FRANCHISE & ROYALTY.
 *   Batch 1 (dev/136) — franchise records + branch mapping, the scope resolver, the
 *   per-franchise dashboard rollup, royalty-plan CRUD and the royalty statement.
 *   Batch 2 (dev/137) — royalty INVOICING + collection + outstanding ageing + franchise
 *   reports, agreements & renewals, onboarding checklist and territory mapping.
 *
 * RbacDataService, NumberingService and StorageService are all @Global, so guards,
 * the ROY- numbering series and R2 uploads resolve without extra imports here.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FranchiseController, FranchiseOpsController],
  providers: [
    FranchiseService, RoyaltyService, RoyaltyInvoiceService,
    AgreementService, OnboardingService, TerritoryService,
  ],
  exports: [FranchiseService, RoyaltyService, RoyaltyInvoiceService],
})
export class FranchiseModule {}
