import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { FeeService, MODE_LABELS, PAYMENT_MODES } from './fee.service';

interface Me { id: number; name: string }

/** Finance & Collections › Fee Collection — LITE. Every route carries @RequirePermission. */
@Controller('fees')
export class FeeController {
  constructor(private readonly svc: FeeService) {}

  @Get('receipts')
  @RequirePermission('fee.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      mode: q?.mode, enrolment_id: q?.enrolment_id ? Number(q.enrolment_id) : undefined,
      q: q?.q, from: q?.from, to: q?.to, limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('fee.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get('meta')
  @RequirePermission('fee.read')
  meta() {
    return {
      modes: PAYMENT_MODES.map((k) => ({ key: k, label: MODE_LABELS[k] })),
      // The screen must SAY this, not imply it by omission.
      online: {
        gateway_capture: false,
        phase: 3,
        note: 'Razorpay / online capture arrives in Phase 3. The keys are already stored per vertical; '
          + 'until then, record an online payment by hand with its UTR reference.',
      },
    };
  }

  @Get('receipts/:id')
  @RequirePermission('fee.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Get('receipts/:id/pdf')
  @RequirePermission('fee.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post('collect')
  @RequirePermission('fee.collect')
  collect(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.collect(dto, me, scope);
  }

  /** Correct a recorded payment (amount / mode / reference / date). Re-runs the installment
   *  allocation and writes an audit_log old→new entry. Permission-gated + scope-enforced. */
  @Patch('receipts/:id')
  @RequirePermission('fee.collect')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete('receipts/:id')
  @RequirePermission('fee.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
