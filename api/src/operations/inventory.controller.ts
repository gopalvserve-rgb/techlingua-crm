import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { InventoryService } from './inventory.service';

interface Me { id: number; name: string }

/** Operations › Inventory — per-branch stock + movement ledger. Full list treatment. */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get() @RequirePermission('inventory.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }

  @Get('summary') @RequirePermission('inventory.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.summary(scope, q ?? {}); }

  @Get('movements') @RequirePermission('inventory.read')
  movements(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.movements(scope, q ?? {}); }

  @Post('adjust') @RequirePermission('inventory.manage')
  adjust(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.adjust(dto, me, scope); }

  @Patch(':id/threshold') @RequirePermission('inventory.manage')
  threshold(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentScope() scope: ResolvedScope) { return this.svc.setThreshold(id, dto, scope); }

  @Post('bulk-delete/impact') @RequirePermission('inventory.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('inventory.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Delete(':id') @RequirePermission('inventory.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
