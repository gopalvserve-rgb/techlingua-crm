import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { StudentController } from './student.controller';
import { StudentService } from './student.service';
import { BatchController } from './batch.controller';
import { BatchService } from './batch.service';

/** Phase 2 (CRM-level): lead->student conversion, the students directory + dashboard,
 *  and batches bound to Branch->Vertical->Course. */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [StudentController, BatchController],
  providers: [StudentService, BatchService],
})
export class StudentsModule {}
