import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { SoftDeleteService } from './softdelete.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };
type BulkBody = { ids?: number[] };

/**
 * Uniform soft-delete surface, driven by the central registry:
 *   GET    /api/<entity>/:id/impact   — association hierarchy (needs <module>.delete)
 *   DELETE /api/<entity>/:id          — soft delete (audit action `delete`)
 *   POST   /api/<entity>/:id/restore  — restore (deleted.manage; 409 if a parent is deleted)
 *   GET    /api/deleted-items?entity= — Administration > Deleted Items
 * Impact + delete are scope-checked via @ScopedEntity (out-of-scope -> 404).
 * Restore routes skip @ScopedEntity deliberately: deleted rows are excluded from
 * scoping lookups, and restore is admin-only (deleted.manage => scope 'all').
 */
@Controller()
export class SoftDeleteController {
  constructor(private readonly sd: SoftDeleteService) {}

  // ---- branches ----
  @Get('branches/:id/impact') @RequirePermission('branch.delete') @ScopedEntity('branch')
  branchImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('branch', id); }
  @Delete('branches/:id') @RequirePermission('branch.delete') @ScopedEntity('branch')
  branchDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('branch', id, u.id); }
  @Post('branches/:id/restore') @RequirePermission('deleted.manage')
  branchRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('branch', id); }

  // ---- verticals ----
  @Get('verticals/:id/impact') @RequirePermission('vertical.delete') @ScopedEntity('vertical')
  verticalImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('vertical', id); }
  @Delete('verticals/:id') @RequirePermission('vertical.delete') @ScopedEntity('vertical')
  verticalDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('vertical', id, u.id); }
  @Post('verticals/:id/restore') @RequirePermission('deleted.manage')
  verticalRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('vertical', id); }

  // ---- pipelines ----
  @Get('pipelines/:id/impact') @RequirePermission('pipeline.delete') @ScopedEntity('pipeline')
  pipelineImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('pipeline', id); }
  @Delete('pipelines/:id') @RequirePermission('pipeline.delete') @ScopedEntity('pipeline')
  pipelineDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('pipeline', id, u.id); }
  @Post('pipelines/:id/restore') @RequirePermission('deleted.manage')
  pipelineRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('pipeline', id); }

  // ---- campaigns ----
  @Get('campaigns/:id/impact') @RequirePermission('campaign.delete') @ScopedEntity('campaign')
  campaignImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('campaign', id); }
  @Delete('campaigns/:id') @RequirePermission('campaign.delete') @ScopedEntity('campaign')
  campaignDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('campaign', id, u.id); }
  @Post('campaigns/:id/restore') @RequirePermission('deleted.manage')
  campaignRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('campaign', id); }

  // ---- sources ----
  @Get('sources/:id/impact') @RequirePermission('source.delete') @ScopedEntity('source')
  sourceImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('source', id); }
  @Delete('sources/:id') @RequirePermission('source.delete') @ScopedEntity('source')
  sourceDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('source', id, u.id); }
  @Post('sources/:id/restore') @RequirePermission('deleted.manage')
  sourceRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('source', id); }

  // ---- leads ----
  @Get('leads/:id/impact') @RequirePermission('lead.delete') @ScopedEntity('lead')
  leadImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('lead', id); }
  @Delete('leads/:id') @RequirePermission('lead.delete') @ScopedEntity('lead')
  leadDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('lead', id, u.id); }
  @Post('leads/:id/restore') @RequirePermission('deleted.manage')
  leadRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('lead', id); }

  // ---- follow-ups ----
  @Get('follow-ups/:id/impact') @RequirePermission('followup.delete') @ScopedEntity('follow_up')
  fuImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('follow_up', id); }
  @Delete('follow-ups/:id') @RequirePermission('followup.delete') @ScopedEntity('follow_up')
  fuDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('follow_up', id, u.id); }
  @Post('follow-ups/:id/restore') @RequirePermission('deleted.manage')
  fuRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('follow_up', id); }

  // ---- users ----
  @Get('users/:id/impact') @RequirePermission('user.delete') @ScopedEntity('user')
  userImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('user', id); }
  @Delete('users/:id') @RequirePermission('user.delete') @ScopedEntity('user')
  userDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('user', id, u.id); }
  @Post('users/:id/restore') @RequirePermission('deleted.manage')
  userRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('user', id); }

  // ---- teams ----
  @Get('teams/:id/impact') @RequirePermission('team.delete') @ScopedEntity('team')
  teamImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('team', id); }
  @Delete('teams/:id') @RequirePermission('team.delete') @ScopedEntity('team')
  teamDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('team', id, u.id); }
  @Post('teams/:id/restore') @RequirePermission('deleted.manage')
  teamRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('team', id); }

  // ---- roles (custom only — system roles 400 in the service) ----
  @Get('roles/:id/impact') @RequirePermission('role.delete')
  roleImpact(@Param('id', ParseIntPipe) id: number) { return this.sd.impact('role', id); }
  @Delete('roles/:id') @RequirePermission('role.delete')
  roleDelete(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sd.remove('role', id, u.id); }
  @Post('roles/:id/restore') @RequirePermission('deleted.manage')
  roleRestore(@Param('id', ParseIntPipe) id: number) { return this.sd.restore('role', id); }

  // ---- masters (state, city, m_*) ----
  @Get('masters/:type/:id/impact') @RequirePermission('master.delete') @ScopedEntity('master')
  masterImpact(@Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.sd.impact(`master:${type}`, id);
  }
  @Delete('masters/:type/:id') @RequirePermission('master.delete') @ScopedEntity('master')
  masterDelete(@Param('type') type: string, @Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.sd.remove(`master:${type}`, id, u.id);
  }
  @Post('masters/:type/:id/restore') @RequirePermission('deleted.manage')
  masterRestore(@Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.sd.restore(`master:${type}`, id);
  }

  // ---- BULK DELETE (client request, Aug 2026) --------------------------------
  // One shared pattern per module: POST /<plural>/bulk-delete{,/impact} { ids: [] }.
  // Same permission as the single delete; each id is record-scope filtered in the service
  // (out-of-scope ids skipped, never a data oracle); soft-delete via the central registry;
  // returns { deleted, skipped } (delete) / aggregate impact (impact). Leads have their own
  // /leads/bulk/delete in LeadsController (mirrors the other /leads/bulk/* actions).

  @Post('branches/bulk-delete/impact') @RequirePermission('branch.delete')
  branchesBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('branch', b?.ids, u.id, s); }
  @Post('branches/bulk-delete') @RequirePermission('branch.delete')
  branchesBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('branch', b?.ids, u.id, s); }

  @Post('verticals/bulk-delete/impact') @RequirePermission('vertical.delete')
  verticalsBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('vertical', b?.ids, u.id, s); }
  @Post('verticals/bulk-delete') @RequirePermission('vertical.delete')
  verticalsBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('vertical', b?.ids, u.id, s); }

  @Post('pipelines/bulk-delete/impact') @RequirePermission('pipeline.delete')
  pipelinesBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('pipeline', b?.ids, u.id, s); }
  @Post('pipelines/bulk-delete') @RequirePermission('pipeline.delete')
  pipelinesBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('pipeline', b?.ids, u.id, s); }

  @Post('campaigns/bulk-delete/impact') @RequirePermission('campaign.delete')
  campaignsBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('campaign', b?.ids, u.id, s); }
  @Post('campaigns/bulk-delete') @RequirePermission('campaign.delete')
  campaignsBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('campaign', b?.ids, u.id, s); }

  @Post('sources/bulk-delete/impact') @RequirePermission('source.delete')
  sourcesBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('source', b?.ids, u.id, s); }
  @Post('sources/bulk-delete') @RequirePermission('source.delete')
  sourcesBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('source', b?.ids, u.id, s); }

  @Post('users/bulk-delete/impact') @RequirePermission('user.delete')
  usersBulkImpact(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkImpact('user', b?.ids, u.id, s); }
  @Post('users/bulk-delete') @RequirePermission('user.delete')
  usersBulkDelete(@Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.sd.bulkRemove('user', b?.ids, u.id, s); }

  // Masters (state, city, m_* incl. courses). Type in the path -> registry key `master:<type>`.
  @Post('masters/:type/bulk-delete/impact') @RequirePermission('master.delete')
  masterBulkImpact(@Param('type') type: string, @Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.sd.bulkImpact(`master:${type}`, b?.ids, u.id, s);
  }
  @Post('masters/:type/bulk-delete') @RequirePermission('master.delete')
  masterBulkDelete(@Param('type') type: string, @Body() b: BulkBody, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.sd.bulkRemove(`master:${type}`, b?.ids, u.id, s);
  }

  // ---- Administration > Deleted Items ----
  @Get('deleted-items/entities') @RequirePermission('deleted.manage')
  entities() { return this.sd.entities(); }

  @Get('deleted-items') @RequirePermission('deleted.manage')
  deletedItems(@Query('entity') entity?: string, @Query('limit') limit?: string) {
    return this.sd.deletedItems(entity || 'branch', limit ? Number(limit) : undefined);
  }
}
