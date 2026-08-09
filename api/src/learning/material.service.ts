import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange } from '../common/date.util';

/**
 * STUDY MATERIAL — a per-batch / per-course / per-vertical library. A material targets ONE
 * access level (batch > course > vertical); a PUBLISHED item is visible to a student whose
 * batch / course / vertical matches. Staff manage it (scope-filtered like every module); a
 * student's read is the access query in `forStudent`, not a grant.
 */
export const MAT_SCOPE_COLS: ScopeColumnMap = { branch: 'm.branch_id', vertical: 'm.vertical_id', owner: 'm.created_by' };
const BATCH_SCOPE_COLS: ScopeColumnMap = { branch: 'bt.branch_id', vertical: 'bt.vertical_id' };
const TYPES = ['video', 'link', 'document', 'note'];
const LEVELS = ['batch', 'course', 'vertical'];

@Injectable()
export class MaterialService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private async batchInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, BATCH_SCOPE_COLS, params);
    const b = await this.db.one<any>(
      `SELECT bt.id, bt.name, bt.branch_id, bt.vertical_id, bt.course_id FROM batch bt
        WHERE bt.id = $1::bigint AND bt.deleted_at IS NULL AND ${w}`, params);
    if (!b) throw new NotFoundException('Batch not found (or outside your access)');
    return b;
  }

  /** Validate a branch+vertical are inside the caller's scope (for course/vertical-level items). */
  private async scopeInScope(branchId: number, verticalId: number, scope: ResolvedScope) {
    const params: unknown[] = [branchId, verticalId];
    const w = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, params);
    const v = await this.db.one<any>(
      `SELECT v.id, v.branch_id FROM vertical v
        WHERE v.id = $2::bigint AND v.branch_id = $1::bigint AND v.deleted_at IS NULL AND ${w}`, params);
    if (!v) throw new BadRequestException('Choose a branch and vertical within your access.');
    return v;
  }

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`m.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, MAT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return;
      params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('m.branch_id', f.branch_id);
    multi('m.vertical_id', f.vertical_id);
    multi('m.course_id', f.course_id);
    multi('m.batch_id', f.batch_id);
    if (TYPES.includes(String(f.material_type))) { params.push(f.material_type); where.push(`m.material_type = $${params.length}::varchar`); }
    if (['draft', 'published'].includes(String(f.visibility))) { params.push(f.visibility); where.push(`m.visibility = $${params.length}::varchar`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`m.created_at >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`m.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(m.title ILIKE $${params.length} OR m.tags ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT m.id, m.title, m.description, m.material_type, m.url, m.body, m.tags,
              m.access_level, m.visibility, m.allow_parents, m.created_at,
              m.branch_id, m.vertical_id, m.course_id, m.batch_id,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name,
              u.name AS created_by_name
         FROM study_material m
         LEFT JOIN branch b ON b.id = m.branch_id
         LEFT JOIN vertical v ON v.id = m.vertical_id
         LEFT JOIN m_course c ON c.id = m.course_id
         LEFT JOIN batch bt ON bt.id = m.batch_id
         LEFT JOIN "user" u ON u.id = m.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC
        LIMIT $${params.length}`, params);
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, MAT_SCOPE_COLS, params);
    const m = await this.db.one<any>(
      `SELECT m.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, bt.name AS batch_name
         FROM study_material m
         LEFT JOIN branch b ON b.id = m.branch_id
         LEFT JOIN vertical v ON v.id = m.vertical_id
         LEFT JOIN m_course c ON c.id = m.course_id
         LEFT JOIN batch bt ON bt.id = m.batch_id
        WHERE m.id = $1::bigint AND m.deleted_at IS NULL AND ${w}`, params);
    if (!m) throw new NotFoundException('Material not found (or outside your access)');
    return m;
  }

  /** What a given student may actually see (published + access match). Powers the parent view. */
  async forStudent(studentId: number, opts: { parentsOnly?: boolean } = {}) {
    const parentClause = opts.parentsOnly ? `AND m.allow_parents = TRUE` : '';
    return this.db.query<any>(
      `SELECT m.id, m.title, m.description, m.material_type, m.url, m.tags, m.access_level, m.created_at,
              c.name AS course_name, bt.name AS batch_name
         FROM study_material m
         JOIN student s ON s.id = $1::bigint AND s.deleted_at IS NULL
         LEFT JOIN m_course c ON c.id = m.course_id
         LEFT JOIN batch bt ON bt.id = m.batch_id
        WHERE m.deleted_at IS NULL AND m.visibility = 'published' ${parentClause}
          AND (
            (m.access_level = 'batch'    AND m.batch_id = s.batch_id)
            OR (m.access_level = 'course'   AND m.course_id = s.course_id)
            OR (m.access_level = 'vertical' AND m.vertical_id = s.vertical_id)
          )
        ORDER BY m.created_at DESC`, [studentId]);
  }

  private norm(dto: any) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the material a title.');
    const type = TYPES.includes(String(dto?.material_type)) ? String(dto.material_type) : 'link';
    if (type !== 'note' && !String(dto?.url ?? '').trim()) throw new BadRequestException('Add a link / file URL for this material.');
    if (type === 'note' && !String(dto?.body ?? '').trim()) throw new BadRequestException('A note needs some content.');
    return { title, type };
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const { title, type } = this.norm(dto);
    const level = LEVELS.includes(String(dto?.access_level)) ? String(dto.access_level) : 'batch';
    let branchId: number, verticalId: number, courseId: number | null = null, batchId: number | null = null;
    if (level === 'batch') {
      batchId = Number(dto?.batch_id);
      if (!batchId) throw new BadRequestException('Choose a batch for batch-level material.');
      const b = await this.batchInScope(batchId, scope);
      branchId = Number(b.branch_id); verticalId = Number(b.vertical_id); courseId = b.course_id ?? null;
    } else {
      branchId = Number(dto?.branch_id); verticalId = Number(dto?.vertical_id);
      if (!branchId || !verticalId) throw new BadRequestException('Choose a branch and vertical.');
      await this.scopeInScope(branchId, verticalId, scope);
      if (level === 'course') {
        courseId = Number(dto?.course_id);
        if (!courseId) throw new BadRequestException('Choose a course for course-level material.');
      }
    }
    const orgId = await this.orgId();
    const visibility = String(dto?.visibility) === 'published' ? 'published' : 'draft';
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO study_material (org_id, branch_id, vertical_id, course_id, batch_id, title, description,
                                   material_type, url, body, tags, access_level, visibility, allow_parents, created_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::bigint)
       RETURNING id`,
      [orgId, branchId, verticalId, courseId, batchId, title, dto?.description ?? null, type,
        dto?.url ?? null, type === 'note' ? (dto?.body ?? null) : null, dto?.tags ?? null,
        level, visibility, !!dto?.allow_parents, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.description !== undefined) set('description', dto.description ?? null);
    if (dto?.material_type !== undefined) { if (!TYPES.includes(String(dto.material_type))) throw new BadRequestException('Invalid material type.'); set('material_type', String(dto.material_type)); }
    if (dto?.url !== undefined) set('url', dto.url ?? null);
    if (dto?.body !== undefined) set('body', dto.body ?? null);
    if (dto?.tags !== undefined) set('tags', dto.tags ?? null);
    if (dto?.visibility !== undefined) { if (!['draft', 'published'].includes(String(dto.visibility))) throw new BadRequestException('Invalid visibility.'); set('visibility', String(dto.visibility)); }
    if (dto?.allow_parents !== undefined) set('allow_parents', !!dto.allow_parents);
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE study_material SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE study_material SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ---- bulk delete (client standard on every list) --------------------- */
  private ids(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, MAT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT m.id FROM study_material m WHERE m.id = ANY($1::bigint[]) AND m.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.ids(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'study_material', label: 'Study Material', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.ids(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.ids(raw).length - deleted };
  }
}
