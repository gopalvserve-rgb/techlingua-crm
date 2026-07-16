import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { PerformanceService } from './performance.service';
import { TargetService } from './target.service';

interface Me { id: number; name: string }

/**
 * Performance & Conversion › Monthly Targets + Counsellor Performance.
 * Every route carries @RequirePermission — sprint5-rbac.spec.ts enforces it.
 */
@Controller('performance')
export class PerformanceController {
  constructor(
    private readonly perf: PerformanceService,
    private readonly targets: TargetService,
  ) {}

  @Get('leaderboard')
  @RequirePermission('performance.read')
  leaderboard(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.perf.leaderboard(scope, { from: q?.from, to: q?.to });
  }

  @Get('summary')
  @RequirePermission('performance.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.perf.summary(scope, { from: q?.from, to: q?.to });
  }

  @Get('targets')
  @RequirePermission('target.read')
  targetList(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.targets.list(scope, { period: q?.period, scope_type: q?.scope_type });
  }

  /** The dashboard's "This month vs target" bar — per role. */
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
}
