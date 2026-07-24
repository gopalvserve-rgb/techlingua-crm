import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { SupportService } from './support.service';

interface Me { id: number; name: string }

/**
 * Help & Support › Support Tickets — INTERNAL staff tickets, full lifecycle.
 * Every route carries @RequirePermission; record scope is enforced INSIDE the SQL by
 * SupportService (a scoped user's list/get can never return another branch's tickets).
 *
 * Literal routes (summary/meta) are declared BEFORE ':id' so the param cannot shadow them.
 */
@Controller('support-tickets')
export class SupportController {
  constructor(private readonly svc: SupportService) {}

  @Get()
  @RequirePermission('ticket.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, q ?? {});
  }

  @Get('summary')
  @RequirePermission('ticket.read')
  summary(@CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope);
  }

  @Get('meta')
  @RequirePermission('ticket.read')
  meta() {
    return this.svc.meta();
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('ticket.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('ticket.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Post(':id/transition')
  @RequirePermission('ticket.update')
  transition(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.transition(id, dto, me, scope);
  }

  @Post(':id/comments')
  @RequirePermission('ticket.comment')
  comment(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.addComment(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('ticket.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
