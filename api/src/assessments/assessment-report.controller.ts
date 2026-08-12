import { Controller, Get, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AssessmentReportService } from './assessment-report.service';

interface Me { id: number; name: string }

/** ASSESSMENT DASHBOARDS / REPORTS — student / faculty / admin aggregates. RBAC assessment_attempt.read. */
@Controller('assessment-reports')
export class AssessmentReportController {
  constructor(private readonly svc: AssessmentReportService) {}

  @Get('student')
  @RequirePermission('assessment_attempt.read')
  student(@Query('student_id') sid: string, @CurrentScope() scope: ResolvedScope) { return this.svc.student(Number(sid), scope); }

  @Get('faculty')
  @RequirePermission('assessment_attempt.read')
  faculty(@CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.faculty(me, scope); }

  @Get('admin')
  @RequirePermission('assessment_attempt.read')
  admin(@CurrentScope() scope: ResolvedScope) { return this.svc.admin(scope); }
}
