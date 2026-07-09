import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS } from './leads.service';

export interface FollowUpFilters {
  lead_id?: number; owner_id?: number; status?: string;
  due?: 'today' | 'overdue' | 'upcoming'; mine?: boolean; limit?: number;
}

export interface CreateFollowUpDto {
  lead_id: number; scheduled_at: string;
  type_id?: number; disposition_id?: number; owner_id?: number; remind_at?: string; notes?: string;
}

const FU_SELECT = `
  SELECT f.id, f.lead_id, f.owner_id, f.type_id, f.disposition_id, f.scheduled_at, f.completed_at,
         f.status, f.remind_at, f.notes, f.created_at,
         ft.name AS type_name, d.name AS disposition_name, u.name AS owner_name,
         l.full_name AS lead_name, l.phone AS lead_phone, l.temperature, l.score,
         co.name AS course_name, st.name AS stage_name, b.name AS branch_name, v.name AS vertical_name
    FROM follow_up f
    JOIN lead l ON l.id = f.lead_id
    LEFT JOIN m_followup_type ft ON ft.id = f.type_id
    LEFT JOIN m_disposition d ON d.id = f.disposition_id
    LEFT JOIN "user" u ON u.id = f.owner_id
    LEFT JOIN m_course co ON co.id = l.course_id
    LEFT JOIN pipeline_stage st ON st.id = l.stage_id
    JOIN branch b ON b.id = l.branch_id
    JOIN vertical v ON v.id = l.vertical_id`;

/** Follow-ups CRUD + today's/overdue lists. Scope flows through the lead path. */
@Injectable()
export class FollowUpsService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  async list(scope: ResolvedScope, f: FollowUpFilters, userId: number) {
    const params: unknown[] = [];
    const where: string[] = [this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, params),
      'f.is_active', 'l.is_active'];
    if (f.lead_id) { params.push(f.lead_id); where.push(`f.lead_id = $${params.length}`); }
    if (f.owner_id) { params.push(f.owner_id); where.push(`f.owner_id = $${params.length}`); }
    if (f.mine) { params.push(userId); where.push(`f.owner_id = $${params.length}`); }
    if (f.status) { params.push(f.status); where.push(`f.status = $${params.length}`); }
    if (f.due === 'today') where.push(`f.status = 'pending' AND f.scheduled_at::date <= CURRENT_DATE`);
    if (f.due === 'overdue') where.push(`f.status = 'pending' AND f.scheduled_at < now()`);
    if (f.due === 'upcoming') where.push(`f.status = 'pending' AND f.scheduled_at >= now()`);
    params.push(Math.min(Number(f.limit) || 100, 500));
    return this.db.query(
      `${FU_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY (l.temperature = 'hot') DESC, f.scheduled_at ASC LIMIT $${params.length}`,
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
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at >= date_trunc('week', now()))::int AS done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length})::int AS my_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND f.scheduled_at::date = CURRENT_DATE)::int AS my_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND f.scheduled_at < date_trunc('day', now()))::int AS my_overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.owner_id = $${params.length}
                               AND f.completed_at >= date_trunc('week', now()))::int AS my_done_week
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${w}) AND f.is_active AND l.is_active`, params,
    );
  }

  async create(dto: CreateFollowUpDto, actorId: number) {
    if (!dto?.lead_id || !dto?.scheduled_at) throw new BadRequestException('lead_id and scheduled_at are required');
    const lead = await this.db.one<{ org_id: string; branch_id: string; owner_id: string | null }>(
      `SELECT org_id, branch_id, owner_id FROM lead WHERE id = $1 AND is_active`, [dto.lead_id],
    );
    if (!lead) throw new NotFoundException('lead not found');
    const owner = dto.owner_id ?? (lead.owner_id ? Number(lead.owner_id) : actorId);
    return this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO follow_up (lead_id, owner_id, type_id, disposition_id, scheduled_at, remind_at, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [dto.lead_id, owner, dto.type_id ?? null, dto.disposition_id ?? null,
          dto.scheduled_at, dto.remind_at ?? null, dto.notes ?? null, actorId],
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

  async update(id: number, dto: Partial<CreateFollowUpDto> & { status?: string; complete?: boolean }, actorId: number) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT f.*, l.org_id, l.branch_id FROM follow_up f JOIN lead l ON l.id = f.lead_id WHERE f.id = $1`, [id],
    );
    if (!before) throw new NotFoundException('follow_up not found');
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

  /** Soft delete. */
  async remove(id: number) {
    const rows = await this.db.query(
      `UPDATE follow_up SET is_active = FALSE, updated_at = now() WHERE id = $1 RETURNING id`, [id],
    );
    if (!rows.length) throw new NotFoundException('follow_up not found');
    return { ok: true };
  }
}
