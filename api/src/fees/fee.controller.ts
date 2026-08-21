import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { FeeService, MODE_LABELS, PAYMENT_MODES } from './fee.service';

interface Me { id: number; name: string }

/** parse a comma/array query param into a clean number[] */
function many(v?: string | string[]): number[] | undefined {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
}

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
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
    });
  }

  @Get('summary')
  @RequirePermission('fee.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.summary(scope, {
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
    });
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

  /* ---- receipt actions (dev/116): Email / WhatsApp / Send-for-approval / Approve / Reject ---- */

  /** Email the receipt PDF to the student (per-vertical SMTP). Degrades cleanly if unconfigured. */
  @Post('receipts/:id/email')
  @RequirePermission('fee.read')
  email(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.emailReceipt(id, me, scope);
  }

  /** WhatsApp the receipt summary to the student. Degrades cleanly if unconfigured. */
  @Post('receipts/:id/whatsapp')
  @RequirePermission('fee.read')
  whatsapp(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.whatsappReceipt(id, me, scope);
  }

  /** Send the receipt for approval (pending_approval in the reusable content-approval workflow). */
  @Post('receipts/:id/submit-approval')
  @RequirePermission('fee.collect')
  submitApproval(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.submitApproval(id, me, scope);
  }

  /** Approve a receipt pending approval — authorized approver only (enrolment.approve). */
  @Post('receipts/:id/approve')
  @RequirePermission('enrolment.approve')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.approveReceipt(id, me, scope);
  }

  /** Reject (send back) a receipt pending approval, with remarks — authorized approver only. */
  @Post('receipts/:id/reject')
  @RequirePermission('enrolment.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.rejectReceipt(id, dto, me, scope);
  }
}
