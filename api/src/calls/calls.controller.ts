import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CallsService } from './calls.service';

interface Me { id: number; name: string }

/**
 * Calls — the real call pipeline (tap-to-dial + call-log import + recording sync).
 *   read  = view history / recordings / report (RBAC-scoped in SQL)
 *   act   = record a dial, sync device rows, upload a recording, log a disposition (own)
 * Literal routes are declared before ':id' so nothing shadows them.
 */
@Controller('calls')
export class CallsController {
  constructor(private readonly svc: CallsService) {}

  @Get('meta')
  @RequirePermission('calls.read')
  meta() { return this.svc.meta(); }

  @Get('summary')
  @RequirePermission('calls.read')
  summary(@CurrentScope() scope: ResolvedScope) { return this.svc.summary(scope); }

  @Get('settings')
  @RequirePermission('calls.read')
  getSettings(@CurrentUser() me: Me) { return this.svc.getSettings(me); }

  @Put('settings')
  @RequirePermission('calls.act')
  updateSettings(@CurrentUser() me: Me, @Body() dto: any) { return this.svc.updateSettings(me, dto); }

  @Get('lead/:leadId')
  @RequirePermission('calls.read')
  leadCalls(@Param('leadId', ParseIntPipe) leadId: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.leadCalls(scope, leadId);
  }

  @Get('recording/:id/url')
  @RequirePermission('calls.read')
  recordingUrl(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope) {
    return this.svc.recordingUrl(scope, id);
  }

  @Get('recording/:id/stream')
  @RequirePermission('calls.read')
  async stream(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const f = await this.svc.recordingBytes(id);
    if (!f) { res.status(404).json({ message: 'Recording not found' }); return; }
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
    res.send(f.body);
  }

  @Post('dial')
  @RequirePermission('calls.act')
  dial(@CurrentUser() me: Me, @Body() dto: any) { return this.svc.dial(me, dto); }

  @Post('log-sync')
  @RequirePermission('calls.act')
  logSync(@CurrentUser() me: Me, @Body() dto: any) { return this.svc.logSync(me, dto); }

  @Post('recording-upload')
  @RequirePermission('calls.act')
  recordingUpload(@CurrentUser() me: Me, @Body() dto: any) { return this.svc.recordingUpload(me, dto); }

  @Post(':id/disposition')
  @RequirePermission('calls.act')
  logDisposition(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @Body() dto: any) {
    return this.svc.logDisposition(me, id, dto);
  }

  @Get()
  @RequirePermission('calls.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, q ?? {}); }
}
