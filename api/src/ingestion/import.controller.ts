import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ImportService } from './import.service';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

type U = { id: number };

/**
 * Bulk CSV lead import.
 *
 * Prefix is `lead-imports`, NOT `leads/import`: LeadsController already owns
 * `GET /leads/:id`, which shadows `GET /leads/import` (the id pipe would 400 on
 * "import"). A dedicated collection avoids the collision entirely.
 *
 * Every endpoint requires `lead.import` AND passes the
 * chosen campaign/source through the record-scope enforcer, so a branch- or
 * campaign-scoped user can only import into their own units.
 *
 * The request body carries the file as text under `csv` — a key the audit
 * redactor already strips (common/redact.ts), so audit_log never stores the
 * customer data blob.
 */
@Controller('lead-imports')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  /** History (who / when / file / counts / status). */
  @Get() @RequirePermission('lead.import')
  list(
    @CurrentScope() s: ResolvedScope,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.list(s, { limit: limit ? Number(limit) : 50, from, to });
  }

  /** Starter template so a first-time user begins from a valid file. */
  @Get('template') @RequirePermission('lead.import')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="lead-import-template.csv"')
  template() { return this.svc.template(); }

  /** STEP 1-2 — headers, auto-mapping, sample rows. */
  @Post('parse') @RequirePermission('lead.import')
  parse(@Body() b: { csv: string }) { return this.svc.parse(b?.csv); }

  /** STEP 3 — per-row validation + duplicate flags BEFORE anything is written. */
  @Post('preview') @RequirePermission('lead.import')
  preview(
    @Body() b: { csv: string; mapping: Record<string, string>; campaign_id: number; source_id: number },
    @CurrentScope() s: ResolvedScope, @CurrentUser() u: U,
  ) {
    return this.svc.preview(b?.csv, b?.mapping ?? {}, Number(b?.campaign_id), Number(b?.source_id), s, u.id);
  }

  /** STEP 4-5 — enqueue the batch; the worker ingests it. */
  @Post() @RequirePermission('lead.import')
  create(
    @Body() b: { csv: string; mapping: Record<string, string>; campaign_id: number; source_id: number; file_name?: string },
    @CurrentScope() s: ResolvedScope, @CurrentUser() u: U,
  ) {
    return this.svc.enqueue(b, s, u.id);
  }

  /** Progress + result report (polled by the UI). */
  @Get(':id') @RequirePermission('lead.import')
  get(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope) {
    return this.svc.get(id, s);
  }

  /** Downloadable error CSV of the failed rows, with reasons. */
  @Get(':id/errors.csv') @RequirePermission('lead.import')
  async errors(@Param('id', ParseIntPipe) id: number, @CurrentScope() s: ResolvedScope, @Res() res: Response) {
    const { filename, body } = await this.svc.errorCsv(id, s);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }
}
