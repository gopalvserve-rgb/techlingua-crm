import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

/**
 * QUESTION CATEGORY — the subject / topic taxonomy for the Question Bank (Assessment Batch A).
 *
 * A category is a subject (parent_id NULL) or a topic under a subject (parent_id set). It
 * carries the hierarchy/scope columns and is enforced through the central ScopeResolver, the
 * same way invoices/students are — never a bespoke scoping mechanism.
 */
export const QCAT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'qc.created_by', branch: 'qc.branch_id', vertical: 'qc.vertical_id',
};

@Injectable()
export class QuestionCategoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(scope: ResolvedScope, f: { branch_ids?: number[]; vertical_ids?: number[]; q?: string; active?: string } = {}) {
    const params: unknown[] = [];
    const where = [`qc.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, QCAT_SCOPE_COLS, params)];
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`qc.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`qc.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.active === '1' || f.active === '0') { params.push(f.active === '1'); where.push(`qc.active = $${params.length}::boolean`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(qc.name ILIKE $${params.length} OR qc.code ILIKE $${params.length})`); }
    return this.db.query<any>(
      `SELECT qc.id, qc.name, qc.code, qc.description, qc.parent_id, qc.branch_id, qc.vertical_id, qc.active, qc.created_at,
              p.name AS parent_name, b.name AS branch_name, v.name AS vertical_name,
              (SELECT count(*) FROM question q WHERE q.category_id = qc.id AND q.deleted_at IS NULL) AS question_count
         FROM question_category qc
         LEFT JOIN question_category p ON p.id = qc.parent_id
         LEFT JOIN branch b ON b.id = qc.branch_id
         LEFT JOIN vertical v ON v.id = qc.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(p.name, qc.name), qc.name`,
      params,
    );
  }

  private async getScoped(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, QCAT_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT qc.* FROM question_category qc WHERE qc.id = $1::bigint AND qc.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Category not found (or outside your access)');
    return r;
  }

  async create(dto: any, me: { id: number }, _scope: ResolvedScope) {
    const org = await this.orgId();
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('A category name is required.');
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO question_category (org_id, branch_id, vertical_id, parent_id, name, code, description, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [org, dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null,
        dto?.parent_id ? Number(dto.parent_id) : null, name.slice(0, 160),
        dto?.code ? String(dto.code).trim().slice(0, 40) : null, dto?.description ?? null,
        dto?.active === false ? false : true, me.id]);
    return { id: Number(r!.id) };
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    await this.getScoped(id, scope);
    if (dto?.parent_id && Number(dto.parent_id) === id) throw new BadRequestException('A category cannot be its own parent.');
    await this.db.query(
      `UPDATE question_category SET
         branch_id = $2, vertical_id = $3, parent_id = $4,
         name = COALESCE($5, name), code = $6, description = $7,
         active = COALESCE($8, active), updated_at = now()
       WHERE id = $1::bigint`,
      [id, dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null,
        dto?.parent_id ? Number(dto.parent_id) : null,
        dto?.name != null ? String(dto.name).trim().slice(0, 160) : null,
        dto?.code ? String(dto.code).trim().slice(0, 40) : null, dto?.description ?? null,
        typeof dto?.active === 'boolean' ? dto.active : null]);
    return { id, ok: true };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.getScoped(id, scope);
    await this.db.query(`UPDATE question_category SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { entity: 'question_category', label: 'Category', requested: 0, in_scope: 0, out_of_scope: 0, total_associations: 0, impact: [] };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, QCAT_SCOPE_COLS, params);
    const inScope = await this.db.query<{ id: string }>(
      `SELECT qc.id FROM question_category qc WHERE qc.id = ANY($1::bigint[]) AND qc.deleted_at IS NULL AND ${w}`, params);
    const inIds = inScope.map((r) => Number(r.id));
    const qc = inIds.length
      ? await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM question WHERE category_id = ANY($1::bigint[]) AND deleted_at IS NULL`, [inIds])
      : { n: '0' };
    const questions = Number(qc?.n ?? 0);
    return {
      entity: 'question_category', label: 'Category', requested: clean.length,
      in_scope: inIds.length, out_of_scope: clean.length - inIds.length,
      total_associations: questions,
      impact: questions ? [{ key: 'questions', label: 'Questions (kept, category cleared)', count: questions }] : [],
    };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deleted: 0, skipped: 0 };
    const params: unknown[] = [clean, me.id];
    const w = this.resolver.buildScopeWhere(scope, QCAT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE question_category qc SET deleted_at = now(), deleted_by = $2::bigint
        WHERE qc.id = ANY($1::bigint[]) AND qc.deleted_at IS NULL AND ${w} RETURNING qc.id`, params);
    return { deleted: rows.length, skipped: clean.length - rows.length };
  }
}
