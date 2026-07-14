import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { DispositionDto, HandoutService } from './handout.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * On-demand "Start Calling" hand-out (PROJECT_DOCUMENTATION §4.1).
 *
 * `lead.pull`  — an agent claims the next batch from an on_demand campaign's pool
 *                and works it as a queue. Counsellors/Telecallers hold it (own scope).
 * `lead.read`  — the manager/admin pool view (waiting counts, who pulled what, when),
 *                record-scoped through the campaign path.
 *
 * TELEPHONY IS OUT OF SCOPE — no dialler, no call control. This is a work queue.
 */
@Controller('leads/handout')
export class HandoutController {
  constructor(private readonly handout: HandoutService) {}

  /** On-demand campaigns I may pull from + how many leads are waiting in each. */
  @Get('campaigns') @RequirePermission('lead.pull')
  campaigns(@CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.handout.campaigns(u.id, s);
  }

  /** My live working queue (most recent open batch) — the Start Calling screen. */
  @Get('current') @RequirePermission('lead.pull')
  current(@CurrentUser() u: U) {
    return this.handout.current(u.id);
  }

  /** Manager/admin: pool status per on_demand campaign + who pulled what and when. */
  @Get('pool') @RequirePermission('lead.read')
  pool(@CurrentScope() s: ResolvedScope, @Query('campaign_id') campaignId?: string) {
    return this.handout.pool(s, campaignId ? Number(campaignId) : undefined);
  }

  /** START CALLING — atomically claim the next N unassigned leads and assign them to me. */
  @Post() @RequirePermission('lead.pull')
  pull(
    @Body() body: { campaign_id: number; size?: number },
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.handout.pull(Number(body?.campaign_id), u.id, s, body?.size);
  }

  /** One batch of mine (by id). */
  @Get(':id') @RequirePermission('lead.pull')
  batch(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.handout.batch(id, u.id);
  }

  /** "Save & next": log a disposition on one lead of my batch and advance the progress. */
  @Post(':id/action') @RequirePermission('lead.pull')
  action(
    @Param('id', ParseIntPipe) id: number, @Body() dto: DispositionDto,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.handout.action(id, dto, u.id, s);
  }
}
