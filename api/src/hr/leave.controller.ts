import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { LeaveService } from './leave.service';

interface Me { id: number; name: string }

/** HR & Workforce › Leaves — types, balances, and the apply→approve/reject workflow. */
@Controller('leaves')
export class LeaveController {
  constructor(private readonly svc: LeaveService) {}

  // ----- leave types (config)
  @Get('types') @RequirePermission('leave.read')
  listTypes(@Query('all') all: string) { return this.svc.listTypes(all === '1'); }
  @Post('types') @RequirePermission('leave.manage')
  saveType(@Body() dto: any) { return this.svc.saveType(dto); }
  @Delete('types/:id') @RequirePermission('leave.manage')
  removeType(@Param('id', ParseIntPipe) id: number) { return this.svc.removeType(id); }

  // ----- balances
  @Get('balances') @RequirePermission('leave.read')
  balances(@Query('employee_id') employeeId: string, @Query('year') year: string, @CurrentScope() scope: ResolvedScope) {
    return this.svc.balances(Number(employeeId), scope, year ? Number(year) : undefined);
  }
  @Post('balances') @RequirePermission('leave.manage')
  setBalance(@Body() dto: any, @CurrentScope() scope: ResolvedScope) { return this.svc.setBalance(dto, scope); }

  // ----- applications
  @Get('summary') @RequirePermission('leave.read')
  summary(@CurrentScope() scope: ResolvedScope) { return this.svc.summary(scope); }

  @Post('bulk-delete/impact') @RequirePermission('leave.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('leave.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get() @RequirePermission('leave.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, q ?? {}); }

  @Post() @RequirePermission('leave.create')
  apply(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.apply(dto, me, scope); }

  @Get(':id') @RequirePermission('leave.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Post(':id/approve') @RequirePermission('leave.approve')
  approve(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.approve(id, dto, me, scope); }

  @Post(':id/reject') @RequirePermission('leave.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.reject(id, dto, me, scope); }

  @Post(':id/cancel') @RequirePermission('leave.create')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.cancel(id, me, scope); }

  @Delete(':id') @RequirePermission('leave.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
