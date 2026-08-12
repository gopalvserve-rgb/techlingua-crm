import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AssessmentCertificateService } from './assessment-certificate.service';

interface Me { id: number; name: string }

/** ASSESSMENT CERTIFICATES — issue / list / view PDF / revoke. RBAC assessment_certificate.*. */
@Controller('assessment-certificates')
export class AssessmentCertificateController {
  constructor(private readonly svc: AssessmentCertificateService) {}

  @Get()
  @RequirePermission('assessment_certificate.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q); }

  @Post()
  @RequirePermission('assessment_certificate.issue')
  issue(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.issue(dto, me, scope); }

  @Post('bulk-issue')
  @RequirePermission('assessment_certificate.issue')
  bulkIssue(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkIssueForAssessment(Number(dto?.assessment_id), me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('assessment_certificate.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(dto?.ids, scope); }

  @Post('bulk-delete')
  @RequirePermission('assessment_certificate.delete')
  bulkRemove(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(dto?.ids, me, scope); }

  @Get(':id')
  @RequirePermission('assessment_certificate.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Get(':id/file')
  @RequirePermission('assessment_certificate.read')
  file(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.presignedUrl(id, scope); }

  @Get(':id/pdf')
  @RequirePermission('assessment_certificate.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post(':id/revoke')
  @RequirePermission('assessment_certificate.revoke')
  revoke(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.revoke(id, dto, me, scope); }

  @Delete(':id')
  @RequirePermission('assessment_certificate.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
