import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AttendanceService } from './attendance.service';

interface Me { id: number; name: string }

/** Students & Academics › Attendance. */
@Controller('academics/attendance')
export class AttendanceController {
  constructor(private readonly svc: AttendanceService) {}

  @Get('roster')
  @RequirePermission('attendance.read')
  roster(@Query('batch_id') batchId: string, @Query('date') date: string, @CurrentScope() scope: ResolvedScope) {
    return this.svc.roster(Number(batchId), date, scope);
  }

  @Get('summary')
  @RequirePermission('attendance.read')
  summary(@Query() q: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.summary(scope, q ?? {});
  }

  @Get()
  @RequirePermission('attendance.read')
  list(@Query() q: any, @CurrentScope() scope: ResolvedScope) {
    return this.svc.list(scope, q ?? {});
  }

  /** Mark a session (staff / self / biometric). Absent => a parent-notification attempt. */
  @Post('mark')
  @RequirePermission('attendance.mark')
  mark(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.mark(dto, me, scope);
  }
}
