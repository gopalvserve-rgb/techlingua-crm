import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

@Controller()
export class HierarchyController {
  constructor(private readonly h: HierarchyService) {}

  // ---- branches ----
  @Get('branches') @RequirePermission('branch.read')
  listBranches(@CurrentScope() s: ResolvedScope, @Query('include_inactive') inc?: string, @Query('q') q?: string) {
    return this.h.listBranches(s, inc === '1' || inc === 'true', q);
  }

  @Post('branches') @RequirePermission('branch.create')
  createBranch(@Body() dto: any, @CurrentUser() u: U) { return this.h.createBranch(dto, u.id); }

  @Patch('branches/:id') @RequirePermission('branch.update') @ScopedEntity('branch')
  updateBranch(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.h.updateBranch(id, dto); }

  // ---- verticals ----
  @Get('verticals') @RequirePermission('vertical.read')
  listVerticals(@CurrentScope() s: ResolvedScope, @Query('branch_id') branchId?: string, @Query('include_inactive') inc?: string, @Query('q') q?: string) {
    return this.h.listVerticals(s, branchId ? Number(branchId) : undefined, inc === '1' || inc === 'true', q);
  }

  @Post('verticals') @RequirePermission('vertical.create')
  createVertical(@Body() dto: any, @CurrentUser() u: U) { return this.h.createVertical(dto, u.id); }

  @Patch('verticals/:id') @RequirePermission('vertical.update') @ScopedEntity('vertical')
  updateVertical(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.h.updateVertical(id, dto); }

  // ---- pipelines & stages ----
  @Get('pipelines') @RequirePermission('pipeline.read')
  listPipelines(@CurrentScope() s: ResolvedScope, @Query('vertical_id') verticalId?: string, @Query('include_inactive') inc?: string, @Query('branch_id') branchId?: string, @Query('q') q?: string) {
    return this.h.listPipelines(s, verticalId ? Number(verticalId) : undefined, inc === '1' || inc === 'true', branchId ? Number(branchId) : undefined, q);
  }

  @Post('pipelines') @RequirePermission('pipeline.create')
  createPipeline(@Body() dto: any, @CurrentUser() u: U) { return this.h.createPipeline(dto, u.id); }

  @Patch('pipelines/:id') @RequirePermission('pipeline.update') @ScopedEntity('pipeline')
  updatePipeline(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.h.updatePipeline(id, dto, u.id, s);
  }

  // ALL in-scope pipeline stages (client, Aug 2026) — feeds the Leads STAGE filter; each row
  // carries pipeline_id so the UI can narrow the options to the selected Pipeline(s).
  @Get('stages') @RequirePermission('pipeline.read')
  listAllStages(@CurrentScope() s: ResolvedScope) { return this.h.listAllStages(s); }

  @Get('pipelines/:id/stages') @RequirePermission('pipeline.read') @ScopedEntity('pipeline')
  listStages(@Param('id', ParseIntPipe) id: number) { return this.h.listStages(id); }

  @Post('pipelines/:id/stages') @RequirePermission('pipeline.update') @ScopedEntity('pipeline')
  createStage(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() u: U) {
    return this.h.createStage(id, dto, u.id);
  }

  @Patch('stages/:id') @RequirePermission('pipeline.update') @ScopedEntity('stage')
  updateStage(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.h.updateStage(id, dto); }

  // hard delete is guarded: 409 when any lead still sits in the stage
  @Delete('stages/:id') @RequirePermission('pipeline.update') @ScopedEntity('stage')
  deleteStage(@Param('id', ParseIntPipe) id: number) { return this.h.deleteStage(id); }

  // full reorder (future drag): body { order: number[] } — a permutation of the pipeline's stage ids
  @Put('pipelines/:id/stages/order') @RequirePermission('pipeline.update') @ScopedEntity('pipeline')
  reorderStages(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.h.reorderStages(id, dto?.order); }

  // ---- campaigns ----
  @Get('campaigns') @RequirePermission('campaign.read')
  listCampaigns(@CurrentScope() s: ResolvedScope, @Query('pipeline_id') pipelineId?: string, @Query('include_inactive') inc?: string, @Query('branch_id') branchId?: string, @Query('vertical_id') verticalId?: string, @Query('q') q?: string) {
    return this.h.listCampaigns(s, pipelineId ? Number(pipelineId) : undefined, inc === '1' || inc === 'true', branchId ? Number(branchId) : undefined, verticalId ? Number(verticalId) : undefined, q);
  }

  @Post('campaigns') @RequirePermission('campaign.create')
  createCampaign(@Body() dto: any, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) { return this.h.createCampaign(dto, u.id, s); }

  @Patch('campaigns/:id') @RequirePermission('campaign.update') @ScopedEntity('campaign')
  updateCampaign(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope) {
    return this.h.updateCampaign(id, dto, u.id, s);
  }

  // UAT-R2 #24 — pause / resume ONE agent on a campaign (Campaign Settings).
  @Patch('campaigns/:id/agents/:userId/pause') @RequirePermission('campaign.update') @ScopedEntity('campaign')
  pauseCampaignAgent(
    @Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: { paused?: boolean }, @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.h.setAgentPause(id, userId, dto?.paused === true, u.id, s);
  }

  // ---- sources ----
  @Get('sources') @RequirePermission('source.read')
  listSources(@CurrentScope() s: ResolvedScope, @Query('campaign_id') campaignId?: string, @Query('include_inactive') inc?: string) {
    return this.h.listSources(s, campaignId ? Number(campaignId) : undefined, inc === '1' || inc === 'true');
  }

  @Post('sources') @RequirePermission('source.create')
  createSource(@Body() dto: any, @CurrentUser() u: U) { return this.h.createSource(dto, u.id); }

  @Patch('sources/:id') @RequirePermission('source.update') @ScopedEntity('source')
  updateSource(
    @Param('id', ParseIntPipe) id: number, @Body() dto: any,
    @CurrentUser() u: U, @CurrentScope() s: ResolvedScope,
  ) {
    return this.h.updateSource(id, dto, s, u.id);
  }
}
