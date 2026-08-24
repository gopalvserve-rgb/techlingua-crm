import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { PerformanceService, PerfFilter } from './performance.service';
import { TargetService } from './target.service';
import { TargetDefService } from './target-def.service';
import { IncentiveService } from './incentive.service';

interface Me { id: number; name: string }

/** Read the optional Branch / Vertical / Counsellor dashboard filter off the query. */
function perfFilter(q: any): PerfFilter {
  const n = (v: unknown) => (v !== undefined && v !== null && v !== '' ? Number(v) || undefined : undefined);
  return { from: q?.from, to: q?.to, branchId: n(q?.branch_id), verticalId: n(q?.vertical_id), userId: n(q?.user_id) };
}

/**
 * Performance & Conversion › Target & Incentive + Counsellor Performance.
 * Every route carries @RequirePermission — sprint5-rbac.spec.ts enforces it.
 */
@Controller('performance')
export class PerformanceController {
  constructor(
    private readonly perf: PerformanceService,
    private readonly targets: TargetService,
    private readonly targetDefs: TargetDefService,
    private readonly incentive: IncentiveService,
  ) {}

  // ----- Counsellor Performance -----
  @Get('leaderboard')
  @RequirePermission('performance.read')
  leaderboard(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.perf.leaderboard(scope, perfFilter(q));
  }

  @Get('summary')
  @RequirePermission('performance.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.perf.summary(scope, perfFilter(q));
  }

  // ----- Legacy Monthly Target (still feeds the Sprint-3 dashboard bar) -----
  @Get('targets')
  @RequirePermission('target.read')
  targetList(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.targets.list(scope, { period: q?.period, scope_type: q?.scope_type });
  }

  @Get('targets/dashboard')
  @RequirePermission('target.read')
  targetDashboard(@CurrentScope() scope: ResolvedScope, @CurrentUser() me: Me) {
    return this.targets.dashboard(scope, Number(me.id));
  }

  @Post('targets')
  @RequirePermission('target.manage')
  saveTarget(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.targets.save(dto, me, scope);
  }

  @Delete('targets/:id')
  @RequirePermission('target.manage')
  removeTarget(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.targets.remove(id, me, scope);
  }

  // ----- Target & Incentive: rich target definitions (dev/134) -----
  @Get('target-defs')
  @RequirePermission('target.read')
  targetDefList(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.targetDefs.list(scope, { period_type: q?.period_type, target_for: q?.target_for });
  }

  @Get('target-defs/:id/dashboard')
  @RequirePermission('target.read')
  targetDefDashboard(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.targetDefs.dashboard(id, scope);
  }

  @Post('target-defs')
  @RequirePermission('target.manage')
  saveTargetDef(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.targetDefs.save(dto, me, scope);
  }

  @Delete('target-defs/:id')
  @RequirePermission('target.manage')
  removeTargetDef(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.targetDefs.remove(id, me, scope);
  }

  // ----- Incentive Plan master (dedicated table) -----
  @Get('incentive-plans')
  @RequirePermission('target.read')
  incentiveList() {
    return this.incentive.list();
  }

  @Get('incentive-plans/:id/compute')
  @RequirePermission('target.read')
  incentiveCompute(@Param('id', ParseIntPipe) id: number, @Query('pct') pct: string) {
    return this.incentive.compute(id, Number(pct));
  }

  @Post('incentive-plans')
  @RequirePermission('target.manage')
  saveIncentive(@Body() dto: any, @CurrentUser() me: Me) {
    return this.incentive.save(dto, me);
  }

  @Delete('incentive-plans/:id')
  @RequirePermission('target.manage')
  removeIncentive(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.incentive.remove(id, me);
  }
}
