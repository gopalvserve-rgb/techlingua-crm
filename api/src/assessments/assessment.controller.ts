import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AssessmentService } from './assessment.service';

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

/** TESTS / EXAMS — Students & Academics › Assessments › Tests. All routes scope-enforced. */
@Controller('assessments')
export class AssessmentController {
  constructor(private readonly svc: AssessmentService) {}

  @Get()
  @RequirePermission('assessment.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      test_types: manyStr(q?.test_type ?? q?.test_types), statuses: manyStr(q?.status ?? q?.statuses),
      languages: manyStr(q?.language ?? q?.languages),
      course_ids: many(q?.course_id ?? q?.course_ids), batch_ids: many(q?.batch_id ?? q?.batch_ids),
      branch_ids: many(q?.branch_id ?? q?.branch_ids), vertical_ids: many(q?.vertical_id ?? q?.vertical_ids),
      q: q?.q, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('assessment.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Post('import')
  @RequirePermission('assessment.create')
  import(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.import(Array.isArray(dto?.rows) ? dto.rows : [], me, scope);
  }

  @Post('from-template')
  @RequirePermission('assessment.create')
  fromTemplate(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.createFromTemplate(dto, me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('assessment.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('assessment.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Get(':id')
  @RequirePermission('assessment.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Get(':id/preview')
  @RequirePermission('assessment.read')
  preview(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.assemble(id, scope, { forAttempt: false });
  }

  @Post()
  @RequirePermission('assessment.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('assessment.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Post(':id/questions')
  @RequirePermission('assessment.update')
  setQuestions(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.setQuestions(id, Array.isArray(dto?.questions) ? dto.questions : (Array.isArray(dto?.links) ? dto.links : []), me, scope);
  }

  @Post(':id/section-pool')
  @RequirePermission('assessment.update')
  setPool(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.setSectionPool(id, dto, me, scope);
  }

  @Post(':id/publish')
  @RequirePermission('assessment.publish')
  publish(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.publish(id, me, scope);
  }

  @Post(':id/close')
  @RequirePermission('assessment.publish')
  close(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.close(id, me, scope);
  }

  @Delete(':id')
  @RequirePermission('assessment.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
