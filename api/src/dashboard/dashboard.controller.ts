import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * THE ROLE-BASED DASHBOARD.
 *
 * The endpoint requires `lead.read`, NOT `dashboard.read` — deliberately. The dashboard
 * IS lead data, so it must be governed by exactly the scope that governs the lead list;
 * asking for a separate permission would let the two drift apart and open the exact hole
 * the client cares about (a counsellor seeing branch numbers). The ResolvedScope handed
 * in here is the same object the Leads list uses.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get() @RequirePermission('lead.read')
  overview(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U, @Query() q: Record<string, string>) {
    return this.dashboard.overview(s, u.id, { from: q.from, to: q.to });
  }

  /** Quick Stats with a CUSTOM DATE RANGE (?from=YYYY-MM-DD&to=YYYY-MM-DD). */
  @Get('quick-stats') @RequirePermission('lead.read')
  quickStats(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.dashboard.quickStats(s, { from: q.from, to: q.to });
  }
}
