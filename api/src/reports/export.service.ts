import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { entityByKey } from './entities';
import { Me, ReportService } from './report.service';
import { ReportConfig } from './query-builder';
import { TooManyColumnsError, reportPdf } from './report-pdf';
import { CellType, SheetColumn, buildCsv, buildXlsx } from './xlsx.util';

export type ExportFormat = 'xlsx' | 'pdf' | 'csv';

/**
 * EXPORTS — Excel / PDF / CSV of any report.
 *
 * =============================================================================
 * WHY EVERY EXPORT GOES THROUGH THE QUEUE, EVEN A SMALL ONE
 * =============================================================================
 * The brief says a large export must not block the API. The obvious design is "small
 * ones inline, big ones queued" — and that is the design that ships a bug, because the
 * threshold is a guess about a client whose data we have not seen. He is about to import
 * "real volumes of leads"; the export that was 40 rows in UAT is 40,000 in September,
 * and the code path that has never been exercised is the one that has to work.
 *
 * So: ONE PATH. Every export is a `report_export` row, picked up by ExportWorker within
 * a tick, and the UI polls. A 12-row export is ready before the user's finger leaves the
 * mouse; a 40,000-row one takes a few seconds and holds no request open. Nothing about
 * the client's first big export is untested code.
 *
 * =============================================================================
 * WHOSE ROWS ARE IN THE FILE
 * =============================================================================
 * `requested_by`. The worker re-resolves that user's scope when it renders (the request's
 * ResolvedScope is long gone by then). An export therefore contains exactly what the
 * person who asked for it can see on screen — never more, and never the worker's.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id ?? 1);
  }

  /** Queue an export of a SAVED report (visibility checked here, scope re-checked at render). */
  async queueSaved(reportId: number, format: ExportFormat, me: Me, scope: ResolvedScope, override?: Partial<ReportConfig>) {
    const def = await this.reports.get(reportId, me, scope);   // throws 404 if not visible
    const config = { ...(def.config ?? {}), ...(override ?? {}) };
    return this.enqueue(def.entity, config, format, me, reportId, def.name);
  }

  /** Queue an export of an UNSAVED definition (the builder's Export button). */
  async queueAdhoc(dto: any, me: Me) {
    const entity = entityByKey(String(dto?.entity ?? ''));
    if (!entity) throw new BadRequestException(`Unknown report data source "${dto?.entity}".`);
    return this.enqueue(entity.key, dto?.config ?? {}, this.fmt(dto?.format), me, null, dto?.name || entity.label);
  }

  private fmt(v: unknown): ExportFormat {
    const f = String(v ?? 'xlsx').toLowerCase();
    if (f !== 'xlsx' && f !== 'pdf' && f !== 'csv') throw new BadRequestException(`Unknown export format "${v}". Use xlsx, pdf or csv.`);
    return f;
  }

  private async enqueue(entityKey: string, config: any, format: ExportFormat, me: Me, reportId: number | null, name: string) {
    const entity = entityByKey(entityKey);
    if (!entity) throw new BadRequestException(`Unknown report data source "${entityKey}".`);
    // FAIL AT THE BUTTON, NOT IN THE WORKER. A PDF with 20 columns cannot be rendered;
    // finding that out from a red row in an export list two minutes later, with no idea
    // which click caused it, is a support call. So the same check the renderer makes is
    // made here, synchronously, while the user is still looking at the screen.
    if (format === 'pdf') {
      const cols = (config?.columns?.length ? config.columns : entity.defaultColumns).length;
      if (cols > 14) {
        throw new BadRequestException(
          `A PDF fits about 14 columns legibly and this report has ${cols}. `
          + `Export it to Excel instead, or remove a few columns.`,
        );
      }
    }
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO report_export (org_id, report_id, entity, config, format, requested_by, file_name)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [await this.orgId(), reportId, entity.key, JSON.stringify({ ...config, _name: name }), format, me.id, fileNameFor(name, format)],
    );
    return { id: Number(r!.id), status: 'queued', format, file_name: fileNameFor(name, format) };
  }

  /** Poll. A user only ever sees their OWN exports — an export is a file of somebody's
   *  scoped rows, so somebody else's export list is not theirs to read. */
  async status(id: number, me: Me) {
    const r = await this.db.one<any>(
      `SELECT id, status, format, file_name, row_count, error, created_at, finished_at
         FROM report_export WHERE id = $1 AND requested_by = $2`, [id, me.id],
    );
    if (!r) throw new NotFoundException('Export not found.');
    return { ...r, id: Number(r.id) };
  }

  async listMine(me: Me) {
    const rows = await this.db.query<any>(
      `SELECT id, status, format, file_name, row_count, error, created_at, finished_at
         FROM report_export WHERE requested_by = $1 AND expires_at > now()
        ORDER BY id DESC LIMIT 20`, [me.id],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async download(id: number, me: Me): Promise<{ buffer: Buffer; filename: string; mime: string }> {
    const r = await this.db.one<any>(
      `SELECT * FROM report_export WHERE id = $1 AND requested_by = $2`, [id, me.id],
    );
    if (!r) throw new NotFoundException('Export not found.');
    if (r.status !== 'ready' || !r.bytes) throw new BadRequestException(`This export is "${r.status}", not ready.`);
    return { buffer: Buffer.from(r.bytes), filename: r.file_name, mime: MIME[r.format as ExportFormat] };
  }

  /** RENDER one queued export. Called by the worker; public so the spec drives it. */
  async render(id: number): Promise<string> {
    const row = await this.db.one<any>(`SELECT * FROM report_export WHERE id = $1`, [id]);
    if (!row) return 'missing';
    try {
      const entity = entityByKey(row.entity);
      if (!entity) throw new BadRequestException(`This export points at "${row.entity}", which no longer exists.`);
      const me: Me = { id: Number(row.requested_by) };
      const config: ReportConfig = { ...(row.config ?? {}), limit: Number(row.config?.limit) || 50_000 };
      // THE scoping line — the requester's scope, resolved now.
      const out = await this.reports.execute(entity, config, me);
      const name = String(row.config?._name || entity.label);
      const buffer = this.build(row.format, name, out);

      await this.db.query(
        `UPDATE report_export
            SET status = 'ready', bytes = $2, row_count = $3, error = NULL, finished_at = now()
          WHERE id = $1`,
        [id, buffer, out.row_count],
      );
      return 'ready';
    } catch (e) {
      const msg = (e as Error).message || 'Export failed';
      await this.db.query(
        `UPDATE report_export SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
        [id, msg.slice(0, 500)],
      );
      return 'failed';
    }
  }

  /** rows -> bytes. Pure enough to test on its own (export-render.spec.ts does). */
  build(format: ExportFormat, name: string, out: Awaited<ReturnType<ReportService['execute']>>): Buffer {
    const columns: SheetColumn[] = out.columns.map((c) => ({ label: c.label, type: c.type as CellType }));
    const stamp = new Date().toLocaleString('en-IN');
    // The scope note travels INTO the file. A spreadsheet forwarded to somebody else must
    // still say whose view of the data it is, or two people compare two exports of "the
    // same report", get different totals, and file a bug against the report.
    const preamble = [
      name,
      `Generated ${stamp} · ${out.row_count} row${out.row_count === 1 ? '' : 's'}`,
      out.scope.note,
    ];
    if (format === 'csv') return buildCsv(columns, out.rows);
    if (format === 'pdf') {
      try {
        return reportPdf({
          title: name,
          subtitle: `${out.entity_label} · generated ${stamp} · ${out.row_count} row${out.row_count === 1 ? '' : 's'}`,
          columns: out.columns, rows: out.rows,
          footnotes: [out.scope.note],
          org_name: 'Tech Lingua LLP',
        });
      } catch (e) {
        if (e instanceof TooManyColumnsError) throw new BadRequestException(e.message);
        throw e;
      }
    }
    return buildXlsx({ name, columns, rows: out.rows, preamble });
  }
}

export const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

/** A filename the client can find again on his own disk: the report's name and the date.
 *  `report(3).xlsx` in a Downloads folder is not a report, it is a puzzle. */
export function fileNameFor(name: string, format: ExportFormat): string {
  const safe = String(name || 'report').replace(/[^\w\d\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';
  const d = new Date().toISOString().slice(0, 10);
  return `${safe}-${d}.${format}`;
}
