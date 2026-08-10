import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AdmissionService } from './admission.service';

interface Me { id: number; name: string }

/**
 * Students & Academics › Admissions (ERP Batch 3). The staff-facing review queue + the
 * generation/administration of the PUBLIC form links. Full list treatment on the queue.
 * RBAC: admission.read (see), admission.manage (form links), admission.review (approve→student
 * / reject / edit a pending), admission.delete (bulk-delete). Literal routes (forms /
 * bulk-delete) are declared before ':id' so no numeric id shadows them.
 */
@Controller('admissions')
export class AdmissionController {
  constructor(private readonly svc: AdmissionService) {}

  /* ---- review queue ---- */
  @Get() @RequirePermission('admission.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }

  /* ---- public form links (mounted before :id) ---- */
  @Get('forms') @RequirePermission('admission.read')
  listForms(@CurrentScope() scope: ResolvedScope) { return this.svc.listForms(scope); }

  @Post('forms') @RequirePermission('admission.manage')
  createForm(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.createForm(b, me, scope); }

  @Patch('forms/:id') @RequirePermission('admission.manage')
  updateForm(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.updateForm(id, b, scope); }

  @Post('forms/:id/regenerate') @RequirePermission('admission.manage')
  regenerateForm(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.regenerateForm(id, scope); }

  @Delete('forms/:id') @RequirePermission('admission.manage')
  removeForm(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.removeForm(id, me, scope); }

  /* ---- bulk delete (mounted before :id) ---- */
  @Post('bulk-delete/impact') @RequirePermission('admission.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('admission.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  /* ---- one submission ---- */
  @Get(':id') @RequirePermission('admission.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  /* ---- documents (education + KYC): list is read-scoped; download is review-only
   *       (staff/admin, in scope) and never public — sensitive KYC bytes never leave
   *       an authenticated, scoped request. ---- */
  @Get(':id/documents') @RequirePermission('admission.read')
  documents(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.listDocuments(id, scope); }

  @Get(':id/documents/:docId/download') @RequirePermission('admission.review')
  async downloadDocument(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { file_name, mime, content } = await this.svc.downloadDocument(id, docId, scope);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file_name.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(content.length));
    res.end(content);
  }

  @Patch(':id') @RequirePermission('admission.review')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, b, scope); }

  @Post(':id/approve') @RequirePermission('admission.review')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.approve(id, me, scope); }

  @Post(':id/reject') @RequirePermission('admission.review')
  reject(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.reject(id, b, me, scope); }

  @Delete(':id') @RequirePermission('admission.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
