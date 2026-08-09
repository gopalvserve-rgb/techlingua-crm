import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { NumberingModule } from '../numbering/numbering.module';
import { StudentsModule } from '../students/students.module';
import { AdmissionController } from './admission.controller';
import { PublicAdmissionController } from './public-admission.controller';
import { AdmissionService } from './admission.service';

/**
 * Phase 2 ERP Batch 3 — Online admission form (public self-serve intake + staff review →
 * approve into a student via the existing StudentService, or reject) and the family/sibling
 * linkage (which lives on StudentService itself). Reuses StudentsModule's exported
 * StudentService for approve→create.
 */
@Module({
  imports: [DatabaseModule, RbacModule, NumberingModule, StudentsModule],
  controllers: [AdmissionController, PublicAdmissionController],
  providers: [AdmissionService],
})
export class AdmissionsModule {}
