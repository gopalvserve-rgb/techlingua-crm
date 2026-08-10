import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { PaymentService, PAYMENT_STATUSES } from './payment.service';

interface Me { id: number; name: string }

const list = (v: any): string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
};
const nums = (v: any): number[] | undefined => list(v)?.map(Number).filter((n) => Number.isFinite(n));

/** Finance & Collections › Online Payments (Razorpay, per vertical). RBAC payment.* + scope. */
@Controller('payments')
export class PaymentController {
  constructor(private readonly svc: PaymentService) {}

  @Get()
  @RequirePermission('payment.read')
  index(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      status: list(q?.status), enrolment_id: q?.enrolment_id ? Number(q.enrolment_id) : undefined,
      q: q?.q, from: q?.from, to: q?.to, branch_ids: nums(q?.branch_ids), vertical_ids: nums(q?.vertical_ids),
      limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('payment.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get('meta')
  @RequirePermission('payment.read')
  meta() {
    return {
      gateway: 'razorpay', currency: 'INR', statuses: PAYMENT_STATUSES,
      note: 'Online collection uses the Razorpay key stored per vertical in Settings. A vertical with no key returns a clean 503 until it is entered.',
    };
  }

  @Get(':id')
  @RequirePermission('payment.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  /** Mint a Razorpay payment link for a fee due / installment (amount in paise, per vertical). */
  @Post('link')
  @RequirePermission('payment.create')
  createLink(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.createLink(dto, me, scope);
  }

  @Post('bulk-delete/impact')
  @RequirePermission('payment.delete')
  bulkImpact(@Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDeleteImpact(Array.isArray(dto?.ids) ? dto.ids : [], scope);
  }

  @Post('bulk-delete')
  @RequirePermission('payment.delete')
  bulkDelete(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkDelete(Array.isArray(dto?.ids) ? dto.ids : [], me, scope);
  }

  @Delete(':id')
  @RequirePermission('payment.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
