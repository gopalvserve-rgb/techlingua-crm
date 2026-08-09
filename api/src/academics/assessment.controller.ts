import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AssessmentService } from './assessment.service';

interface Me { id: number; name: string }

/** Students & Academics › Tests & Scores. */
@Controller('academics/tests')
export class AssessmentController {
  constructor(private readonly svc: AssessmentService) {}

  @Get()
  @RequirePermission('test.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.list(scope, q ?? {});
  }

  @Get(':id')
  @RequirePermission('test.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('test.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('test.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('test.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }

  /** Enter / update per-student scores (grade computed from marks / max_marks). */
  @Post(':id/scores')
  @RequirePermission('test.grade')
  saveScores(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.saveScores(id, dto, me, scope);
  }
}
