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
  list(@Param('type') type: string, @Query() query: Record<string, string | string[]>) {
    // Course master list filters (client, Aug 2026): multi-select Branch/Vertical (via meta) +
    // name search. Harmless for other master types (no meta.branch_id/vertical_id).
    const csv = (v?: string | string[]) => v == null ? undefined :
      [...new Set((Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean))];
    const all = query.all === '1' || query.all === 'true';
    return this.masters.list(type, all, {
      branchIds: csv(query.branch_ids), verticalIds: csv(query.vertical_ids),
      // Course list (client, Aug 2026): Course (own id) / Status / Course Type / Delivery Mode.
      courseIds: csv(query.course_ids), statuses: csv(query.statuses),
      courseTypes: csv(query.course_types), deliveryModes: csv(query.delivery_modes),
      q: typeof query.q === 'string' ? query.q : undefined,
    });
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
