import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { MasterDto, MastersService } from './masters.service';
import { CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';

@Controller('masters')
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  /** List available master types (drives the Masters admin sidebar). */
  @Get()
  @RequirePermission('master.read')
  types() {
    return this.masters.types();
  }

  @Get(':type')
  @RequirePermission('master.read')
  list(@Param('type') type: string, @Query('all') all?: string) {
    return this.masters.list(type, all === '1');
  }

  @Post(':type')
  @RequirePermission('master.create')
  create(@Param('type') type: string, @Body() dto: MasterDto, @CurrentUser() user: { id: number }) {
    return this.masters.create(type, dto, user.id);
  }

  @Patch(':type/:id')
  @RequirePermission('master.update')
  @ScopedEntity('master')
  update(@Param('type') type: string, @Param('id', ParseIntPipe) id: number, @Body() dto: Partial<MasterDto>) {
    return this.masters.update(type, id, dto);
  }

  @Patch(':type/:id/deactivate')
  @RequirePermission('master.deactivate')
  @ScopedEntity('master')
  deactivate(@Param('type') type: string, @Param('id', ParseIntPipe) id: number) {
    return this.masters.deactivate(type, id);
  }
}
