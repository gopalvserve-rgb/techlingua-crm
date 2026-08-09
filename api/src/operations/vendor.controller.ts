import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { VendorService } from './vendor.service';

interface Me { id: number; name: string }

/** Operations › Vendors — org-wide vendor master (India GSTIN). Full list treatment. */
@Controller('vendors')
export class VendorController {
  constructor(private readonly svc: VendorService) {}

  @Get() @RequirePermission('vendor.read')
  list(@Query() q: any) { return this.svc.list(q ?? {}); }

  @Post('bulk-delete/impact') @RequirePermission('vendor.delete')
  bulkImpact(@Body() b: any) { return this.svc.bulkImpact(b?.ids); }
  @Post('bulk-delete') @RequirePermission('vendor.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me) { return this.svc.bulkRemove(b?.ids, me); }

  @Get(':id') @RequirePermission('vendor.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post() @RequirePermission('vendor.create')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Patch(':id') @RequirePermission('vendor.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.update(id, dto); }

  @Delete(':id') @RequirePermission('vendor.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }
}
