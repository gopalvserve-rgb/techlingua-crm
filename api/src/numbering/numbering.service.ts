import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

/**
 * THE NUMBERING SERIES — quotations, enrolments, receipts (and, in Phase 3, invoices).
 *
 * =============================================================================
 * WHY THIS IS A TABLE AND NOT THE OLD `app_setting.numbering_series` JSON BLOB
 * =============================================================================
 * Sprint 4 shipped numbering as a JSON textarea in Settings and said "used from
 * Sprint 5". Sprint 5 is where it must actually ALLOCATE, and allocation has two
 * requirements a JSON blob cannot meet:
 *
 *   1. ATOMICITY. Two counsellors saving a quotation in the same millisecond must not
 *      get QT-0007 twice. `UPDATE ... SET next_number = next_number + 1 RETURNING` is
 *      one statement, so the ROW LOCK is the mutex — no read-modify-write, no race.
 *      A single JSON row would serialise every document in the org behind one lock.
 *   2. PER-BRANCH / PER-VERTICAL. §5 requires separate numbering per branch and per
 *      vertical. That is a row per series, not a nested object nobody can index.
 *
 * Migration 029 carries the JSON across and DELETES the app_setting row — the 028
 * calendar_sync rule: the old editing surface must GO, not merely stop being read.
 * Two places to edit one number is how you get two different numbers.
 *
 * RESOLUTION is "MOST SPECIFIC WINS", the same rule channel_config and the SLA
 * policies already use, so the product has ONE mental model:
 *     (branch + vertical)  ->  (vertical)  ->  (branch)  ->  org-wide
 *
 * PERIOD RESET: 'yearly' embeds the CALENDAR year (QT-2026/0001) and restarts the
 * counter each January; 'monthly' embeds YYYYMM. The token is part of the number, so
 * numbers stay unique for ever even across a reset.
 *   >> CLIENT DECISION OUTSTANDING: calendar year vs INDIAN FINANCIAL year (Apr–Mar).
 *      We default to the calendar year because it is what the number itself says and
 *      cannot be misread. Switching to FY is one function below + one settings value;
 *      it is NOT a migration. Flagged in PROJECT_STATUS §4.
 */

export const NUMBER_KINDS = ['quotation', 'enrolment', 'receipt', 'invoice', 'refund', 'lead', 'support', 'student', 'enrollment', 'admission', 'po', 'asset', 'catalog', 'employee', 'assessment_certificate'] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

/** The default series a lazily-created row gets. A fresh database must never come up
 *  unable to save a quotation — that is the Sprint-3 "no scoring rules on a fresh DB"
 *  lesson, and here it would be a 500 on the client's first quote. */
