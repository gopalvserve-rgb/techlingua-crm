import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CertificateService } from './certificate.service';

interface Me { id: number; name: string }

/** Students & Academics › Certificates. Full list treatment; RBAC certificate.*. */
@Controller('learning/certificates')
export class CertificateController {
  constructor(private readonly svc: CertificateService) {}

  @Get() @RequirePermission('certificate.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, q ?? {}); }

  @Post('bulk-delete/impact') @RequirePermission('certificate.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('certificate.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id/pdf') @RequirePermission('certificate.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post() @RequirePermission('certificate.issue')
  issue(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.issue(dto, me, scope); }

  @Post(':id/reissue') @RequirePermission('certificate.issue')
  reissue(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.reissue(id, dto, me, scope); }

  @Post(':id/revoke') @RequirePermission('certificate.revoke')
  revoke(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.revoke(id, dto, me, scope); }

  @Delete(':id') @RequirePermission('certificate.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
