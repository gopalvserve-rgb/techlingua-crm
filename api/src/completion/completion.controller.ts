import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { BotsService } from './bots.service';
import { ScholarshipService } from './scholarship.service';
import { SharedDocsService } from './shared-docs.service';
import { PayrollService } from './payroll.service';
import { InsightsService } from './insights.service';

interface Me { id: number; name: string }

/** Engagement › WhatsBot / AI Bot. */
@Controller('bots')
export class BotsController {
  constructor(private readonly svc: BotsService) {}

  @Get('settings') @RequirePermission('message.read')
  settings() { return this.svc.getSettings(); }

  @Put('whatsbot') @RequirePermission('message.manage')
  saveWhatsBot(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveWhatsBot(dto, Number(me.id)); }

  @Put('aibot') @RequirePermission('message.manage')
  saveAiBot(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveAiBot(dto, Number(me.id)); }

  @Get('rules') @RequirePermission('message.read')
  rules() { return this.svc.listRules(); }

  @Post('rules') @RequirePermission('message.manage')
  createRule(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.createRule(dto, Number(me.id)); }

  @Patch('rules/:id') @RequirePermission('message.manage')
  updateRule(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.updateRule(id, dto); }

  @Delete('rules/:id') @RequirePermission('message.manage')
  deleteRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.deleteRule(id, Number(me.id)); }

  @Get('log') @RequirePermission('message.read')
  log(@Query('limit') limit?: string) { return this.svc.listLog(Number(limit) || 100); }

  /** "Try it" — what the bot would answer; nothing is sent. */
  @Post('simulate') @RequirePermission('message.read')
  simulate(@Body() dto: any) { return this.svc.simulate(String(dto?.text ?? ''), !!dto?.first_message); }
}

/** Finance › Scholarships. */
@Controller('scholarships')
export class ScholarshipController {
  constructor(private readonly svc: ScholarshipService) {}

  @Get() @RequirePermission('scholarship.read')
  list(@CurrentScope() scope: ResolvedScope, @Query() q: any) { return this.svc.list(scope, { status: q?.status, q: q?.q }); }

  @Post() @RequirePermission('scholarship.request')
  request(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.request(dto, me, scope); }

  @Post(':id/approve') @RequirePermission('scholarship.approve')
  approve(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.approve(id, dto, me, scope);
  }

  @Post(':id/reject') @RequirePermission('scholarship.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.reject(id, dto, me, scope);
  }

  @Delete(':id') @RequirePermission('scholarship.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) { return this.svc.remove(id, me, scope); }
}

/** Workspace › Shared Documents. */
@Controller('shared-docs')
export class SharedDocsController {
  constructor(private readonly svc: SharedDocsService) {}

  @Get() @RequirePermission('shared_doc.read')
  list(@CurrentUser() me: Me, @Query() q: any) { return this.svc.list(Number(me.id), { folder_id: q?.folder_id, q: q?.q }); }

  @Post() @RequirePermission('shared_doc.upload')
  upload(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.upload(dto, Number(me.id)); }

  @Post('folders') @RequirePermission('shared_doc.upload')
  createFolder(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.createFolder(dto, Number(me.id)); }

  @Delete('folders/:id') @RequirePermission('shared_doc.delete')
  deleteFolder(@Param('id', ParseIntPipe) id: number) { return this.svc.deleteFolder(id); }

  @Get(':id/download') @RequirePermission('shared_doc.read')
  async download(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @Res() res: Response) {
    const f = await this.svc.download(id, Number(me.id));
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.file_name)}"`);
    res.end(f.content);
  }

  @Delete(':id') @RequirePermission('shared_doc.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, Number(me.id)); }
}

/** HR › Salary. */
@Controller('payroll')
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  @Get('structures') @RequirePermission('payroll.read')
  structures(@Query() q: any) { return this.svc.structures({ branch_id: q?.branch_id }); }

  @Put('structures/:employeeId') @RequirePermission('payroll.manage')
  saveStructure(@Param('employeeId', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.saveStructure(id, dto, Number(me.id));
  }

  @Get('runs') @RequirePermission('payroll.read')
  runs() { return this.svc.runs(); }

  @Post('runs') @RequirePermission('payroll.manage')
  run(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.run(dto, Number(me.id)); }

  @Get('runs/:id') @RequirePermission('payroll.read')
  payslips(@Param('id', ParseIntPipe) id: number) { return this.svc.payslips(id); }

  @Post('runs/:id/finalise') @RequirePermission('payroll.manage')
  finalise(@Param('id', ParseIntPipe) id: number) { return this.svc.finalise(id); }

  @Delete('runs/:id') @RequirePermission('payroll.manage')
  removeRun(@Param('id', ParseIntPipe) id: number) { return this.svc.removeRun(id); }
}

/** Communication Intelligence (keywords, AI usage/settings), Forecasting, Duplicate Rules, Compliance. */
@Controller('insights')
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}

  @Get('keywords') @RequirePermission('ai.read')
  keywords() { return this.svc.keywords(); }

  @Post('keywords') @RequirePermission('ai.run')
  addKeyword(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.addKeyword(dto, Number(me.id)); }

  @Patch('keywords/:id') @RequirePermission('ai.run')
  updateKeyword(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.updateKeyword(id, dto); }

  @Delete('keywords/:id') @RequirePermission('ai.run')
  removeKeyword(@Param('id', ParseIntPipe) id: number) { return this.svc.removeKeyword(id); }

  @Get('keyword-report') @RequirePermission('ai.read')
  keywordReport(@Query() q: any) { return this.svc.keywordReport({ from: q?.from, to: q?.to, keyword_id: q?.keyword_id }); }

  @Get('ai-usage') @RequirePermission('ai.read')
  aiUsage(@Query() q: any) { return this.svc.aiUsage({ from: q?.from, to: q?.to }); }

  @Get('ai-settings') @RequirePermission('settings.read')
  aiSettings() { return this.svc.aiSettingsView(); }

  @Put('ai-settings') @RequirePermission('settings.update')
  saveAiSettings(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveAiSettings(dto, Number(me.id)); }

  @Get('forecast') @RequirePermission('report.read')
  forecast() { return this.svc.forecast(); }

  @Get('duplicate-rules') @RequirePermission('lead.read')
  duplicateRules() { return this.svc.duplicateRulesView(); }

  @Put('duplicate-rules') @RequirePermission('settings.update')
  saveDuplicateRules(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveDuplicateRules(dto, Number(me.id)); }

  @Get('compliance') @RequirePermission('settings.read')
  compliance() { return this.svc.compliance(); }

  @Put('compliance') @RequirePermission('settings.update')
  saveCompliance(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveCompliance(dto, Number(me.id)); }
}
