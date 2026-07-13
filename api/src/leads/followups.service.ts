import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS } from './leads.service';

export interface FollowUpFilters {
  lead_id?: number; owner_id?: number; status?: string;
  due?: 'today' | 'overdue' | 'upcoming'; mine?: boolean; limit?: number;
  /** client update #4 — My Tasks tabs: assigned (owner_id = me) | reported (created_by = me) */
  view?: 'assigned' | 'reported';
  priority?: 'low' | 'medium' | 'high';
}

export interface CreateFollowUpDto {
  lead_id: number; scheduled_at: string;
  type_id?: number; disposition_id?: number; owner_id?: number; remind_at?: string; notes?: string;
  priority?: 'low' | 'medium' | 'high';
  /** client update #5 — the person the assignee reports task progress to.
   *  Optional, NULL when not supplied (the UI defaults it to the current user).
   *  Independent of created_by — "Reported by Me" still keys off created_by. */
  report_to_id?: number | null;
}

export const FOLLOWUP_PRIORITIES = ['low', 'medium', 'high'] as const;

/** Validate an incoming priority value (create/update APIs). */
export function assertPriority(value: unknown): 'low' | 'medium' | 'high' {
  if (!FOLLOWUP_PRIORITIES.includes(value as any)) {
    throw new BadRequestException(`invalid priority — expected one of: ${FOLLOWUP_PRIORITIES.join(', ')}`);
  }
  return value as 'low' | 'medium' | 'high';
}

const FU_SELECT = `
  SELECT f.id, f.lead_id, f.owner_id, f.type_id, f.disposition_id, f.scheduled_at, f.completed_at,
         f.status, f.priority, f.remind_at, f.notes, f.created_at, f.created_by, f.report_to_id,
         ft.name AS type_name, d.name AS disposition_name, u.name AS owner_name, cu.name AS creator_name,
         ru.name AS report_to_name,
         l.full_name AS lead_name, l.phone AS lead_phone, l.temperature, l.score,
         co.name AS course_name, st.name AS stage_name, b.name AS branch_name, v.name AS vertical_name,
         (l.deleted_at IS NOT NULL) AS lead_deleted
    FROM follow_up f
    JOIN lead l ON l.id = f.lead_id
    LEFT JOIN m_followup_type ft ON ft.id = f.type_id
    LEFT JOIN m_disposition d ON d.id = f.disposition_id
    LEFT JOIN "user" u ON u.id = f.owner_id
    LEFT JOIN "user" cu ON cu.id = f.created_by
    LEFT JOIN "user" ru ON ru.id = f.report_to_id
    LEFT JOIN m_course co ON co.id = l.course_id
    LEFT JOIN pipeline_stage st ON st.id = l.stage_id
    JOIN branch b ON b.id = l.branch_id
    JOIN vertical v ON v.id = l.vertical_id`;

