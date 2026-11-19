import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CrossSellService } from './crosssell.service';
import { CrossSellOpportunityService } from './opportunity.service';

interface Me { id: number; name: string }

/**
 * CRM › Cross-Sell — suggest additional courses to converted contacts and act on them.
 *
 * read   = view candidates / attempts (RBAC-scoped INSIDE the SQL by CrossSellService, so
 *          a counsellor's list can never return another branch's contacts).
 * act    = create a follow-up / a new lead / dismiss a suggestion.
 * manage = maintain the admin rule map (current course -> suggested course).
 *
 * Literal routes (candidates/summary/meta/attempts/rules/act) are declared with distinct
 * literal segments so no ':id' can shadow them.
 */
@Controller('cross-sell')
export class CrossSellController {
  constructor(private readonly svc: CrossSellService, private readonly opp: CrossSellOpportunityService) {}

  /* ---- client 12 Nov 2026: dashboard, opportunities, recommendations, campaigns, reports ---- */

  @Get('dashboard')
  @RequirePermission('crosssell.read')
  dashboard(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.dashboard(scope, q ?? {}); }

  @Get('recommendations')
  @RequirePermission('crosssell.read')
  recommendations(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.recommendations(scope, q ?? {}); }

  @Get('recommendations/top')
  @RequirePermission('crosssell.read')
  topRecommendations(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.topRecommendations(scope, q ?? {}, 10); }

  @Get('opportunities')
  @RequirePermission('crosssell.read')
  opportunities(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.list(scope, q ?? {}); }

  @Get('opportunities/:id')
  @RequirePermission('crosssell.read')
  opportunity(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.opp.get(id, scope); }

  @Post('opportunities')
  @RequirePermission('crosssell.act')
  createOpportunity(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.opp.create(dto, me, scope, dto?.from_recommendation ? 'recommendation' : 'manual');
  }

  @Patch('opportunities/:id')
  @RequirePermission('crosssell.act')
  updateOpportunity(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.opp.update(id, dto, me, scope);
  }

  @Delete('opportunities/:id')
  @RequirePermission('crosssell.manage')
  removeOpportunity(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.opp.remove(id, me, scope);
  }

  @Get('campaigns')
  @RequirePermission('crosssell.read')
  campaigns(@CurrentScope() scope: ResolvedScope) { return this.opp.campaigns(scope); }

  @Get('campaigns/audience')
  @RequirePermission('crosssell.act')
  audience(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.audience(scope, q ?? {}); }

  @Post('campaigns')
  @RequirePermission('crosssell.act')
  sendCampaign(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.opp.sendCampaign(dto, me, scope); }

  @Get('reports')
  @RequirePermission('crosssell.read')
  reports(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.opp.reports(scope, q ?? {}); }

  // (12 Nov 2026: the old candidates / summary / meta routes are replaced by recommendations + dashboard)

  @Get('attempts')
  @RequirePermission('crosssell.read')
  attempts(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.attempts(scope, q ?? {});
  }

  @Get('rules')
  @RequirePermission('crosssell.manage')
  rules() {
    return this.svc.listRules();
  }

  @Post('rules')
  @RequirePermission('crosssell.manage')
  createRule(@Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.createRule(dto, me);
  }

  @Patch('rules/:id')
  @RequirePermission('crosssell.manage')
  updateRule(@Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.svc.updateRule(id, dto);
  }

  @Delete('rules/:id')
  @RequirePermission('crosssell.manage')
  removeRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.svc.removeRule(id, me);
  }

  @Post('act')
  @RequirePermission('crosssell.act')
  act(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.act(dto, me, scope);
  }
}
