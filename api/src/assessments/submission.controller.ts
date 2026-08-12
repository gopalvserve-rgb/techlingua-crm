import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { SubmissionService } from './submission.service';

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

/** ASSIGNMENT SUBMISSIONS — file answers + faculty evaluation queue. */
@Controller('submissions')
export class SubmissionController {
  constructor(private readonly svc: SubmissionService) {}

  @Get()
  @RequirePermission('assignment_submission.read')
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

  @Post('upload-url')
  @RequirePermission('assignment_submission.create')
  uploadUrl(@Body() dto: any) {
    return this.svc.uploadUrl(dto);
  }

  @Patch(':sid/evaluate')
  @RequirePermission('assessment.evaluate')
  evaluate(@Param('sid', ParseIntPipe) sid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.evaluate(sid, dto, me, scope);
  }
}
