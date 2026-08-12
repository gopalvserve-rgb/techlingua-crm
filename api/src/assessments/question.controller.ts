import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { QuestionService } from './question.service';

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

/** QUESTION BANK — Students & Academics › Assessments › Question Bank. All routes scoped. */
@Controller('questions')
export class QuestionController {
  constructor(private readonly svc: QuestionService) {}

  @Get()
  @RequirePermission('question.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      q_types: manyStr(q?.q_type ?? q?.q_types), difficulties: manyStr(q?.difficulty ?? q?.difficulties),
      languages: manyStr(q?.language ?? q?.languages),
      category_ids: many(q?.category_id ?? q?.category_ids),
      branch_ids: many(q?.branch_id ?? q?.branch_ids), vertical_ids: many(q?.vertical_id ?? q?.vertical_ids),
      active: q?.active, q: q?.q, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('question.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Post('upload-url')
  @RequirePermission('question.create')
  uploadUrl(@Body() dto: any) {
    return this.svc.uploadUrl(dto);
  }

  @Post('import')
  @RequirePermission('question.import')
  import(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.import(Array.isArray(dto?.rows) ? dto.rows : [], me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('question.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('question.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Get(':id')
  @RequirePermission('question.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('question.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('question.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('question.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
