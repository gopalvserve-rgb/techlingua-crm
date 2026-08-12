import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { Band, resolveBand, validateBands } from './grade';

/**
 * GRADE SCHEMES — Assessment Batch D.
 *
 * A configurable set of grading bands (India default seeded in migration 066). Admin edits the
 * bands; the module validates they are contiguous over 0..100 with at least one pass band. A test
 * MAY pin a scheme (assessment.grade_scheme_id); otherwise the org DEFAULT scheme is used to turn
 * a percentage into a grade. Scope-enforced via the central ScopeResolver like every other entity.
 */
export const GRADE_SCHEME_SCOPE_COLS: ScopeColumnMap = { branch: 'gs.branch_id', vertical: 'gs.vertical_id', owner: 'gs.created_by' };

export interface ResolvedGrade { grade_label: string | null; is_pass: boolean | null; scheme_id: number | null; scheme_name: string | null }

@Injectable()
export class GradeSchemeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async bandsOf(schemeId: number): Promise<Band[]> {
    const rows = await this.db.query<any>(
      `SELECT label, min_pct, max_pct, is_pass, ordering FROM grade_band WHERE scheme_id = $1::bigint ORDER BY ordering, min_pct`, [schemeId]);
    return rows.map((b) => ({ label: b.label, min_pct: Number(b.min_pct), max_pct: Number(b.max_pct), is_pass: b.is_pass, ordering: Number(b.ordering) }));
  }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`gs.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, GRADE_SCHEME_SCOPE_COLS, params)];
    if (f.q) { params.push(`%${f.q}%`); where.push(`gs.name ILIKE $${params.length}`); }
    if (String(f.active) === '1') where.push(`gs.active`);
    const rows = await this.db.query<any>(
      `SELECT gs.id, gs.name, gs.is_default, gs.active, gs.branch_id, gs.vertical_id, gs.created_at,
              b.name AS branch_name, v.name AS vertical_name,
              (SELECT count(*) FROM grade_band gb WHERE gb.scheme_id = gs.id) AS band_count
         FROM grade_scheme gs
         LEFT JOIN branch b ON b.id = gs.branch_id
         LEFT JOIN vertical v ON v.id = gs.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY gs.is_default DESC, gs.name`, params);
    return rows.map((r) => ({ ...r, band_count: Number(r.band_count) }));
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, GRADE_SCHEME_SCOPE_COLS, params);
    const gs = await this.db.one<any>(
      `SELECT gs.*, b.name AS branch_name, v.name AS vertical_name
         FROM grade_scheme gs
         LEFT JOIN branch b ON b.id = gs.branch_id
         LEFT JOIN vertical v ON v.id = gs.vertical_id
        WHERE gs.id = $1::bigint AND gs.deleted_at IS NULL AND ${w}`, params);
    if (!gs) throw new NotFoundException('Grade scheme not found (or outside your access)');
    return { ...gs, bands: await this.bandsOf(id) };
  }

  private async writeBands(c: PoolClient, schemeId: number, bands: Band[]) {
    await c.query(`DELETE FROM grade_band WHERE scheme_id = $1::bigint`, [schemeId]);
    for (const b of bands) {
      await c.query(
        `INSERT INTO grade_band (scheme_id, label, min_pct, max_pct, is_pass, ordering)
         VALUES ($1::bigint,$2,$3,$4,$5,$6)`,
        [schemeId, b.label, b.min_pct, b.max_pct, b.is_pass, b.ordering ?? 1]);
    }
  }

  async create(dto: any, me: { id: number }, _scope: ResolvedScope) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the grade scheme a name.');
    const v = validateBands(Array.isArray(dto?.bands) ? dto.bands : []);
    if (!v.ok) throw new BadRequestException(v.message);
    const org = await this.orgId();
    const id = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO grade_scheme (org_id, branch_id, vertical_id, name, is_default, active, created_by)
         VALUES ($1,$2,$3,$4,false,$5,$6) RETURNING id`,
        [org, dto?.branch_id ?? null, dto?.vertical_id ?? null, name, dto?.active === false ? false : true, me.id]);
      const sid = Number(r.rows[0].id);
      await this.writeBands(c, sid, v.bands);
      return sid;
    });
    return { id };
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const name = dto?.name != null ? String(dto.name).trim() : null;
    if (name === '') throw new BadRequestException('Give the grade scheme a name.');
    let bands: Band[] | null = null;
    if (Array.isArray(dto?.bands)) {
      const v = validateBands(dto.bands);
      if (!v.ok) throw new BadRequestException(v.message);
      bands = v.bands;
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE grade_scheme SET name = COALESCE($2, name), active = COALESCE($3, active), updated_at = now()
          WHERE id = $1::bigint`,
        [id, name, dto?.active === undefined ? null : !!dto.active]);
      if (bands) await this.writeBands(c, id, bands);
    });
    return { id };
  }

  async setDefault(id: number, scope: ResolvedScope) {
    const gs = await this.get(id, scope);
    const org = await this.orgId();
    await this.db.tx(async (c) => {
      await c.query(`UPDATE grade_scheme SET is_default = false, updated_at = now() WHERE org_id = $1::bigint AND is_default`, [org]);
      await c.query(`UPDATE grade_scheme SET is_default = true, active = true, updated_at = now() WHERE id = $1::bigint`, [id]);
    });
    return { id, is_default: true, name: gs.name };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const gs = await this.get(id, scope);
    if (gs.is_default) throw new BadRequestException('The default grade scheme cannot be deleted — make another scheme the default first.');
    await this.db.query(`UPDATE grade_scheme SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ---------------------------------------------------------------- resolution */

  /** The effective scheme for an assessment: its pinned scheme, else the org default. */
  async effectiveScheme(schemeId: number | null | undefined): Promise<{ id: number; name: string; bands: Band[] } | null> {
    const org = await this.orgId();
    let row: any = null;
    if (schemeId) {
      row = await this.db.one<any>(`SELECT id, name FROM grade_scheme WHERE id = $1::bigint AND deleted_at IS NULL`, [schemeId]);
    }
    if (!row) {
      row = await this.db.one<any>(`SELECT id, name FROM grade_scheme WHERE org_id = $1::bigint AND is_default AND deleted_at IS NULL ORDER BY id LIMIT 1`, [org]);
    }
    if (!row) return null;
    return { id: Number(row.id), name: row.name, bands: await this.bandsOf(Number(row.id)) };
  }

  /** Turn a percentage into a grade using an assessment's (or the default) scheme. */
  async gradeFor(pct: number | null, schemeId: number | null | undefined): Promise<ResolvedGrade> {
    if (pct == null) return { grade_label: null, is_pass: null, scheme_id: null, scheme_name: null };
    const sch = await this.effectiveScheme(schemeId);
    if (!sch) return { grade_label: null, is_pass: null, scheme_id: null, scheme_name: null };
    const band = resolveBand(sch.bands, Number(pct));
    return { grade_label: band?.label ?? null, is_pass: band ? !!band.is_pass : null, scheme_id: sch.id, scheme_name: sch.name };
  }
}
