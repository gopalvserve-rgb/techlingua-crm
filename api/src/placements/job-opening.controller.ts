import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { JobOpeningService } from './job-opening.service';

interface Me { id: number; name: string }

/** Students & Academics › Placement Support. Scope-enforced CRUD + applicants view. */
@Controller('job-openings')
export class JobOpeningController {
  constructor(private readonly svc: JobOpeningService) {}

  @Get() @RequirePermission('placement.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, q ?? {}); }

  @Post('upload-url') @RequirePermission('placement.create')
  uploadUrl(@Body() dto: any) { return this.svc.uploadUrl(dto); }

  @Post('bulk-delete/impact') @RequirePermission('placement.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('placement.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('placement.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Get(':id/applications') @RequirePermission('placement_application.read')
  applications(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.applications(id, scope); }

  @Post() @RequirePermission('placement.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id') @RequirePermission('placement.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, scope); }

  @Delete(':id') @RequirePermission('placement.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}

/** PATCH /placement-applications/:id — advance an application (staff, scope-enforced via opening). */
@Controller('placement-applications')
export class PlacementApplicationController {
  constructor(private readonly svc: JobOpeningService) {}

  @Patch(':id') @RequirePermission('placement_application.update')
  advance(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.advanceApplication(id, dto, me, scope);
  }
}

/**
 * STUDENT-FACING placement access. Guarded by student.read/update (staff acting on a student's
 * behalf from the profile), NOT the placement.* staff permissions — the eligibility gate lives in
 * the service. Paths do not collide with the StudentController routes.
 */
@Controller('students')
export class StudentPlacementsController {
  constructor(private readonly svc: JobOpeningService) {}

  @Get(':id/placements') @RequirePermission('student.read')
  placements(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.studentPlacements(id, scope); }

  @Get(':id/placement-applications') @RequirePermission('student.read')
  myApplications(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.studentApplications(id, scope); }

  @Post(':id/placements/:jobId/apply') @RequirePermission('student.update')
  apply(@Param('id', ParseIntPipe) id: number, @Param('jobId', ParseIntPipe) jobId: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.apply(id, jobId, dto, me, scope);
  }
}
