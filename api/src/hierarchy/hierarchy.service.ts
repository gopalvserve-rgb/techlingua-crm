import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { validateDistributionConfig, validateDuplicacyConfig } from './campaign-config.validator';
import { requireDateString } from '../common/date.util';
import { StorageService } from '../storage/storage.service';

/**
 * Hierarchy CRUD: Branch > Vertical > Pipeline (+stages) > Campaign > Source.
 * On create, each child copies its parent's ancestor chain (full-path denormalisation)
 * so no client can produce an inconsistent path.
 */
/** Multi-select hierarchy filter ids (client, Aug 2026): OR within a level, AND across
 *  levels, ANDed on top of RBAC scope. Singular params stay for back-compat. */
export interface HierIds { branchIds?: number[]; verticalIds?: number[]; pipelineIds?: number[]; campaignIds?: number[]; }

export interface BranchDto {
  name: string;
  code: string;
  state_id?: number | null;
  city_id?: number | null;
  address?: string | null;
  /** 'company' | 'franchise' (accepts the form's "Company Branch" / "Franchise Branch") */
  branch_type?: string | null;
  contact_number?: string | null;
  email?: string | null;
  head_user_id?: number | null;
  /** Phase 3 — the seller identity on a GST tax invoice. */
  legal_name?: string | null;
  gstin?: string | null;
  pan?: string | null;
  /** QA-10 sweep: the Add Branch form has a Status select — honour it on create. */
  is_active?: boolean;
}

