import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';
import { ContentApprovalWorkflowService } from '../governance/content-approval.service';

/**
 * COURSE CONTENT — structured lessons / units under a course (Academics Governance Batch 2).
 * Governed by the shared ContentApprovalWorkflowService: draft -> pending_approval (trainer
 * submit) -> published (admin approve); reject -> changes_requested (remarks); unpublish. The
 * `workflow_status` column is a MIRROR kept in sync with the content_approval ledger, exactly
 * like assessment. Non-approvers (trainers/students) only ever list PUBLISHED items for their
 * scope; approvers (Academic Admin / Super Admin) see every status so they can review.
 * Scope-enforced through the central ScopeResolver. Files live in Cloudflare R2 (r2_key only).
 */
export const CC_SCOPE_COLS: ScopeColumnMap = { branch: 'cc.branch_id', vertical: 'cc.vertical_id', owner: 'cc.created_by' };
const ENTITY = 'course_content';

interface Me { id: number; name?: string }

@Injectable()
export class CourseContentService {
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

  /** Does the caller hold course_content.approve (i.e. an Academic Admin / Super Admin)? */
  async canApprove(userId: number): Promise<boolean> {
    if (!userId) return false;
    const grants = await this.rbacData.loadUserGrants(userId);
    return this.resolver.resolve(grants, `${ENTITY}.approve`).allowed;
  }

  /** Validate the chosen course is within the caller's scope; return its branch/vertical. */
  private async courseInScope(courseId: number, scope: ResolvedScope) {
    const params: unknown[] = [courseId];
    const w = this.resolver.buildScopeWhere(scope, { branch: 'c.branch_id', vertical: 'c.vertical_id' }, params);
    const c = await this.db.one<any>(
      `SELECT c.id, c.branch_id, c.vertical_id FROM m_course c
        WHERE c.id = $1::bigint AND c.deleted_at IS NULL AND ${w}`, params);
    if (!c) throw new BadRequestException('Choose a course within your access.');
    if (!c.branch_id || !c.vertical_id) throw new BadRequestException('That course is missing a branch/vertical.');
    return c;
  }

  private tags(raw: unknown): string[] | null {
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = arr.map((t) => String(t).trim()).filter(Boolean);
    return out.length ? out : null;
  }

  async list(scope: ResolvedScope, me: Me, f: any = {}) {
    const params: unknown[] = [];
    const where = [`cc.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, CC_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('cc.course_id', f.course_id); multi('cc.batch_id', f.batch_id);
    multi('cc.branch_id', f.branch_id); multi('cc.vertical_id', f.vertical_id);
    const canApprove = await this.canApprove(me?.id);
    if (!canApprove) {
      where.push(`cc.workflow_status = 'published'`);
    } else if (f.status && ['draft', 'pending_approval', 'published', 'changes_requested', 'unpublished'].includes(String(f.status))) {
      params.push(String(f.status)); where.push(`cc.workflow_status = $${params.length}::varchar`);
    }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(cc.title ILIKE $${params.length} OR cc.description ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT cc.id, cc.title, cc.module_no, cc.description, cc.file_r2_key, cc.external_url, cc.tags,
              cc.workflow_status, cc.review_remarks, cc.course_id, cc.batch_id, cc.branch_id, cc.vertical_id,
              cc.created_at, cc.created_by,
              c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS created_by_name
         FROM course_content cc
         LEFT JOIN m_course c ON c.id = cc.course_id
         LEFT JOIN batch bt ON bt.id = cc.batch_id
         LEFT JOIN branch b ON b.id = cc.branch_id
         LEFT JOIN vertical v ON v.id = cc.vertical_id
         LEFT JOIN "user" u ON u.id = cc.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY cc.course_id, cc.module_no, cc.id
        LIMIT $${params.length}`, params);
  }

