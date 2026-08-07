import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { parseCsv, rowToObject, toCsv } from './csv.util';
import { assertDateRange } from '../common/date.util';
import { LEAD_IMPORT_FIELDS, CUSTOM_PREFIX, applyMapping, autoMap, validateMapping } from './mapping.util';
import { DuplicateAction, IngestPayload, IngestValidationError } from './ingestion.types';
import { LeadIngestionService, IngestTarget } from './lead-ingestion.service';

/** Import batches scope through their denormalised path (same columns as leads). */
export const BATCH_SCOPE_COLS: ScopeColumnMap = {
  branch: 'b.branch_id', vertical: 'b.vertical_id', pipeline: 'b.pipeline_id', campaign: 'b.campaign_id',
};

/** Client-side guard mirrors this: 5 MB / 20 000 rows per file. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 20000;
const PREVIEW_ROWS = 200;

/** What the campaign's duplicacy action will DO to a matching row (shown in the preview). */
const ACTION_REASON: Record<DuplicateAction, string> = {
  ignore: 'campaign rule: IGNORE — this row will be skipped, the existing lead is untouched',
  create: 'campaign rule: CREATE — a second, flagged lead will be added',
  merge: 'campaign rule: MERGE — this row will be folded into the existing lead (blanks filled; conflicts keep the existing value and are recorded)',
  merge_and_reopen: 'campaign rule: MERGE & REOPEN — folded into the existing lead; a CLOSED lead is re-opened and re-assigned to the next round-robin agent',
  flag: 'campaign rule: FLAG — a second lead is added and flagged as a duplicate so it is filterable on the Leads list',
};

