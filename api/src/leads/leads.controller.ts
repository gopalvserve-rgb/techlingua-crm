import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CreateLeadDto, LeadsService } from './leads.service';
import { CreateFollowUpDto, FollowUpsService } from './followups.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };
const num = (v?: string) => (v != null && v !== '' ? Number(v) : undefined);

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get() @RequirePermission('lead.read')
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.leads.list(s, {
      branch_id: num(q.branch_id), vertical_id: num(q.vertical_id), pipeline_id: num(q.pipeline_id),
      campaign_id: num(q.campaign_id), stage_id: num(q.stage_id), status_id: num(q.status_id),
      owner_id: num(q.owner_id), source_id: num(q.source_id), temperature: q.temperature || undefined,
      q: q.q || undefined, limit: num(q.limit), offset: num(q.offset),
    });
  }

  /** Scoped dashboard numbers: KPIs, per-stage counts, 14-day series, follow-up counters. */
  @Get('summary') @RequirePermission('lead.read')
  summary(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.leads.summary(s, u.id);
  }

  @Get(':id') @RequirePermission('lead.read') @ScopedEntity('lead')
  get(@Param('id', ParseIntPipe) id: number) { return this.leads.get(id); }

  @Get(':id/activities') @RequirePermission('lead.read') @ScopedEntity('lead')
  activities(@Param('id', ParseIntPipe) id: number) { return this.leads.activities(id); }

  @Post() @RequirePermission('lead.create')
  create(@Body() dto: CreateLeadDto, @CurrentUser() u: U) { return this.leads.create(dto, u.id); }

  @Patch(':id') @RequirePermission('lead.update') @ScopedEntity('lead')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Record<string, unknown>, @CurrentUser() u: U) {
    return this.leads.update(id, dto, u.id);
  }

  @Post(':id/notes') @RequirePermission('lead.update') @ScopedEntity('lead')
  addNote(@Param('id', ParseIntPipe) id: number, @Body() body: { note: string }, @CurrentUser() u: U) {
    return this.leads.addNote(id, body?.note, u.id);
  }
}

@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly fu: FollowUpsService) {}

  @Get() @RequirePermission('followup.read')
  list(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U, @Query() q: Record<string, string>) {
    return this.fu.list(s, {
      lead_id: num(q.lead_id), owner_id: num(q.owner_id), status: q.status || undefined,
      due: (q.due as 'today' | 'overdue' | 'upcoming') || undefined,
      mine: q.mine === '1' || q.mine === 'true', limit: num(q.limit),
    }, u.id);
  }

  @Get('summary') @RequirePermission('followup.read')
  summary(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U) { return this.fu.summary(s, u.id); }

  @Post() @RequirePermission('followup.create')
  create(@Body() dto: CreateFollowUpDto, @CurrentUser() u: U) { return this.fu.create(dto, u.id); }

  @Patch(':id') @RequirePermission('followup.update') @ScopedEntity('follow_up')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateFollowUpDto> & { status?: string; complete?: boolean },
    @CurrentUser() u: U,
  ) {
    return this.fu.update(id, dto, u.id);
  }

  @Delete(':id') @RequirePermission('followup.delete') @ScopedEntity('follow_up')
  remove(@Param('id', ParseIntPipe) id: number) { return this.fu.remove(id); }
}