  private async getRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, CC_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT cc.*, c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name
         FROM course_content cc
         LEFT JOIN m_course c ON c.id = cc.course_id
         LEFT JOIN batch bt ON bt.id = cc.batch_id
         LEFT JOIN branch b ON b.id = cc.branch_id
         LEFT JOIN vertical v ON v.id = cc.vertical_id
        WHERE cc.id = $1::bigint AND cc.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Course content not found (or outside your access)');
    return r;
  }

  async get(id: number, scope: ResolvedScope, me: Me) {
    const r = await this.getRow(id, scope);
    // Non-approvers may only open a published item.
    if (r.workflow_status !== 'published' && !(await this.canApprove(me?.id))) {
      throw new NotFoundException('Course content not found (or outside your access)');
    }
    let file_url: string | null = null;
    if (r.file_r2_key) { try { file_url = await this.storage.presignGet(String(r.file_r2_key), 600); } catch { file_url = null; } }
    return { ...r, file_url };
  }

  async create(dto: any, me: Me, scope: ResolvedScope) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the content a title.');
    const courseId = Number(dto?.course_id);
    if (!courseId) throw new BadRequestException('Choose a course.');
    const c = await this.courseInScope(courseId, scope);
    const batchId = dto?.batch_id ? Number(dto.batch_id) : null;
    const org = await this.orgId();
    const moduleNo = Number.isFinite(Number(dto?.module_no)) ? Number(dto.module_no) : 1;
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO course_content (org_id, branch_id, vertical_id, course_id, batch_id, title, module_no,
          description, file_r2_key, external_url, tags, workflow_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12)
       RETURNING id`,
      [org, c.branch_id, c.vertical_id, courseId, batchId, title, moduleNo,
        dto?.description ?? null, dto?.file_r2_key ?? null, dto?.external_url ?? null, this.tags(dto?.tags), me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any, _me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.module_no !== undefined) set('module_no', Number.isFinite(Number(dto.module_no)) ? Number(dto.module_no) : 1);
    if (dto?.description !== undefined) set('description', dto.description ?? null);
    if (dto?.file_r2_key !== undefined) set('file_r2_key', dto.file_r2_key ?? null);
    if (dto?.external_url !== undefined) set('external_url', dto.external_url ?? null);
    if (dto?.tags !== undefined) set('tags', this.tags(dto.tags));
    if (dto?.batch_id !== undefined) set('batch_id', dto.batch_id ? Number(dto.batch_id) : null);
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE course_content SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.db.query(`UPDATE course_content SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, CC_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT cc.id FROM course_content cc WHERE cc.id = ANY($1::bigint[]) AND cc.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: ENTITY, label: 'Course Content', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: Me, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    for (const id of ok) await this.db.query(`UPDATE course_content SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { deleted: ok.length, skipped: this.idList(raw).length - ok.length };
  }

  /* ------------------------------------------------------------- governance */
  async submit(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.submit(ENTITY, id, me);
    await this.db.query(`UPDATE course_content SET workflow_status='pending_approval', submitted_by=$2, submitted_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`, [id, me.id]);
    return { id, workflow_status: 'pending_approval' };
  }
  async approve(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.approve(ENTITY, id, me);
    await this.db.query(`UPDATE course_content SET workflow_status='published', published_by=$2, published_at=now(), reviewed_by=$2, reviewed_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`, [id, me.id]);
    return { id, workflow_status: 'published' };
  }
  async reject(id: number, remarks: string, me: Me, scope: ResolvedScope) {
    if (!remarks || !String(remarks).trim()) throw new BadRequestException('Remarks are required when sending content back.');
    await this.getRow(id, scope);
    await this.workflow.reject(ENTITY, id, me, remarks);
    await this.db.query(`UPDATE course_content SET workflow_status='changes_requested', reviewed_by=$2, reviewed_at=now(), review_remarks=$3, updated_at=now() WHERE id=$1::bigint`, [id, me.id, String(remarks)]);
    return { id, workflow_status: 'changes_requested', review_remarks: String(remarks) };
  }
  async unpublish(id: number, me: Me, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.workflow.unpublish(ENTITY, id, me);
    await this.db.query(`UPDATE course_content SET workflow_status='unpublished', updated_at=now() WHERE id=$1::bigint`, [id]);
    return { id, workflow_status: 'unpublished' };
  }

  /** Presigned PUT so the browser uploads a lesson file straight to R2. */
  async uploadUrl(dto: { file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'file');
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.materialKey('course-content', fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }
}
