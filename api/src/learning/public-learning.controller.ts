import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../rbac/rbac.decorators';
import { ReportCardService } from './reportcard.service';
import { MaterialService } from './material.service';

/**
 * PARENT VIEW — a login-free, shareable read of a PUBLISHED report card by its share token.
 * Staff publish a card (mints the token) and share the link; a parent/guardian opens it and
 * sees the child's report card, attendance summary and the parent-visible study material for
 * the child's batch/course. No auth (a full parent-login portal is a later item — noted).
 */
@Public()
@Controller('public/report-card')
export class PublicLearningController {
  constructor(private readonly rc: ReportCardService, private readonly mat: MaterialService) {}

  @Public()
  @Get(':token')
  async view(@Param('token') token: string) {
    const card = await this.rc.byToken(token);
    const materials = await this.mat.forStudent(Number(card.student_id), { parentsOnly: true });
    return {
      org_name: card.org_name, vertical_name: card.vertical_name, branch_name: card.branch_name,
      student_name: card.student_name, student_no: card.student_no,
      course_name: card.course_name, batch_name: card.batch_name,
      report_card: {
        term: card.term, period_from: card.period_from, period_to: card.period_to,
        attendance_pct: card.attendance_pct, attendance_present: card.attendance_present, attendance_total: card.attendance_total,
        test_avg_pct: card.test_avg_pct, test_count: card.test_count,
        assignment_avg_pct: card.assignment_avg_pct, assignment_count: card.assignment_count,
        overall_pct: card.overall_pct, overall_grade: card.overall_grade, remarks: card.remarks,
      },
      materials,
    };
  }

  @Public()
  @Get(':token/pdf')
  async pdf(@Param('token') token: string, @Res() res: Response) {
    const { buffer, filename } = await this.rc.pdfByToken(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }
}
