import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ScoringService } from './scoring.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * Lead Scoring. Reading the band/distribution needs `score.read` (everyone, at their own
 * record scope — a counsellor's distribution is their own leads). EDITING the rules needs
 * `score.manage` (Super Admin / Org Admin only) — the rules are org-wide policy.
 */
@Controller('scoring')
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  /** Band distribution + the current band thresholds — SCOPED. */
  @Get('summary') @RequirePermission('score.read')
  summary(@CurrentScope() s: ResolvedScope) { return this.scoring.distribution(s); }

  /** The rule-type catalogue that drives the rule form (label, hint, config fields). */
  @Get('rule-types') @RequirePermission('score.read')
  ruleTypes() { return this.scoring.ruleTypes(); }

  @Get('rules') @RequirePermission('score.read')
  rules(@Query('include_inactive') inc?: string) {
    return this.scoring.listRules(inc === '1' || inc === 'true');
  }

  @Get('config') @RequirePermission('score.read')
  config() { return this.scoring.config(); }

  @Patch('config') @RequirePermission('score.manage')
  saveConfig(@Body() body: Record<string, unknown>, @CurrentUser() u: U) {
    return this.scoring.saveConfig(body, u.id);
  }

  @Post('rules') @RequirePermission('score.manage')
  create(@Body() dto: Record<string, unknown>, @CurrentUser() u: U) {
    return this.scoring.createRule(dto, u.id);
  }

  @Patch('rules/:id') @RequirePermission('score.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Record<string, unknown>, @CurrentUser() u: U) {
    return this.scoring.updateRule(id, dto, u.id);
  }

  @Delete('rules/:id') @RequirePermission('score.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: U) {
    return this.scoring.deleteRule(id, u.id);
  }

  /** Force a full re-score (after a bulk rule edit). Admin only — it touches every lead. */
  @Post('recompute') @RequirePermission('score.manage')
  async recompute() { return { rescored: await this.scoring.recomputeAll() }; }
}
