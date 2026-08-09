import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { TrainingService } from './training.service';

interface Me { id: number; name: string }

/**
 * Help & Support › Training Videos — an ORG-WIDE staff training library.
 * View is training.view (all staff); create/edit/delete is training.manage (admins).
 * Literal routes (categories) declared before ':id'.
 */
@Controller('training-videos')
export class TrainingController {
  constructor(private readonly svc: TrainingService) {}

  @Get() @RequirePermission('training.view')
  list(@Query() q: any) { return this.svc.list(q ?? {}); }

  @Get('categories') @RequirePermission('training.view')
  categories() { return this.svc.categories(); }

  @Post('bulk-delete/impact') @RequirePermission('training.manage')
  bulkImpact(@Body() b: any) { return this.svc.bulkImpact(b?.ids); }
  @Post('bulk-delete') @RequirePermission('training.manage')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me) { return this.svc.bulkRemove(b?.ids, me); }

  @Post() @RequirePermission('training.manage')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Patch(':id') @RequirePermission('training.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.update(id, dto); }

  @Delete(':id') @RequirePermission('training.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }
}
