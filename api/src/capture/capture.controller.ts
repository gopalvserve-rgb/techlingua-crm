import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CaptureService, ReferralDto, WalkInDto } from './capture.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

// Multi-select list filters (client, Aug 2026): accept CSV or repeated keys.
const nums = (v?: string | string[]): number[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
};
const strs = (v?: string | string[]): string[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  return parts.length ? [...new Set(parts)] : undefined;
};

/** Walk-ins — the branch desk. Assign-on-add: the counsellor is mandatory and owns the lead. */
@Controller('walk-ins')
export class WalkInController {
  constructor(private readonly capture: CaptureService) {}

  @Get() @RequirePermission('walkin.read')
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    return this.capture.listWalkIns(s, {
      today: q.today === '1' || q.today === 'true',
      status: (typeof q.status === 'string' ? q.status : undefined) || undefined,
      from: (typeof q.from === 'string' ? q.from : undefined) || undefined,
      to: (typeof q.to === 'string' ? q.to : undefined) || undefined,
      // Client (Aug 2026) list filters — multi-select Branch/Vertical/Counsellor/Status + Purpose.
      branch_ids: nums(q.branch_ids), vertical_ids: nums(q.vertical_ids),
      counsellor_ids: nums(q.counsellor_ids), statuses: strs(q.statuses), purposes: strs(q.purposes),
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
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    return this.capture.listReferrals(s, {
      status: (typeof q.status === 'string' ? q.status : undefined) || undefined,
      // Client (Aug 2026) list filters — Branch/Vertical, Referrer type, Assigned counsellor, date range.
      branch_ids: nums(q.branch_ids), vertical_ids: nums(q.vertical_ids),
      referrer_types: strs(q.referrer_types), counsellor_ids: nums(q.counsellor_ids),
      from: (typeof q.from === 'string' ? q.from : undefined) || undefined,
      to: (typeof q.to === 'string' ? q.to : undefined) || undefined,
      limit: Number(q.limit) || 100,
    });
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
