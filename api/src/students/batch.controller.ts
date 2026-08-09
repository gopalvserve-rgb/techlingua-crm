import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { BatchService } from './batch.service';

interface Me { id: number; name: string }

/** Students & Academics › Batches. A batch is bound to Branch -> Vertical -> Course. */
@Controller('batches')
export class BatchController {
  constructor(private readonly svc: BatchService) {}

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

  @Delete(':id')
  @RequirePermission('batch.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
