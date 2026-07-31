import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CreateLeadDto, LeadsService } from './leads.service';
import { CreateFollowUpDto, FollowUpsService } from './followups.service';
import { LeadMergeService } from '../ingestion/merge.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };
const num = (v?: string) => (v != null && v !== '' ? Number(v) : undefined);

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly merge: LeadMergeService,
    private readonly enforcer: ScopeEnforcerService,
  ) {}

  @Get() @RequirePermission('lead.read')
  list(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.leads.list(s, {
      branch_id: num(q.branch_id), vertical_id: num(q.vertical_id), pipeline_id: num(q.pipeline_id),
      campaign_id: num(q.campaign_id), stage_id: num(q.stage_id), status_id: num(q.status_id),
      owner_id: num(q.owner_id), source_id: num(q.source_id), temperature: q.temperature || undefined,
      created_from: q.created_from || undefined, created_to: q.created_to || undefined,
      // Sprint 3 — the score BAND is filterable and sortable; SLA breaches are filterable
      sla_breached: q.sla_breached === '1' || q.sla_breached === 'true',
      flagged: q.flagged === '1' || q.flagged === 'true',
      duplicate: q.duplicate === '1' || q.duplicate === 'true',
      // Bulk actions (Jul 2026) — the paused-only filter (find parked leads to resume).
      paused: q.paused === '1' || q.paused === 'true',
      // Dashboard card links (Aug 2026) — Conversions (won) and Unassigned filters.
      won: q.won === '1' || q.won === 'true',
      unassigned: q.unassigned === '1' || q.unassigned === 'true',
      sort: q.sort || undefined,
      q: q.q || undefined, limit: num(q.limit), offset: num(q.offset),
    });
  }

  /** Scoped dashboard numbers: KPIs, per-stage counts, 14-day series, follow-up counters. */
  @Get('summary') @RequirePermission('lead.read')
  summary(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U) {
    return this.leads.summary(s, u.id);
  }

  // Bulk actions — "select all matching filter": just the in-scope ids for the current
  // filters (capped), so the UI can bulk-act over the whole filtered set, not one page.
  // Declared BEFORE @Get(':id') so 'select-ids' is not swallowed by the id route.
  @Get('select-ids') @RequirePermission('lead.read')
  selectIds(@CurrentScope() s: ResolvedScope, @Query() q: Record<string, string>) {
    return this.leads.selectIds(s, {
      branch_id: num(q.branch_id), vertical_id: num(q.vertical_id), pipeline_id: num(q.pipeline_id),
      campaign_id: num(q.campaign_id), stage_id: num(q.stage_id), status_id: num(q.status_id),
      owner_id: num(q.owner_id), source_id: num(q.source_id), temperature: q.temperature || undefined,
      created_from: q.created_from || undefined, created_to: q.created_to || undefined,
      sla_breached: q.sla_breached === '1' || q.sla_breached === 'true',
      flagged: q.flagged === '1' || q.flagged === 'true',
      duplicate: q.duplicate === '1' || q.duplicate === 'true',
      paused: q.paused === '1' || q.paused === 'true',
      won: q.won === '1' || q.won === 'true',
      unassigned: q.unassigned === '1' || q.unassigned === 'true',
      q: q.q || undefined,
    });
  }

  // ---- BULK actions over a selected/filtered set (client request, Jul 2026) --------------
  // Declared BEFORE the `:id/...` routes so `/leads/bulk/...` is not matched as `:id='bulk'`.
  // Each is RBAC-gated by permission AND per-lead record scope (skipped leads are reported).

  /** Transfer ALL selected leads to a Branch/Vertical/Campaign (owner_mode keep|distribute). */
  @Post('bulk/transfer') @RequirePermission('lead.transfer')
  bulkTransfer(@Body() dto: { lead_ids?: number[] } & Record<string, unknown>, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.leads.bulkTransfer(dto?.lead_ids, dto ?? {}, u.id, s);
  }

  /** Reassign ALL selected leads to one active, in-scope user. */
  @Post('bulk/reassign') @RequirePermission('lead.assign')
  bulkReassign(@Body() dto: { lead_ids?: number[]; to_user_id?: number }, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.leads.bulkReassign(dto?.lead_ids, Number(dto?.to_user_id), u.id, s);
  }

  /** Pause ALL selected leads (park out of distribution + SLA/escalation sweeps). */
  @Post('bulk/pause') @RequirePermission('lead.update')
  bulkPause(@Body() dto: { lead_ids?: number[] }, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.leads.bulkSetPaused(dto?.lead_ids, true, u.id, s);
  }

  /** Resume ALL selected leads. */
  @Post('bulk/resume') @RequirePermission('lead.update')
  bulkResume(@Body() dto: { lead_ids?: number[] }, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.leads.bulkSetPaused(dto?.lead_ids, false, u.id, s);
  }

  @Get(':id') @RequirePermission('lead.read') @ScopedEntity('lead')
  get(@Param('id', ParseIntPipe) id: number) { return this.leads.get(id); }

  @Get(':id/activities') @RequirePermission('lead.read') @ScopedEntity('lead')
  activities(@Param('id', ParseIntPipe) id: number) { return this.leads.activities(id); }

  @Post() @RequirePermission('lead.create')
  create(@Body() dto: CreateLeadDto, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.leads.create(dto, u.id, s);
  }

  @Patch(':id') @RequirePermission('lead.update') @ScopedEntity('lead')
  update(
    @Param('id', ParseIntPipe) id: number, @Body() dto: Record<string, unknown>,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.leads.update(id, dto, u.id, s);
  }

  // UAT-R3 #23 — reassign a lead's owner. Gated on `lead.assign` (a manager giving a lead
  // to someone), distinct from `lead.update`. Writes the 'assign' activity + audit entry.
  @Post(':id/reassign') @RequirePermission('lead.assign') @ScopedEntity('lead')
  reassign(
    @Param('id', ParseIntPipe) id: number, @Body() dto: { owner_id?: number },
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.leads.reassign(id, Number(dto?.owner_id), u.id, s);
  }

  // Users row action #7 — BULK reassign: move EVERY lead owned by from_user_id to
  // to_user_id (active, in-scope). Gated on `lead.assign` like the single reassign.
  @Post('reassign-all') @RequirePermission('lead.assign')
  reassignAll(
    @Body() dto: { from_user_id?: number; to_user_id?: number },
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.leads.reassignAllOwned(Number(dto?.from_user_id), Number(dto?.to_user_id), u.id, s);
  }

  // Single-lead TRANSFER — move THIS lead to another Branch/Vertical/(Pipeline)/Campaign.
  // Gated on `lead.transfer`; :id checked by @ScopedEntity, the TARGET campaign by the
  // service (assertRefInScope). Declared AFTER the `bulk/*` routes above.
  @Post(':id/transfer') @RequirePermission('lead.transfer') @ScopedEntity('lead')
  transfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { campaign_id?: number; source_id?: number; owner_mode?: 'keep' | 'distribute' } & Record<string, unknown>,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.leads.transfer(id, dto ?? {}, u.id, s);
  }

  @Post(':id/notes') @RequirePermission('lead.update') @ScopedEntity('lead')
  addNote(@Param('id', ParseIntPipe) id: number, @Body() body: { note: string }, @CurrentUser() u: U) {
    return this.leads.addNote(id, body?.note, u.id);
  }

  // ---- duplicates & merge (NeoDove §4) ------------------------------------
  // RBAC: reading the panel needs lead.read; merging needs lead.merge, and BOTH
  // leads must be inside the caller's record scope — :id via @ScopedEntity and
  // the other one via the STRICT enforcer (out of scope -> 404, no oracle).

  /** "This lead is a duplicate of X" · "N duplicates of this lead" · merge history + diffs. */
  @Get(':id/duplicates') @RequirePermission('lead.read') @ScopedEntity('lead')
  duplicates(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope) {
    return this.merge.duplicatesFor(id, s);
  }

  /** What a merge WOULD change — the diff the modal renders before the user commits. */
  @Get(':id/merge-preview') @RequirePermission('lead.merge') @ScopedEntity('lead')
  async mergePreview(
    @Param('id', ParseIntPipe) id: number, @Query('from') from: string,
    @CurrentScope() s: ResolvedScope, @CurrentUser() u: U,
  ) {
    const sourceId = Number(from);
    if (!Number.isFinite(sourceId) || sourceId <= 0) throw new BadRequestException('from (source lead id) is required');
    await this.enforcer.assertInScope(s, 'lead', sourceId, u.id);
    return this.merge.preview(id, sourceId);
  }

  /** Merge `from_lead_id` INTO :id — the target survives, the source becomes a tombstone. */
  @Post(':id/merge') @RequirePermission('lead.merge') @ScopedEntity('lead')
  async mergeLeads(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { from_lead_id: number; reopen?: boolean },
    @CurrentScope() s: ResolvedScope, @CurrentUser() u: U,
  ) {
    const sourceId = Number(body?.from_lead_id);
    if (!Number.isFinite(sourceId) || sourceId <= 0) throw new BadRequestException('from_lead_id is required');
    await this.enforcer.assertInScope(s, 'lead', sourceId, u.id);
    return this.merge.mergeLeads(id, sourceId, u.id, body?.reopen === true);
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
      view: (q.view as 'assigned' | 'reported') || undefined,
      priority: (q.priority as 'low' | 'medium' | 'high') || undefined,
      branch_id: num(q.branch_id), vertical_id: num(q.vertical_id),
      pipeline_id: num(q.pipeline_id), campaign_id: num(q.campaign_id),
    }, u.id);
  }

  @Get('summary') @RequirePermission('followup.read')
  summary(@CurrentScope() s: ResolvedScope, @CurrentUser() u: U) { return this.fu.summary(s, u.id); }

  @Post() @RequirePermission('followup.create')
  create(@Body() dto: CreateFollowUpDto, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.fu.create(dto, u.id, s);
  }

  @Patch(':id') @RequirePermission('followup.update') @ScopedEntity('follow_up')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateFollowUpDto> & { status?: string; complete?: boolean },
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.fu.update(id, dto, u.id, s);
  }

  // DELETE /follow-ups/:id now lives in SoftDeleteController (central registry:
  // impact preview + deleted_at/deleted_by + restore).
}
