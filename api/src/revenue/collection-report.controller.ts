import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentScope, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { CollectionReportService } from './collection-report.service';

const many = (v?: string | string[]): number[] | undefined => {
  if (v == null) return undefined;
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  const out = [...new Set(parts.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0))];
  return out.length ? out : undefined;
};
const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);

/** Finance & Collections › Collection Reports + Tally export. */
@Controller('collection-reports')
export class CollectionReportController {
  constructor(private readonly svc: CollectionReportService) {}

  @Get()
  @RequirePermission('collection_report.read')
  report(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>) {
    return this.svc.report(scope, {
      dimension: one(q.dimension), from: one(q.from), to: one(q.to),
      branch_ids: many(q.branch_ids ?? q.branch_id), vertical_ids: many(q.vertical_ids ?? q.vertical_id),
    });
  }

  @Get('export')
  @RequirePermission('collection_report.export')
  async export(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>, @Res() res: Response) {
    const { buffer, filename, contentType } = await this.svc.export(scope, String(one(q.format) ?? 'xlsx'), {
      dimension: one(q.dimension), from: one(q.from), to: one(q.to),
      branch_ids: many(q.branch_ids ?? q.branch_id), vertical_ids: many(q.vertical_ids ?? q.vertical_id),
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Get('tally')
  @RequirePermission('collection_report.export')
  async tally(@CurrentScope() scope: ResolvedScope, @Query() q: Record<string, string | string[]>, @Res() res: Response) {
    const { xml, filename } = await this.svc.tally(scope, {
      from: one(q.from), to: one(q.to),
      branch_ids: many(q.branch_ids ?? q.branch_id), vertical_ids: many(q.vertical_ids ?? q.vertical_id),
    });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(xml);
  }
}
