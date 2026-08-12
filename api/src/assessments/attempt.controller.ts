import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AttemptService } from './attempt.service';

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

/** STUDENT ATTEMPTS — take/save/submit + faculty evaluation + the expiry sweep. */
@Controller('attempts')
export class AttemptController {
  constructor(private readonly svc: AttemptService) {}

  @Get()
  @RequirePermission('assessment_attempt.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      assessment_ids: many(q?.assessment_id ?? q?.assessment_ids),
      student_ids: many(q?.student_id ?? q?.student_ids),
      statuses: manyStr(q?.status ?? q?.statuses),
      branch_ids: many(q?.branch_id ?? q?.branch_ids),
      vertical_ids: many(q?.vertical_id ?? q?.vertical_ids),
      limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Post('expire')
  @RequirePermission('assessment_attempt.update')
  expire(@CurrentUser() me: Me) {
    return this.svc.expireOverdue(me);
  }

  @Get(':aid')
  @RequirePermission('assessment_attempt.read')
  get(@Param('aid', ParseIntPipe) aid: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(aid, scope);
  }

  @Patch(':aid/answers')
  @RequirePermission('assessment_attempt.update')
  save(@Param('aid', ParseIntPipe) aid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.saveAnswers(aid, dto, me, scope);
  }

  @Post(':aid/submit')
  @RequirePermission('assessment_attempt.update')
  submit(@Param('aid', ParseIntPipe) aid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.submit(aid, dto, me, scope);
  }

  @Patch(':aid/evaluate')
  @RequirePermission('assessment.evaluate')
  evaluate(@Param('aid', ParseIntPipe) aid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.evaluate(aid, dto, me, scope);
  }
}
