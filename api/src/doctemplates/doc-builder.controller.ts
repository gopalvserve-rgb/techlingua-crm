import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentScope, CurrentUser, Public, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { DatabaseService } from '../database/database.service';
import { DocBuilderService } from './doc-builder.service';
import { DocType } from './builder-catalog';
import { loadDocData } from './builder-data';

interface Me { id: number; name: string }

const sendPdf = (res: Response, buf: Buffer, name: string) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
  res.send(buf);
};

/**
 * Administration › Template Management (client 12 Nov 2026) — the document builder.
 * read = see templates / print the documents that have no other print button (admission form,
 * marksheet, offer letter, experience certificate) within the reader's own branch / vertical;
 * manage = create / edit / clone / submit / restore / delete; approve = approve / reject /
 * publish / unpublish / default; override = print one document with a different template.
 */
@Controller('doc-builder')
export class DocBuilderController {
  constructor(private readonly svc: DocBuilderService, private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  @Get('catalog') @RequirePermission('doctemplate.read')
  catalog() { return this.svc.catalog(); }

  @Get('templates') @RequirePermission('doctemplate.read')
  list(@Query('doc_type') docType?: string) { return this.svc.list({ doc_type: docType }); }

  @Get('templates/:id') @RequirePermission('doctemplate.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post('templates') @RequirePermission('doctemplate.manage')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Patch('templates/:id') @RequirePermission('doctemplate.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.update(id, dto, me); }

  @Post('templates/:id/clone') @RequirePermission('doctemplate.manage')
  clone(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.clone(id, dto, me); }

  @Post('templates/:id/submit') @RequirePermission('doctemplate.manage')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.submit(id, me); }

  @Post('templates/:id/restore/:versionId') @RequirePermission('doctemplate.manage')
  restore(@Param('id', ParseIntPipe) id: number, @Param('versionId', ParseIntPipe) versionId: number, @CurrentUser() me: Me) {
    return this.svc.restore(id, versionId, me);
  }

  @Delete('templates/:id') @RequirePermission('doctemplate.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }

  @Post('templates/:id/publish') @RequirePermission('doctemplate.approve')
  publish(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.publish(id, dto, me); }

  @Post('templates/:id/reject') @RequirePermission('doctemplate.approve')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.reject(id, dto?.note, me); }

  @Post('templates/:id/unpublish') @RequirePermission('doctemplate.approve')
  unpublish(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.unpublish(id, me); }

  @Post('templates/:id/default') @RequirePermission('doctemplate.approve')
  setDefault(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.setDefault(id, me); }

  @Get('samples/:type') @RequirePermission('doctemplate.manage')
  samples(@Param('type') type: string) { return this.svc.samples(type as DocType); }

  @Get('published/:type') @RequirePermission('doctemplate.read')
  published(@Param('type') type: string) { return this.svc.published(type as DocType); }

  /** Preview a draft design as a PDF (sample data, or a real record). */
  @Post('preview') @RequirePermission('doctemplate.manage')
  async preview(@Body() dto: any, @Res() res: Response) {
    const buf = await this.svc.preview(dto?.doc_type, dto?.config, dto?.ref_id ? Number(dto.ref_id) : null);
    sendPdf(res, buf, `preview-${dto?.doc_type ?? 'document'}`);
  }

  /**
   * Print one record with the builder. A reader may print records of their own branch / vertical;
   * `template_id` (a different template for this one document) needs doctemplate.override.
   */
  @Get('print/:type/:refId') @RequirePermission('doctemplate.read')
  async print(@Param('type') type: string, @Param('refId', ParseIntPipe) refId: number, @Query('template_id') templateId: string | undefined,
              @CurrentScope() scope: ResolvedScope, @CurrentUser() me: Me, @Res() res: Response) {
    const loaded = await loadDocData(this.db, type as DocType, refId);
    if (!loaded) { res.status(404).json({ message: 'Record not found' }); return; }
    const params: unknown[] = [loaded.ctx.branch_id, loaded.ctx.vertical_id];
    const w = this.resolver.buildScopeWhere(scope, { branch: '$1::bigint', vertical: '$2::bigint' }, params);
    const ok = await this.db.one<{ ok: number }>(`SELECT 1 AS ok WHERE ${w}`, params);
    if (!ok) { res.status(404).json({ message: 'Record not found (or outside your access)' }); return; }
    if (templateId) {
      const can = await this.db.one<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM user_assignment ua JOIN role_permission rp ON rp.role_id = ua.role_id JOIN permission p ON p.id = rp.permission_id
                         WHERE ua.user_id = $1 AND ua.is_active AND p.key = 'doctemplate.override') AS ok`, [me.id]);
      this.svc.assertOverride(!!can?.ok);
    }
    const out = await this.svc.renderRecord(type as DocType, refId, { templateId: templateId ? Number(templateId) : null });
    if (!out) { res.status(409).json({ message: 'No published template for this document yet — publish one in Template Management.' }); return; }
    sendPdf(res, out.buffer, `${type}-${refId}`);
  }
}

/** PUBLIC — the page a scanned QR code opens. Reveals only what is printed on the document. */
@Public()
@Controller('public/verify')
export class DocVerifyController {
  constructor(private readonly svc: DocBuilderService) {}

  @Public() @Get(':code')
  verify(@Param('code') code: string) { return this.svc.verify(code); }
}
