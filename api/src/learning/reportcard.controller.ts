import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { ReportCardService } from './reportcard.service';

interface Me { id: number; name: string }

/** Students & Academics › Academic Progress (report cards). Full list treatment; RBAC reportcard.*. */
@Controller('learning/report-cards')
export class ReportCardController {
  constructor(private readonly svc: ReportCardService) {}

  @Get() @RequirePermission('reportcard.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, q ?? {}); }

  /** Preview the computed components for a student before saving a card. */
  @Get('preview') @RequirePermission('reportcard.read')
  preview(@Query() q: any, @CurrentScope() scope: ResolvedScope) {
    const sid = Number(q?.student_id);
    if (!sid) return { attendance_pct: null };
    return this.svc.computeForStudent(sid, scope, q?.from || undefined, q?.to || undefined);
  }

  @Post('bulk-delete/impact') @RequirePermission('reportcard.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('reportcard.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('reportcard.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Get(':id/pdf') @RequirePermission('reportcard.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post() @RequirePermission('reportcard.create')
  generate(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.generate(dto, me, scope); }

  @Post(':id/publish') @RequirePermission('reportcard.create')
  publish(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.publish(id, dto?.publish !== false, me, scope);
  }

  @Delete(':id') @RequirePermission('reportcard.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
