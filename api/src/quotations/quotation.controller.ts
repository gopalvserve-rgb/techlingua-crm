import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { QuotationService } from './quotation.service';

interface Me { id: number; name: string }

/**
 * QUOTATIONS — Performance & Conversion › Quotations.
 *
 * EVERY route carries @RequirePermission; `sprint5-rbac.spec.ts` walks these prototypes
 * and fails the build otherwise. A route without one has no `request.scope`, so every
 * scoped query it builds either throws or falls open — and this module quotes money.
 */
@Controller('quotations')
export class QuotationController {
  constructor(private readonly svc: QuotationService) {}

  @Get()
  @RequirePermission('quotation.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      status: q?.status, lead_id: q?.lead_id ? Number(q.lead_id) : undefined,
      q: q?.q, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('quotation.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get(':id')
  @RequirePermission('quotation.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  /** The PDF, inline so it opens in a tab. Scope-checked inside `pdf()` -> `get()`. */
  @Get(':id/pdf')
  @RequirePermission('quotation.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Get(':id/convert-preview')
  @RequirePermission('quotation.read')
  convertPreview(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.convertPreview(id, scope);
  }

  @Post()
  @RequirePermission('quotation.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('quotation.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Post(':id/revise')
  @RequirePermission('quotation.create')
  revise(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.revise(id, dto, me, scope);
  }

  @Post(':id/send')
  @RequirePermission('quotation.send')
  send(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.send(id, dto, me, scope);
  }

  /** "I handed it to him" — the offline despatch. See QuotationService.markSent(). */
  @Post(':id/mark-sent')
  @RequirePermission('quotation.send')
  markSent(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.markSent(id, dto, me, scope);
  }

  @Post(':id/accept')
  @RequirePermission('quotation.update')
  accept(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.decide(id, 'accepted', dto, me, scope);
  }

  @Post(':id/reject')
  @RequirePermission('quotation.update')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.decide(id, 'rejected', dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('quotation.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
