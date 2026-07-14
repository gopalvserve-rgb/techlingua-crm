import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { CalendarService, CalendarEventDto } from './calendar.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * Calendar. The FEED merges calendar events (governed by `calendar.read`) with follow-ups
 * (governed by `followup.read`) — two different permissions, so the follow-up scope is
 * resolved separately through the SAME central ScopeResolver rather than reusing the
 * calendar scope (which would silently widen or narrow what a user sees).
 */
@Controller('calendar')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly rbacData: RbacDataService,
    private readonly resolver: ScopeResolverService,
  ) {}

  @Get() @RequirePermission('calendar.read')
  async feed(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U, @Query() q: Record<string, string>) {
    const grants = await this.rbacData.loadUserGrants(u.id);
    const followUpScope = this.resolver.resolve(grants, 'followup.read');
    return this.calendar.feed(s, followUpScope, { from: q.from, to: q.to });
  }

  /** Google / Outlook sync state — "Not configured" until the client supplies credentials. */
  @Get('sync') @RequirePermission('calendar.read')
  syncStatus() { return this.calendar.syncStatus(); }

  /** Manual "Sync now" -> 503 NotConfigured (never an Error-Log entry) until credentials land. */
  @Post('sync') @RequirePermission('calendar.update')
  syncNow() { return this.calendar.syncNow(); }

  @Post() @RequirePermission('calendar.create')
  create(@Body() dto: CalendarEventDto, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.calendar.create(dto, u.id, s);
  }

  @Patch(':id') @RequirePermission('calendar.update')
  update(
    @Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CalendarEventDto>,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.calendar.update(id, dto, u.id, s);
  }

  @Delete(':id') @RequirePermission('calendar.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.calendar.remove(id, u.id);
  }
}
