import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { InvoiceService } from './invoice.service';

interface Me { id: number; name: string }

/** parse a comma/array query param into a clean number[] */
function many(v?: string | string[]): number[] | undefined {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
}
function manyStr(v?: string | string[]): string[] | undefined {
  if (v == null) return undefined;
  const out = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * GST TAX INVOICES — Finance & Collections › Invoices. Every route carries
 * @RequirePermission; a route without one has no request.scope and every scoped query it
 * builds either throws or falls open — and this module issues legal tax documents.
 */
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly svc: InvoiceService) {}

  @Get()
  @RequirePermission('invoice.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      statuses: manyStr(q?.statuses ?? q?.status), supply_type: q?.supply_type,
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
      enrolment_id: q?.enrolment_id ? Number(q.enrolment_id) : undefined,
      q: q?.q, from: q?.from, to: q?.to, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('invoice.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get(':id')
  @RequirePermission('invoice.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Get(':id/pdf')
  @RequirePermission('invoice.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post()
  @RequirePermission('invoice.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Post('generate')
  @RequirePermission('invoice.create')
  generate(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.generate(dto, me, scope);
  }

  @Post(':id/issue')
  @RequirePermission('invoice.issue')
  issue(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.issue(id, me, scope);
  }

  @Post(':id/mark-paid')
  @RequirePermission('invoice.issue')
  markPaid(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.markPaid(id, me, scope);
  }

  @Post(':id/cancel')
  @RequirePermission('invoice.cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.cancel(id, dto, me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('invoice.read')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('invoice.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Delete(':id')
  @RequirePermission('invoice.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
