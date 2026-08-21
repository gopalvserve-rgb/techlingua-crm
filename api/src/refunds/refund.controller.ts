import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { RefundService, REFUND_MODES, MODE_LABELS } from './refund.service';

interface Me { id: number; name: string }

const many = (v?: string | string[]): number[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
};
const csv = (v?: string | string[]): string[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)] : undefined;
};

/** Finance & Collections › Refunds. Every route carries @RequirePermission. */
@Controller('refunds')
export class RefundController {
  constructor(private readonly svc: RefundService) {}

  @Get()
  @RequirePermission('refund.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      status: csv(q?.status), enrolment_id: q?.enrolment_id ? Number(q.enrolment_id) : undefined,
      q: q?.q, from: q?.from, to: q?.to, branch_ids: many(q?.branch_ids ?? q?.branch_id),
      vertical_ids: many(q?.vertical_ids ?? q?.vertical_id), limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('refund.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.summary(scope, {
      branch_ids: many(q?.branch_ids ?? q?.branch_id), vertical_ids: many(q?.vertical_ids ?? q?.vertical_id),
    });
  }

  @Get('meta')
  @RequirePermission('refund.read')
  async meta() {
    const policy = await this.svc.policy();
    return {
      modes: REFUND_MODES.map((k) => ({ key: k, label: MODE_LABELS[k] })),
      policy: { require_approval: policy.require_approval, high_value_over_minor: policy.high_value_over_minor },
    };
  }

  @Get('policy')
  @RequirePermission('refund.read')
  getPolicy() { return this.svc.policy(); }

  @Post('policy')
  @RequirePermission('settings.update')
  setPolicy(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.setPolicy(dto, Number(me.id)); }

  @Get('refundable/:enrolmentId')
  @RequirePermission('refund.request')
  refundable(@Param('enrolmentId', ParseIntPipe) id: number) { return this.svc.refundable(id); }

  @Get(':id')
  @RequirePermission('refund.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Get(':id/pdf')
  @RequirePermission('refund.read')
  async pdf(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.pdf(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post()
  @RequirePermission('refund.request')
  request(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.request(dto, me, scope);
  }

  /** Approve a NORMAL (at-or-below-threshold) refund. A high-value refund is refused here
   *  and must go through approve-high. */
  @Post(':id/approve')
  @RequirePermission('refund.approve')
  approve(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.decide(id, true, dto?.note ?? null, me, scope, false);
  }

  /** Approve a HIGH-VALUE refund — only the senior approver holds refund.approve_high. */
  @Post(':id/approve-high')
  @RequirePermission('refund.approve_high')
  approveHigh(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.decide(id, true, dto?.note ?? null, me, scope, true);
  }

  @Post(':id/reject')
  @RequirePermission('refund.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.decide(id, false, dto?.note ?? null, me, scope, false);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('refund.delete')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('refund.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Delete(':id')
  @RequirePermission('refund.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
