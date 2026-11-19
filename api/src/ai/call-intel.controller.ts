import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CallIntelService } from './call-intel.service';

interface Me { id: number; name: string }

/**
 * Communication Intelligence (client 12 Nov 2026) — AI Insights overview, Call Insights, Call
 * Ratings, Quality Monitoring, Call Transcription and Call Summaries all read from here.
 * ai.read = see (scoped to the user's own calls / branch / vertical); ai.run = queue, retry,
 * paste, re-analyse, review; settings.update = transcription settings.
 */
@Controller('call-intel')
export class CallIntelController {
  constructor(private readonly svc: CallIntelService) {}

  @Get('status') @RequirePermission('ai.read')
  status(@CurrentScope() scope: ResolvedScope) { return this.svc.status(scope); }

  @Get('settings') @RequirePermission('ai.read')
  settings() { return this.svc.settings(); }

  @Put('settings') @RequirePermission('settings.update')
  saveSettings(@Body() dto: any) { return this.svc.saveSettings(dto); }

  @Get('overview') @RequirePermission('ai.read')
  overview(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.overview(scope, q ?? {}); }

  @Get('insights') @RequirePermission('ai.read')
  insights(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.insights(scope, q ?? {}); }

  @Get('insights/:id') @RequirePermission('ai.read')
  insight(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.insight(id, scope); }

  @Post('insights/:id/review') @RequirePermission('ai.run')
  review(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.review(id, dto?.note, me, scope);
  }

  @Get('ratings') @RequirePermission('ai.read')
  ratings(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.ratings(scope, q ?? {}); }

  @Get('queue') @RequirePermission('ai.read')
  queue(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.queue(scope, q ?? {}); }

  @Get('recordings/untranscribed') @RequirePermission('ai.read')
  untranscribed(@CurrentScope() scope: ResolvedScope) { return this.svc.untranscribed(scope); }

  @Post('recordings/:id/transcribe') @RequirePermission('ai.run')
  transcribe(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.enqueueRecording(id, me); }

  @Post('transcripts/:id/retry') @RequirePermission('ai.run')
  retry(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.retry(id, scope); }

  @Post('transcripts/:id/analyse') @RequirePermission('ai.run')
  reanalyse(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) { return this.svc.reanalyse(id, scope); }

  @Post('paste') @RequirePermission('ai.run')
  paste(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.paste(dto, me, scope); }
}
