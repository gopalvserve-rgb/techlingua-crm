import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CourseContentService } from './course-content.service';

interface Me { id: number; name: string }

/** Students & Academics › Course Content. Scope-enforced CRUD + the governance workflow. */
@Controller('course-contents')
export class CourseContentController {
  constructor(private readonly svc: CourseContentService) {}

  @Get() @RequirePermission('course_content.read')
  list(@Query() q: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, me, q ?? {}); }

  @Post('upload-url') @RequirePermission('course_content.create')
  uploadUrl(@Body() dto: any) { return this.svc.uploadUrl(dto); }

  @Post('bulk-delete/impact') @RequirePermission('course_content.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('course_content.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('course_content.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope, me); }

  @Post() @RequirePermission('course_content.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id') @RequirePermission('course_content.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, me, scope); }

  @Delete(':id') @RequirePermission('course_content.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }

  // --- Governance: submit (trainer) -> approve / reject / unpublish (approver) ---
  @Post(':id/submit') @RequirePermission('course_content.submit')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.submit(id, me, scope); }
  @Post(':id/approve') @RequirePermission('course_content.approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.approve(id, me, scope); }
  @Post(':id/reject') @RequirePermission('course_content.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.reject(id, dto?.remarks ?? dto?.review_remarks ?? '', me, scope); }
  @Post(':id/unpublish') @RequirePermission('course_content.approve')
  unpublish(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.unpublish(id, me, scope); }
}
