import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';
import { HrAttendanceController } from './hr-attendance.controller';
import { HrAttendanceService } from './hr-attendance.service';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';

/**
 * Phase 2 ERP Batch 6 — Basic HR (no statutory payroll): Employee Directory, Staff Attendance,
 * Leaves. Employee / attendance / leave are branch-scoped (ScopeResolver); leave_type is an
 * org-wide master. Leave approvals notify via NotificationsModule (the channel-agnostic notifier),
 * deduct the balance, and mark those days as leave in staff attendance.
 */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule, NotificationsModule],
  controllers: [EmployeeController, HrAttendanceController, LeaveController],
  providers: [EmployeeService, HrAttendanceService, LeaveService],
})
export class HrModule {}
