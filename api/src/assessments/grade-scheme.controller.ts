import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { GradeSchemeService } from './grade-scheme.service';

interface Me { id: number; name: string }

/** GRADE SCHEMES — configurable grading bands (India default seeded). RBAC grade_scheme.*. */
@Controller('grade-schemes')
export class GradeSchemeController {
  constructor(private readonly svc: GradeSchemeService) {}

  @Get()
  @RequirePermission('grade_scheme.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q); }

  @Get(':id')
  @RequirePermission('grade_scheme.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Post()
  @RequirePermission('grade_scheme.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id')
  @RequirePermission('grade_scheme.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, me, scope); }

  @Post(':id/set-default')
  @RequirePermission('grade_scheme.update')
  setDefault(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.setDefault(id, scope); }

  @Delete(':id')
  @RequirePermission('grade_scheme.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
