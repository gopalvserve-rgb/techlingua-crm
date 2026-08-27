import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { StudentService } from './student.service';
import { RbacDataService } from '../rbac/rbac-data.service';

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
  constructor(
    private readonly svc: StudentService,
    private readonly rbac: RbacDataService,
  ) {}

  /** The caller's admission capabilities — feed the admission-journey next-action flags. */
  private async caps(userId: number): Promise<{ canApprove: boolean; canUpdate: boolean }> {
    const g = await this.rbac.loadUserGrants(userId);
    const has = (k: string) => g.rolePermissions.some((rp) => rp.permissionKey === k);
    return { canApprove: has('admission.approve'), canUpdate: has('student.update') };
  }

  /** ADMISSION JOURNEY — the intake funnel timeline per enrolment for this student. */
  @Get(':id/admission-journey')
  @RequirePermission('student.read')
  async admissionJourney(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.studentAdmissionJourney(id, scope, await this.caps(Number(me.id)));
  }

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

  /** The 11-status lifecycle CATALOG (labels + LMS access) — powers the Change-Status UI. */
  @Get('status-catalog')
  @RequirePermission('student.read')
  statusCatalog() {
    return this.svc.statusCatalog();
  }

  /** The enrolment (per-course) status catalog — the shared catalog filtered to the enrolment
   *  subset. Literal route declared before ':id' so no numeric id can shadow it. */
  @Get('enrolment-status-catalog')
  @RequirePermission('student.read')
  enrolmentStatusCatalog() {
    return this.svc.enrolmentStatusCatalog();
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

  /** dev/108 #2 — LEAD JOURNEY: the originating lead (linked via lead_id) + its activity
   *  timeline / follow-ups, surfaced as a tab in the student profile. Guarded by student.read
   *  (whoever can see the student can see where they came from). `{ lead: null }` when the
   *  student was created directly (no originating lead) → the UI shows a clean empty state. */
  @Get(':id/lead-journey')
  @RequirePermission('student.read')
  leadJourney(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.leadJourney(id, scope);
  }

  /** BRANCH TRANSFER — move a student to another Branch (and Vertical, optional Batch). Reuses
   *  student.update; scoped on BOTH ends inside the service so a transfer cannot cross a scope
   *  boundary in either direction. Writes a student_transfer history row + audit. */
  @Post(':id/transfer')
  @RequirePermission('student.update')
  transfer(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.branchTransfer(id, dto, me, scope);
  }

  /** CHANGE STATUS — the lifecycle transition. Guarded by student.update; the SENSITIVE
   *  statuses are additionally gated by student.status_manage INSIDE the service (else 403),
   *  where the required fields + outstanding snapshot + history are enforced. */
  @Post(':id/status')
  @RequirePermission('student.update')
  changeStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.changeStatus(id, dto, me, scope);
  }

  /** The status transition trail (who / when / reason / approver). */
  @Get(':id/status-history')
  @RequirePermission('student.read')
  statusHistory(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.statusHistory(id, scope);
  }

  /** STUDENT-FACING LMS READ — published material/content/syllabus for the student, with the
   *  status-driven LMS-access gate enforced (NONE → 403). */
  @Get(':id/lms')
  @RequirePermission('student.read')
  lms(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.lmsContent(id, scope);
  }

  /* -------- PER-COURSE ENROLLMENT status (the Course Enrollment section) -------- */

  /** LIST this student's course enrolments, each with its OWN status + combined LMS access. */
  @Get(':id/enrolments')
  @RequirePermission('student.read')
  enrolments(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.listEnrolments(id, scope);
  }

  /** ADD an enrolment (enrol the student into ANOTHER course). Reuses student.update. */
  @Post(':id/enrolments')
  @RequirePermission('student.update')
  addEnrolment(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.addEnrolment(id, dto, me, scope);
  }

  /** EDIT this course-enrolment (client feedback item 6) — course/fee/discount/plan/start. Scope-
   *  enforced + lead-OPTIONAL (fixes the old PATCH /enrolments/:id 404 on a lead-less enrolment,
   *  DEF-2) and runs the Discount Master over-cap decision on save (DEF-4). Guarded by student.update. */
  @Patch(':id/enrolments/:eid')
  @RequirePermission('student.update')
  updateEnrolment(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.updateEnrolment(eid, dto, me, scope, id);
  }

  /** UPGRADE — add another LEVEL to this course-enrolment (A1 → add A2). Same enrolment: Total/Net
   *  increase, plan reconciles, no second enrolment. Guarded by student.update; scope-enforced. */
  @Post(':id/enrolments/:eid/levels')
  @RequirePermission('student.update')
  addEnrolmentLevel(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.addEnrolmentLevel(eid, dto, me, scope, id);
  }

  /** 27aug Batch C items 4 & 5 — ASSIGN a batch to ONE of the student's enrolments (per-course).
   *  batch_id null unassigns. No hard block on an incomplete admission step (returns a warning). */
  @Post(':id/enrolments/:eid/assign-batch')
  @RequirePermission('student.update')
  assignEnrolmentBatch(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.assignEnrolmentBatch(eid, dto, me, scope, id);
  }

  /** CHANGE a single enrolment's status. Guarded by student.update; SENSITIVE statuses are
   *  additionally gated by student.status_manage INSIDE the service (403), with the required
   *  fields + Approved-By enforced (400). */
  @Post(':id/enrolments/:eid/status')
  @RequirePermission('student.update')
  changeEnrolmentStatus(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.changeEnrolmentStatus(eid, dto, me, scope, id);
  }

  /** The per-enrolment status transition trail. */
  @Get(':id/enrolments/:eid/status-history')
  @RequirePermission('student.read')
  enrolmentStatusHistory(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.enrolmentStatusHistory(eid, scope, id);
  }

  /** COURSE TRANSFER (client feedback #8) — move this enrolment to another course. Reuses
   *  student.update; scope-enforced on BOTH ends inside the service; re-points the enrolment,
   *  recomputes the fee from the target Course master (payments preserved → outstanding recomputes),
   *  mints the target vertical's Student ID when needed, and writes an enrolment_course_transfer row. */
  @Post(':id/enrolments/:eid/course-transfer')
  @RequirePermission('student.update')
  transferEnrolmentCourse(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.transferEnrolmentCourse(eid, dto, me, scope, id);
  }

  /** The per-enrolment course-transfer history trail. */
  @Get(':id/enrolments/:eid/course-transfer-history')
  @RequirePermission('student.read')
  enrolmentCourseTransferHistory(@Param('id', ParseIntPipe) id: number, @Param('eid', ParseIntPipe) eid: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.enrolmentCourseTransferHistory(eid, scope, id);
  }

  /** STUDENT SYLLABUS + COURSE CONTENT ACCESS — per enrolled course, published-only, gated by
   *  the combined (overall + per-enrolment) LMS access. Blocks a cancelled/withdrawn course. */
  @Get(':id/learning')
  @RequirePermission('student.read')
  learning(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.learning(id, scope);
  }

  /* -------- documents (education + KYC). List is student.read; download is student.update
   *          (staff/admin, in scope) and never public — sensitive KYC bytes stay behind an
   *          authenticated, scoped request. -------- */
  @Get(':id/documents')
  @RequirePermission('student.read')
  documents(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.listDocuments(id, scope);
  }

  @Get(':id/documents/:docId/download')
  @RequirePermission('student.update')
  async downloadDocument(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { file_name, mime, content } = await this.svc.downloadDocument(id, docId, scope);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file_name.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(content.length));
    res.end(content);
  }

  /** Presigned R2 URL for a sensitive student doc (5-min, single-use, never public). R2-backed only. */
  @Get(':id/documents/:docId/url')
  @RequirePermission('student.update')
  documentUrl(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.downloadDocumentUrl(id, docId, scope);
  }

  /* -------- PHOTO (profile avatar) — presigned R2 upload then attach. student.update. -------- */
  @Post(':id/photo/upload-url')
  @RequirePermission('student.update')
  photoUploadUrl(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.photoUploadUrl(id, dto, scope);
  }

  @Post(':id/photo')
  @RequirePermission('student.update')
  attachPhoto(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.attachPhoto(id, dto, me, scope);
  }

  /* -------- DOCUMENT UPLOAD (KYC / education / misc) — presigned R2 then attach; delete by PK. -------- */
  @Post(':id/documents/upload-url')
  @RequirePermission('student.update')
  documentUploadUrl(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.documentUploadUrl(id, dto, scope);
  }

  @Post(':id/documents')
  @RequirePermission('student.update')
  attachDocument(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.attachDocument(id, dto, me, scope);
  }

  @Delete(':id/documents/:docId')
  @RequirePermission('student.update')
  removeDocument(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.removeDocument(id, docId, me, scope);
  }

  /* -------- STUDENT ID CARD — a printable branded PDF (photo + name + Student ID + course +
   *          branch>vertical), generated via PdfAssetService → R2 like certificates. -------- */
  @Get(':id/id-card')
  @RequirePermission('student.read')
  async idCard(@Param('id', ParseIntPipe) id: number, @Query('vertical_id') verticalId: string | undefined, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.idCard(id, scope, verticalId != null && verticalId !== '' ? Number(verticalId) : null);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /** (Re)generate the ID card + persist to R2; returns the stored r2_key. */
  @Post(':id/id-card')
  @RequirePermission('student.read')
  async regenIdCard(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    const vid = dto?.vertical_id != null && dto.vertical_id !== '' ? Number(dto.vertical_id) : null;
    const { r2_key, filename } = await this.svc.idCard(id, scope, vid);
    return { r2_key, filename, generated: true };
  }

  /** A short-lived presigned R2 URL for the ID card (for a preview / download link). */
  @Get(':id/id-card/url')
  @RequirePermission('student.read')
  idCardUrl(@Param('id', ParseIntPipe) id: number, @Query('vertical_id') verticalId: string | undefined, @CurrentScope() scope: ResolvedScope) {
    return this.svc.idCardUrl(id, scope, verticalId != null && verticalId !== '' ? Number(verticalId) : null);
  }

  /** LIST the vertical-wise Student IDs (one per vertical) for the ID-card picker. */
  @Get(':id/vertical-ids')
  @RequirePermission('student.read')
  verticalIds(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.verticalIds(id, scope);
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

  /** BULK "Convert to students" — the Leads-list multi-select action. Takes { ids:number[] }
   *  and reuses the single-convert per lead (own transaction each) so behaviour/dedupe/scope
   *  are identical; returns a per-lead {converted,skipped,failed} report + counts. Same
   *  student.create guard as the single Convert; scope enforced per lead inside the service. */
  @Post('bulk-convert')
  @RequirePermission('student.create')
  bulkConvert(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkConvert(b?.ids, me, scope);
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
