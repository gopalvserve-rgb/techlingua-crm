import { Controller, Get, Query } from '@nestjs/common';
import { CurrentScope, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { RevenueService } from './revenue.service';

const many = (v?: string | string[]): number[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
};
const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);

/** Finance & Collections › Revenue — collection (money in, net of refunds) vs accrual. */
@Controller('revenue')
export class RevenueController {
  constructor(private readonly svc: RevenueService) {}

  @Get()
  @RequirePermission('revenue.read')
  revenue(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    return this.svc.revenue(scope, {
      view: one(q.view), group_by: one(q.group_by), from: one(q.from), to: one(q.to),
      branch_ids: many(q.branch_ids ?? q.branch_id), vertical_ids: many(q.vertical_ids ?? q.vertical_id),
    });
  }

  @Get('overview')
  @RequirePermission('revenue.read')
  overview(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    return this.svc.overview(scope, {
      from: one(q.from), to: one(q.to),
      branch_ids: many(q.branch_ids ?? q.branch_id), vertical_ids: many(q.vertical_ids ?? q.vertical_id),
    });
  }
}
