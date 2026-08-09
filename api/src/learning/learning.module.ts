import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { MaterialController } from './material.controller';
import { MaterialService } from './material.service';
import { CertificateController } from './certificate.controller';
import { CertificateService } from './certificate.service';
import { ReportCardController } from './reportcard.controller';
import { ReportCardService } from './reportcard.service';
import { PublicLearningController } from './public-learning.controller';

/**
 * Phase 2 ERP Batch 2 — Learning: study material (access-controlled library), certificates
 * (serial + branded PDF, issue/reissue/revoke) and academic-progress report cards (computed
 * from attendance + scores + assignments, PDF, tokenised parent view).
 */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule],
  controllers: [MaterialController, CertificateController, ReportCardController, PublicLearningController],
  providers: [MaterialService, CertificateService, ReportCardService],
})
export class LearningModule {}
