import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { JourneyService } from './journey.service';

interface Me { id: number }

@Controller('journeys')
export class JourneyController {
  constructor(private readonly svc: JourneyService) {}

  /** The trigger catalogue the builder's first dropdown is generated from. */
  @Get('triggers')
  @RequirePermission('journey.read')
  triggers() { return this.svc.triggers(); }

  /** Run history — per journey or (on the lead sheet) per lead. */
  @Get('runs')
  @RequirePermission('journey.read')
  runs(@Query('journey_id') jid?: string, @Query('lead_id') lid?: string, @Query('limit') limit?: string) {
    return this.svc.runs({
      journey_id: jid ? Number(jid) : undefined,
      lead_id: lid ? Number(lid) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get()
  @RequirePermission('journey.read')
  list() { return this.svc.list(); }

  @Get(':id')
  @RequirePermission('journey.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post()
  @RequirePermission('journey.create')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, Number(me.id)); }

  @Patch(':id')
  @RequirePermission('journey.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.update(id, dto, Number(me.id));
  }

  /** Activate / pause — the kill switch, and a mutation, so it needs journey.update. */
  @Patch(':id/status')
  @RequirePermission('journey.update')
  setStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.setStatus(id, String(dto?.status ?? ''), Number(me.id));
  }

  /** Run a journey against one lead by hand. Idempotent — it will not double-send. */
  @Post(':id/run')
  @RequirePermission('journey.update')
  run(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.runFor(id, Number(dto?.lead_id), scope);
  }

  @Delete(':id')
  @RequirePermission('journey.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.svc.remove(id, Number(me.id));
  }
}
