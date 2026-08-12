import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ContentApprovalWorkflowService } from './content-approval.service';

/**
 * GOVERNANCE — the reusable content-approval workflow (docs/dev/67). @Global so the shared
 * ContentApprovalWorkflowService injects into any module (assessments now, Batch-2 content
 * later) without a per-module import.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [ContentApprovalWorkflowService],
  exports: [ContentApprovalWorkflowService],
})
export class GovernanceModule {}
