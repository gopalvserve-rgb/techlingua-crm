import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { AiService } from './ai.service';

interface Me { id: number; name: string }
type BulkBody = { ids?: number[] };

/**
 * AI › Communication Intelligence — credential-gated AI over the text that exists.
 *
 * read   = view provider status, the AI-analyses list, per-subject insights & the dashboard panel.
 * run    = run summary / sentiment / quality / transcription (degrades cleanly to a 503
 *          "AI not configured" state when no DeepSeek/Gemini key is stored — never a 500).
 * delete = soft-delete analyses (bulk), record-scoped in the service.
 *
 * Literal routes (status/subjects/summary/analyze/analyses/bulk-delete) precede ':id'.
 */
@Controller('ai')
export class AiController {
  constructor(private readonly svc: AiService) {}

  @Get('status')
  @RequirePermission('ai.read')
  status() { return this.svc.status(); }

  @Get('subjects')
  @RequirePermission('ai.read')
  subjects(@CurrentScope() scope: ResolvedScope, @Query('type') type: string, @Query('q') q?: string) {
    return this.svc.subjects(scope, type ?? 'lead', q);
  }

  @Get('summary')
  @RequirePermission('ai.read')
  summary(@CurrentScope() scope: ResolvedScope) { return this.svc.summary(scope); }

  @Get('analyses')
  @RequirePermission('ai.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }

  @Post('analyze')
  @RequirePermission('ai.run')
  analyze(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.analyze(dto ?? {}, me, scope);
  }

  @Post('analyses/bulk-delete/impact')
  @RequirePermission('ai.delete')
  bulkImpact(@Body() b: BulkBody, @CurrentScope() scope: ResolvedScope) { return this.svc.bulkImpact(b?.ids, scope); }

  @Post('analyses/bulk-delete')
  @RequirePermission('ai.delete')
  bulkDelete(@Body() b: BulkBody, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.bulkRemove(b?.ids, me, scope);
  }

  @Get('analyses/:id')
  @RequirePermission('ai.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.get(id, scope); }

  @Delete('analyses/:id')
  @RequirePermission('ai.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }
}
