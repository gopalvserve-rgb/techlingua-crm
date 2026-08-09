import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { CatalogService } from './catalog.service';

interface Me { id: number; name: string }

/** Operations › Catalog — org-wide item/product/service master. Full list treatment on the list. */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get() @RequirePermission('catalog.read')
  list(@Query() q: any) { return this.svc.list(q ?? {}); }

  @Post('bulk-delete/impact') @RequirePermission('catalog.delete')
  bulkImpact(@Body() b: any) { return this.svc.bulkImpact(b?.ids); }
  @Post('bulk-delete') @RequirePermission('catalog.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me) { return this.svc.bulkRemove(b?.ids, me); }

  @Get(':id') @RequirePermission('catalog.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @RequirePermission('catalog.create')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Patch(':id') @RequirePermission('catalog.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.update(id, dto, me); }

  @Delete(':id') @RequirePermission('catalog.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }
}
