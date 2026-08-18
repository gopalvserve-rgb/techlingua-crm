import { Body, Controller, Get, Param, ParseIntPipe, Put } from '@nestjs/common';
import { CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { CoursesService } from './courses.service';
import { CourseLevelsService } from './course-levels.service';

/**
 * Course catalogs — dropdown sources for the Course master's Course Type / Level / Delivery Mode.
 * Read-gated by master.read (courses ARE a master); mirrors GET /batches/type-catalog.
 *
 * Course LEVELS (enrollment re-model, batch 1) — a course's multiple levels + per-level fees:
 *   GET /courses/:id/levels          → all levels of a course (batch-2 convert reads this)
 *   PUT /courses/:id/levels {levels} → replace the course's levels (from the Course form saver)
 */
@Controller('courses')
export class CoursesController {
  constructor(
    private readonly svc: CoursesService,
    private readonly levels: CourseLevelsService,
  ) {}

  @Get('type-catalog')
  @RequirePermission('master.read')
  typeCatalog() {
    return this.svc.typeCatalog();
  }

  @Get('level-catalog')
  @RequirePermission('master.read')
  levelCatalog() {
    return this.svc.levelCatalog();
  }

  @Get('delivery-catalog')
  @RequirePermission('master.read')
  deliveryCatalog() {
    return this.svc.deliveryCatalog();
  }

  /** All levels (code + fee) of one course — the read batch-2's convert screen consumes. */
  @Get(':id/levels')
  @RequirePermission('master.read')
  listLevels(@Param('id', ParseIntPipe) id: number) {
    return this.levels.list(id);
  }

  /** Replace a course's levels (validated: non-empty unique codes, fee >= 0). */
  @Put(':id/levels')
  @RequirePermission('master.update')
  @ScopedEntity('master')
  setLevels(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { levels?: unknown },
    @CurrentUser() user: { id: number },
  ) {
    return this.levels.replace(id, body?.levels, user.id);
  }
}
