import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { DashScopeFilter } from './dashboard.service';

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
    return this.dashboard.overview(s, u.id, { from: q.from, to: q.to, ...scopeFilter(q) });
  }

  /** Quick Stats with a CUSTOM DATE RANGE (?from=YYYY-MM-DD&to=YYYY-MM-DD). */
  @Get('quick-stats') @RequirePermission('lead.read')
  quickStats(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.dashboard.quickStats(s, { from: q.from, to: q.to, ...scopeFilter(q) });
  }
}

/**
 * The optional global-scope narrow carried by the top-bar selector. Parsed permissively
 * (a bad value is simply dropped); the SERVICE ANDs it on top of the RBAC scope, so it can
 * only ever narrow within what the caller may already see — it can never widen it.
 */
function scopeFilter(q: Record<string, string | string[]>): DashScopeFilter {
  const n = (v?: string | string[]) => { const x = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(x) && x > 0 ? x : undefined; };
  const many = (v?: string | string[]): number[] | undefined => {
    if (v == null) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
    const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((k) => Number.isInteger(k) && k > 0))];
    return out.length ? out : undefined;
  };
  return {
    branch_id: n(q.branch_id), vertical_id: n(q.vertical_id), pipeline_id: n(q.pipeline_id), campaign_id: n(q.campaign_id),
    branch_ids: many(q.branch_ids), vertical_ids: many(q.vertical_ids), pipeline_ids: many(q.pipeline_ids), campaign_ids: many(q.campaign_ids),
  };
}
