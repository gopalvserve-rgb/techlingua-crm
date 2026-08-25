import { ForbiddenException, Injectable } from '@nestjs/common';
import { FranchiseService } from './franchise.service';
import { FranchiseAccessService } from './franchise-access.service';
import { RoyaltyInvoiceService } from './royalty-invoice.service';
import { FranchiseComplianceService } from './franchise-compliance.service';
import { FranchiseTargetService } from './franchise-target.service';

/**
 * PARTNER SELF-SERVICE PORTAL (Phase 4 Batch 3).
 *
 * The franchise-owner landing, FIXED to the logged-in owner's franchise (no selector).
 * It reuses the Batch-1/2 rollups (dashboard, royalty outstanding) + the new target &
 * compliance summaries, all scoped to the owner's own franchise. Head office keeps the
 * full Franchise module (all franchises); this is the owner's read-only view of theirs.
 */
@Injectable()
export class FranchisePortalService {
  constructor(
    private readonly franchises: FranchiseService,
    private readonly access: FranchiseAccessService,
    private readonly invoices: RoyaltyInvoiceService,
    private readonly compliance: FranchiseComplianceService,
    private readonly targets: FranchiseTargetService,
  ) {}

  /** The owner's primary franchise id (their first). Throws 403 if the user owns none. */
  private async myFranchiseId(userId: number): Promise<number> {
    const ids = await this.access.ownerFranchiseIds(userId);
    if (!ids.length) throw new ForbiddenException('No franchise is linked to your account.');
    return ids[0];
  }

  /** The portal landing payload — the owner's franchise dashboard + summaries. */
  async me(userId: number, opts: { from?: string; to?: string } = {}) {
    const franchiseId = await this.myFranchiseId(userId);
    const allIds = await this.access.ownerFranchiseIds(userId);
    const dashboard = await this.franchises.dashboard(franchiseId, opts);
    const outstanding = await this.invoices.outstanding(franchiseId).catch(() => null);
    const compliance = (await this.compliance.list(franchiseId)).summary;
    const targets = await this.targets.leaderboard(allIds).catch(() => []);
    return {
      franchise_ids: allIds,
      franchise: dashboard.franchise,
      dashboard,
      royalty_outstanding: outstanding,
      compliance,
      targets,
    };
  }

  async royaltyInvoices(userId: number) {
    const franchiseId = await this.myFranchiseId(userId);
    return this.invoices.list(franchiseId);
  }

  async royaltyStatement(userId: number, opts: { from?: string; to?: string } = {}) {
    const franchiseId = await this.myFranchiseId(userId);
    return this.franchises.dashboard(franchiseId, opts);
  }
}
