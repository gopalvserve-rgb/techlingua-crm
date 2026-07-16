import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NotifierService } from '../notifications/notifier.service';

/**
 * OPTIONAL APPROVALS — "optional approval per step" (PROJECT_DOCUMENTATION §5).
 *
 * =============================================================================
 * THE MODEL, IN ONE PARAGRAPH
 * =============================================================================
 * §5 says approvals are OPTIONAL and fixes no default, so THE DEFAULT INVENTS NO
 * BUREAUCRACY: `enabled: false`. A counsellor closes a sale and it is closed —
 * exactly as today. Switch the master flag on and the SAME closure lands in an
 * approval QUEUE instead: the enrolment is created with status `pending_approval`,
 * a request row is written, the approvers are notified through the Sprint-3 notifier
 * (so it reaches the bell, and email/SMS/WhatsApp if the matrix says so), and the
 * enrolment does not count towards targets or revenue until somebody approves it.
 * Rejecting it sets `rejected` and frees the lead to be re-enrolled.
 *
 * It is ONE app_setting row — `enrolment_approvals` — so turning it on is a switch,
 * NOT A DEPLOY. Each STEP is independently switchable, which is what "per step" means.
 *
 * STEPS SHIPPED:
 *   closure   — every enrolment needs approval.            (enabled within the policy)
 *   discount  — only when the discount exceeds N%.         (disabled by default)
 *
 * WHO APPROVES: `enrolment.approve`, which migration 029 grants to Branch Manager,
 * Vertical Manager and the admins — and deliberately NOT to Counsellor or Team Leader.
 * An approval a counsellor can grant himself is not an approval. The queue is scoped by
 * the SAME ScopeResolver as everything else, so a Branch Manager sees his branch's
 * queue and nobody else's — which is why `branch_id`/`vertical_id` are denormalised
 * onto the request row rather than joined from the enrolment.
 */

export const APPROVAL_SCOPE_COLS: ScopeColumnMap = {
  branch: 'a.branch_id', vertical: 'a.vertical_id',
};

export interface ApprovalStep {
  key: string;
  label: string;
  enabled: boolean;
  roles?: string[];
  /** `discount` only: require approval when the discount exceeds this percentage. */
  discount_pct_over?: number;
}
export interface ApprovalPolicy {
  enabled: boolean;
  steps: ApprovalStep[];
}

/** DEFAULT OFF. Mirrors migration 029's seed exactly — a fresh DB and a missing row
 *  must behave identically (the Sprint-3 "no scoring rules on a fresh DB" lesson). */
export const DEFAULT_APPROVALS: ApprovalPolicy = {
  enabled: false,
  steps: [
    { key: 'closure', label: 'Enrolment closure', enabled: true, roles: ['Branch Manager', 'Vertical Manager'] },
    { key: 'discount', label: 'Discount above threshold', enabled: false, roles: ['Branch Manager'], discount_pct_over: 10 },
  ],
};

/**
 * PURE — which steps a given enrolment must clear. Testable without a database, and it
 * is the single place the policy is interpreted, so the queue, the UI badge and the
 * status can never disagree about whether something needs approving.
 */
