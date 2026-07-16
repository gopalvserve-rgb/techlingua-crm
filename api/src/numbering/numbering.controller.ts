import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { KIND_DEFAULTS, NumberingService } from './numbering.service';

interface Me { id: number; name: string }

/**
 * NUMBERING SERIES — Administration › Settings › Numbering.
 *
 * Behind `settings.read` / `settings.update` (Super/Org Admin only, migration 026),
 * because a numbering series is a settings concern and because renumbering a client's
 * quotations is not something a Branch Manager should be able to do.
 */
@Controller('numbering')
export class NumberingController {
  constructor(private readonly svc: NumberingService) {}

  @Get()
  @RequirePermission('settings.read')
  async list() {
    return {
      kinds: Object.entries(KIND_DEFAULTS).map(([key, d]) => ({ key, label: d.label })),
      series: await this.svc.list(),
    };
  }

  @Post()
  @RequirePermission('settings.update')
  save(@Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.save(dto, Number(me.id));
  }

  @Delete(':id')
  @RequirePermission('settings.update')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }
}