/** Follow-ups CRUD + today's/overdue lists. Scope flows through the lead path. */
@Injectable()
export class FollowUpsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
  ) {}

  async list(scope: ResolvedScope, f: FollowUpFilters, userId: number) {
    const params: unknown[] = [];
    const where: string[] = [this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, params),
      'f.deleted_at IS NULL', 'f.is_active', 'l.is_active'];
    if (f.lead_id) { params.push(f.lead_id); where.push(`f.lead_id = $${params.length}`); }
    if (f.owner_id) { params.push(f.owner_id); where.push(`f.owner_id = $${params.length}`); }
    if (f.mine) { params.push(userId); where.push(`f.owner_id = $${params.length}`); }
    // My Tasks tabs (client update #4): assigned -> I own it, reported -> I created it
    if (f.view === 'assigned') { params.push(userId); where.push(`f.owner_id = $${params.length}`); }
    if (f.view === 'reported') { params.push(userId); where.push(`f.created_by = $${params.length}`); }
    if (f.priority) { params.push(assertPriority(f.priority)); where.push(`f.priority = $${params.length}`); }
    if (f.status) { params.push(f.status); where.push(`f.status = $${params.length}`); }
    if (f.due === 'today') where.push(`f.status = 'pending' AND f.scheduled_at::date <= CURRENT_DATE`);
    if (f.due === 'overdue') where.push(`f.status = 'pending' AND f.scheduled_at < now()`);
    if (f.due === 'upcoming') where.push(`f.status = 'pending' AND f.scheduled_at >= now()`);
    params.push(Math.min(Number(f.limit) || 100, 500));
    // priority sorts within the due DATE (high > medium > low), hot leads first inside a slot
    return this.db.query(
      `${FU_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY f.scheduled_at::date ASC,
                 CASE f.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 (l.temperature = 'hot') DESC, f.scheduled_at ASC
        LIMIT $${params.length}`,
      params,
    );
  }

  /** KPI strip for My Tasks / Today's Follow-ups (scoped + per-user). */
  async summary(scope: ResolvedScope, userId: number) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, params);
    params.push(userId);
    return this.db.one(
      `SELECT COUNT(*) FILTER (WHERE f.status = 'pending')::int AS open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at::date = CURRENT_DATE)::int AS due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at < date_trunc('day', now()))::int AS overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at::date = CURRENT_DATE)::int AS done_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at >= date_trunc('week', now())
                               AND f.scheduled_at < date_trunc('week', now()) + interval '7 days')::int AS this_week,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at >= date_trunc('week', now()))::int AS done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length})::int AS my_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND f.scheduled_at::date = CURRENT_DATE)::int AS my_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND f.scheduled_at < date_trunc('day', now()))::int AS my_overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.owner_id = $${params.length}
                               AND f.completed_at >= date_trunc('week', now()))::int AS my_done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length})::int AS reported_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length}
                               AND f.scheduled_at::date = CURRENT_DATE)::int AS reported_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length}
                               AND f.scheduled_at < date_trunc('day', now()))::int AS reported_overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.created_by = $${params.length}
                               AND f.completed_at >= date_trunc('week', now()))::int AS reported_done_week
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${w}) AND f.is_active AND l.is_active
          AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, params,
    );
  }

  async create(dto: CreateFollowUpDto, actorId: number, scope: ResolvedScope) {
    if (!dto?.lead_id || !dto?.scheduled_at) throw new BadRequestException('lead_id and scheduled_at are required');
    // DEF-QA4-03: the body lead_id (and any explicit owner) must be inside the
    // caller's scope — a scoped agent cannot attach follow-ups to foreign leads.
    // Out-of-scope -> 404, consistent with the by-ID policy (no existence oracle).
    await this.enforcer.assertRefInScope(scope, 'lead', dto.lead_id, actorId);
    await this.enforcer.assertRefInScope(scope, 'user', dto.owner_id, actorId);
    // client update #5 — Report To: same scope rules as owner, plus a real-active-user check.
    await this.enforcer.assertRefInScope(scope, 'user', dto.report_to_id, actorId);
    // DEF-1: an explicitly named task owner must be an ACTIVE user (400 otherwise).
    if (dto.owner_id != null) await this.assertActiveUser(dto.owner_id, 'owner_id');
    const reportTo = await this.resolveReportTo(dto.report_to_id);
    const lead = await this.db.one<{ org_id: string; branch_id: string; owner_id: string | null }>(
      `SELECT org_id, branch_id, owner_id FROM lead WHERE id = $1 AND is_active AND deleted_at IS NULL`, [dto.lead_id],
    );
    if (!lead) throw new NotFoundException('lead not found');
    const owner = dto.owner_id ?? (lead.owner_id ? Number(lead.owner_id) : actorId);
    const priority = dto.priority !== undefined ? assertPriority(dto.priority) : 'medium';
    return this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO follow_up (lead_id, owner_id, type_id, disposition_id, scheduled_at, remind_at, notes, priority, created_by, report_to_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [dto.lead_id, owner, dto.type_id ?? null, dto.disposition_id ?? null,
          dto.scheduled_at, dto.remind_at ?? null, dto.notes ?? null, priority, actorId, reportTo],
      );
      await c.query(
        `UPDATE lead SET next_follow_up_at = LEAST(COALESCE(next_follow_up_at, $2::timestamptz), $2::timestamptz),
                         last_activity_at = now(), updated_at = now() WHERE id = $1`,
        [dto.lead_id, dto.scheduled_at],
      );
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note)
         VALUES ($1,$2,$3,$4,'follow_up',$5,$6)`,
        [dto.lead_id, Number(lead.org_id), Number(lead.branch_id), actorId,
          JSON.stringify({ follow_up_id: ins.rows[0].id, scheduled_at: dto.scheduled_at, action: 'scheduled' }),
          dto.notes ?? null],
      );
      return ins.rows[0];
    });
  }

  async update(
    id: number,
    dto: Partial<CreateFollowUpDto> & { status?: string; complete?: boolean },
    actorId: number,
    scope: ResolvedScope,
  ) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT f.*, l.org_id, l.branch_id FROM follow_up f JOIN lead l ON l.id = f.lead_id WHERE f.id = $1 AND f.deleted_at IS NULL`, [id],
    );
    if (!before) throw new NotFoundException('follow_up not found');
    // DEF-QA4-03: reassignment target must be inside the caller's scope.
    if (dto.owner_id != null && Number(dto.owner_id) !== Number(before.owner_id ?? 0)) {
      await this.enforcer.assertRefInScope(scope, 'user', Number(dto.owner_id), actorId);
    }
    // DEF-1: reassignment target must also be an ACTIVE user (400 otherwise).
    if (dto.owner_id != null) await this.assertActiveUser(dto.owner_id, 'owner_id');
    // client update #5 — Report To may be changed (or cleared with null); same scope check as owner.
    if (dto.report_to_id != null && Number(dto.report_to_id) !== Number(before.report_to_id ?? 0)) {
      await this.enforcer.assertRefInScope(scope, 'user', Number(dto.report_to_id), actorId);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto.complete || dto.status === 'done') { set('status', 'done'); sets.push(`completed_at = now()`); }
    else if (dto.status !== undefined) {
      if (!['pending', 'done', 'overdue'].includes(String(dto.status))) throw new BadRequestException('invalid status');
      set('status', dto.status);
    }
    if (dto.scheduled_at !== undefined) set('scheduled_at', dto.scheduled_at);
    if (dto.remind_at !== undefined) set('remind_at', dto.remind_at);
    if (dto.type_id !== undefined) set('type_id', dto.type_id);
    if (dto.disposition_id !== undefined) set('disposition_id', dto.disposition_id);
    if (dto.owner_id !== undefined) set('owner_id', dto.owner_id);
    if (dto.report_to_id !== undefined) set('report_to_id', await this.resolveReportTo(dto.report_to_id));
    if (dto.priority !== undefined) set('priority', assertPriority(dto.priority));
    if (dto.notes !== undefined) set('notes', dto.notes);
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    return this.db.tx(async (c) => {
      const upd = await c.query(
        `UPDATE follow_up SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
      );
      const done = upd.rows[0].status === 'done' && before.status !== 'done';
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
         VALUES ($1,$2,$3,$4,'follow_up',$5,$6,$7)`,
        [before.lead_id, Number(before.org_id), Number(before.branch_id), actorId,
          JSON.stringify({ follow_up_id: id, status: before.status }),
          JSON.stringify({ follow_up_id: id, status: upd.rows[0].status, action: done ? 'completed' : 'updated' }),
          dto.notes ?? null],
      );
      await c.query(`UPDATE lead SET last_activity_at = now() WHERE id = $1`, [before.lead_id]);
      return upd.rows[0];
    });
  }

  /**
   * DEF-1 — the ONE place that answers "is this user assignable?" (task owner + Report To).
   *
   * The deactivation flag on "user" is `status` ('active' | 'disabled') — that is what
   * Users > deactivate writes and what auth.service.ts checks at login. The legacy
   * `is_active` boolean is never written to FALSE, so guarding on it was a no-op and let
   * a disabled user be assigned. Guard on `status` (soft-delete check stays).
   */
  private async assertActiveUser(id: number, field: 'owner_id' | 'report_to_id'): Promise<void> {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`invalid ${field}`);
    const u = await this.db.one<{ id: string }>(
      `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [n],
    );
    if (!u) throw new BadRequestException(`${field} must be an active user`);
  }

  /**
   * client update #5 — validate an incoming report_to_id: null/undefined clears it,
   * anything else must be a real, active (status='active'), non-deleted user (400 otherwise).
   */
  private async resolveReportTo(id: number | null | undefined): Promise<number | null> {
    if (id === undefined || id === null || (id as unknown as string) === '') return null;
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('invalid report_to_id');
    await this.assertActiveUser(n, 'report_to_id');
    return n;
  }
}