export const KIND_DEFAULTS: Record<string, { prefix: string; reset: string; label: string }> = {
  quotation: { prefix: 'QT-',  reset: 'yearly', label: 'Quotations' },
  enrolment: { prefix: 'ENR-', reset: 'yearly', label: 'Enrolments' },
  receipt:   { prefix: 'RCP-', reset: 'yearly', label: 'Fee receipts' },
  // Phase 3 owns invoicing. The series exists so the numbering screen is complete and
  // Phase 3 needs no migration; NOTHING allocates from it today.
  invoice:   { prefix: 'INV-', reset: 'fy', label: 'GST Tax Invoices' },
  // Phase 3 Batch 4 — refund vouchers. REF-, reset per Indian FY (like the invoice
  // series). Allocated ON APPROVAL only (an unapproved request never burns a number).
  refund:    { prefix: 'REF-', reset: 'fy', label: 'Refund vouchers' },
  // `lead` is CARRIED FORWARD, not invented: the client had configured it in the old
  // `app_setting.numbering_series` JSON, so migration 029 brought it across rather than
  // silently dropping his setting. Nothing allocates a lead number today — leads are
  // identified by phone (the de-dup key), not by a serial — so the label says so plainly.
  // Without this entry the row rendered as a bare lowercase "lead" and its Edit button
  // 400'd on an "Unknown numbering series", which the live smoke surfaced.
  lead:      { prefix: 'LD-', reset: 'none', label: 'Leads (not currently numbered)' },
  // Support & Tickets (migration 037) — SUP-#### staff tickets.
  support:   { prefix: 'SUP-', reset: 'none', label: 'Support tickets' },
  // Phase 2 — Students & Academics. `student` mints the Student ID (STU-), `enrollment`
  // the academic Enrollment No (EN-). Both allocate per branch/vertical if a more specific
  // series row exists, org-wide otherwise (the same MOST-SPECIFIC-WINS rule as everything else).
  student:    { prefix: 'STU-', reset: 'none', label: 'Student IDs' },
  enrollment: { prefix: 'EN-',  reset: 'none', label: 'Enrollment numbers' },
  // Phase 2 ERP Batch 2 (Learning) — CERT-#### certificate serials, reset yearly.
  certificate: { prefix: 'CERT-', reset: 'yearly', label: 'Certificates' },
  // Phase 2 ERP Batch 3 — ADM-#### admission numbers, minted when a pending admission is
  // APPROVED into a student (an unapproved submission never burns a number).
  admission:  { prefix: 'ADM-', reset: 'yearly', label: 'Admissions' },
  // Phase 2 ERP Batch 5 (Operations). PO-#### purchase orders (reset yearly), AST-#### asset
  // tags and ITM-#### catalog item codes (both per branch/vertical if a more specific series row
  // exists, org-wide otherwise — the same MOST-SPECIFIC-WINS rule).
  po:         { prefix: 'PO-',  reset: 'yearly', label: 'Purchase Orders' },
  asset:      { prefix: 'AST-', reset: 'none', label: 'Asset codes' },
  catalog:    { prefix: 'ITM-', reset: 'none', label: 'Catalog item codes' },
  // Phase 2 ERP Batch 6 (Basic HR). EMP-#### employee codes (per branch/vertical if a more
  // specific series row exists, org-wide otherwise — the same MOST-SPECIFIC-WINS rule).
  employee:   { prefix: 'EMP-', reset: 'none', label: 'Employee codes' },
  // Phase 2 Assessment Batch D — ACRT-#### exam/course certificate numbers, reset per Indian FY
  // (like invoices). Allocated per branch/vertical if a more specific series row exists.
  assessment_certificate: { prefix: 'ACRT-', reset: 'fy', label: 'Assessment certificates' },
};

export interface SeriesRow {
  id: number; kind: string; branch_id: number | null; vertical_id: number | null;
  prefix: string; suffix: string; next_number: string | number; padding: number;
  reset_period: string; period_token: string;
}

