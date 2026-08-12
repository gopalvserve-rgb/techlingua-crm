import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { QuestionService } from './question.service';
import { QuestionController } from './question.controller';
import { QuestionCategoryService } from './question-category.service';
import { QuestionCategoryController } from './question-category.controller';
import { AssessmentService } from './assessment.service';
import { AssessmentController } from './assessment.controller';
import { AssessmentTemplateService } from './assessment-template.service';
import { AssessmentTemplateController } from './assessment-template.controller';
import { AttemptService } from './attempt.service';
import { AttemptController } from './attempt.controller';
import { SubmissionService } from './submission.service';
import { SubmissionController } from './submission.controller';
import { GradeSchemeService } from './grade-scheme.service';
import { GradeSchemeController } from './grade-scheme.controller';
import { ResultService } from './result.service';
import { ResultController } from './result.controller';
import { AssessmentCertificateService } from './assessment-certificate.service';
import { AssessmentCertificateController } from './assessment-certificate.controller';
import { PublicCertificateController } from './public-certificate.controller';
import { AssessmentReportService } from './assessment-report.service';
import { AssessmentReportController } from './assessment-report.controller';

/**
 * ASSESSMENTS — the Assessment / Test module.
 *   · Batch A: the Question Bank foundation (categories + questions + options).
 *   · Batch B: Tests / Exams (assessment + sections + question links) + reusable
 *     settings templates, publish/close, server-side total, and the answer-stripped
 *     assemble() seam that Batch C's attempt flow consumes.
 * StorageModule is @Global, so StorageService (R2) injects without importing it here.
 * Batches C (attempts/evaluation) and D (results/analytics) extend this further.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [
    QuestionCategoryController, QuestionController,
    AssessmentTemplateController, AssessmentController,
    AttemptController, SubmissionController,
    GradeSchemeController, ResultController,
    AssessmentCertificateController, PublicCertificateController, AssessmentReportController,
  ],
  providers: [
    QuestionCategoryService, QuestionService,
    AssessmentTemplateService, AssessmentService,
    AttemptService, SubmissionService,
    GradeSchemeService, ResultService, AssessmentCertificateService, AssessmentReportService,
  ],
  exports: [
    QuestionCategoryService, QuestionService,
    AssessmentTemplateService, AssessmentService,
    AttemptService, SubmissionService,
    GradeSchemeService, ResultService, AssessmentCertificateService, AssessmentReportService,
  ],
})
export class AssessmentsModule {}
