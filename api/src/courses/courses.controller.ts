import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../rbac/rbac.decorators';
import { CoursesService } from './courses.service';

/**
 * Course catalogs — dropdown sources for the Course master's Course Type / Level / Delivery Mode.
 * Read-gated by master.read (courses ARE a master); mirrors GET /batches/type-catalog.
 */
@Controller('courses')
export class CoursesController {
  constructor(private readonly svc: CoursesService) {}

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
}