/** PURE — the token a date belongs to, given a reset period. Testable without a clock. */
export function periodToken(reset: string, at: Date): string {
  if (reset === 'yearly') return String(at.getUTCFullYear());
  if (reset === 'monthly') return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  // Indian FINANCIAL YEAR (Apr–Mar). Token like "2026-27" so a GST invoice serial
  // reads its own year and restarts each 1 April. (getUTCMonth: 0=Jan, 3=Apr.)
  if (reset === 'fy') {
    const y = at.getUTCFullYear();
    const startYear = at.getUTCMonth() >= 3 ? y : y - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  return '';
}

/** PURE — assemble the visible number. One function, so a quote number and a receipt
 *  number can never be formatted by two subtly different rules. */
export function formatNumber(
  parts: { prefix: string; suffix: string; padding: number; token: string; n: number },
): string {
  const body = String(parts.n).padStart(Math.max(0, parts.padding), '0');
  const tok = parts.token ? `${parts.token}/` : '';
  return `${parts.prefix ?? ''}${tok}${body}${parts.suffix ?? ''}`;
}

@Injectable()
export class NumberingService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /**
   * MOST SPECIFIC WINS. Explicit `::bigint` casts on every parameter: the Sprint-3
   * `$3`-cast bug was a query Postgres 16/17 rejected for an inferred parameter type
   * that PG18 tolerates — it passed every unit test and failed only on the live DB.
   */
  async resolve(kind: string, branchId?: number | null, verticalId?: number | null): Promise<SeriesRow | null> {
    const orgId = await this.orgId();
    return this.db.one<SeriesRow>(
      `SELECT id, kind, branch_id, vertical_id, prefix, suffix, next_number, padding,
              reset_period, period_token
         FROM number_series
        WHERE org_id = $1::bigint
          AND kind = $2::varchar
          AND (branch_id IS NULL OR branch_id = $3::bigint)
          AND (vertical_id IS NULL OR vertical_id = $4::bigint)
        ORDER BY (branch_id IS NOT NULL)::int + (vertical_id IS NOT NULL)::int DESC,
                 (vertical_id IS NOT NULL)::int DESC,
                 id ASC
        LIMIT 1`,
      [orgId, kind, branchId ?? null, verticalId ?? null],
    );
  }

  /** Create the org-wide default for a kind that has none. Idempotent. */
  private async ensure(kind: string): Promise<void> {
    const d = KIND_DEFAULTS[kind];
    if (!d) throw new BadRequestException(`Unknown numbering series "${kind}"`);
    await this.db.query(
      `INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
       SELECT id, $1::varchar, $2::varchar, 1, 4, $3::varchar FROM organisation ORDER BY id LIMIT 1
       ON CONFLICT DO NOTHING`,
      [kind, d.prefix, d.reset],
    );
  }

  /**
   * ALLOCATE the next number. ONE statement, so the row lock is the mutex.
   *
   * Pass the CALLER'S transaction client and the number is allocated inside it: if the
   * quotation insert rolls back, so does the number. (Postgres sequences deliberately do
   * NOT roll back; a counter that skips QT-0007 for ever because someone's browser died
   * mid-save is exactly the kind of gap an auditor asks about.)
   */
  async allocate(
    kind: string,
    ctx: { branch_id?: number | null; vertical_id?: number | null } = {},
    client?: PoolClient,
    now: Date = new Date(),
  ): Promise<string> {
    const q = client
      ? <T>(sql: string, p: unknown[]) => client.query(sql, p as any[]).then((r) => r.rows as T[])
      : <T>(sql: string, p: unknown[]) => this.db.query(sql, p) as Promise<T[]>;

    let row = await this.resolve(kind, ctx.branch_id, ctx.vertical_id);
    if (!row) {
      await this.ensure(kind);
      row = await this.resolve(kind, ctx.branch_id, ctx.vertical_id);
      if (!row) throw new BadRequestException(`No numbering series is configured for "${kind}".`);
    }

    const token = periodToken(row.reset_period, now);
    const out = await q<{ allocated: string; prefix: string; suffix: string; padding: number; period_token: string }>(
      `UPDATE number_series
          SET next_number = CASE
                              WHEN reset_period <> 'none' AND period_token IS DISTINCT FROM $2::varchar THEN 2
                              ELSE next_number + 1
                            END,
              period_token = CASE WHEN reset_period <> 'none' THEN $2::varchar ELSE '' END,
              updated_at = now()
        WHERE id = $1::bigint
        RETURNING next_number - 1 AS allocated, prefix, suffix, padding, period_token`,
      [row.id, token],
    );
    // RETURNING gives the NEW row, so `next_number - 1` is the number we just took —
    // true both on a normal increment (old+1-1 = old) and on a period reset (2-1 = 1).
    const r = out[0];
    if (!r) throw new BadRequestException(`Numbering series "${kind}" vanished mid-allocation`);
    return formatNumber({
      prefix: r.prefix, suffix: r.suffix, padding: Number(r.padding),
      token: r.period_token, n: Number(r.allocated),
    });
  }

  /** What the NEXT number would look like — for a form's placeholder. Allocates nothing. */
  async peek(kind: string, ctx: { branch_id?: number | null; vertical_id?: number | null } = {}): Promise<string> {
    const row = await this.resolve(kind, ctx.branch_id, ctx.vertical_id);
    const d = KIND_DEFAULTS[kind] ?? { prefix: '', reset: 'none' };
    if (!row) return formatNumber({ prefix: d.prefix, suffix: '', padding: 4, token: periodToken(d.reset, new Date()), n: 1 });
    const token = periodToken(row.reset_period, new Date());
    const n = row.reset_period !== 'none' && row.period_token !== token ? 1 : Number(row.next_number);
    return formatNumber({ prefix: row.prefix, suffix: row.suffix, padding: Number(row.padding), token, n });
  }

  // ------------------------------------------------------------------ admin CRUD

  async list() {
    const rows = await this.db.query<any>(
      `SELECT ns.id, ns.kind, ns.branch_id, ns.vertical_id, ns.prefix, ns.suffix,
              ns.next_number, ns.padding, ns.reset_period, ns.period_token, ns.updated_at,
              b.name AS branch_name, v.name AS vertical_name
         FROM number_series ns
         LEFT JOIN branch b ON b.id = ns.branch_id
         LEFT JOIN vertical v ON v.id = ns.vertical_id
        ORDER BY ns.kind, ns.branch_id NULLS FIRST, ns.vertical_id NULLS FIRST`,
    );
    return rows.map((r) => ({
      ...r,
      next_number: Number(r.next_number),
      padding: Number(r.padding),
      label: KIND_DEFAULTS[r.kind]?.label ?? r.kind,
      preview: formatNumber({
        prefix: r.prefix, suffix: r.suffix, padding: Number(r.padding),
        token: periodToken(r.reset_period, new Date()),
        n: r.reset_period !== 'none' && r.period_token !== periodToken(r.reset_period, new Date())
          ? 1 : Number(r.next_number),
      }),
    }));
  }

  async save(dto: any, actorId: number) {
    const kind = String(dto?.kind ?? '');
    if (!KIND_DEFAULTS[kind]) throw new BadRequestException(`Unknown numbering series "${kind}"`);
    const reset = String(dto?.reset_period ?? 'none');
    if (!['none', 'yearly', 'monthly', 'fy'].includes(reset)) throw new BadRequestException('Reset must be none, yearly, monthly or fy (Indian financial year)');
    const next = Number(dto?.next_number ?? 1);
    if (!Number.isInteger(next) || next < 1) throw new BadRequestException('Next number must be a whole number of 1 or more');
    const padding = Number(dto?.padding ?? 4);
    if (!Number.isInteger(padding) || padding < 0 || padding > 12) throw new BadRequestException('Padding must be between 0 and 12');
    const orgId = await this.orgId();

    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO number_series (org_id, kind, branch_id, vertical_id, prefix, suffix,
                                  next_number, padding, reset_period, updated_by, updated_at)
       VALUES ($1::bigint, $2::varchar, $3::bigint, $4::bigint, $5::varchar, $6::varchar,
               $7::bigint, $8::int, $9::varchar, $10::bigint, now())
       ON CONFLICT (org_id, kind, COALESCE(branch_id, 0), COALESCE(vertical_id, 0))
       DO UPDATE SET prefix = EXCLUDED.prefix, suffix = EXCLUDED.suffix,
                     next_number = EXCLUDED.next_number, padding = EXCLUDED.padding,
                     reset_period = EXCLUDED.reset_period, updated_by = EXCLUDED.updated_by,
                     updated_at = now()
       RETURNING id`,
      [orgId, kind, dto?.branch_id ?? null, dto?.vertical_id ?? null,
        String(dto?.prefix ?? ''), String(dto?.suffix ?? ''), next, padding, reset, actorId],
    );
    return { id: Number(rows[0].id) };
  }

  async remove(id: number) {
    const row = await this.db.one<SeriesRow>(`SELECT * FROM number_series WHERE id = $1::bigint`, [id]);
    if (!row) throw new NotFoundException('Series not found');
    // The org-wide fallback must survive: deleting it would leave a branch series with
    // nothing to fall back to and the next quotation would 400.
    if (row.branch_id === null && row.vertical_id === null) {
      throw new BadRequestException(
        `The org-wide ${KIND_DEFAULTS[row.kind]?.label ?? row.kind} series is the fallback for every branch — it cannot be deleted. Edit it instead.`,
      );
    }
    await this.db.query(`DELETE FROM number_series WHERE id = $1::bigint`, [id]);
    return { ok: true };
  }
}
