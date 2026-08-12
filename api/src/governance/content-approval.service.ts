import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * CONTENT-APPROVAL WORKFLOW — the ONE reusable mechanism the academics-governance model runs
 * on (docs/dev/67). A single ledger table `content_approval` keyed by (entity_type, entity_id)
 * holds the workflow_status + review metadata for EVERY governed entity — assessments now,
 * study material / course content / syllabus in Batch 2 — so it is one code path, not
 * per-module bespoke logic. Transition history reuses the existing `audit_log`.
 *
 * Lifecycle:  draft -> pending_approval (`.submit`) -> published (`.approve`/publish)
 *             pending_approval -> changes_requested (`.reject`, with remarks) -> back to draft
 *             published -> unpublished (`.unpublish`)
 *
 * PERMISSIONS ARE ENFORCED BY THE CALLING CONTROLLER via @RequirePermission (the existing guard
 * pattern): `${module}.submit` to submit, `${module}.approve`/`.publish` to approve/reject/
 * unpublish. This service is intentionally permission-agnostic; it only enforces that the
 * source->target transition is legal, so a trainer who reaches `approve` without the permission
 * is already 403'd before ever getting here.
 *
 * Batch 2 REUSES this by calling submit()/approve()/reject()/unpublish() with its own
 * entity_type; entities whose status lives natively (like assessment) call record() directly
 * after mutating their own status column, keeping the ledger a uniform, queryable mirror.
 */
export type WorkflowStatus =
  | 'draft' | 'pending_approval' | 'published' | 'changes_requested' | 'unpublished';

export interface Actor { id: number; name?: string }

const AUDIT_ACTION: Record<WorkflowStatus, string> = {
  draft: 'workflow_draft',
  pending_approval: 'workflow_submit',
  published: 'workflow_approve',
  changes_requested: 'workflow_reject',
  unpublished: 'workflow_unpublish',
};

@Injectable()
export class ContentApprovalWorkflowService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id);
  }

  /** Current ledger row for an entity, or null if it has never entered the workflow. */
  async getStatus(entityType: string, entityId: number) {
    return this.db.one<any>(
      `SELECT * FROM content_approval WHERE entity_type = $1 AND entity_id = $2::bigint`,
      [entityType, entityId],
    );
  }

  /** Bulk lookup for list rendering: { [entityId]: workflow_status }. */
  async getStatuses(entityType: string, ids: number[]): Promise<Record<number, string>> {
    const clean = [...new Set((ids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return {};
    const rows = await this.db.query<{ entity_id: string; workflow_status: string }>(
      `SELECT entity_id, workflow_status FROM content_approval
        WHERE entity_type = $1 AND entity_id = ANY($2::bigint[])`,
      [entityType, clean],
    );
    const out: Record<number, string> = {};
    for (const r of rows) out[Number(r.entity_id)] = r.workflow_status;
    return out;
  }

  /**
   * Upsert the ledger to `target`, stamping the right review-metadata columns and writing an
   * audit_log transition row. Used both by the transition wrappers below and directly by the
   * assessment service (whose status lives on its own table).
   */
  async record(
    entityType: string,
    entityId: number,
    target: WorkflowStatus,
    opts: { me: Actor; remarks?: string | null } = { me: { id: 0 } },
  ) {
    const org = await this.orgId();
    const me = opts.me?.id || null;
    const remarks = opts.remarks != null ? String(opts.remarks) : null;
    const isSubmit = target === 'pending_approval';
    const isReview = target === 'published' || target === 'changes_requested' || target === 'unpublished';
    const isPublish = target === 'published';

    const row = await this.db.one<any>(
      `INSERT INTO content_approval
         (org_id, entity_type, entity_id, workflow_status,
          submitted_by, submitted_at, reviewed_by, reviewed_at, review_remarks, published_by, published_at, updated_at)
       VALUES ($1::bigint,$2::text,$3::bigint,$4::text,
          CASE WHEN $5::boolean THEN $6::bigint ELSE NULL END, CASE WHEN $5::boolean THEN now() ELSE NULL END,
          CASE WHEN $7::boolean THEN $6::bigint ELSE NULL END, CASE WHEN $7::boolean THEN now() ELSE NULL END,
          $8::text,
          CASE WHEN $9::boolean THEN $6::bigint ELSE NULL END, CASE WHEN $9::boolean THEN now() ELSE NULL END, now())
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
          workflow_status = EXCLUDED.workflow_status,
          submitted_by    = CASE WHEN $5::boolean THEN $6::bigint ELSE content_approval.submitted_by END,
          submitted_at    = CASE WHEN $5::boolean THEN now() ELSE content_approval.submitted_at END,
          reviewed_by     = CASE WHEN $7::boolean THEN $6::bigint ELSE content_approval.reviewed_by END,
          reviewed_at     = CASE WHEN $7::boolean THEN now() ELSE content_approval.reviewed_at END,
          review_remarks  = CASE WHEN $7::boolean THEN $8::text ELSE content_approval.review_remarks END,
          published_by    = CASE WHEN $9::boolean THEN $6::bigint ELSE content_approval.published_by END,
          published_at    = CASE WHEN $9::boolean THEN now() ELSE content_approval.published_at END,
          updated_at      = now()
       RETURNING *`,
      [org, entityType, entityId, target, isSubmit, me, isReview, remarks, isPublish],
    );

    await this.db.query(
      `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
       VALUES ($1,$2,$3,$4::bigint,$5,$6)`,
      [org, me, entityType, entityId, AUDIT_ACTION[target],
       JSON.stringify({ workflow_status: target, remarks: remarks ?? undefined })],
    );
    return row;
  }

  /** draft/changes_requested/unpublished -> pending_approval. */
  async submit(entityType: string, entityId: number, me: Actor) {
    const cur = await this.getStatus(entityType, entityId);
    const s = cur?.workflow_status;
    if (s === 'pending_approval') throw new BadRequestException('This item is already submitted for approval.');
    if (s === 'published') throw new BadRequestException('This item is already published. Unpublish it first to edit.');
    return this.record(entityType, entityId, 'pending_approval', { me });
  }

  /** pending_approval (or draft, as an admin shortcut) -> published. */
  async approve(entityType: string, entityId: number, me: Actor) {
    const cur = await this.getStatus(entityType, entityId);
    if (cur?.workflow_status === 'published') throw new BadRequestException('This item is already published.');
    return this.record(entityType, entityId, 'published', { me });
  }

  /** pending_approval -> changes_requested (returns to draft for the trainer), with remarks. */
  async reject(entityType: string, entityId: number, me: Actor, remarks: string) {
    if (!remarks || !String(remarks).trim()) throw new BadRequestException('Remarks are required when sending content back.');
    const cur = await this.getStatus(entityType, entityId);
    if (cur?.workflow_status !== 'pending_approval') throw new BadRequestException('Only an item pending approval can be sent back.');
    return this.record(entityType, entityId, 'changes_requested', { me, remarks });
  }

  /** published -> unpublished (admin pulls a live item). */
  async unpublish(entityType: string, entityId: number, me: Actor) {
    const cur = await this.getStatus(entityType, entityId);
    if (cur?.workflow_status !== 'published') throw new BadRequestException('Only a published item can be unpublished.');
    return this.record(entityType, entityId, 'unpublished', { me });
  }
}
