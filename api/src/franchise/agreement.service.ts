import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';

/**
 * FRANCHISE AGREEMENTS & RENEWALS (Phase 4 Batch 2).
 *
 * Agreement records (agreement no, sign/start/end/renewal dates), an optional signed
 * document stored in R2 (document_r2_key, presigned on read), and a renewal-reminder
 * (expiring-soon) list. The stored status is operator-set (active / renewed); the list
 * ALSO derives expiring / expired from end_date vs today so the badge is always live.
 */

const STATUSES = ['active', 'expiring', 'expired', 'renewed'];

@Injectable()
export class AgreementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private map = (r: any) => ({
    id: Number(r.id),
    franchise_id: Number(r.franchise_id),
    franchise_name: r.franchise_name ?? null,
    agreement_no: r.agreement_no ?? null,
    sign_date: r.sign_date, start_date: r.start_date, end_date: r.end_date, renewal_date: r.renewal_date,
    status: r.status,
    derived_status: r.derived_status ?? r.status,
    days_to_expiry: r.days_to_expiry === null || r.days_to_expiry === undefined ? null : Number(r.days_to_expiry),
    has_document: !!r.document_r2_key,
    note: r.note ?? null,
    created_at: r.created_at,
  });

  /** The derived-status + days-to-expiry SQL, shared by list + expiring. */
  private readonly derivedCols = `
    ((now() AT TIME ZONE 'Asia/Kolkata')::date) AS today,
    (a.end_date - (now() AT TIME ZONE 'Asia/Kolkata')::date) AS days_to_expiry,
    CASE
      WHEN a.status = 'renewed' THEN 'renewed'
      WHEN a.end_date IS NULL THEN a.status
      WHEN a.end_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'expired'
      WHEN a.end_date <= ((now() AT TIME ZONE 'Asia/Kolkata')::date + 60) THEN 'expiring'
      ELSE 'active'
    END AS derived_status`;

  async list(franchiseId?: number, status?: string) {
    const params: unknown[] = [];
    let clause = 'a.deleted_at IS NULL';
    if (franchiseId) { params.push(franchiseId); clause += ` AND a.franchise_id = $${params.length}::bigint`; }
    const rows = await this.db.query<any>(
      `SELECT a.*, f.name AS franchise_name, ${this.derivedCols}
         FROM franchise_agreement a JOIN franchise f ON f.id = a.franchise_id
        WHERE ${clause}
        ORDER BY COALESCE(a.end_date, a.start_date) DESC NULLS LAST, a.id DESC`, params);
    let mapped = rows.map(this.map);
    if (status && STATUSES.includes(status)) mapped = mapped.filter((r) => r.derived_status === status);
    return mapped;
  }

  async get(id: number) {
    const r = await this.db.one<any>(
      `SELECT a.*, f.name AS franchise_name, ${this.derivedCols}
         FROM franchise_agreement a JOIN franchise f ON f.id = a.franchise_id
        WHERE a.id = $1::bigint AND a.deleted_at IS NULL`, [id]);
    if (!r) throw new NotFoundException('Agreement not found');
    let document_url: string | null = null;
    if (r.document_r2_key) { try { document_url = await this.storage.presignGet(String(r.document_r2_key), 600); } catch { document_url = null; } }
    return { ...this.map(r), document_url };
  }

  /** Expiring-soon reminder: active agreements whose end_date is within `days` (default 60). */
  async expiring(days = 60) {
    const d = Math.max(1, Math.min(365, Math.trunc(Number(days) || 60)));
    const rows = await this.db.query<any>(
      `SELECT a.*, f.name AS franchise_name, ${this.derivedCols}
         FROM franchise_agreement a JOIN franchise f ON f.id = a.franchise_id
        WHERE a.deleted_at IS NULL AND a.status <> 'renewed' AND a.end_date IS NOT NULL
          AND a.end_date <= ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)
        ORDER BY a.end_date`, [d]);
    return rows.map(this.map);
  }

  private ymd(v: unknown): string | null {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? ''));
    return m ? m[1] : null;
  }

  async save(dto: any, me: { id: number }) {
    const franchiseId = Number(dto?.franchise_id);
    if (!Number.isInteger(franchiseId) || franchiseId <= 0) throw new BadRequestException('Choose a franchise.');
    const status = STATUSES.includes(dto?.status) ? dto.status : 'active';
    const start = this.ymd(dto?.start_date);
    const end = this.ymd(dto?.end_date);
    if (start && end && end < start) throw new BadRequestException('The end date cannot be before the start date.');
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;
    const cols = [franchiseId, dto?.agreement_no ?? null, this.ymd(dto?.sign_date), start, end,
      this.ymd(dto?.renewal_date), dto?.document_r2_key ?? null, status, dto?.note ?? null];
    if (id) {
      const upd = await this.db.query<{ id: string }>(
        `UPDATE franchise_agreement SET franchise_id=$2::bigint, agreement_no=$3, sign_date=$4::date,
                start_date=$5::date, end_date=$6::date, renewal_date=$7::date,
                document_r2_key=COALESCE($8, document_r2_key), status=$9, note=$10, updated_at=now()
          WHERE id=$1::bigint AND deleted_at IS NULL RETURNING id`,
        [id, ...cols]);
      if (!upd.length) throw new NotFoundException('Agreement not found');
      return { id };
    }
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO franchise_agreement (org_id, franchise_id, agreement_no, sign_date, start_date, end_date,
              renewal_date, document_r2_key, status, note, created_by)
       VALUES ($1::bigint,$2::bigint,$3,$4::date,$5::date,$6::date,$7::date,$8,$9,$10,$11::bigint) RETURNING id`,
      [orgId, ...cols, me.id]);
    return { id: Number(ins[0].id) };
  }

  async remove(id: number, me: { id: number }) {
    const r = await this.db.query<{ id: string }>(
      `UPDATE franchise_agreement SET deleted_at = now(), deleted_by = $2::bigint
        WHERE id = $1::bigint AND deleted_at IS NULL RETURNING id`, [id, me.id]);
    if (!r.length) throw new NotFoundException('Agreement not found');
    return { id, ok: true };
  }

  /** Presigned PUT for a signed-agreement document upload (browser -> R2), like course-content. */
  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'agreement.pdf');
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.materialKey('franchise-agreement', fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }
}
