import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { QuestionService } from './question.service';
import { QuestionController } from './question.controller';
import { QuestionCategoryService } from './question-category.service';
import { QuestionCategoryController } from './question-category.controller';

/**
 * ASSESSMENTS — Batch A: the Question Bank foundation (categories + questions + options).
 * StorageModule is @Global, so StorageService (R2) injects without importing it here.
 * Batches B (tests/exams), C (attempts/evaluation) and D (results/analytics) extend this.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [QuestionCategoryController, QuestionController],
  providers: [QuestionCategoryService, QuestionService],
  exports: [QuestionCategoryService, QuestionService],
})
export class AssessmentsModule {}
