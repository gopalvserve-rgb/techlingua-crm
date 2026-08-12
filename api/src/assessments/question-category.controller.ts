import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { QuestionCategoryService } from './question-category.service';

interface Me { id: number; name: string }

function many(v?: string | string[]): number[] | undefined {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
}

/** QUESTION CATEGORIES — the subject/topic taxonomy behind the Question Bank. Scope-enforced. */
@Controller('question-categories')
export class QuestionCategoryController {
  constructor(private readonly svc: QuestionCategoryService) {}

  @Get()
  @RequirePermission('question_category.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      branch_ids: many(q?.branch_id ?? q?.branch_ids), vertical_ids: many(q?.vertical_id ?? q?.vertical_ids),
      q: q?.q, active: q?.active,
    });
  }

  @Post()
  @RequirePermission('question_category.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('question_category.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('question_category.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Patch(':id')
  @RequirePermission('question_category.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('question_category.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