@Injectable()
export class HierarchyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly storage?: StorageService,
  ) {}

  /* ---- vertical billing-identity validation (India-first, loose) — dev/88 ---- */
  private static IMG_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml']);

  /** GSTIN: 15 chars, 2-digit state code + 10-char PAN + 3 more (loose upper-case check). */
  static normGstin(v?: string | null): string | null {
    const t = HierarchyService.text(v, 15);
    if (t === null) return null;
    const g = t.toUpperCase();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}[Z]{1}[0-9A-Z]{1}$/.test(g)) {
      throw new BadRequestException('GSTIN must be a valid 15-character India GSTIN (e.g. 27AAPFU0939F1ZV).');
    }
    return g;
  }

  /** Email: a loose shape check (blank clears the field). */
  static normEmail(v?: string | null): string | null {
    const t = HierarchyService.text(v, 255);
    if (t === null) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new BadRequestException('Enter a valid email address.');
    return t;
  }

  /** Phone: Indian 10-digit or E.164 (digits, +, spaces, hyphens; 6–15 digits). */
  static normPhone(v?: string | null): string | null {
    const t = HierarchyService.text(v, 24);
    if (t === null) return null;
    const digits = t.replace(/[^0-9]/g, '');
    if (digits.length < 6 || digits.length > 15) throw new BadRequestException('Enter a valid phone number (Indian mobile or E.164).');
    return t;
  }

  /** Normalise & validate the vertical billing/identity DTO fields into a column map. */
  private normVerticalIdentity(dto: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if ('gstin' in dto) out.gstin = HierarchyService.normGstin(dto.gstin as string | null);
    if ('email' in dto) out.email = HierarchyService.normEmail(dto.email as string | null);
    if ('phone' in dto) out.phone = HierarchyService.normPhone(dto.phone as string | null);
    if ('billing_address' in dto) out.billing_address = HierarchyService.text(dto.billing_address as string | null, 2000);
    if ('display_name' in dto) out.display_name = HierarchyService.text(dto.display_name as string | null, 200);
    if ('bank_name' in dto) out.bank_name = HierarchyService.text(dto.bank_name as string | null, 160);
    if ('bank_account_no' in dto) out.bank_account_no = HierarchyService.text(dto.bank_account_no as string | null, 40);
    if ('bank_ifsc' in dto) { const f = HierarchyService.text(dto.bank_ifsc as string | null, 15); out.bank_ifsc = f ? f.toUpperCase() : f; }
    if ('bank_branch' in dto) out.bank_branch = HierarchyService.text(dto.bank_branch as string | null, 160);
    if ('bank_account_holder' in dto) out.bank_account_holder = HierarchyService.text(dto.bank_account_holder as string | null, 200);
    // dev/132 ITEM B — UPI id + MULTIPLE bank accounts (one active/required). The active bank
    // is also mirrored into the legacy single-bank columns above so existing readers keep working.
    if ('upi_id' in dto) out.upi_id = HierarchyService.text(dto.upi_id as string | null, 120);
    if ('banks' in dto) {
      const banks = HierarchyService.normBanks(dto.banks);
      out.banks = banks;
      const active = (banks.find((b) => b.active) ?? banks[0]) as Record<string, string> | undefined;
      out.bank_name = active ? (active.name || null) : null;
      out.bank_account_no = active ? (active.account_no || null) : null;
      out.bank_ifsc = active ? (active.ifsc || null) : null;
      out.bank_branch = active ? (active.branch || null) : null;
      out.bank_account_holder = active ? (active.account_holder || null) : null;
    }
    return out;
  }

  /** Normalise the vertical bank-accounts array: trim/cap each field, drop empty rows, and
   *  guarantee EXACTLY ONE active/required bank (first flagged, else the first row). */
  static normBanks(v: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(v)) return [];
    const rows = v.map((b: any) => ({
      name: HierarchyService.text(b?.name as string | null, 160) ?? '',
      account_no: HierarchyService.text(b?.account_no as string | null, 40) ?? '',
      ifsc: (HierarchyService.text(b?.ifsc as string | null, 15) ?? '').toUpperCase(),
      branch: HierarchyService.text(b?.branch as string | null, 160) ?? '',
      account_holder: HierarchyService.text(b?.account_holder as string | null, 200) ?? '',
      active: !!b?.active,
    })).filter((b) => b.name || b.account_no);
    if (rows.length && !rows.some((b) => b.active)) rows[0].active = true;
    let seen = false;
    for (const b of rows) { if (b.active) { if (seen) b.active = false; else seen = true; } }
    return rows;
  }

  /**
   * Agent-pool referential check (user picker): every user id referenced by a
   * campaign's distribution_config (agent_user_ids + conditions[].assign_to_user_ids)
   * must be an EXISTING, ACTIVE, non-deleted user (400 with the offending ids),
   * and must fall inside the caller's resolved scope (404, assertRefInScope
   * policy — no existence oracle across scope boundaries).
   */
  private async assertDistributionUsers(dist: Record<string, unknown> | null, scope: ResolvedScope, actorId: number) {
    if (!dist) return;
    const ids = new Set<number>();
    for (const id of (dist.agent_user_ids as number[] | undefined) ?? []) ids.add(Number(id));
    for (const c of (dist.conditions as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const id of (c.assign_to_user_ids as number[] | undefined) ?? []) ids.add(Number(id));
    }
    if (!ids.size) return;
    const list = [...ids];
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE id = ANY($1::bigint[]) AND status = 'active' AND deleted_at IS NULL`, [list],
    );
    const ok = new Set(rows.map((r) => Number(r.id)));
    const bad = list.filter((id) => !ok.has(id));
    if (bad.length) {
      throw new BadRequestException(
        `distribution_config references unknown, inactive or deleted user id(s): ${bad.join(', ')}`,
      );
    }
    for (const id of list) await this.enforcer.assertRefInScope(scope, 'user', id, actorId);
  }

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  // ---- branches -----------------------------------------------------------

  /** Trim a free-text form value; '' (an untouched input) is NULL, never an empty string. */
  static text(v?: string | null, max = 32): string | null {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t === '' ? null : t.slice(0, max);
  }

  /** A date input sends '' when cleared — that is NULL, not an invalid date (22P02). */
  static date(v?: string | null): string | null {
    return requireDateString(v, () => {
      throw new BadRequestException(`invalid date: ${v} (expected YYYY-MM-DD)`);
    });
  }

  /** Form sends the prototype labels ("Company Branch" / "Franchise Branch"); store the enum. */
  static branchType(v?: string | null): string | null {
    if (v === undefined || v === null || v === '') return null;
    const t = String(v).trim().toLowerCase();
    if (t.startsWith('franchise')) return 'franchise';
    if (t.startsWith('company')) return 'company';
    if (t === 'company' || t === 'franchise') return t;
    throw new BadRequestException(`invalid branch_type: ${v}`);
  }


  /** UAT: lists hide inactive rows by default; `?include_inactive=1` shows them (scope-safe). */
  static activeFilter(alias: string, includeInactive?: boolean): string {
    return includeInactive ? '' : ` AND ${alias}.is_active`;
  }

  // UAT-R3 #19 — Branch list filters: free-text search on name/code (status via include_inactive).
  /** Multi-select filter (client, Aug 2026): fold a singular id + an ids[] into one
   *  `col IN (...)` (OR within the filter), ANDed onto the scoped WHERE. Ints > 0 only.
   *  Returns null when nothing is selected so the caller can skip the AND. */
  private inCol(col: string, single: number | undefined, arr: number[] | undefined, params: unknown[]): string | null {
    const vals = [...new Set([...(arr ?? []), ...(single != null ? [single] : [])])]
      .map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!vals.length) return null;
    const ph = vals.map((v) => { params.push(v); return `$${params.length}`; });
    return `${col} IN (${ph.join(',')})`;
  }

  listBranches(scope: ResolvedScope, includeInactive = false, q?: string) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'b.id' }, params);
    let sql = `SELECT b.*, s.name AS state_name, c.name AS city_name, hu.name AS head_name,
              (SELECT COUNT(*)::int FROM vertical v WHERE v.branch_id = b.id AND v.is_active AND v.deleted_at IS NULL) AS vertical_count
         FROM branch b LEFT JOIN state s ON s.id = b.state_id LEFT JOIN city c ON c.id = b.city_id
              LEFT JOIN "user" hu ON hu.id = b.head_user_id
        WHERE ${where} AND b.deleted_at IS NULL${HierarchyService.activeFilter('b', includeInactive)}`;
    if (q && q.trim()) { params.push(`%${q.trim()}%`); sql += ` AND (b.name ILIKE $${params.length} OR b.code ILIKE $${params.length})`; }
    return this.db.query(sql + ` ORDER BY b.name`, params);
  }

  async createBranch(dto: BranchDto, actorId: number) {
    if (!dto?.name || !dto?.code) throw new BadRequestException('name and code are required');
    const rows = await this.db.query(
      `INSERT INTO branch (org_id, name, code, state_id, city_id, address,
                           branch_type, contact_number, email, head_user_id, is_active,
                           legal_name, gstin, pan, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, TRUE),$12,$13,$14,$15) RETURNING *`,
      [await this.orgId(), dto.name.trim(), dto.code.trim().toUpperCase(),
        dto.state_id ?? null, dto.city_id ?? null, dto.address ?? null,
        HierarchyService.branchType(dto.branch_type), dto.contact_number ?? null,
        dto.email ?? null, dto.head_user_id ?? null, dto.is_active ?? null,
        dto.legal_name ?? null, dto.gstin ?? null, dto.pan ?? null, actorId],
    );
    return rows[0];
  }

  /** DEF-2: every field the Add Branch form shows is now persisted and PATCHable. */
  updateBranch(id: number, dto: Partial<BranchDto> & { is_active?: boolean }) {
    const clean = { ...dto };
    if (clean.branch_type !== undefined) clean.branch_type = HierarchyService.branchType(clean.branch_type) as any;
    return this.genericUpdate('branch', id, clean, [
      'name', 'code', 'state_id', 'city_id', 'address',
      'branch_type', 'contact_number', 'email', 'head_user_id', 'is_active',
      'legal_name', 'gstin', 'pan',
    ]);
  }

  // ---- verticals ----------------------------------------------------------

  // UAT-R3 #19 — Vertical list filters: by Branch (existing) + free-text search on name/code.
  listVerticals(scope: ResolvedScope, branchId?: number, includeInactive = false, q?: string, opts?: HierIds) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, params);
    let sql = `SELECT v.*, b.name AS branch_name, hu.name AS head_name,
                      (SELECT COUNT(*)::int FROM pipeline p WHERE p.vertical_id = v.id AND p.is_active AND p.deleted_at IS NULL) AS pipeline_count
                 FROM vertical v JOIN branch b ON b.id = v.branch_id
                      LEFT JOIN "user" hu ON hu.id = v.head_user_id
                WHERE ${where} AND v.deleted_at IS NULL${HierarchyService.activeFilter('v', includeInactive)}`;
    { const c = this.inCol('v.branch_id', branchId, opts?.branchIds, params); if (c) sql += ` AND ${c}`; }
    if (q && q.trim()) { params.push(`%${q.trim()}%`); sql += ` AND (v.name ILIKE $${params.length} OR v.code ILIKE $${params.length})`; }
    return this.withLogoUrls(this.db.query(sql + ` ORDER BY v.name`, params));
  }

  /** dev/88 — attach a short-lived presigned logo_url to every vertical row that has a
   *  logo_r2_key (R2-only; the raw key never leaves as a URL). Degrades to null if R2 is off. */
  private async withLogoUrls(rowsP: Promise<any[]>): Promise<any[]> {
    const rows = await rowsP;
    if (!this.storage) return rows;
    await Promise.all(rows.map(async (r) => {
      if (r && r.logo_r2_key) {
        try { r.logo_url = await this.storage!.presignGet(String(r.logo_r2_key), 300, 'logo'); }
        catch { r.logo_url = null; }
      }
      // dev/132 ITEM B — a short-lived presigned URL for the payment QR image too.
      if (r && r.qr_r2_key) {
        try { r.qr_url = await this.storage!.presignGet(String(r.qr_r2_key), 300, 'qr'); }
        catch { r.qr_url = null; }
      }
    }));
    return rows;
  }

  async createVertical(dto: { branch_id: number; name: string; code: string; smtp_config?: object; gateway_config?: object; head_user_id?: number | null; description?: string | null; is_active?: boolean;
    gstin?: string | null; billing_address?: string | null; phone?: string | null; email?: string | null; display_name?: string | null;
    bank_name?: string | null; bank_account_no?: string | null; bank_ifsc?: string | null; bank_branch?: string | null; bank_account_holder?: string | null;
    banks?: unknown; upi_id?: string | null }, actorId: number) {
    if (!dto?.branch_id || !dto?.name || !dto?.code) throw new BadRequestException('branch_id, name and code are required');
    const branch = await this.db.one<{ org_id: string }>(`SELECT org_id FROM branch WHERE id = $1 AND deleted_at IS NULL`, [dto.branch_id]);
    if (!branch) throw new NotFoundException('branch not found');
    // dev/88 — the billing / identity fields (GSTIN, billing address, phone, email, display
    // name, bank details) are validated (India-first, loose) and stored on the vertical so the
    // vertical's GST invoices can snapshot them as the seller identity (055 fallback: branch).
    const idn = this.normVerticalIdentity(dto as Record<string, unknown>);
    // dev/132 ITEM B — banks[]/upi on create. If no banks[] array was sent but the legacy
    // single-bank fields were, seed a one-row banks[] so the Add form's single bank persists.
    let banks = (idn.banks as Array<Record<string, unknown>> | undefined) ?? [];
    if (!('banks' in (dto as Record<string, unknown>)) && (idn.bank_name || idn.bank_account_no)) {
      banks = [{ name: idn.bank_name ?? '', account_no: idn.bank_account_no ?? '', ifsc: idn.bank_ifsc ?? '',
        branch: idn.bank_branch ?? '', account_holder: idn.bank_account_holder ?? '', active: true }];
    }
    // DEF-S2-04: Vertical Head + Description are on the Add form and MUST be in the
    // INSERT (they were only in the PATCH whitelist, so Add silently dropped them).
    const rows = await this.db.query(
      `INSERT INTO vertical (org_id, branch_id, name, code, smtp_config, gateway_config,
                             head_user_id, description, is_active,
                             gstin, billing_address, phone, email, display_name,
                             bank_name, bank_account_no, bank_ifsc, bank_branch, bank_account_holder,
                             banks, upi_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE),
               $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22) RETURNING *`,
      [Number(branch.org_id), dto.branch_id, dto.name.trim(), dto.code.trim().toUpperCase(),
        JSON.stringify(dto.smtp_config ?? {}), JSON.stringify(dto.gateway_config ?? {}),
        dto.head_user_id ?? null, dto.description?.trim() ? dto.description.trim() : null,
        dto.is_active ?? null,
        idn.gstin ?? null, idn.billing_address ?? null, idn.phone ?? null, idn.email ?? null, idn.display_name ?? null,
        idn.bank_name ?? null, idn.bank_account_no ?? null, idn.bank_ifsc ?? null, idn.bank_branch ?? null, idn.bank_account_holder ?? null,
        JSON.stringify(banks), idn.upi_id ?? null,
        actorId],
    );
    return rows[0];
  }

  updateVertical(id: number, dto: Record<string, unknown>) {
    // dev/88 — validate + normalise the billing/identity fields before they hit the whitelist.
    const clean = { ...dto, ...this.normVerticalIdentity(dto) };
    return this.genericUpdate('vertical', id, clean,
      ['name', 'code', 'smtp_config', 'gateway_config', 'head_user_id', 'description', 'is_active',
        'gstin', 'billing_address', 'phone', 'email', 'display_name',
        'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'bank_account_holder',
        'banks', 'upi_id']);
  }

  /* ---- vertical logo (R2, presigned) — mirrors the student photo flow (dev/77) ---- */

  /** Presigned PUT for the vertical logo. Returns the R2 key the client PUTs the bytes to,
   *  then POSTs back to /logo to attach. Image types only; R2-only (no DB blob). */
  async logoUploadUrl(id: number, dto: { file_name?: string; content_type?: string }) {
    const v = await this.db.one<{ id: string }>(`SELECT id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!v) throw new NotFoundException('vertical not found');
    if (!this.storage) throw new BadRequestException('File storage is not configured.');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !HierarchyService.IMG_MIME.has(ct)) throw new BadRequestException('The logo must be a JPG, PNG, WEBP or SVG image.');
    const key = this.storage.verticalLogoKey(id, String(dto?.file_name ?? 'logo.png'));
    const url = await this.storage.presignPut(key, ct || 'image/png', 300);
    return { url, r2_key: key, expires_in: 300 };
  }

  /** Attach an uploaded logo: stores the new R2 key on the vertical and returns a fresh
   *  presigned logo_url. R2-only — the previous object is simply superseded by the key. */
  async attachLogo(id: number, dto: { r2_key?: string; content_type?: string }) {
    const v = await this.db.one<{ id: string }>(`SELECT id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!v) throw new NotFoundException('vertical not found');
    const key = String(dto?.r2_key ?? '').trim();
    if (!key || !key.startsWith(`verticals/${id}/logo/`)) throw new BadRequestException('Upload the logo first (missing or invalid r2_key).');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !HierarchyService.IMG_MIME.has(ct)) throw new BadRequestException('The logo must be a JPG, PNG, WEBP or SVG image.');
    const rows = await this.db.query(
      `UPDATE vertical SET logo_r2_key = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING id, logo_r2_key`, [key, id]);
    if (!rows.length) throw new NotFoundException('vertical not found');
    let logo_url: string | null = null;
    try { if (this.storage) logo_url = await this.storage.presignGet(key, 300, 'logo'); } catch { /* R2 off — key persists */ }
    return { id, logo_r2_key: key, logo_url };
  }

  /* ---- vertical payment QR (R2, presigned) — dev/132 ITEM B, mirrors the logo flow ---- */

  /** Presigned PUT for the vertical payment QR image. */
  async qrUploadUrl(id: number, dto: { file_name?: string; content_type?: string }) {
    const v = await this.db.one<{ id: string }>(`SELECT id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!v) throw new NotFoundException('vertical not found');
    if (!this.storage) throw new BadRequestException('File storage is not configured.');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !HierarchyService.IMG_MIME.has(ct)) throw new BadRequestException('The QR must be a JPG, PNG, WEBP or SVG image.');
    const key = this.storage.verticalQrKey(id, String(dto?.file_name ?? 'qr.png'));
    const url = await this.storage.presignPut(key, ct || 'image/png', 300);
    return { url, r2_key: key, expires_in: 300 };
  }

  /** Attach an uploaded payment QR: stores the R2 key and returns a fresh presigned qr_url. */
  async attachQr(id: number, dto: { r2_key?: string; content_type?: string }) {
    const v = await this.db.one<{ id: string }>(`SELECT id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!v) throw new NotFoundException('vertical not found');
    const key = String(dto?.r2_key ?? '').trim();
    if (!key || !key.startsWith(`verticals/${id}/qr/`)) throw new BadRequestException('Upload the QR first (missing or invalid r2_key).');
    const ct = String(dto?.content_type ?? '').toLowerCase();
    if (ct && !HierarchyService.IMG_MIME.has(ct)) throw new BadRequestException('The QR must be a JPG, PNG, WEBP or SVG image.');
    const rows = await this.db.query(
      `UPDATE vertical SET qr_r2_key = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING id, qr_r2_key`, [key, id]);
    if (!rows.length) throw new NotFoundException('vertical not found');
    let qr_url: string | null = null;
    try { if (this.storage) qr_url = await this.storage.presignGet(key, 300, 'qr'); } catch { /* R2 off — key persists */ }
    return { id, qr_r2_key: key, qr_url };
  }

  // ---- pipelines + stages -------------------------------------------------

  // UAT-R3 #19 — Pipeline list filters follow Branch \u2192 Vertical (+ search); vertical filter existed.
  listPipelines(scope: ResolvedScope, verticalId?: number, includeInactive = false, branchId?: number, q?: string, opts?: HierIds) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'p.branch_id', vertical: 'p.vertical_id', pipeline: 'p.id',
    }, params);
    let sql = `SELECT p.*, v.name AS vertical_name, b.name AS branch_name, ou.name AS owner_name
                 FROM pipeline p JOIN vertical v ON v.id = p.vertical_id JOIN branch b ON b.id = p.branch_id
                      LEFT JOIN "user" ou ON ou.id = p.owner_user_id
                WHERE ${where} AND p.deleted_at IS NULL${HierarchyService.activeFilter('p', includeInactive)}`;
    { const c = this.inCol('p.branch_id', branchId, opts?.branchIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('p.vertical_id', verticalId, opts?.verticalIds, params); if (c) sql += ` AND ${c}`; }
    if (q && q.trim()) { params.push(`%${q.trim()}%`); sql += ` AND (p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`; }
    // UAT-R2 #7 — list in hierarchy order Branch \u203a Vertical \u203a Pipeline.
    return this.db.query(sql + ` ORDER BY b.name, v.name, p.name`, params);
  }

  /**
   * UAT-R2 #9 — the Add-Pipeline form's stage editor now sends the stages the user built
   * with "Add row". When a non-empty `stages` array is supplied it is seeded verbatim (in
   * order); when omitted/empty we keep seeding the default six-stage set so a quick pipeline
   * still gets a working flow. Exactly one stage is the default landing stage: the one the
   * user marked, else the first.
   */
  static buildStageSeed(stages: unknown): Array<[string, string, boolean]> {
    const defaults: Array<[string, string, boolean]> = [
      ['New Lead', 'open', true], ['Contacted', 'open', false], ['Counselling', 'open', false],
      ['Negotiation', 'open', false], ['Enrolled', 'won', false], ['Lost', 'lost', false],
    ];
    if (!Array.isArray(stages) || stages.length === 0) return defaults;
    const seed: Array<[string, string, boolean]> = [];
    let defaultAt = -1;
    for (const raw of stages) {
      const s = (raw ?? {}) as { name?: unknown; stage_type?: unknown; is_default?: unknown };
      const name = String(s.name ?? '').trim();
      if (!name) continue;
      if (name.length > 60) throw new BadRequestException('a stage name must be 60 characters or fewer');
      const type = s.stage_type == null ? 'open' : String(s.stage_type);
      if (!['open', 'won', 'lost'].includes(type)) throw new BadRequestException('stage_type must be open|won|lost');
      if (s.is_default === true && defaultAt === -1) defaultAt = seed.length;
      seed.push([name, type, false]);
    }
    if (seed.length === 0) return defaults;
    if (seed.length > 40) throw new BadRequestException('a pipeline can carry at most 40 stages');
    seed[defaultAt === -1 ? 0 : defaultAt][2] = true;
    return seed;
  }

  async createPipeline(dto: { vertical_id: number; name: string; code: string; owner_user_id?: number | null; is_active?: boolean; stages?: unknown }, actorId: number) {
    if (!dto?.vertical_id || !dto?.name || !dto?.code) throw new BadRequestException('vertical_id, name and code are required');
    const v = await this.db.one<{ org_id: string; branch_id: string }>(
      `SELECT org_id, branch_id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [dto.vertical_id],
    );
    if (!v) throw new NotFoundException('vertical not found');
    const seed = HierarchyService.buildStageSeed(dto.stages);
    return this.db.tx(async (c) => {
      const p = await c.query(
        `INSERT INTO pipeline (org_id, branch_id, vertical_id, name, code, owner_user_id, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, TRUE),$8) RETURNING *`,
        [Number(v.org_id), Number(v.branch_id), dto.vertical_id, dto.name.trim(), dto.code.trim().toUpperCase(),
          dto.owner_user_id ?? null, dto.is_active ?? null, actorId],
      );
      let sort = 0;
      for (const [name, type, isDefault] of seed) {
        await c.query(
          `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.rows[0].id, name, sort++, type, isDefault, actorId],
        );
      }
      return p.rows[0];
    });
  }

  /**
   * UAT-R3 #22 — Branch and Vertical are EDITABLE on a pipeline. Re-parenting moves the
   * pipeline to a new Vertical; the Branch is DERIVED from that Vertical server-side (a
   * vertical belongs to exactly one branch), exactly as on create — so the denormalised
   * path can never go inconsistent. Because campaigns, sources and leads all carry the
   * pipeline's branch_id/vertical_id DENORMALISED, a re-parent re-denormalises every
   * descendant in the SAME transaction (chosen over blocking when descendants exist: the
   * client explicitly asked for editable Branch/Vertical, and a half-moved tree is the
   * worse outcome). pipeline_id itself never changes, so campaign/source/lead links hold.
   */
  async updatePipeline(id: number, dto: Record<string, unknown>, actorId?: number, scope?: ResolvedScope) {
    const reparent = dto.vertical_id !== undefined && dto.vertical_id !== null && String(dto.vertical_id) !== '';
    if (!reparent) {
      return this.genericUpdate('pipeline', id, dto, ['name', 'code', 'owner_user_id', 'is_active']);
    }
    const newVerticalId = Number(dto.vertical_id);
    const v = await this.db.one<{ org_id: string; branch_id: string }>(
      `SELECT org_id, branch_id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [newVerticalId]);
    if (!v) throw new NotFoundException('vertical not found');
    // the path is derived from the vertical; a mismatched branch_id in the body is rejected.
    if (dto.branch_id !== undefined && dto.branch_id !== null && String(dto.branch_id) !== ''
        && Number(dto.branch_id) !== Number(v.branch_id)) {
      throw new BadRequestException('vertical does not belong to the given branch');
    }
    const newBranchId = Number(v.branch_id);
    // RBAC: the caller cannot move a pipeline into a Vertical/Branch outside their scope.
    if (scope && actorId != null) {
      await this.enforcer.assertRefInScope(scope, 'vertical', newVerticalId, actorId);
    }
    return this.db.tx(async (c) => {
      const cur = await c.query<{ id: string }>(
        `SELECT id FROM pipeline WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!cur.rows.length) throw new NotFoundException('pipeline not found');
      const sets: string[] = ['branch_id = $1', 'vertical_id = $2'];
      const params: unknown[] = [newBranchId, newVerticalId];
      for (const col of ['name', 'code', 'owner_user_id', 'is_active'] as const) {
        if (dto[col] !== undefined) { params.push(dto[col]); sets.push(`${col} = $${params.length}`); }
      }
      params.push(id);
      const upd = await c.query(
        `UPDATE pipeline SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params);
      // re-denormalise the path on every descendant that carries branch_id/vertical_id.
      await c.query(`UPDATE campaign SET branch_id = $1, vertical_id = $2, updated_at = now() WHERE pipeline_id = $3 AND deleted_at IS NULL`, [newBranchId, newVerticalId, id]);
      await c.query(`UPDATE source   SET branch_id = $1, vertical_id = $2, updated_at = now() WHERE pipeline_id = $3 AND deleted_at IS NULL`, [newBranchId, newVerticalId, id]);
      await c.query(`UPDATE lead     SET branch_id = $1, vertical_id = $2, updated_at = now() WHERE pipeline_id = $3 AND deleted_at IS NULL`, [newBranchId, newVerticalId, id]);
      return upd.rows[0];
    });
  }

  /** ALL pipeline stages across the caller's in-scope, active pipelines (Leads STAGE filter).
   *  Each row carries pipeline_id + pipeline_name so the UI can filter options by Pipeline. */
  listAllStages(scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'p.branch_id', vertical: 'p.vertical_id', pipeline: 'p.id',
    }, params);
    return this.db.query(
      `SELECT st.id, st.name, st.pipeline_id, st.stage_type, st.sort_order, p.name AS pipeline_name
         FROM pipeline_stage st JOIN pipeline p ON p.id = st.pipeline_id
        WHERE ${where} AND p.deleted_at IS NULL AND p.is_active AND st.is_active IS NOT FALSE
        ORDER BY p.name, st.sort_order`, params);
  }

  listStages(pipelineId: number) {
    return this.db.query(
      `SELECT * FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY sort_order`, [pipelineId],
    );
  }

  /** Stage tags (configurator chips: Cold / Warm / Hot / free text).
   *  Trimmed, case-insensitively deduped, each <= 40 chars, max 20 per stage. */
  static normalizeTags(input: unknown): string[] {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestException('tags must be an array of strings');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of input) {
      if (typeof t !== 'string') throw new BadRequestException('tags must be an array of strings');
      const v = t.trim();
      if (!v) continue;
      if (v.length > 40) throw new BadRequestException('each tag must be 40 characters or fewer');
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    if (out.length > 20) throw new BadRequestException('a stage can carry at most 20 tags');
    return out;
  }

  /**
   * Create a stage. Stage-configurator insert-at-position: when `after_stage_id`
   * is present, the stage lands directly after that stage (`null` = head of the
   * flow) and every later stage is reindexed (+1) in the same transaction so
   * sort_order stays contiguous. Without it, behaviour is unchanged (append, or
   * an explicit `sort_order`).
   */
  async createStage(
    pipelineId: number,
    dto: { name: string; stage_type?: string; sort_order?: number; is_default?: boolean; tags?: unknown; after_stage_id?: number | null },
    actorId: number,
  ) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const type = dto.stage_type ?? 'open';
    if (!['open', 'won', 'lost'].includes(type)) throw new BadRequestException('stage_type must be open|won|lost');
    const tags = HierarchyService.normalizeTags(dto.tags);

    if (dto.after_stage_id !== undefined) {
      let newSort = 0;
      if (dto.after_stage_id !== null) {
        const after = await this.db.one<{ pipeline_id: string; sort_order: number }>(
          `SELECT pipeline_id, sort_order FROM pipeline_stage WHERE id = $1`, [dto.after_stage_id],
        );
        if (!after || Number(after.pipeline_id) !== Number(pipelineId)) {
          throw new BadRequestException('after_stage_id must reference a stage of the same pipeline');
        }
        newSort = Number(after.sort_order) + 1;
      }
      return this.db.tx(async (c) => {
        await c.query(
          `UPDATE pipeline_stage SET sort_order = sort_order + 1, updated_at = now()
            WHERE pipeline_id = $1 AND sort_order >= $2`, [pipelineId, newSort],
        );
        if (dto.is_default) {
          await c.query(
            `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default`,
            [pipelineId],
          );
        }
        const ins = await c.query(
          `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, tags, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [pipelineId, dto.name.trim(), newSort, type, dto.is_default ?? false, JSON.stringify(tags), actorId],
        );
        return ins.rows[0];
      });
    }

    if (dto.is_default) {
      await this.db.query(
        `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default`,
        [pipelineId],
      );
    }
    const rows = await this.db.query(
      `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, tags, created_by)
       VALUES ($1,$2,COALESCE($3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM pipeline_stage WHERE pipeline_id=$1)),$4,$5,$6,$7)
       RETURNING *`,
      [pipelineId, dto.name.trim(), dto.sort_order ?? null, type, dto.is_default ?? false, JSON.stringify(tags), actorId],
    );
    return rows[0];
  }

  async updateStage(id: number, dto: Record<string, unknown>) {
    if (dto.stage_type !== undefined && !['open', 'won', 'lost'].includes(String(dto.stage_type))) {
      throw new BadRequestException('stage_type must be open|won|lost');
    }
    if (dto.tags !== undefined) dto = { ...dto, tags: HierarchyService.normalizeTags(dto.tags) };
    if (dto.is_default === true) {
      // a pipeline keeps exactly one default landing stage
      const st = await this.db.one<{ pipeline_id: string }>(`SELECT pipeline_id FROM pipeline_stage WHERE id = $1`, [id]);
      if (!st) throw new NotFoundException('pipeline_stage not found');
      await this.db.query(
        `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default AND id <> $2`,
        [Number(st.pipeline_id), id],
      );
    }
    return this.genericUpdate('pipeline_stage', id, dto, ['name', 'sort_order', 'stage_type', 'is_default', 'tags', 'is_active']);
  }

  /**
   * Hard-delete a stage. Guard: any lead still referencing the stage blocks the
   * delete with 409 (rename/deactivate instead, or move the leads first).
   * Remaining stages are compacted so sort_order stays contiguous.
   */
  async deleteStage(id: number) {
    const st = await this.db.one<{ id: string; pipeline_id: string; name: string; sort_order: number }>(
      `SELECT id, pipeline_id, name, sort_order FROM pipeline_stage WHERE id = $1`, [id],
    );
    if (!st) throw new NotFoundException('pipeline_stage not found');
    const ref = await this.db.one<{ ct: number }>(`SELECT COUNT(*)::int AS ct FROM lead WHERE stage_id = $1`, [id]);
    if (ref && Number(ref.ct) > 0) {
      throw new ConflictException(
        `Cannot delete stage "${st.name}" — ${ref.ct} lead(s) are currently in it. ` +
        `Move those leads to another stage first, or mark the stage Inactive instead.`,
      );
    }
    return this.db.tx(async (c) => {
      await c.query(`DELETE FROM pipeline_stage WHERE id = $1`, [id]);
      await c.query(
        `UPDATE pipeline_stage SET sort_order = sort_order - 1, updated_at = now()
          WHERE pipeline_id = $1 AND sort_order > $2`, [Number(st.pipeline_id), st.sort_order],
      );
      return { deleted: true, id: Number(st.id), name: st.name };
    });
  }

  /** Reorder every stage of a pipeline (future drag). `order` must be a permutation of the pipeline's stage ids. */
  async reorderStages(pipelineId: number, order: unknown) {
    if (!Array.isArray(order) || order.length === 0 || order.some((x) => !Number.isFinite(Number(x)))) {
      throw new BadRequestException('order must be a non-empty array of stage ids');
    }
    const ids = order.map(Number);
    const existing = await this.db.query<{ id: string }>(`SELECT id FROM pipeline_stage WHERE pipeline_id = $1`, [pipelineId]);
    const have = existing.map((r) => Number(r.id)).sort((a, b) => a - b).join(',');
    const got = [...ids].sort((a, b) => a - b).join(',');
    if (!existing.length || have !== got) {
      throw new BadRequestException('order must contain every stage id of the pipeline exactly once');
    }
    return this.db.tx(async (c) => {
      for (let i = 0; i < ids.length; i++) {
        await c.query(`UPDATE pipeline_stage SET sort_order = $1, updated_at = now() WHERE id = $2`, [i, ids[i]]);
      }
      const rows = await c.query(`SELECT * FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY sort_order`, [pipelineId]);
      return rows.rows;
    });
  }

  // ---- campaigns ----------------------------------------------------------

  // UAT-R3 #19 — Campaign list filters follow Branch \u2192 Vertical \u2192 Pipeline (+ search, status).
  listCampaigns(scope: ResolvedScope, pipelineId?: number, includeInactive = false, branchId?: number, verticalId?: number, q?: string, opts?: HierIds) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'c.branch_id', vertical: 'c.vertical_id', pipeline: 'c.pipeline_id', campaign: 'c.id',
    }, params);
    let sql = `SELECT c.*, p.name AS pipeline_name, v.name AS vertical_name, b.name AS branch_name,
                 COALESCE((SELECT json_agg(cm.user_id ORDER BY cm.user_id)
                             FROM campaign_manager cm WHERE cm.campaign_id = c.id), '[]'::json) AS manager_user_ids,
                 COALESCE((SELECT json_agg(cap.user_id ORDER BY cap.user_id)
                             FROM campaign_agent_pause cap WHERE cap.campaign_id = c.id AND cap.paused), '[]'::json)
                   AS paused_agent_user_ids
                 FROM campaign c JOIN pipeline p ON p.id = c.pipeline_id
                 JOIN vertical v ON v.id = c.vertical_id JOIN branch b ON b.id = c.branch_id
                WHERE ${where} AND c.deleted_at IS NULL${HierarchyService.activeFilter('c', includeInactive)}`;
    { const c = this.inCol('c.branch_id', branchId, opts?.branchIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('c.vertical_id', verticalId, opts?.verticalIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('c.pipeline_id', pipelineId, opts?.pipelineIds, params); if (c) sql += ` AND ${c}`; }
    if (q && q.trim()) { params.push(`%${q.trim()}%`); sql += ` AND c.name ILIKE $${params.length}`; }
    return this.db.query(sql + ` ORDER BY c.name`, params);
  }

  async createCampaign(dto: {
    pipeline_id: number; name: string; utm?: object; cost?: number; priority?: string;
    distribution_config?: object; duplicacy_config?: object; is_active?: boolean;
    // DEF-S2-02 — rendered on the campaign modal since day one, stored since migration 024
    campaign_type?: string | null; marketing_channel?: string | null;
    start_date?: string | null; end_date?: string | null;
    // UAT-R2 #23 — campaign managers (management/visibility only, NOT the agent pool)
    manager_user_ids?: number[];
  }, actorId: number, scope: ResolvedScope) {
    if (!dto?.pipeline_id || !dto?.name) throw new BadRequestException('pipeline_id and name are required');
    // NeoDove configs are validated strictly on create AND update (QA DEF-2).
    // Omitted/null configs fall back to the documented defaults (COALESCE below).
    const dist = dto.distribution_config != null ? validateDistributionConfig(dto.distribution_config) : null;
    await this.assertDistributionUsers(dist, scope, actorId);
    const dup = dto.duplicacy_config != null ? validateDuplicacyConfig(dto.duplicacy_config) : null;
    const p = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string }>(
      `SELECT org_id, branch_id, vertical_id FROM pipeline WHERE id = $1 AND deleted_at IS NULL`, [dto.pipeline_id],
    );
    if (!p) throw new NotFoundException('pipeline not found');
    const rows = await this.db.query(
      `INSERT INTO campaign (org_id, branch_id, vertical_id, pipeline_id, name, utm, cost, priority,
                             distribution_config, duplicacy_config,
                             campaign_type, marketing_channel, start_date, end_date, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9, '{"mode":"on_demand","batch_size":10}'::jsonb),
               COALESCE($10, '{"check_scope":"this_campaign","match_key":"phone","on_duplicate":"ignore","open_reassign_same_user":true}'::jsonb),
               $11,$12,$13,$14,COALESCE($15, TRUE),$16)
       RETURNING *`,
      [Number(p.org_id), Number(p.branch_id), Number(p.vertical_id), dto.pipeline_id, dto.name.trim(),
        JSON.stringify(dto.utm ?? {}), dto.cost ?? 0, dto.priority ?? 'med',
        dist ? JSON.stringify(dist) : null,
        dup ? JSON.stringify(dup) : null,
        HierarchyService.text(dto.campaign_type), HierarchyService.text(dto.marketing_channel),
        HierarchyService.date(dto.start_date), HierarchyService.date(dto.end_date),
        dto.is_active ?? null, actorId],
    );
    const created = rows[0] as Record<string, unknown>;
    // #23 — managers are a SEPARATE set from the distribution agent pool; a manager
    // is never added to distribution_config, so a manager receives no auto-assigned leads.
    const managerIds = await this.replaceManagers(Number(created.id), dto.manager_user_ids, actorId, scope);
    return { ...created, manager_user_ids: managerIds, paused_agent_user_ids: [] };
  }

  async updateCampaign(id: number, dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    // Same strict NeoDove config validation as on create (QA DEF-2).
    if (dto.distribution_config !== undefined) {
      const dist = validateDistributionConfig(dto.distribution_config);
      await this.assertDistributionUsers(dist, scope, actorId);
      dto = { ...dto, distribution_config: dist };
      // Pool edits never break the round-robin rotation: the cursor is a
      // monotonically increasing counter and the pick applies `% pool.length`
      // at assignment time (leads.service), so shrinking/growing/reordering the
      // agent pool stays safe without touching campaign_distribution_state.
    }
    if (dto.duplicacy_config !== undefined) dto = { ...dto, duplicacy_config: validateDuplicacyConfig(dto.duplicacy_config) };
    // DEF-S2-02: the four form fields are PATCHable like every other stored field
    // ('' from an emptied date input -> NULL, never a 22P02).
    for (const k of ['campaign_type', 'marketing_channel'] as const) {
      if (dto[k] !== undefined) dto = { ...dto, [k]: HierarchyService.text(dto[k] as string | null) };
    }
    for (const k of ['start_date', 'end_date'] as const) {
      if (dto[k] !== undefined) dto = { ...dto, [k]: HierarchyService.date(dto[k] as string | null) };
    }
    // #23 — managers are applied separately (they are not a campaign column).
    const managerProvided = dto.manager_user_ids !== undefined;
    let managerIds: number[] | undefined;
    if (managerProvided) managerIds = await this.replaceManagers(id, dto.manager_user_ids as number[], actorId, scope);
    const COLS = ['name', 'utm', 'cost', 'priority', 'distribution_config', 'duplicacy_config',
      'campaign_type', 'marketing_channel', 'start_date', 'end_date', 'is_active'];
    if (!COLS.some((k) => dto[k] !== undefined)) {
      // only managers (or agent-pause) changed — nothing to UPDATE on the row itself.
      const row = await this.db.one<Record<string, unknown>>(
        `SELECT * FROM campaign WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!row) throw new NotFoundException('campaign not found');
      return managerProvided ? { ...row, manager_user_ids: managerIds } : row;
    }
    const updated = await this.genericUpdate('campaign', id, dto, COLS);
    return managerProvided ? { ...updated, manager_user_ids: managerIds } : updated;
  }

  /**
   * #23 — replace a campaign's manager set. Managers are validated exactly like
   * distribution agents (active, existing, in the caller's scope) but are stored
   * in `campaign_manager`, entirely separate from `distribution_config` — so a
   * manager is NEVER placed in the round-robin / conditional pool.
   */
  private async replaceManagers(
    campaignId: number, ids: number[] | undefined, actorId: number, scope: ResolvedScope,
  ): Promise<number[]> {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (list.length) {
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM "user" WHERE id = ANY($1::bigint[]) AND status = 'active' AND deleted_at IS NULL`, [list]);
      const ok = new Set(rows.map((r) => Number(r.id)));
      const bad = list.filter((id) => !ok.has(id));
      if (bad.length) {
        throw new BadRequestException(
          `manager_user_ids references unknown, inactive or deleted user id(s): ${bad.join(', ')}`);
      }
      for (const id of list) await this.enforcer.assertRefInScope(scope, 'user', id, actorId);
    }
    await this.db.query(`DELETE FROM campaign_manager WHERE campaign_id = $1`, [campaignId]);
    for (const uid of list) {
      await this.db.query(
        `INSERT INTO campaign_manager (campaign_id, user_id, created_by) VALUES ($1,$2,$3)
         ON CONFLICT (campaign_id, user_id) DO NOTHING`, [campaignId, uid, actorId]);
    }
    return list;
  }

  /**
   * #24 — pause/resume ONE agent on ONE campaign. A paused agent is skipped by the
   * distribution engine (LeadIngestionService.resolvePool) and resumes when set
   * back to active. Upserted so a repeated toggle never duplicates a row.
   */
  async setAgentPause(
    campaignId: number, userId: number, paused: boolean, actorId: number, scope: ResolvedScope,
  ) {
    await this.enforcer.assertRefInScope(scope, 'campaign', campaignId, actorId);
    const u = await this.db.one<{ id: string }>(
      `SELECT id FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    if (!u) throw new BadRequestException('unknown user');
    await this.db.query(
      `INSERT INTO campaign_agent_pause (campaign_id, user_id, paused, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (campaign_id, user_id)
       DO UPDATE SET paused = EXCLUDED.paused, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [campaignId, userId, !!paused, actorId]);
    return { campaign_id: campaignId, user_id: userId, paused: !!paused };
  }

  // ---- sources ------------------------------------------------------------

  listSources(scope: ResolvedScope, campaignId?: number, includeInactive = false, opts?: HierIds) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 's.branch_id', vertical: 's.vertical_id', pipeline: 's.pipeline_id', campaign: 's.campaign_id',
    }, params);
    let sql = `SELECT s.*, c.name AS campaign_name, ms.name AS master_source_name,
                      b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name
                 FROM source s LEFT JOIN campaign c ON c.id = s.campaign_id
                 LEFT JOIN m_source ms ON ms.id = s.master_source_id
                 LEFT JOIN branch b ON b.id = s.branch_id
                 LEFT JOIN vertical v ON v.id = s.vertical_id
                 LEFT JOIN pipeline p ON p.id = s.pipeline_id
                WHERE ${where} AND s.deleted_at IS NULL${HierarchyService.activeFilter('s', includeInactive)}`;
    { const c = this.inCol('s.branch_id', undefined, opts?.branchIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('s.vertical_id', undefined, opts?.verticalIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('s.pipeline_id', undefined, opts?.pipelineIds, params); if (c) sql += ` AND ${c}`; }
    { const c = this.inCol('s.campaign_id', campaignId, opts?.campaignIds, params); if (c) sql += ` AND ${c}`; }
    return this.db.query(sql + ` ORDER BY s.name`, params);
  }

  /**
   * 27aug Batch C item 1 — CAMPAIGN OPTIONAL + canonical source catalogue.
   * A Lead Source no longer requires a campaign: when `campaign_id` is omitted the source is
   * created ORG-LEVEL (no Branch/Vertical/Pipeline/Campaign path). When a campaign IS given the
   * full path is derived from it, exactly as before. Every source is backed by the ONE canonical
   * `m_source` catalogue (reconciliation, item 1b): if no `master_source_id` is supplied we
   * find-or-create the canonical row by name and link it, so the Masters "Sources" list and the
   * Lead Source Master can never diverge.
   */
  async createSource(dto: {
    campaign_id?: number | null; name: string; channel?: string; master_source_id?: number; config?: object;
    cost_per_lead?: number | string | null; is_active?: boolean;
  }, actorId: number) {
    if (!dto?.name || !String(dto.name).trim()) throw new BadRequestException('name is required');
    const hasCampaign = dto.campaign_id !== undefined && dto.campaign_id !== null && String(dto.campaign_id).trim() !== '';
    let orgId: number; let branchId: number | null = null; let verticalId: number | null = null;
    let pipelineId: number | null = null; let campaignId: number | null = null;
    if (hasCampaign) {
      const c = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string; pipeline_id: string }>(
        `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign WHERE id = $1 AND deleted_at IS NULL`, [Number(dto.campaign_id)],
      );
      if (!c) throw new NotFoundException('campaign not found');
      orgId = Number(c.org_id); branchId = Number(c.branch_id); verticalId = Number(c.vertical_id);
      pipelineId = Number(c.pipeline_id); campaignId = Number(dto.campaign_id);
    } else {
      const o = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
      if (!o) throw new NotFoundException('no organisation');
      orgId = Number(o.id);
    }
    const masterSourceId = await this.ensureMasterSource(orgId, dto.name.trim(), dto.master_source_id, actorId);
    const channel = dto.channel ?? 'manual';
    const webhookToken = ['meta', 'google', 'justdial', 'indiamart', 'form', 'webhook'].includes(channel)
      ? 'whk_' + Math.random().toString(36).slice(2, 18) : null;
    const rows = await this.db.query(
      `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, master_source_id,
                           name, channel, webhook_token, config, cost_per_lead, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, TRUE),$13) RETURNING *`,
      [orgId, branchId, verticalId, pipelineId, campaignId,
        masterSourceId, dto.name.trim(), channel, webhookToken,
        JSON.stringify(dto.config ?? {}), dto.cost_per_lead ?? 0, dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  /**
   * Canonical Source catalogue helper (reconciliation, item 1b). Returns a valid `m_source` id:
   * the supplied one when given, else a find-or-create by (case-insensitive) name so the two
   * "source" screens share ONE underlying catalogue table.
   */
  private async ensureMasterSource(orgId: number, name: string, providedId?: number | null, actorId?: number): Promise<number> {
    if (providedId !== undefined && providedId !== null && Number(providedId) > 0) return Number(providedId);
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM m_source WHERE org_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL ORDER BY id LIMIT 1`,
      [orgId, name]);
    if (existing) return Number(existing.id);
    const created = await this.db.one<{ id: string }>(
      `INSERT INTO m_source (org_id, name, is_active, meta, created_by) VALUES ($1,$2,TRUE,'{}'::jsonb,$3) RETURNING id`,
      [orgId, name, actorId ?? null]);
    return Number(created!.id);
  }

  /**
   * Update a source. A source's own scalar fields (name/channel/status/…) are patched
   * in place. **Re-parent (Aug 2026):** when the body carries a new `campaign_id`, the
   * source is MOVED under that campaign and its full denormalised path
   * (branch_id/vertical_id/pipeline_id/campaign_id + org_id) is RE-DERIVED from the target
   * campaign — the exact one-transaction re-denormalisation the pipeline re-parent and lead
   * transfer use, so no client can produce an inconsistent path.
   *
   * RBAC: the actor may only move a source they can see (`source` in scope — also enforced
   * by @ScopedEntity('source') on the route) INTO a campaign they can see (`campaign` in
   * scope). An out-of-scope target campaign is a 404, never a silent widen.
   *
   * Existing leads captured through this source KEEP their own captured path (a lead carries
   * its own denormalised Branch>…>Campaign, set at ingestion, and may since have moved stage,
   * owner or pipeline). Re-parenting the SOURCE affects the source record and FUTURE captures
   * only — it never retroactively re-paths already-distributed leads. (Moving a lead across
   * the hierarchy is a separate, explicit Lead Transfer with its own owner/stage/SLA handling.)
   */
  async updateSource(id: number, dto: Record<string, unknown>, scope?: ResolvedScope, actorId?: number) {
    const reparent = dto.campaign_id !== undefined && dto.campaign_id !== null && String(dto.campaign_id) !== '';
    if (!reparent) {
      // Keep the canonical m_source link in sync when the name changes (item 1b): a rename of a
      // Lead Source find-or-creates its canonical catalogue row so the two source screens agree.
      if (dto.name !== undefined && String(dto.name).trim() && (dto.master_source_id === undefined || dto.master_source_id === null)) {
        const row = await this.db.one<{ org_id: string }>(`SELECT org_id FROM source WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (row) dto.master_source_id = await this.ensureMasterSource(Number(row.org_id), String(dto.name).trim(), null, actorId);
      }
      return this.genericUpdate('source', id, dto,
        ['name', 'channel', 'master_source_id', 'config', 'cost_per_lead', 'is_active']);
    }
    const targetCampaignId = Number(dto.campaign_id);
    if (!Number.isInteger(targetCampaignId) || targetCampaignId <= 0) {
      throw new BadRequestException('campaign_id must reference a valid campaign');
    }
    // The source must exist and be in the actor's scope (route @ScopedEntity('source') also guards).
    const src = await this.db.one<{ id: string; campaign_id: string }>(
      `SELECT id, campaign_id FROM source WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!src) throw new NotFoundException('source not found');
    if (scope) await this.enforcer.assertRefInScope(scope, 'source', id, actorId);
    // The target campaign must exist and be in the actor's scope — else 404 (no cross-scope oracle).
    const camp = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string; pipeline_id: string }>(
      `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign WHERE id = $1 AND deleted_at IS NULL`,
      [targetCampaignId]);
    if (!camp) throw new NotFoundException('target campaign not found');
    if (scope) await this.enforcer.assertRefInScope(scope, 'campaign', targetCampaignId, actorId);

    // Re-derive the full path from the campaign, plus any other whitelisted scalar edits, in
    // ONE UPDATE so the source can never be left with a half-moved path.
    const sets: string[] = [
      'org_id = $1', 'branch_id = $2', 'vertical_id = $3', 'pipeline_id = $4', 'campaign_id = $5',
    ];
    const params: unknown[] = [
      Number(camp.org_id), Number(camp.branch_id), Number(camp.vertical_id), Number(camp.pipeline_id),
      targetCampaignId,
    ];
    for (const key of ['name', 'channel', 'master_source_id', 'config', 'cost_per_lead', 'is_active']) {
      if (dto[key] === undefined) continue;
      const val = typeof dto[key] === 'object' && dto[key] !== null ? JSON.stringify(dto[key]) : dto[key];
      params.push(val);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    const rows = await this.db.query(
      `UPDATE source SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params);
    if (!rows.length) throw new NotFoundException('source not found');
    return rows[0];
  }

  // ---- shared -------------------------------------------------------------

  private async genericUpdate(table: string, id: number, dto: Record<string, unknown>, allowed: string[]) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of allowed) {
      if (dto[key] === undefined) continue;
      const val = typeof dto[key] === 'object' && dto[key] !== null ? JSON.stringify(dto[key]) : dto[key];
      params.push(val);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const rows = await this.db.query(
      `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params,
    );
    if (!rows.length) throw new NotFoundException(`${table} not found`);
    return rows[0];
  }
}
