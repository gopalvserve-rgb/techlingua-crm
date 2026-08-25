import { Controller, Get, Query } from '@nestjs/common';
import { CurrentScope, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { FinanceDashboardService } from './finance-dashboard.service';

/**
 * FINANCE DASHBOARD — REAL ₹ KPIs, scoped by the caller's RBAC scope. The optional
 * top-bar branch/vertical narrow + DateRange are parsed permissively and ANDed on top;
 * they can only narrow within what the caller may already see.
 */
@Controller('finance/dashboard')
export class FinanceDashboardController {
  constructor(private readonly svc: FinanceDashboardService) {}

  @Get()
  @RequirePermission('finance_dashboard.read')
  dashboard(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    const many = (v?: string | string[]): number[] | undefined => {
      if (v == null) return undefined;
      const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
      const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
      return out.length ? out : undefined;
    };
    const manyStr = (v?: string | string[]): string[] | undefined => {
      if (v == null) return undefined;
      const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
      const out = [...new Set(parts.map((x) => String(x).trim()).filter(Boolean))];
      return out.length ? out : undefined;
    };
    return this.svc.dashboard(scope, {
      from: Array.isArray(q.from) ? q.from[0] : q.from,
      to: Array.isArray(q.to) ? q.to[0] : q.to,
      branch_ids: many(q.branch_ids ?? q.branch_id),
      vertical_ids: many(q.vertical_ids ?? q.vertical_id),
      // crm25aug (#5) filter bar
      counsellor_ids: many(q.counsellor_ids ?? q.counsellor_id),
      course_ids: many(q.course_ids ?? q.course_id),
      trainer_ids: many(q.trainer_ids ?? q.trainer_id),
      statuses: manyStr(q.statuses ?? q.status),
      payment_modes: manyStr(q.payment_modes ?? q.payment_mode ?? q.mode),
    });
  }
}
