import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AssetService } from './asset.service';

interface Me { id: number; name: string }

/** Operations › Assets — equipment/furniture/IT register. Full list treatment. */
@Controller('assets')
export class AssetController {
  constructor(private readonly svc: AssetService) {}

  @Get() @RequirePermission('asset.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }

  @Get('summary') @RequirePermission('asset.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.summary(scope, q ?? {}); }

  @Post('bulk-delete/impact') @RequirePermission('asset.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('asset.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('asset.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Post() @RequirePermission('asset.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id') @RequirePermission('asset.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, me, scope); }

  @Delete(':id') @RequirePermission('asset.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
