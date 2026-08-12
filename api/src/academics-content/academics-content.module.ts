import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { CourseContentService } from './course-content.service';
import { CourseContentController } from './course-content.controller';
import { SyllabusService } from './syllabus.service';
import { SyllabusController } from './syllabus.controller';

/**
 * ACADEMICS CONTENT — Academics Governance Batch 2. Two NEW governed content entities
 * (Course Content + Syllabus) that reuse the @Global ContentApprovalWorkflowService. Study
 * Material governance is added in-place to the existing LearningModule. StorageModule is
 * @Global so StorageService (R2) injects without importing it here.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [CourseContentController, SyllabusController],
  providers: [CourseContentService, SyllabusService],
  exports: [CourseContentService, SyllabusService],
})
export class AcademicsContentModule {}
