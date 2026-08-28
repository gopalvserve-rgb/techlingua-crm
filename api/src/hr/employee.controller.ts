import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { EmployeeService } from './employee.service';

interface Me { id: number; name: string }

/** HR & Workforce › Employee Directory — the staff register. Full list treatment. */
@Controller('employees')
export class EmployeeController {
  constructor(private readonly svc: EmployeeService) {}

  @Get() @RequirePermission('employee.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }

  @Get('summary') @RequirePermission('employee.read')
  summary(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.summary(scope, q ?? {}); }

  @Post('bulk-delete/impact') @RequirePermission('employee.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('employee.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Get(':id') @RequirePermission('employee.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  /** dev/143 item 5 — printable Employee ID card (consumes the employee_id document template). */
  @Get(':id/id-card') @RequirePermission('employee.read')
  async idCard(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const { buffer, filename } = await this.svc.idCard(id, scope);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Post() @RequirePermission('employee.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Patch(':id') @RequirePermission('employee.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.update(id, dto, me, scope); }

  @Delete(':id') @RequirePermission('employee.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
