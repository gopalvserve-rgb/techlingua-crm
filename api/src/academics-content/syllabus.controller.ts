import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { SyllabusService } from './syllabus.service';

interface Me { id: number; name: string }

/** Students & Academics › Syllabus. Scope-enforced CRUD + the governance workflow. */
@Controller('syllabi')
export class SyllabusController {
  constructor(private readonly svc: SyllabusService) {}

  @Get() @RequirePermission('syllabus.read')
  list(@Query() q: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, me, q ?? {}); }

  @Post('upload-url') @RequirePermission('syllabus.create')
  uploadUrl(@Body() dto: any) { return this.svc.uploadUrl(dto); }

  @Post('bulk-delete/impact') @RequirePermission('syllabus.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('syllabus.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('syllabus.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope, me); }

  @Post() @RequirePermission('syllabus.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id') @RequirePermission('syllabus.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, me, scope); }

  @Delete(':id') @RequirePermission('syllabus.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }

  // --- Governance ---
  @Post(':id/submit') @RequirePermission('syllabus.submit')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.submit(id, me, scope); }
  @Post(':id/approve') @RequirePermission('syllabus.approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.approve(id, me, scope); }
  @Post(':id/reject') @RequirePermission('syllabus.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.reject(id, dto?.remarks ?? dto?.review_remarks ?? '', me, scope); }
  @Post(':id/unpublish') @RequirePermission('syllabus.approve')
  unpublish(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.unpublish(id, me, scope); }
}
