import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CaptureService, ReferralDto, WalkInDto } from './capture.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/** Walk-ins — the branch desk. Assign-on-add: the counsellor is mandatory and owns the lead. */
@Controller('walk-ins')
export class WalkInController {
  constructor(private readonly capture: CaptureService) {}

  @Get() @RequirePermission('walkin.read')
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.capture.listWalkIns(s, {
      today: q.today === '1' || q.today === 'true',
      status: q.status || undefined,
      from: q.from || undefined, to: q.to || undefined,
      limit: Number(q.limit) || 100,
    });
  }

  @Get('summary') @RequirePermission('walkin.read')
  summary(@CurrentScope() s: ResolvedScope) { return this.capture.walkInSummary(s); }

  @Post() @RequirePermission('walkin.create')
  create(@Body() dto: WalkInDto, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.capture.createWalkIn(dto, u.id, s);
  }

  @Patch(':id') @RequirePermission('walkin.update')
  update(
    @Param('id', ParseIntPipe) id: number, @Body() dto: Partial<WalkInDto>,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.capture.updateWalkIn(id, dto, u.id, s);
  }

  @Delete(':id') @RequirePermission('walkin.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.capture.removeWalkIn(id, u.id);
  }
}

/** Referrals — a student/parent/partner refers someone; the referred person becomes a lead. */
@Controller('referrals')
export class ReferralController {
  constructor(private readonly capture: CaptureService) {}

  @Get() @RequirePermission('referral.read')
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.capture.listReferrals(s, { status: q.status || undefined, limit: Number(q.limit) || 100 });
  }

  @Get('summary') @RequirePermission('referral.read')
  summary(@CurrentScope() s: ResolvedScope) { return this.capture.referralSummary(s); }

  @Post() @RequirePermission('referral.create')
  create(@Body() dto: ReferralDto, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.capture.createReferral(dto, u.id, s);
  }

  @Patch(':id') @RequirePermission('referral.update')
  update(
    @Param('id', ParseIntPipe) id: number, @Body() dto: Partial<ReferralDto>,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.capture.updateReferral(id, dto, u.id, s);
  }

  @Delete(':id') @RequirePermission('referral.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.capture.removeReferral(id, u.id);
  }
}