export interface PreviewRow {
  row_num: number;
  status: 'valid' | 'duplicate' | 'error';
  reason?: string;
  name?: string;
  phone?: string;
  duplicate_of?: number | null;
  /** the campaign's duplicacy action this row WILL get: ignore | create | merge | merge_and_reopen
   *  ('skip' = the row repeats earlier in the same file and is imported once). */
  action?: 'ignore' | 'create' | 'merge' | 'merge_and_reopen' | 'flag' | 'skip' | null;
  /** soft note (import course fix): the row imports, but a master value could not be resolved. */
  warning?: string;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ingestion: LeadIngestionService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private checkSize(csv: string) {
    if (!csv || !csv.trim()) throw new BadRequestException('The file is empty.');
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      throw new BadRequestException(`File too large — the limit is ${MAX_CSV_BYTES / 1024 / 1024} MB per import.`);
    }
  }

  /** RBAC: a scoped user may only import into campaigns/sources inside their scope. */
  private async assertTargetInScope(scope: ResolvedScope, campaignId: number, sourceId: number, userId: number) {
    if (!campaignId || !sourceId) throw new BadRequestException('Choose a target Campaign and Source.');
    await this.enforcer.assertRefInScope(scope, 'campaign', campaignId, userId);
    await this.enforcer.assertRefInScope(scope, 'source', sourceId, userId);
  }

  /** STEP 1-2 — parse the file, return headers + an auto-mapping + a sample. */
  async parse(csv: string) {
    this.checkSize(csv);
    const { headers, rows } = parseCsv(csv);
    if (!headers.length) throw new BadRequestException('Could not read a header row from this file.');
    if (!rows.length) throw new BadRequestException('The file has a header but no data rows.');
    if (rows.length > MAX_CSV_ROWS) throw new BadRequestException(`Too many rows (${rows.length}) — the limit is ${MAX_CSV_ROWS} per import.`);
    const custom = await this.db.query<{ field_key: string; label: string }>(
      `SELECT field_key, label FROM custom_field_def
        WHERE entity = 'lead' AND is_active AND deleted_at IS NULL ORDER BY sort_order, id`,
    );
    return {
      headers,
      total_rows: rows.length,
      sample: rows.slice(0, 10).map((r) => rowToObject(headers, r)),
      mapping: autoMap(headers, custom),
      fields: LEAD_IMPORT_FIELDS,
      custom_fields: custom.map((c) => ({ key: CUSTOM_PREFIX + c.field_key, label: c.label })),
    };
  }

  /** STEP 3 — validate every row against the chosen target; flag duplicates BEFORE import. */
  async preview(
    csv: string, mapping: Record<string, string>, campaignId: number, sourceId: number,
    scope: ResolvedScope, userId: number,
  ) {
    this.checkSize(csv);
    await this.assertTargetInScope(scope, campaignId, sourceId, userId);
    const mapErrors = validateMapping(mapping);
    if (mapErrors.length) throw new BadRequestException(mapErrors.join(' '));

    const { headers, rows } = parseCsv(csv);
    const target = await this.ingestion.loadTarget(campaignId, sourceId);

    const action = (target.duplicacy.on_duplicate ?? 'ignore') as DuplicateAction;
    const out: PreviewRow[] = [];
    let valid = 0, dupes = 0, errors = 0, warnings = 0;
    const seenKeys = new Set<string>();
    const seenPhones = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const raw = rowToObject(headers, rows[i]);
      const payload = applyMapping(raw, mapping);
      const rowNum = i + 1;
      try {
        // Import course fix: resolve masters softly (matches inbound). An unknown Course/City/etc.
        // does NOT fail the row — it imports and the raw value is kept on the note; we surface it
        // as a clear per-row warning here so the user sees it BEFORE committing.
        const lead = this.ingestion.normalise(payload, target, { softMasters: true });
        const key = this.ingestion.dedupeKey(payload, {
          channel: 'csv', campaign_id: campaignId, source_id: sourceId, actor_id: userId,
        });
        if (seenKeys.has(key)) {
          dupes++;
          if (out.length < PREVIEW_ROWS) {
            out.push({
              row_num: rowNum, status: 'duplicate', action: 'skip', name: lead.full_name, phone: lead.phone,
              reason: 'Identical row appears earlier in this file — it will be imported once.',
            });
          }
          continue;
        }
        seenKeys.add(key);
        const existing = await this.ingestion.findDuplicate([lead.phone, lead.whatsapp_phone].filter(Boolean) as string[], target);
        if (existing || seenPhones.has(lead.phone)) {
          dupes++;
          if (out.length < PREVIEW_ROWS) {
            out.push({
              row_num: rowNum, status: 'duplicate', name: lead.full_name, phone: lead.phone,
              duplicate_of: existing ? Number(existing.id) : null,
              // the ACTION that will be applied, not merely "it's a duplicate"
              action: existing ? action : 'skip',
              reason: existing
                ? `Phone matches existing lead #${existing.id} — ${ACTION_REASON[action]}`
                : 'Phone repeats earlier in this file — it will be imported once.',
            });
          }
          seenPhones.add(lead.phone);
          continue;
        }
        seenPhones.add(lead.phone);
        valid++;
        const warn = lead.unresolved?.length
          ? lead.unresolved.map(([l, v]) => `${l} \u201c${v}\u201d is not in the master \u2014 the lead is imported without it (the value is kept in the note).`).join(' ')
          : undefined;
        if (warn) warnings++;
        if (out.length < PREVIEW_ROWS) out.push({ row_num: rowNum, status: 'valid', action: null, name: lead.full_name, phone: lead.phone, warning: warn });
      } catch (e) {
        errors++;
        const reason = e instanceof IngestValidationError ? e.message : (e as Error).message;
        if (out.length < PREVIEW_ROWS) out.push({ row_num: rowNum, status: 'error', reason, name: payload.full_name, phone: payload.phone });
      }
    }

    return {
      total: rows.length, valid, duplicates: dupes, errors, warnings,
      duplicate_action: target.duplicacy.on_duplicate ?? 'ignore',
      duplicate_scope: target.duplicacy.check_scope ?? 'this_campaign',
      distribution_mode: target.distribution?.mode ?? 'on_demand',
      rows: out, truncated: rows.length > PREVIEW_ROWS,
    };
  }

  /** STEP 4-5 — enqueue: one durable job per row. The worker does the ingesting. */
  async enqueue(
    body: { csv: string; mapping: Record<string, string>; campaign_id: number; source_id: number; file_name?: string },
    scope: ResolvedScope, userId: number,
  ) {
    this.checkSize(body.csv);
    const campaignId = Number(body.campaign_id);
    const sourceId = Number(body.source_id);
    await this.assertTargetInScope(scope, campaignId, sourceId, userId);
    const mapErrors = validateMapping(body.mapping ?? {});
    if (mapErrors.length) throw new BadRequestException(mapErrors.join(' '));

    const { headers, rows } = parseCsv(body.csv);
    if (!rows.length) throw new BadRequestException('The file has no data rows.');
    if (rows.length > MAX_CSV_ROWS) throw new BadRequestException(`Too many rows (${rows.length}) — the limit is ${MAX_CSV_ROWS}.`);

    const target = await this.ingestion.loadTarget(campaignId, sourceId);
    const fileHash = createHash('sha256').update(body.csv).digest('hex');

    return this.db.tx(async (c) => {
      const b = await c.query(
        `INSERT INTO import_batch (org_id, channel, file_name, file_hash, branch_id, vertical_id, pipeline_id,
                                   campaign_id, source_id, mapping, status, total_rows, created_by)
         VALUES ($1,'csv',$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11) RETURNING *`,
        [target.org_id, (body.file_name ?? 'leads.csv').slice(0, 255), fileHash,
          target.branch_id, target.vertical_id, target.pipeline_id, campaignId, sourceId,
          JSON.stringify(body.mapping), rows.length, userId],
      );
      const batch = b.rows[0];
      for (let i = 0; i < rows.length; i++) {
        const raw = rowToObject(headers, rows[i]);
        const payload: IngestPayload = applyMapping(raw, body.mapping);
        const key = this.ingestion.dedupeKey(payload, {
          channel: 'csv', campaign_id: campaignId, source_id: sourceId, actor_id: userId,
        });
        await c.query(
          `INSERT INTO import_job (batch_id, row_num, payload, raw, dedupe_key) VALUES ($1,$2,$3,$4,$5)`,
          [batch.id, i + 1, JSON.stringify(payload), JSON.stringify(raw), key],
        );
      }
      return batch;
    });
  }

  // ---- read side (Import History, progress polling, error CSV) -------------

  private scopeWhere(scope: ResolvedScope, params: unknown[]): string {
    return this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
  }

  async list(scope: ResolvedScope, opts: { limit?: number; from?: unknown; to?: unknown } = {}) {
    // DEF-DR-01/02: route the date-range through the one strict validator (bad date -> 400, not 500).
    const { from, to } = assertDateRange(opts.from, opts.to);
    const params: unknown[] = [];
    const where = this.scopeWhere(scope, params);
    const extra: string[] = [];
    if (from) { params.push(from); extra.push(`b.created_at >= $${params.length}::date`); }
    if (to) { params.push(to); extra.push(`b.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    params.push(Math.min(Number(opts.limit) || 50, 200));
    return this.db.query(
      `SELECT b.*, c.name AS campaign_name, s.name AS source_name, br.name AS branch_name,
              v.name AS vertical_name, u.name AS created_by_name
         FROM import_batch b
         JOIN campaign c ON c.id = b.campaign_id
         JOIN source s   ON s.id = b.source_id
         JOIN branch br  ON br.id = b.branch_id
         JOIN vertical v ON v.id = b.vertical_id
         LEFT JOIN "user" u ON u.id = b.created_by
        WHERE (${where})${extra.length ? ' AND ' + extra.join(' AND ') : ''}
        ORDER BY b.created_at DESC LIMIT $${params.length}`,
      params,
    );
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.scopeWhere(scope, params);
    params.push(id);
    const batch = await this.db.one<any>(
      `SELECT b.*, c.name AS campaign_name, s.name AS source_name, u.name AS created_by_name
         FROM import_batch b
         JOIN campaign c ON c.id = b.campaign_id
         JOIN source s   ON s.id = b.source_id
         LEFT JOIN "user" u ON u.id = b.created_by
        WHERE b.id = $${params.length} AND (${where})`,
      params,
    );
    if (!batch) throw new NotFoundException('import not found');
    const errors = await this.db.query(
      `SELECT row_num, reason, raw FROM import_error WHERE batch_id = $1 ORDER BY row_num LIMIT 200`, [id],
    );
    const pending = await this.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM import_job WHERE batch_id = $1 AND status IN ('queued','running')`, [id],
    );
    return { ...batch, pending: pending?.n ?? 0, errors };
  }

  /** Downloadable error CSV: the failed rows, verbatim, plus the reason. */
  async errorCsv(id: number, scope: ResolvedScope): Promise<{ filename: string; body: string }> {
    const batch = await this.get(id, scope);
    const rows = await this.db.query<{ row_num: number; reason: string; raw: Record<string, string> }>(
      `SELECT row_num, reason, raw FROM import_error WHERE batch_id = $1 ORDER BY row_num`, [id],
    );
    const headers = Object.keys(rows[0]?.raw ?? {});
    const body = toCsv(
      ['Row', 'Error', ...headers],
      rows.map((r) => [r.row_num, r.reason, ...headers.map((h) => r.raw?.[h] ?? '')]),
    );
    const base = String(batch.file_name ?? 'import').replace(/\.csv$/i, '').replace(/[^A-Za-z0-9._-]/g, '_');
    return { filename: `${base}-errors.csv`, body };
  }

  /** Template CSV so a first-time user starts from a valid file. */
  template(): string {
    return toCsv(
      LEAD_IMPORT_FIELDS.map((f) => f.label),
      [['Priya Sharma', '+91 98111 00001', 'priya@example.com', '', '', '', '', '', '', '', '', 'high', 'hot', '80', '', '', 'Walk-in enquiry, prefers "evening" batch', 'EXT-1001']],
    );
  }
}

export type { IngestTarget };
