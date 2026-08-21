import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { PlanService } from './plan.service';

interface Me { id: number; name: string }

function many(v?: string | string[]): number[] | undefined {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
}
function manyStr(v?: string | string[]): string[] | undefined {
  if (v == null) return undefined;
  const out = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * PAYMENT PLANS — Finance & Collections › Payment Plans. Every route carries
 * @RequirePermission (payment_plan.*); scope is the caller's RBAC scope on the enrolment.
 */
@Controller('payment-plans')
export class PlanController {
  constructor(private readonly svc: PlanService) {}

  @Get()
  @RequirePermission('payment_plan.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      status: manyStr(q?.status ?? q?.statuses), plan_type: manyStr(q?.plan_type ?? q?.plan_types),
      enrolment_id: q?.enrolment_id ? Number(q.enrolment_id) : undefined,
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
      q: q?.q, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('payment_plan.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.summary(scope, {
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
    });
  }

  @Get(':id')
  @RequirePermission('payment_plan.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('payment_plan.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('payment_plan.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('payment_plan.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Delete(':id')
  @RequirePermission('payment_plan.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
