import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { InvoiceService } from '../invoices/invoice.service';
import { InvoiceTemplateService } from './invoice-template.service';
import { COLUMN_CATALOG, INVOICE_FIELDS, PAYMENT_FIELDS, SECTION_CATALOG, STUDENT_FIELDS, SUMMARY_CATALOG, defaultConfig } from './template-config';

interface Me { id: number; name: string }

const sendPdf = (res: Response, buf: Buffer, name: string) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
};

/**
 * FEE INVOICE TEMPLATE BUILDER — Administration › Template Setup › Fee Invoice builder.
 * Designing and publishing need settings.update (Super / Org Admin), reading settings.read; a
 * preview against a REAL invoice also needs invoice.read in that invoice's scope.
 */
@Controller('invoice-templates')
export class InvoiceTemplateController {
  constructor(private readonly svc: InvoiceTemplateService, private readonly invoices: InvoiceService) {}

  @Get()
  @RequirePermission('settings.read')
  list() { return this.svc.list(); }

  /** The catalogue the builder offers: sections, fields, columns, summary rows, layouts. */
  @Get('catalog')
  @RequirePermission('settings.read')
  catalog() {
    return {
      sections: SECTION_CATALOG, invoice_fields: INVOICE_FIELDS, student_fields: STUDENT_FIELDS, payment_fields: PAYMENT_FIELDS,
      columns: COLUMN_CATALOG, summary: SUMMARY_CATALOG,
      layouts: { professional: defaultConfig('professional'), minimal: defaultConfig('minimal'), detailed: defaultConfig('detailed') },
      variables: [...INVOICE_FIELDS, ...STUDENT_FIELDS, ...PAYMENT_FIELDS].map((f) => f.key)
        .concat(['grand_total', 'amount_paid', 'outstanding_balance', 'institute_name', 'today']),
    };
  }

  @Get(':id')
  @RequirePermission('settings.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Get(':id/versions')
  @RequirePermission('settings.read')
  versions(@Param('id', ParseIntPipe) id: number) { return this.svc.versions(id); }

  @Post()
  @RequirePermission('settings.update')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Post(':id/duplicate')
  @RequirePermission('settings.update')
  duplicate(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.duplicate(id, me); }

  @Patch(':id')
  @RequirePermission('settings.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.update(id, dto, me); }

  @Post(':id/publish')
  @RequirePermission('settings.update')
  publish(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) { return this.svc.publish(id, dto, me); }

  @Post(':id/unpublish')
  @RequirePermission('settings.update')
  unpublish(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.unpublish(id, me); }

  @Post(':id/default')
  @RequirePermission('settings.update')
  setDefault(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.setDefault(id, me); }

  @Post(':id/restore/:versionId')
  @RequirePermission('settings.update')
  restore(@Param('id', ParseIntPipe) id: number, @Param('versionId', ParseIntPipe) versionId: number, @CurrentUser() me: Me) {
    return this.svc.restore(id, versionId, me);
  }

  @Delete(':id')
  @RequirePermission('settings.update')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }

  /** Live / PDF preview of an UNSAVED design with sample data (intra or inter-state). */
  @Post('preview')
  @RequirePermission('settings.read')
  async preview(@Body() dto: any, @Res() res: Response) {
    sendPdf(res, await this.svc.preview(dto?.config, null, dto?.supply), 'invoice-template-preview.pdf');
  }

  /** Preview an unsaved design with a REAL invoice's data (scope-checked like the invoice PDF). */
  @Post('preview/invoice/:invoiceId')
  @RequirePermission('invoice.read')
  async previewWithInvoice(@Param('invoiceId', ParseIntPipe) invoiceId: number, @Body() dto: any,
    @CurrentScope() scope: ResolvedScope, @Res() res: Response) {
    const gi = await this.invoices.get(invoiceId, scope);
    sendPdf(res, await this.svc.preview(dto?.config, gi), `preview-${String(gi.invoice_no || 'draft').replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`);
  }
}
