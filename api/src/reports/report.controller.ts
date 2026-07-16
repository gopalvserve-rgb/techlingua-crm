import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { catalog } from './entities';
import { FILTER_OPS } from './query-builder';
import { Me, ReportService } from './report.service';
import { StandardReportService } from './standard.service';
import { ExportService } from './export.service';
import { ScheduleService } from './schedule.service';
import { ScheduleWorker } from './schedule.worker';

/** Analytics & Reports. Every route carries @RequirePermission — the reflection test
 *  fails the build for one that does not. */
@Controller('reports')
export class ReportController {
  constructor(
    private readonly svc: ReportService,
    private readonly standard: StandardReportService,
    private readonly exports: ExportService,
    private readonly schedules: ScheduleService,
    private readonly scheduleWorker: ScheduleWorker,
  ) {}

  /* --------------------------------------------------------------- catalog */

  /** What the builder draws itself from. Contains NO SQL — the client has never seen
   *  a fragment of it and never will (reports/entities.ts). */
  @Get('catalog')
  @RequirePermission('report.read')
  async catalog(@CurrentUser() me: Me) {
    const allowed = await this.svc.entitiesFor(me);
    return {
      // Only the entities this user's role actually reaches. Offering "Fee receipts" to
      // a telecaller and then handing back an empty grid is how a client files a bug
      // against a rule that is working exactly as intended.
      entities: catalog().filter((e) => allowed.includes(e.key)),
      operators: Object.entries(FILTER_OPS).map(([key, v]) => ({ key, label: v.label, types: v.types, arity: v.arity })),
      date_presets: [
        { key: 'all', label: 'All time' }, { key: 'today', label: 'Today' },
        { key: 'yesterday', label: 'Yesterday' }, { key: 'last_7', label: 'Last 7 days' },
        { key: 'last_30', label: 'Last 30 days' }, { key: 'this_month', label: 'This month' },
        { key: 'last_month', label: 'Last month' }, { key: 'this_quarter', label: 'This quarter' },
        { key: 'this_year', label: 'This year' }, { key: 'custom', label: 'Custom range…' },
      ],
      formats: [
        { key: 'xlsx', label: 'Excel (.xlsx)' },
        { key: 'csv', label: 'CSV' },
        { key: 'pdf', label: 'PDF', note: 'Best up to ~14 columns. PDFs print "Rs." — the standard PDF fonts have no rupee symbol; the Excel export shows it correctly.' },
      ],
    };
  }

  /* ------------------------------------------------------ standard reports */

  @Get('funnel')
  @RequirePermission('report.read')
  funnel(@CurrentUser() me: Me, @Query() q: any) { return this.standard.funnel(me, { from: q?.from, to: q?.to }); }

  @Get('tat')
  @RequirePermission('report.read')
  tat(@CurrentUser() me: Me, @Query() q: any) { return this.standard.tat(me, { from: q?.from, to: q?.to }); }

  @Get('activity')
  @RequirePermission('report.read')
  activity(@CurrentUser() me: Me, @Query() q: any) { return this.standard.activity(me, { from: q?.from, to: q?.to }); }

  @Get('roi')
  @RequirePermission('report.read')
  roi(@CurrentUser() me: Me, @Query() q: any) { return this.standard.roi(me, { from: q?.from, to: q?.to }); }

  /* ----------------------------------------------------------- definitions */

  @Get()
  @RequirePermission('report.read')
  list(@CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.list(me, scope); }

  @Post('preview')
  @RequirePermission('report.read')
  preview(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.preview(dto, me); }

  @Post()
  @RequirePermission('report.create')
  create(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.create(dto, me, scope); }

  @Get(':id')
  @RequirePermission('report.read')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.get(id, me, scope);
  }

  /** RUN. The rows come back in the CALLER'S scope, always — see ReportService. */
  @Post(':id/run')
  @RequirePermission('report.read')
  run(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.run(id, me, scope, dto?.override);
  }

  @Patch(':id')
  @RequirePermission('report.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.update(id, dto, me, scope);
  }

  @Delete(':id')
  @RequirePermission('report.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.remove(id, me, scope);
  }

  @Post(':id/share')
  @RequirePermission('report.share')
  share(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.share(id, dto, me, scope);
  }

  /* --------------------------------------------------------------- exports */

  @Get('exports/mine')
  @RequirePermission('report.export')
  myExports(@CurrentUser() me: Me) { return this.exports.listMine(me); }

  @Post('exports')
  @RequirePermission('report.export')
  exportAdhoc(@Body() dto: any, @CurrentUser() me: Me) { return this.exports.queueAdhoc(dto, me); }

  @Post(':id/export')
  @RequirePermission('report.export')
  exportSaved(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.exports.queueSaved(id, dto?.format ?? 'xlsx', me, scope, dto?.override);
  }

  @Get('exports/:id')
  @RequirePermission('report.export')
  exportStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.exports.status(id, me); }

  @Get('exports/:id/download')
  @RequirePermission('report.export')
  async download(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @Res() res: Response) {
    const { buffer, filename, mime } = await this.exports.download(id, me);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  /* ------------------------------------------------------------- schedules */

  @Get('schedules/all')
  @RequirePermission('report.read')
  listSchedules(@CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.schedules.list(me, scope); }

  @Post('schedules')
  @RequirePermission('report.schedule')
  createSchedule(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.schedules.create(dto, me, scope);
  }

  @Patch('schedules/:id/active')
  @RequirePermission('report.schedule')
  setActive(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.schedules.setActive(id, dto?.is_active !== false, me, scope);
  }

  @Delete('schedules/:id')
  @RequirePermission('report.schedule')
  removeSchedule(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.schedules.remove(id, me, scope);
  }

  @Get('schedules/:id/history')
  @RequirePermission('report.read')
  history(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.schedules.history(id, me, scope);
  }

  /** "Send now" — THE SAME code path the timer uses, so testing a schedule tests the
   *  real thing (including the SMTP-not-configured message, which is the answer the
   *  client most needs today). It consumes the CURRENT period's run key, so pressing it
   *  means the morning run will correctly decline to send a second copy. */
  @Post('schedules/:id/run')
  @RequirePermission('report.schedule')
  async runNow(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    await this.schedules.get(id, me, scope);   // 404 if not theirs
    const ran = await this.scheduleWorker.runSchedule(id);
    return ran
      ? { ran: true, note: 'Delivery attempted — see the history below for the outcome.' }
      : { ran: false, note: 'This period has already been delivered. The next run is scheduled as shown.' };
  }
}
