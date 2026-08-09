import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { StudentService } from './student.service';

interface Me { id: number; name: string }

/**
 * Students & Academics › Student Management (Phase 2 at the CRM level).
 * Every route carries @RequirePermission; the SQL is scoped INSIDE StudentService so a
 * counsellor's list can never return another branch's students.
 *
 * Literal routes (summary / by-lead / convert) are declared before ':id' so no numeric id
 * can shadow them.
 */
@Controller('students')
export class StudentController {
  constructor(private readonly svc: StudentService) {}

  @Get()
  @RequirePermission('student.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, q ?? {});
  }

  @Get('summary')
  @RequirePermission('student.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.summary(scope, q ?? {});
  }

  @Get('by-lead/:leadId')
  @RequirePermission('student.read')
  byLead(@Param('leadId', ParseIntPipe) leadId: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.byLead(leadId, scope);
  }

  @Get(':id')
  @RequirePermission('student.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  /** THE STUDENT PROFILE AGGREGATE — one scoped read powering the tabbed detail view
   *  (identity/contact/family/address/id/education + academics + certificates + report
   *  cards + fees). Guarded by student.read; the SQL is scoped inside profile(). */
  @Get(':id/profile')
  @RequirePermission('student.read')
  profile(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.profile(id, scope);
  }

  /* -------- family / siblings (ERP Batch 3). Read via student.read; link/unlink reuse
   *          student.update, mirroring how batch transfer/waitlist reuse it. -------- */
  @Get(':id/siblings')
  @RequirePermission('student.read')
  siblings(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.siblings(id, scope);
  }

  @Post(':id/siblings')
  @RequirePermission('student.update')
  linkSibling(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.linkSibling(id, b?.sibling_id, me, scope);
  }

  @Delete(':id/siblings')
  @RequirePermission('student.update')
  unlinkSibling(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.unlinkSibling(id, me, scope);
  }

  /** THE "Convert to Student" BUTTON — idempotent, wins the lead. Guarded by student.create,
   *  which migration 044 grants to exactly the roles that already hold enrolment.create (a
   *  desk that can close a sale can make the student it produces). */
  @Post('convert')
  @RequirePermission('student.create')
  convert(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.convert(dto, me, scope);
  }

  /** ADD a student directly (the Admission form) — lead-less, full profile, auto Student ID +
   *  Enrollment No. Guarded by student.create (the same key Convert uses). */
  @Post()
  @RequirePermission('student.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  /** Bulk soft-delete (OBS-2) — the full-list treatment every list carries. Impact preview
   *  then delete, both scoped inside the service so out-of-scope ids are silently skipped. */
  @Post('bulk-delete/impact')
  @RequirePermission('student.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkImpact(b?.ids, scope);
  }

  @Post('bulk-delete')
  @RequirePermission('student.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkRemove(b?.ids, me, scope);
  }

  @Patch(':id')
  @RequirePermission('student.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('student.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
