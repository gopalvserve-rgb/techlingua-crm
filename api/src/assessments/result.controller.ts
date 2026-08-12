import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { ResultService } from './result.service';

/**
 * RESULTS — the student result card (gated by show_result_mode) + the test leaderboard.
 * Distinct paths so it composes with the existing Attempt/Assessment controllers.
 */
@Controller()
export class ResultController {
  constructor(private readonly svc: ResultService) {}

  @Get('attempts/:aid/result')
  @RequirePermission('assessment_attempt.read')
  attemptResult(@Param('aid', ParseIntPipe) aid: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.attemptResult(aid, scope);
  }

  @Get('assessments/:id/results')
  @RequirePermission('assessment.read')
  leaderboard(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.leaderboard(id, scope);
  }

  // --- Governance: RELEASE results to students (Academic Admin / Super Admin) ---
  @Post('attempts/:aid/release-result')
  @RequirePermission('results.publish')
  releaseAttempt(@Param('aid', ParseIntPipe) aid: number, @CurrentUser() me: { id: number }, @CurrentScope() scope: ResolvedScope) {
    return this.svc.releaseAttempt(aid, me, scope);
  }

  @Post('assessments/:id/release-results')
  @RequirePermission('results.publish')
  releaseAssessment(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: { id: number }, @CurrentScope() scope: ResolvedScope) {
    return this.svc.releaseAssessment(id, me, scope);
  }
}
