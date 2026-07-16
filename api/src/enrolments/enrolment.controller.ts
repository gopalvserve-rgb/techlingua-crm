import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { EnrolmentService, PAYMENT_PLANS, PLAN_LABELS } from './enrolment.service';
import { ApprovalService } from './approval.service';

interface Me { id: number; name: string }

/** Performance & Conversion › Sale Closure. Every route carries @RequirePermission. */
@Controller('enrolments')
export class EnrolmentController {
  constructor(
    private readonly svc: EnrolmentService,
    private readonly approvals: ApprovalService,
  ) {}

  @Get()
  @RequirePermission('enrolment.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, {
      status: q?.status, q: q?.q, from: q?.from, to: q?.to,
      limit: q?.limit ? Number(q.limit) : undefined,
    });
  }

  @Get('summary')
  @RequirePermission('enrolment.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  /** The form's option lists + whether approvals are on, in one call. */
  @Get('meta')
  @RequirePermission('enrolment.read')
  async meta() {
    const policy = await this.approvals.policy();
    return {
      payment_plans: PAYMENT_PLANS.map((k) => ({ key: k, label: PLAN_LABELS[k] })),
      approvals: {
        enabled: policy.enabled,
        steps: (policy.steps ?? []).filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label })),
      },
    };
  }

  /** THE APPROVAL QUEUE — scoped. `enrolment.approve` is Branch/Vertical Manager + admins. */
  @Get('approvals')
  @RequirePermission('enrolment.approve')
  queue(@CurrentScope() scope: ResolvedScope, @Query('status') status?: string) {
    return this.approvals.queue(scope, { status });
  }

  /** The approval POLICY. Read is wide (a counsellor should know his sale needs a nod). */
  @Get('approval-policy')
  @RequirePermission('enrolment.read')
  policy() {
    return this.approvals.policy();
  }

  /** …but only an admin flips it. `settings.update` = Super/Org Admin (migration 026). */
  @Post('approval-policy')
  @RequirePermission('settings.update')
  setPolicy(@Body() dto: any, @CurrentUser() me: Me) {
    return this.approvals.setPolicy(dto, Number(me.id));
  }

  @Post('approvals/:id/approve')
  @RequirePermission('enrolment.approve')
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    const d = await this.approvals.decide(id, true, dto?.note ?? null, me, scope);
    return this.svc.settleApproval(d.entity_id, true, Number(me.id));
  }

  @Post('approvals/:id/reject')
  @RequirePermission('enrolment.approve')
  async rejectApproval(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    const d = await this.approvals.decide(id, false, dto?.note ?? null, me, scope);
    return this.svc.settleApproval(d.entity_id, false, Number(me.id));
  }

  @Get(':id')
  @RequirePermission('enrolment.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('enrolment.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('enrolment.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Post(':id/cancel')
  @RequirePermission('enrolment.update')
  cancel(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.cancel(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('enrolment.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
