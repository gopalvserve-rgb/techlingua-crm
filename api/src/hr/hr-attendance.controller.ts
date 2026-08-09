import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { HrAttendanceService } from './hr-attendance.service';

interface Me { id: number; name: string }

/** HR & Workforce › Attendance — daily STAFF attendance. */
@Controller('hr/attendance')
export class HrAttendanceController {
  constructor(private readonly svc: HrAttendanceService) {}

  @Get('roster') @RequirePermission('hr_attendance.read')
  roster(@Query('date') date: string, @Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.roster(date, scope, q ?? {}); }

  @Get('sheet') @RequirePermission('hr_attendance.read')
  sheet(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.sheet(scope, q ?? {}); }

  @Get('summary') @RequirePermission('hr_attendance.read')
  summary(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.summary(scope, q ?? {}); }

  @Get() @RequirePermission('hr_attendance.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) { return this.svc.list(scope, q ?? {}); }

  @Post('mark') @RequirePermission('hr_attendance.mark')
  mark(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.mark(dto, me, scope); }

  @Post('bulk-delete/impact') @RequirePermission('hr_attendance.delete')
  bulkImpact(@Body() b: any, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }
  @Post('bulk-delete') @RequirePermission('hr_attendance.delete')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkRemove(b?.ids, me, scope); }

  @Delete(':id') @RequirePermission('hr_attendance.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}