export function requiredSteps(
  policy: ApprovalPolicy,
  ctx: { fee_minor: number; discount_minor: number },
): ApprovalStep[] {
  if (!policy?.enabled) return [];
  const out: ApprovalStep[] = [];
  for (const s of policy.steps ?? []) {
    if (!s.enabled) continue;
    if (s.key === 'discount') {
      const over = Number(s.discount_pct_over ?? 0);
      const pct = ctx.fee_minor > 0 ? (ctx.discount_minor * 100) / ctx.fee_minor : 0;
      // strictly greater: "approval above 10%" must not fire at exactly 10%
      if (!(pct > over)) continue;
    }
    out.push(s);
  }
  return out;
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly resolver: ScopeResolverService,
    private readonly notifier?: NotifierService,
  ) {}

  async policy(): Promise<ApprovalPolicy> {
    return this.settings.get('enrolment_approvals', DEFAULT_APPROVALS as unknown as Record<string, unknown>) as unknown as Promise<ApprovalPolicy>;
  }

  async setPolicy(dto: any, actorId: number): Promise<ApprovalPolicy> {
    const cur = await this.policy();
    const steps = Array.isArray(dto?.steps) ? dto.steps : cur.steps;
    for (const s of steps) {
      if (!s?.key || !(cur.steps ?? []).some((x) => x.key === s.key)) {
        throw new BadRequestException(`Unknown approval step "${s?.key}"`);
      }
      if (s.key === 'discount' && s.discount_pct_over !== undefined) {
        const n = Number(s.discount_pct_over);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException('The discount threshold must be between 0 and 100%.');
      }
    }
    const next: ApprovalPolicy = {
      enabled: dto?.enabled === undefined ? cur.enabled : !!dto.enabled,
      steps: (cur.steps ?? []).map((c) => {
        const in_ = steps.find((s: any) => s.key === c.key);
        return in_ ? { ...c, ...in_, key: c.key, label: c.label } : c;
      }),
    };
    await this.settings.set('enrolment_approvals', next as unknown as Record<string, unknown>, actorId);
    return next;
  }

  /**
   * Open the requests for an enrolment, inside the caller's transaction. The UNIQUE
   * index `uq_approval_open` is the idempotency guarantee, not a check-then-insert that
   * races: a retried submit cannot create a second pending approval (the journey_run
   * lesson — `ON CONFLICT DO NOTHING`, not "SELECT then INSERT").
   */
  async open(
    c: PoolClient,
    a: { orgId: number; entityType: string; entityId: number; branchId: number; verticalId: number; requestedBy: number },
    steps: ApprovalStep[],
  ): Promise<number> {
    let n = 0;
    for (const s of steps) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO approval_request (org_id, entity_type, entity_id, step_key, step_label,
                                       status, branch_id, vertical_id, requested_by)
         VALUES ($1::bigint, $2::varchar, $3::bigint, $4::varchar, $5::varchar, 'pending',
                 $6::bigint, $7::bigint, $8::bigint)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [a.orgId, a.entityType, a.entityId, s.key, s.label, a.branchId, a.verticalId, a.requestedBy],
      );
      if (r.rows.length) n += 1;
    }
    return n;
  }

  /**
   * Tell the approvers, through the SPRINT-3 NOTIFIER — so an approval lands in the bell
   * and fans out to email/SMS/WhatsApp exactly as the notification matrix says, with no
   * new plumbing. That seam is why this is four lines and not a channel integration.
   *
   * Best-effort and OUTSIDE the transaction: a notifier hiccup must never roll back a
   * sale that is already committed. The queue screen is the system of record; the
   * notification is a courtesy.
   *
   * WHO: users holding one of the step's roles, whose assignment covers this branch (an
   * assignment with NO branch is org-wide — the ScopeResolver's own rule 3).
   * The link goes to the LEAD, because that is the deep-link the notification centre
   * actually handles; an `enrolment` link_type would render a dead click.
   */
  async notifyApprovers(
    entityId: number, enrolmentNo: string, branchId: number, leadId: number, steps: ApprovalStep[],
  ) {
    if (!this.notifier || !steps.length) return;
    const roles = [...new Set(steps.flatMap((s) => s.roles ?? []))];
    if (!roles.length) return;
    const approvers = await this.db.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM "user" u
         JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
         JOIN role r ON r.id = ua.role_id
        WHERE r.name = ANY($1::text[])
          AND u.is_active AND u.deleted_at IS NULL
          AND (ua.branch_id IS NULL OR ua.branch_id = $2::bigint)`,
      [roles, branchId],
    );
    try {
      await this.notifier.notifyMany(approvers.map((a) => Number(a.id)), {
        type: 'approval',
        severity: 'warn',
        title: `Enrolment ${enrolmentNo} needs your approval`,
        body: steps.map((s) => s.label).join(' \u00b7 '),
        link: { type: 'lead', id: leadId },
        meta: { enrolment_id: entityId, steps: steps.map((s) => s.key) },
      });
    } catch { /* a notification is not the sale */ }
  }

  /** The QUEUE — scoped. A Branch Manager sees his branch's pending approvals. */
  async queue(scope: ResolvedScope, f: { status?: string } = {}) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, APPROVAL_SCOPE_COLS, params);
    const status = f.status ?? 'pending';
    params.push(status);
    return this.db.query<any>(
      `SELECT a.id, a.entity_type, a.entity_id, a.step_key, a.step_label, a.status,
              a.requested_at, a.decided_at, a.note,
              e.enrolment_no, e.net_fee_minor, e.fee_minor, e.discount_minor, e.status AS enrolment_status,
              l.full_name AS lead_name, c.name AS course_name,
              b.name AS branch_name, v.name AS vertical_name,
              ru.name AS requested_by_name, au.name AS approver_name
         FROM approval_request a
         LEFT JOIN enrolment e ON e.id = a.entity_id AND a.entity_type = 'enrolment'
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" ru ON ru.id = a.requested_by
         LEFT JOIN "user" au ON au.id = a.approver_id
        WHERE ${w} AND a.status = $${params.length}::varchar
        ORDER BY a.requested_at ASC
        LIMIT 200`,
      params,
    );
  }

  /**
   * DECIDE. Returns the enrolment id so the caller can settle the enrolment's status.
   * The scope check is the queue's own — an approver outside the branch gets a 404,
   * not a decision.
   */
  async decide(id: number, approve: boolean, note: string | null, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, APPROVAL_SCOPE_COLS, params);
    const req = await this.db.one<any>(
      `SELECT a.* FROM approval_request a WHERE a.id = $1::bigint AND ${w}`,
      params,
    );
    if (!req) throw new NotFoundException('Approval request not found');
    if (req.status !== 'pending') throw new BadRequestException(`This request was already ${req.status}.`);
    if (Number(req.requested_by) === Number(me.id)) {
      // The permission grid already keeps counsellors out, but a Branch Manager can
      // create an enrolment AND holds `enrolment.approve` — so the self-approval bar
      // has to be enforced here, on the request, not merely in the role grid.
      throw new BadRequestException('You cannot approve your own enrolment. Ask another approver.');
    }
    await this.db.query(
      `UPDATE approval_request
          SET status = $2::varchar, approver_id = $3::bigint, decided_at = now(), note = $4
        WHERE id = $1::bigint AND status = 'pending'`,
      [id, approve ? 'approved' : 'rejected', me.id, note],
    );
    return { entity_type: req.entity_type as string, entity_id: Number(req.entity_id), approved: approve };
  }

  /** Are all this entity's steps cleared? */
  async allCleared(entityType: string, entityId: number): Promise<boolean> {
    const r = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM approval_request
        WHERE entity_type = $1::varchar AND entity_id = $2::bigint AND status = 'pending'`,
      [entityType, entityId],
    );
    return Number(r?.n ?? 0) === 0;
  }

  async forEntity(entityType: string, entityId: number) {
    return this.db.query<any>(
      `SELECT a.id, a.step_key, a.step_label, a.status, a.requested_at, a.decided_at, a.note,
              ru.name AS requested_by_name, au.name AS approver_name
         FROM approval_request a
         LEFT JOIN "user" ru ON ru.id = a.requested_by
         LEFT JOIN "user" au ON au.id = a.approver_id
        WHERE a.entity_type = $1::varchar AND a.entity_id = $2::bigint
        ORDER BY a.requested_at`,
      [entityType, entityId],
    );
  }
}
