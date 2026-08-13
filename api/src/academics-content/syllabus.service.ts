import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';
import { ContentApprovalWorkflowService } from '../governance/content-approval.service';

/**
 * SYLLABUS — a versioned syllabus outline under a course (Academics Governance Batch 2).
 * Same governance model as course_content: draft -> pending_approval -> published; reject ->
 * changes_requested; unpublish. `workflow_status` mirrors the content_approval ledger.
 * Non-approvers list PUBLISHED only; approvers see all. Files -> Cloudflare R2 (r2_key only).
 */
export const SY_SCOPE_COLS: ScopeColumnMap = { branch: 'sy.branch_id', vertical: 'sy.vertical_id', owner: 'sy.created_by' };
const ENTITY = 'syllabus';

interface Me { id: number; name?: string }

@Injectable()
export class SyllabusService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly rbacData: RbacDataService,
    private readonly storage: StorageService,
    private readonly workflow: ContentApprovalWorkflowService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async canApprove(userId: number): Promise<boolean> {
    if (!userId) return false;
    const grants = await this.rbacData.loadUserGrants(userId);
    return this.resolver.resolve(grants, `${ENTITY}.approve`).allowed;
  }

  private async scopeInScope(branchId: number, verticalId: number, courseId: number, scope: ResolvedScope) {
    const p: unknown[] = [branchId, verticalId];
    const w = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, p);
    const v = await this.db.one<any>(
      `SELECT v.id, v.branch_id FROM vertical v
        WHERE v.id = $2::bigint AND v.branch_id = $1::bigint AND v.deleted_at IS NULL AND ${w}`, p);
    if (!v) throw new BadRequestException('Choose a branch and vertical within your access.');
    const c = await this.db.one<any>(`SELECT id FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
    if (!c) throw new BadRequestException('Choose a valid course.');
    return { branch_id: branchId, vertical_id: verticalId, id: courseId };
  }

  private tags(raw: unknown): string[] | null {
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = arr.map((t) => String(t).trim()).filter(Boolean);
    return out.length ? out : null;
  }

  async list(scope: ResolvedScope, me: Me, f: any = {}) {
    const params: unknown[] = [];
    const where = [`sy.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, SY_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('sy.course_id', f.course_id); multi('sy.batch_id', f.batch_id);
    multi('sy.branch_id', f.branch_id); multi('sy.vertical_id', f.vertical_id);
    const canApprove = await this.canApprove(me?.id);
    if (!canApprove) {
      // Non-approvers see PUBLISHED items PLUS their OWN non-published items (draft/pending_approval/
      // changes_requested) so a creator can find, reopen and resubmit their own work. Scope untouched.
      params.push(me?.id ?? 0); where.push(`(sy.workflow_status = 'published' OR sy.created_by = $${params.length}::bigint)`);
    }
    if (f.status && ['draft', 'pending_approval', 'published', 'changes_requested', 'unpublished'].includes(String(f.status))) {
      params.push(String(f.status)); where.push(`sy.workflow_status = $${params.length}::varchar`);
    }
    if (f.mine === '1' || f.mine === 1 || f.mine === true || String(f.mine) === 'true') {
      params.push(me?.id ?? 0); where.push(`sy.created_by = $${params.length}::bigint`);
    }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(sy.title ILIKE $${params.length} OR sy.body ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT sy.id, sy.title, sy.version, sy.body, sy.file_r2_key, sy.external_url, sy.tags,
              sy.workflow_status, sy.review_remarks, sy.course_id, sy.batch_id, sy.branch_id, sy.vertical_id,
              sy.created_at, sy.created_by,
              c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS created_by_name
         FROM syllabus sy
         LEFT JOIN m_course c ON c.id = sy.course_id
         LEFT JOIN batch bt ON bt.id = sy.batch_id
         LEFT JOIN branch b ON b.id = sy.branch_id
         LEFT JOIN vertical v ON v.id = sy.vertical_id
         LEFT JOIN "user" u ON u.id = sy.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY sy.course_id, sy.created_at DESC, sy.id
        LIMIT $${params.length}`, params);
  }

  private async getRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, SY_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT sy.*, c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name
         FROM syllabus sy
         LEFT JOIN m_course c ON c.id = sy.course_id
         LEFT JOIN batch bt ON bt.id = sy.batch_id
         LEFT JOIN branch b ON b.id = sy.branch_id
         LEFT JOIN vertical v ON v.id = sy.vertical_id
        WHERE sy.id = $1::bigint AND sy.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Syllabus not found (or outside your access)');
    return r;
  }

  async get(id: number, scope: ResolvedScope, me: Me) {
    const r = await this.getRow(id, scope);
    if (r.workflow_status !== 'published' && Number(r.created_by) !== Number(me?.id) && !(await this.canApprove(me?.id))) {
      throw new NotFoundException('Syllabus not found (or outside your access)');
    }
    let file_url: string | null = null;
    if (r.file_r2_key) { try { file_url = await this.storage.presignGet(String(r.file_r2_key), 600); } catch { file_url = null; } }
    return { ...r, file_url };
  }

  async create(dto: any, me: Me, scope: ResolvedScope) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the syllabus a title.');
    const courseId = Number(dto?.course_id);
    const branchIdIn = Number(dto?.branch_id);
    const verticalIdIn = Number(dto?.vertical_id);
    if (!courseId) throw new BadRequestException('Choose a course.');
    if (!branchIdIn || !verticalIdIn) throw new BadRequestException('Choose a branch and vertical.');
    const c = await this.scopeInScope(branchIdIn, verticalIdIn, courseId, scope);
    const batchId = dto?.batch_id ? Number(dto.batch_id) : null;
    const org = await this.orgId();
    const version = String(dto?.version ?? 'v1').trim() || 'v1';
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO syllabus (org_id, branch_id, vertical_id, course_id, batch_id, title, version, body,
          file_r2_key, external_url, tags, workflow_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12)
       RETURNING id`,
      [org, c.branch_id, c.vertical_id, courseId, batchId, title, version,
        dto?.body ?? null, dto?.file_r2_key ?? null, dto?.external_url ?? null, this.tags(dto?.tags), me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, _me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.version !== undefined) set('version', String(dto.version ?? 'v1').trim() || 'v1');
    if (dto?.body !== undefined) set('body', dto.body ?? null);
    if (dto?.file_r2_key !== undefined) set('file_r2_key', dto.file_r2_key ?? null);
    if (dto?.external_url !== undefined) set('external_url', dto.external_url ?? null);
    if (dto?.tags !== undefined) set('tags', this.tags(dto.tags));
    if (dto?.batch_id !== undefined) set('batch_id', dto.batch_id ? Number(dto.batch_id) : null);
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE syllabus SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.db.query(`UPDATE syllabus SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, SY_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT sy.id FROM syllabus sy WHERE sy.id = ANY($1::bigint[]) AND sy.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: ENTITY, label: 'Syllabus', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: Me, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    for (const id of ok) await this.db.query(`UPDATE syllabus SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { deleted: ok.length, skipped: this.idList(raw).length - ok.length };
  }

  /* ------------------------------------------------------------- governance */
  async submit(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.submit(ENTITY, id, me);
    await this.db.query(`UPDATE syllabus SET workflow_status='pending_approval', submitted_by=$2, submitted_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`, [id, me.id]);
    return { id, workflow_status: 'pending_approval' };
  }
  async approve(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.approve(ENTITY, id, me);
    await this.db.query(`UPDATE syllabus SET workflow_status='published', published_by=$2, published_at=now(), reviewed_by=$2, reviewed_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`, [id, me.id]);
    return { id, workflow_status: 'published' };
  }
  async reject(id: number, remarks: string, me: Me, scope: ResolvedScope) {
    if (!remarks || !String(remarks).trim()) throw new BadRequestException('Remarks are required when sending content back.');
    await this.getRow(id, scope);
    await this.workflow.reject(ENTITY, id, me, remarks);
    await this.db.query(`UPDATE syllabus SET workflow_status='changes_requested', reviewed_by=$2, reviewed_at=now(), review_remarks=$3, updated_at=now() WHERE id=$1::bigint`, [id, me.id, String(remarks)]);
    return { id, workflow_status: 'changes_requested', review_remarks: String(remarks) };
  }
  async unpublish(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.unpublish(ENTITY, id, me);
    await this.db.query(`UPDATE syllabus SET workflow_status='unpublished', updated_at=now() WHERE id=$1::bigint`, [id]);
    return { id, workflow_status: 'unpublished' };
  }

  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'file');
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.materialKey('syllabus', fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }
}
