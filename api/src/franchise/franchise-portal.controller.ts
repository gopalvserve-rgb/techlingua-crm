import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { FranchiseAccessService } from './franchise-access.service';
import { FranchisePortalService } from './franchise-portal.service';
import { FranchiseTargetService } from './franchise-target.service';
import { FranchiseComplianceService } from './franchise-compliance.service';

type Me = { id: number };
const str = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
const int = (v?: string | string[]) => { const n = Number(str(v)); return Number.isFinite(n) ? n : 0; };

/**
 * FRANCHISE PORTAL · TARGETS · COMPLIANCE (Phase 4 Batch 3).
 *
 * Partner self-service portal (franchise-owner view, auto-scoped to their franchise),
 * franchise targets & performance (target-vs-actual + leaderboard) and the per-franchise
 * compliance checklist + audit view. Franchise owners are additionally constrained by the
 * FranchiseAccessService guard (they cannot address another franchise by id).
 */
@Controller()
export class FranchisePortalController {
  constructor(
    private readonly portal: FranchisePortalService,
    private readonly targets: FranchiseTargetService,
    private readonly compliance: FranchiseComplianceService,
    private readonly access: FranchiseAccessService,
  ) {}

  // ------------------------------------------------------- partner portal (owner)
  @Get('franchise-portal/me')
  @RequirePermission('franchise_portal.read')
  portalMe(@CurrentUser() me: Me, @Query() q: Record<string, string | string[]>) {
    return this.portal.me(me.id, { from: str(q.from), to: str(q.to) });
  }

  @Get('franchise-portal/royalty-invoices')
  @RequirePermission('franchise_portal.read')
  portalInvoices(@CurrentUser() me: Me) { return this.portal.royaltyInvoices(me.id); }

  // ------------------------------------------------------- targets & performance
  @Get('franchise-targets')
  @RequirePermission('franchise_target.read')
  async targetList(@CurrentUser() me: Me, @Query() q: Record<string, string | string[]>) {
    const constraint = await this.access.listConstraint(me.id);
    return this.targets.list(q.franchise_id ? int(q.franchise_id) : undefined, constraint);
  }

  @Get('franchise-targets/leaderboard')
  @RequirePermission('franchise_target.read')
  async targetLeaderboard(@CurrentUser() me: Me) {
    const constraint = await this.access.listConstraint(me.id);
    return this.targets.leaderboard(constraint);
  }

  @Get('franchise-targets/:id/performance')
  @RequirePermission('franchise_target.read')
  async targetPerf(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    const perf = await this.targets.performance(id);
    await this.access.assertCanAccess(me.id, perf.target.franchise_id);
    return perf;
  }

  @Post('franchise-targets')
  @RequirePermission('franchise_target.manage')
  targetSave(@Body() dto: any, @CurrentUser() me: Me) { return this.targets.save(dto, me); }

  @Delete('franchise-targets/:id')
  @RequirePermission('franchise_target.manage')
  targetRemove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.targets.remove(id, me); }

  // ------------------------------------------------------- compliance & audits
  @Get('franchises/:id/compliance')
  @RequirePermission('franchise_compliance.read')
  async compList(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.compliance.list(id);
  }

  @Post('franchises/:id/compliance/items/:itemId')
  @RequirePermission('franchise_compliance.manage')
  async compStatus(@Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number, @Body() dto: any, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.compliance.setStatus(id, itemId, dto, me);
  }

  @Post('franchises/:id/compliance/items')
  @RequirePermission('franchise_compliance.manage')
  async compAdd(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.compliance.addItem(id, dto);
  }

  @Delete('franchises/:id/compliance/items/:itemId')
  @RequirePermission('franchise_compliance.manage')
  async compRemove(@Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.compliance.removeItem(id, itemId);
  }

  @Post('franchise-compliance/upload-url')
  @RequirePermission('franchise_compliance.manage')
  compUploadUrl(@Body() dto: any) { return this.compliance.uploadUrl(dto); }

  @Get('franchise-audit')
  @RequirePermission('franchise_compliance.read')
  async auditView(@CurrentUser() me: Me, @Query() q: Record<string, string | string[]>) {
    const fid = q.franchise_id ? int(q.franchise_id) : undefined;
    if (fid) await this.access.assertCanAccess(me.id, fid);
    const constraint = await this.access.listConstraint(me.id);
    // An owner with no franchise_id filter still only sees THEIR franchises' audit rows.
    if (!fid && constraint && constraint.length) {
      const merged = await Promise.all(constraint.map((f) => this.compliance.audit({ franchiseId: f, limit: q.limit ? int(q.limit) : 100 })));
      return merged.flat().sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, q.limit ? int(q.limit) : 100);
    }
    return this.compliance.audit({ franchiseId: fid, limit: q.limit ? int(q.limit) : 100 });
  }
}
