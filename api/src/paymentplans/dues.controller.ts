import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { DuesService } from './dues.service';

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

/** FEE DUES & AGEING — Finance & Collections › Fee Dues. RBAC fee_dues.read + scope. */
@Controller('fee-dues')
export class DuesController {
  constructor(private readonly svc: DuesService) {}

  @Get()
  @RequirePermission('fee_dues.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      bucket: manyStr(q?.bucket ?? q?.buckets), source: manyStr(q?.source),
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
      course_ids: many(q?.course_ids ?? q?.course_id), owner_ids: many(q?.owner_ids ?? q?.owner_id),
      q: q?.q, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('fee_dues.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.summary(scope, {
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
    });
  }

  /** Manual fee reminder for an enrolment's outstanding (client feedback item 5). Scope +
   *  permission enforced; idempotent per enrolment per IST day; degrades cleanly. */
  @Post('remind')
  @RequirePermission('fee_dues.read')
  remind(@CurrentScope() scope: ResolvedScope, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.remind(scope, Number(dto?.enrolment_id), me);
  }
}
