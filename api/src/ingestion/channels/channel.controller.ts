import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { NotConfiguredException } from '../../common/not-configured.exception';
import { ChannelService } from './channel.service';
import { WebhookService } from './webhook.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../../rbac/rbac.decorators';
import { ResolvedScope } from '../../rbac/rbac.types';

type U = { id: number };

/**
 * Lead-capture channel administration (Marketing & Lead Management › Lead Capture).
 *
 * `channel.read`   — see the channels, their status and the inbound event log
 *                    (Branch/Vertical Managers get this, scoped to their units).
 * `channel.manage` — create/edit/delete, and READ BACK the two credentials that
 *                    must be pasted into Meta/Google. Super Admin + Org Admin only.
 *
 * Every route is record-scoped through the channel's campaign (ScopeEnforcer), so
 * a branch-scoped admin can only wire up their own campaigns — an out-of-scope
 * campaign 404s, per the project's existing policy.
 */
@Controller('channels')
export class ChannelController {
  constructor(private readonly svc: ChannelService, private readonly hooks: WebhookService) {}

  /** The provider registry — drives the Configure form (add a provider, get a form). */
  @Get('providers') @RequirePermission('channel.read')
  providers() { return this.svc.providers(); }

  /** The inbound event log across all channels in scope (mounted before :id). */
  @Get('events') @RequirePermission('channel.read')
  events(
    @CurrentScope() s: ResolvedScope,
    @Query('channel_id') cid?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.events(s, cid ? Number(cid) : undefined, limit ? Number(limit) : 50, from, to);
  }

  @Get() @RequirePermission('channel.read')
  list(@CurrentScope() s: ResolvedScope) { return this.svc.list(s); }

  @Get(':id') @RequirePermission('channel.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.get(id, s, u.id);
  }

  /** The ONLY endpoint that reveals a credential (Meta verify token / Google key). */
  @Get(':id/credentials') @RequirePermission('channel.manage')
  credentials(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.credentials(id, s, u.id);
  }

  @Post() @RequirePermission('channel.manage')
  create(@Body() b: any, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.create(b, s, u.id);
  }

  @Patch(':id') @RequirePermission('channel.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() b: any, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.update(id, b, s, u.id);
  }

  @Delete(':id') @RequirePermission('channel.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.remove(id, s, u.id);
  }

  /** Rotate the public URL key + the generated verify/webhook token. */
  @Post(':id/regenerate') @RequirePermission('channel.manage')
  regenerate(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.svc.regenerate(id, s, u.id);
  }

  /**
   * "Pull now" for a Google Sheet channel. With no Google credentials this is a
   * clean 503 with the exact reason (same contract as the SMS gateway) — never a 500.
   */
  @Post(':id/poll') @RequirePermission('channel.manage')
  async poll(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    await this.svc.get(id, s, u.id);                 // scope + existence
    const row = await this.svc.raw(id);
    if (!row || row.provider !== 'google_sheet') {
      throw new NotConfiguredException('This channel is not a Google Sheet channel.');
    }
    const missing = this.svc.missing(row);
    if (missing.length) {
      throw new NotConfiguredException(`Not configured — still needed: ${missing.join(', ')}`);
    }
    return this.hooks.pollSheet(row, { manual: true });
  }
}
