import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CourseworkService } from './coursework.service';

interface Me { id: number; name: string }

/** Students & Academics › Assignments (coursework). */
@Controller('academics/coursework')
export class CourseworkController {
  constructor(private readonly svc: CourseworkService) {}

  @Get()
  @RequirePermission('coursework.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.list(scope, q ?? {});
  }

  @Get(':id')
  @RequirePermission('coursework.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('coursework.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('coursework.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('coursework.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }

  /** Record a student submission (assigned -> submitted). */
  @Post(':id/submissions')
  @RequirePermission('coursework.update')
  submit(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.saveSubmission(id, dto, me, scope);
  }

  /** Grade a student submission (marks + feedback). */
  @Post(':id/grade')
  @RequirePermission('coursework.grade')
  grade(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.grade(id, dto, me, scope);
  }
}
