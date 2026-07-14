import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { SlaService, SlaPolicyDto } from './sla.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * SLA & TAT. `sla.read` (scoped) for the KPI strip, the breach list and a lead's own
 * clocks; `sla.manage` (admins) to define the policies. The breach list is filtered by
 * the caller's record scope, so a Branch Manager's "manager view" is their branch — the
 * SQL cannot return another branch's breaches.
 */
@Controller('sla')
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get('summary') @RequirePermission('sla.read')
  summary(@CurrentScope() s: ResolvedScope) { return this.sla.summary(s); }

  /** THE MANAGER VIEW — every open breach in scope. */
  @Get('breaches') @RequirePermission('sla.read')
  breaches(@CurrentScope() s: ResolvedScope, @Query('limit') limit?: string) {
    return this.sla.breaches(s, Number(limit) || 100);
  }

  @Get('policies') @RequirePermission('sla.read')
  policies(@Query('include_inactive') inc?: string) {
    return this.sla.listPolicies(inc === '1' || inc === 'true');
  }

  @Post('policies') @RequirePermission('sla.manage')
  create(@Body() dto: SlaPolicyDto, @CurrentUser() u: U) { return this.sla.createPolicy(dto, u.id); }

  @Patch('policies/:id') @RequirePermission('sla.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<SlaPolicyDto>, @CurrentUser() u: U) {
    return this.sla.updatePolicy(id, dto, u.id);
  }

  @Delete('policies/:id') @RequirePermission('sla.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) { return this.sla.deletePolicy(id, u.id); }

  /** A single lead's clocks + stage TAT. Record-scoped: an out-of-scope lead 404s. */
  @Get('lead/:id') @RequirePermission('sla.read') @ScopedEntity('lead')
  forLead(@Param('id', ParseIntPipe) id: number) { return this.sla.forLead(id); }
}
