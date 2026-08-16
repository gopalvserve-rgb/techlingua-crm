import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { BatchService } from './batch.service';

interface Me { id: number; name: string }

/** Students & Academics › Batches. A batch is bound to Branch -> Vertical -> Course and carries
 *  a 7-code lifecycle status (upcoming/active/completed/cancelled/expired/archived/suspended). */
@Controller('batches')
export class BatchController {
  constructor(private readonly svc: BatchService) {}

  /** The batch-status lifecycle CATALOG (labels + meanings) — powers the Change-Status UI. */
  @Get('status-catalog')
  @RequirePermission('batch.read')
  statusCatalog() {
    return this.svc.statusCatalog();
  }

  /** The BATCH TYPE catalog (9 codes) — powers the Batch Type dropdown. Declared BEFORE :id. */
  @Get('type-catalog')
  @RequirePermission('batch.read')
  typeCatalog() {
    return this.svc.typeCatalog();
  }

  @Get()
  @RequirePermission('batch.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.list(scope, q ?? {});
  }

  @Get(':id')
  @RequirePermission('batch.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, scope);
  }

  @Post()
  @RequirePermission('batch.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.create(dto, me, scope);
  }

  @Patch(':id')
  @RequirePermission('batch.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  /** CHANGE STATUS — manual statuses stick; auto statuses re-derive from dates (resume). Guarded
   *  by batch.update (same gate as create/update) and scope-enforced inside the service. */
  @Post(':id/status')
  @RequirePermission('batch.update')
  changeStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.changeStatus(id, dto, me, scope);
  }

  /** BULK change status for the selected batches (list multi-select). Guarded by batch.update. */
  @Post('bulk-status')
  @RequirePermission('batch.update')
  bulkStatus(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkStatus(b?.ids, b, me, scope);
  }

  /** BULK soft-delete the selected batches — impact preview then delete. Guarded by batch.delete. */
  @Post('bulk-delete/impact')
  @RequirePermission('batch.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkImpact(b?.ids, scope);
  }

  @Post('bulk-delete')
  @RequirePermission('batch.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkRemove(b?.ids, me, scope);
  }

  /** The status transition trail (who / when / from → to / manual? / reason). */
  @Get(':id/status-history')
  @RequirePermission('batch.read')
  statusHistory(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.statusHistory(id, scope);
  }

  @Delete(':id')
  @RequirePermission('batch.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
