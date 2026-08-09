import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RbacModule } from '../rbac/rbac.module';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';
import { ReleaseNoteController } from './release-note.controller';
import { ReleaseNoteService } from './release-note.service';

/**
 * Phase 2 ERP Batch 7 — Support extras: Training Videos + Release Notes (the last
 * Phase-2 support items). Both are org-wide staff content libraries under Help & Support.
 */
@Module({
  imports: [DatabaseModule, RbacModule],
  controllers: [TrainingController, ReleaseNoteController],
  providers: [TrainingService, ReleaseNoteService],
})
export class SupportExtrasModule {}
