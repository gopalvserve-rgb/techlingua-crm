import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { FranchiseService } from './franchise.service';
import { RoyaltyService } from './royalty.service';
import { FranchiseAccessService } from './franchise-access.service';

type Me = { id: number };
const str = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
const int = (v?: string | string[]) => { const n = Number(str(v)); return Number.isFinite(n) ? n : 0; };

/**
 * FRANCHISE & ROYALTY (Phase 4 Batch 1). Franchise CRUD + branch mapping, a scope
 * resolver (branch_ids), the per-franchise dashboard rollup, royalty-plan CRUD and
 * the royalty statement. Admin-only in this batch (see migration 105 grants).
 */
@Controller()
export class FranchiseController {
  constructor(
    private readonly franchises: FranchiseService,
    private readonly royalty: RoyaltyService,
    private readonly access: FranchiseAccessService,
  ) {}

  // -------------------------------------------------------------- franchises
  @Get('franchises')
  @RequirePermission('franchise.read')
  async list(@CurrentUser() me: Me) {
    const all = await this.franchises.list();
    const constraint = await this.access.listConstraint(me.id);
    return constraint ? all.filter((f) => constraint.includes(f.id)) : all;
  }

  @Get('franchises/:id')
  @RequirePermission('franchise.read')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.franchises.get(id);
  }

  @Get('franchises/:id/scope')
  @RequirePermission('franchise.read')
  async scope(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.franchises.scope(id);
  }

  @Get('franchises/:id/dashboard')
  @RequirePermission('franchise.read')
  async dashboard(@Param('id', ParseIntPipe) id: number, @Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.franchises.dashboard(id, { from: str(q.from), to: str(q.to) });
  }

  @Get('franchises/:id/royalty/statement')
  @RequirePermission('royalty.read')
  async statement(@Param('id', ParseIntPipe) id: number, @Query() q: Record<string, string | string[]>, @CurrentUser() me: Me) {
    await this.access.assertCanAccess(me.id, id);
    return this.royalty.statement(id, {
      from: str(q.from), to: str(q.to),
      plan_id: q.plan_id ? int(q.plan_id) : undefined,
      adjustments_minor: q.adjustments_minor ? Math.trunc(Number(str(q.adjustments_minor))) : 0,
    });
  }

  @Post('franchises')
  @RequirePermission('franchise.create')
  save(@Body() dto: any, @CurrentUser() me: Me) { return this.franchises.save(dto, me); }

  @Delete('franchises/:id')
  @RequirePermission('franchise.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.franchises.remove(id, me); }

  // ------------------------------------------------------------ royalty plans
  @Get('royalty-plans')
  @RequirePermission('royalty.read')
  planList(@Query() q: Record<string, string | string[]>) {
    return this.royalty.list(q.franchise_id ? int(q.franchise_id) : undefined);
  }

  @Get('royalty-plans/:id')
  @RequirePermission('royalty.read')
  planGet(@Param('id', ParseIntPipe) id: number) { return this.royalty.get(id); }

  @Get('royalty-plans/:id/compute')
  @RequirePermission('royalty.read')
  planCompute(@Param('id', ParseIntPipe) id: number, @Query() q: Record<string, string | string[]>) {
    return this.royalty.compute(
      id,
      Math.trunc(Number(str(q.gross_minor ?? q.gross)) || 0),
      Math.trunc(Number(str(q.refunds_minor ?? q.refunds)) || 0),
      Math.max(1, Math.trunc(Number(str(q.months)) || 1)),
    );
  }

  @Post('royalty-plans')
  @RequirePermission('royalty.manage')
  planSave(@Body() dto: any, @CurrentUser() me: Me) { return this.royalty.save(dto, me); }

  @Delete('royalty-plans/:id')
  @RequirePermission('royalty.manage')
  planRemove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.royalty.remove(id, me); }
}
