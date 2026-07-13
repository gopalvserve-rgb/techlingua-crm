import { Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { SoftDeleteService } from './softdelete.service';
import { CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';

type U = { id: number };

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

  // ---- Administration > Deleted Items ----
  @Get('deleted-items/entities') @RequirePermission('deleted.manage')
  entities() { return this.sd.entities(); }

  @Get('deleted-items') @RequirePermission('deleted.manage')
  deletedItems(@Query('entity') entity?: string, @Query('limit') limit?: string) {
    return this.sd.deletedItems(entity || 'branch', limit ? Number(limit) : undefined);
  }
}
