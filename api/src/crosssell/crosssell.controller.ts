import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CrossSellService } from './crosssell.service';

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
  constructor(private readonly svc: CrossSellService) {}

  @Get('candidates')
  @RequirePermission('crosssell.read')
  candidates(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.candidates(scope, q ?? {});
  }

  @Get('summary')
  @RequirePermission('crosssell.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get('meta')
  @RequirePermission('crosssell.read')
  meta() {
    return this.svc.meta();
  }

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
