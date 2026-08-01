import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { assertDateRange } from '../common/date.util';
import { NotifierService } from '../notifications/notifier.service';
import { SettingsService } from '../common/settings.service';
import { assertActiveUser } from '../leads/active-user.util';

/**
 * SUPPORT & TICKETS — internal staff tickets, full lifecycle.
 *
 * =============================================================================
 * SCOPE — why this does NOT call resolver.buildScopeWhere() directly for 'own'
 * =============================================================================
 * A support ticket has TWO people a counsellor legitimately "owns": the one who RAISED
 * it (created_by) and the one it is ASSIGNED to (assignee_id). The generic buildScopeWhere
 * maps the 'own' filter to a single owner column, which would hide a ticket assigned to me
 * but raised by someone else. So the 'own' filter is expanded here to
 * `(created_by = me OR assignee_id = me)`; branch/vertical/all fall straight through to the
 * same resolver semantics every other entity uses. The result is a parameterised WHERE
 * fragment that goes INSIDE the SQL — a scoped counsellor's query can never return another
 * branch's tickets.
 */

/** Lifecycle: open -> in_progress -> resolved -> closed, with a reopen path. */
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** Allowed transitions. `resolved`/`closed` -> `in_progress` IS the reopen path. */
export const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['in_progress', 'resolved'],
  in_progress: ['open', 'resolved'],
  resolved: ['in_progress', 'closed'],   // in_progress = reopen
  closed: ['in_progress'],               // reopen a closed ticket
};

export interface SlaTarget { first_response: number; resolution: number }
export const SLA_DEFAULTS: Record<string, SlaTarget> = {
  urgent: { first_response: 30, resolution: 240 },
  high: { first_response: 60, resolution: 480 },
  medium: { first_response: 120, resolution: 1440 },
  low: { first_response: 240, resolution: 2880 },
};

@Injectable()
export class SupportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly notifier: NotifierService,
    private readonly settings: SettingsService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async slaConfig(): Promise<Record<string, SlaTarget>> {
    return this.settings.get('support_sla', SLA_DEFAULTS) as unknown as Promise<Record<string, SlaTarget>>;
  }

  /** Ticket-specific scope WHERE. Expands 'own' to reporter OR assignee (see class note). */
  private ticketScopeWhere(scope: ResolvedScope, params: unknown[]): string {
    if (!scope.allowed) return '1=0';
    if (scope.all) return '1=1';
    const parts: string[] = [];
    for (const f of scope.filters) {
      switch (f.kind) {
        case 'own':
        case 'team': {
          // team has no first-class column on a ticket; degrade to the acting user's own
          // reporter/assignee visibility rather than widening to a branch.
          const uid = f.kind === 'own' ? f.userId : undefined;
          if (uid != null) {
            params.push(uid);
            parts.push(`(t.created_by = $${params.length} OR t.assignee_id = $${params.length})`);
          }
          break;
        }
        case 'branch': params.push(f.branchId); parts.push(`t.branch_id = $${params.length}`); break;
        case 'vertical': params.push(f.verticalId); parts.push(`t.vertical_id = $${params.length}`); break;
        case 'pipeline': case 'campaign': break; // a ticket has no pipeline/campaign
      }
    }
    if (!parts.length) return '1=0';
    return `(${parts.join(' OR ')})`;
  }

  /** Build the SLA-aware SELECT columns (resolution due + overdue), parameterised by config. */
  private slaSelect(cfg: Record<string, SlaTarget>, params: unknown[]): string {
    const mins = (pick: (t: SlaTarget) => number) => {
      const c = (p: string) => { params.push(pick(cfg[p] ?? SLA_DEFAULTS[p])); return `$${params.length}::int`; };
      return `CASE t.priority WHEN 'urgent' THEN ${c('urgent')} WHEN 'high' THEN ${c('high')} `
        + `WHEN 'medium' THEN ${c('medium')} ELSE ${c('low')} END`;
    };
    const resMin = mins((x) => x.resolution);
    const frMin = mins((x) => x.first_response);
    return `
      (t.created_at + (${resMin}) * interval '1 minute') AS resolution_due_at,
      (t.created_at + (${frMin}) * interval '1 minute') AS first_response_due_at,
      (t.status NOT IN ('resolved','closed')
        AND now() > t.created_at + (${resMin}) * interval '1 minute') AS overdue,
      (t.first_response_at IS NULL AND t.status NOT IN ('resolved','closed')
        AND now() > t.created_at + (${frMin}) * interval '1 minute') AS first_response_breached`;
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: {
    status?: string; priority?: string; category?: string; assignee_id?: string | number;
    branch_id?: string | number; vertical_id?: string | number; q?: string;
    from?: string; to?: string; overdue?: string; limit?: number;
  } = {}) {
    const cfg = await this.slaConfig();
    const params: unknown[] = [];
    const slaCols = this.slaSelect(cfg, params);
    const where = [`t.deleted_at IS NULL`, this.ticketScopeWhere(scope, params)];
    if (f.status) { params.push(f.status); where.push(`t.status = $${params.length}::varchar`); }
    if (f.priority) { params.push(f.priority); where.push(`t.priority = $${params.length}::varchar`); }
    if (f.category) { params.push(f.category); where.push(`t.category = $${params.length}::varchar`); }
    if (f.assignee_id) { params.push(Number(f.assignee_id)); where.push(`t.assignee_id = $${params.length}::bigint`); }
    if (f.branch_id) { params.push(Number(f.branch_id)); where.push(`t.branch_id = $${params.length}::bigint`); }
    if (f.vertical_id) { params.push(Number(f.vertical_id)); where.push(`t.vertical_id = $${params.length}::bigint`); }
    // DEF-DR-02: strict validation — malformed date -> 400, never a 500.
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`t.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`t.created_at < ($${params.length}::date + 1)`); }
    if (f.q) {
      params.push(`%${f.q}%`);
      where.push(`(t.subject ILIKE $${params.length} OR t.ticket_no ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }
    params.push(Math.min(Number(f.limit ?? 200), 500));
    const limitIdx = params.length;
    const rows = await this.db.query<any>(
      `SELECT t.id, t.ticket_no, t.subject, t.category, t.priority, t.status,
              t.branch_id, t.vertical_id, t.assignee_id, t.created_by,
              t.first_response_at, t.resolved_at, t.closed_at, t.created_at, t.updated_at,
              b.name AS branch_name, v.name AS vertical_name,
              a.name AS assignee_name, rep.name AS reporter_name,
              (SELECT count(*) FROM support_ticket_comment cc WHERE cc.ticket_id = t.id) AS comment_count,
              ${slaCols}
         FROM support_ticket t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN "user" a ON a.id = t.assignee_id
         LEFT JOIN "user" rep ON rep.id = t.created_by
        WHERE ${where.join(' AND ')}
        ${f.overdue === '1' ? `AND (t.status NOT IN ('resolved','closed') AND now() > t.created_at + (CASE t.priority WHEN 'urgent' THEN ${cfg.urgent?.resolution ?? 240} WHEN 'high' THEN ${cfg.high?.resolution ?? 480} WHEN 'medium' THEN ${cfg.medium?.resolution ?? 1440} ELSE ${cfg.low?.resolution ?? 2880} END) * interval '1 minute')` : ''}
        ORDER BY t.created_at DESC
        LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  async summary(scope: ResolvedScope) {
    const cfg = await this.slaConfig();
    const params: unknown[] = [];
    const w = this.ticketScopeWhere(scope, params);
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE t.status = 'open') AS open,
              count(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
              count(*) FILTER (WHERE t.status = 'resolved') AS resolved,
              count(*) FILTER (WHERE t.status = 'closed') AS closed,
              count(*) FILTER (WHERE t.status NOT IN ('resolved','closed')
                AND now() > t.created_at + (CASE t.priority
                  WHEN 'urgent' THEN ${cfg.urgent?.resolution ?? 240} WHEN 'high' THEN ${cfg.high?.resolution ?? 480}
                  WHEN 'medium' THEN ${cfg.medium?.resolution ?? 1440} ELSE ${cfg.low?.resolution ?? 2880} END) * interval '1 minute') AS overdue
         FROM support_ticket t
        WHERE t.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      open: Number(r?.open ?? 0), in_progress: Number(r?.in_progress ?? 0),
      resolved: Number(r?.resolved ?? 0), closed: Number(r?.closed ?? 0), overdue: Number(r?.overdue ?? 0),
    };
  }

  async meta() {
    const cfg = await this.slaConfig();
    return {
      priorities: TICKET_PRIORITIES.map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1) })),
      statuses: TICKET_STATUSES.map((k) => ({ key: k, label: this.statusLabel(k) })),
      transitions: TRANSITIONS,
      sla: cfg,
    };
  }

  statusLabel(s: string): string {
    return s === 'in_progress' ? 'In Progress' : s[0].toUpperCase() + s.slice(1);
  }

  async get(id: number, scope: ResolvedScope) {
    const cfg = await this.slaConfig();
    const params: unknown[] = [];
    const slaCols = this.slaSelect(cfg, params);
    params.push(id);
    const idIdx = params.length;
    const w = this.ticketScopeWhere(scope, params);
    const t = await this.db.one<any>(
      `SELECT t.*, b.name AS branch_name, v.name AS vertical_name,
              a.name AS assignee_name, rep.name AS reporter_name,
              ${slaCols}
         FROM support_ticket t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN "user" a ON a.id = t.assignee_id
         LEFT JOIN "user" rep ON rep.id = t.created_by
        WHERE t.id = $${idIdx}::bigint AND t.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!t) throw new NotFoundException('Ticket not found (or outside your access)');
    const comments = await this.db.query<any>(
      `SELECT c.id, c.body, c.is_internal, c.created_at, c.author_id, u.name AS author_name
         FROM support_ticket_comment c LEFT JOIN "user" u ON u.id = c.author_id
        WHERE c.ticket_id = $1::bigint ORDER BY c.created_at ASC`,
      [id],
    );
    return { ...t, comments };
  }

  /* ----------------------------------------------------------------- writes */

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const subject = String(dto?.subject ?? '').trim();
    if (!subject) throw new BadRequestException('A subject is required.');
    const priority = String(dto?.priority ?? 'medium');
    if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) throw new BadRequestException('Choose a valid priority.');
    const branchId = dto?.branch_id ? Number(dto.branch_id) : null;
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    const assigneeId = dto?.assignee_id ? Number(dto.assignee_id) : null;
    if (assigneeId) await assertActiveUser(this.db, assigneeId, 'Assignee');
    // Creating a ticket the creator could not then SEE (out of their own scope) is a
    // footgun; branch/vertical scoped creators must file within their unit.
    this.assertCreateInScope(scope, branchId, verticalId);
    const orgId = await this.orgId();

    const out = await this.db.tx(async (c) => {
      const ticketNo = await this.numbering.allocate('support', { branch_id: branchId, vertical_id: verticalId }, c);
      const r = await c.query<{ id: string }>(
        `INSERT INTO support_ticket (org_id, ticket_no, subject, description, category, priority, status,
                                     branch_id, vertical_id, assignee_id, created_by)
         VALUES ($1::bigint,$2::varchar,$3::varchar,$4,$5,$6::varchar,'open',$7::bigint,$8::bigint,$9::bigint,$10::bigint)
         RETURNING id`,
        [orgId, ticketNo, subject.slice(0, 200), dto?.description ?? null, dto?.category ?? null, priority,
          branchId, verticalId, assigneeId, me.id],
      );
      return { id: Number(r.rows[0].id), ticket_no: ticketNo };
    });

    if (assigneeId && assigneeId !== me.id) {
      await this.notifier.notify({
        userId: assigneeId, type: 'assignment', title: `Ticket ${out.ticket_no} assigned to you`,
        body: subject, meta: { ticket_id: out.id },
      });
    }
    return { ...out, status: 'open' };
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.subject !== undefined) {
      const s = String(dto.subject).trim();
      if (!s) throw new BadRequestException('A subject is required.');
      set('subject', s.slice(0, 200));
    }
    if (dto?.description !== undefined) set('description', dto.description);
    if (dto?.category !== undefined) set('category', dto.category || null);
    if (dto?.priority !== undefined) {
      if (!(TICKET_PRIORITIES as readonly string[]).includes(String(dto.priority))) throw new BadRequestException('Choose a valid priority.');
      set('priority', dto.priority);
    }
    let newAssignee: number | null | undefined;
    if (dto?.assignee_id !== undefined) {
      newAssignee = dto.assignee_id ? Number(dto.assignee_id) : null;
      if (newAssignee) await assertActiveUser(this.db, newAssignee, 'Assignee');
      set('assignee_id', newAssignee);
    }
    if (!sets.length) return { id, ok: true };
    params.push(id);
    await this.db.query(
      `UPDATE support_ticket SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`,
      params,
    );
    if (newAssignee && newAssignee !== Number(cur.assignee_id) && newAssignee !== me.id) {
      await this.notifier.notify({
        userId: newAssignee, type: 'assignment', title: `Ticket ${cur.ticket_no} assigned to you`,
        body: cur.subject, meta: { ticket_id: id },
      });
    }
    return { id, ok: true };
  }

  /** Lifecycle transition (covers reopen). Illegal transitions are refused with a 400. */
  async transition(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const to = String(dto?.status ?? '') as TicketStatus;
    if (!(TICKET_STATUSES as readonly string[]).includes(to)) throw new BadRequestException('Unknown status.');
    const from = cur.status as TicketStatus;
    if (from === to) return { id, status: to };
    if (!TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `A ${this.statusLabel(from)} ticket cannot move straight to ${this.statusLabel(to)}.`,
      );
    }
    const reopen = (from === 'resolved' || from === 'closed') && to === 'in_progress';
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE support_ticket
            SET status = $2::varchar,
                first_response_at = COALESCE(first_response_at, CASE WHEN $2 = 'in_progress' THEN now() END),
                resolved_at = CASE WHEN $2 = 'resolved' THEN now()
                                   WHEN $2 IN ('open','in_progress') THEN NULL ELSE resolved_at END,
                closed_at   = CASE WHEN $2 = 'closed' THEN now()
                                   WHEN $2 IN ('open','in_progress','resolved') THEN NULL ELSE closed_at END,
                updated_at = now()
          WHERE id = $1::bigint`,
        [id, to],
      );
      if (dto?.note) {
        await c.query(
          `INSERT INTO support_ticket_comment (org_id, ticket_id, author_id, body, is_internal)
           VALUES ($1::bigint, $2::bigint, $3::bigint, $4, TRUE)`,
          [Number(cur.org_id), id, me.id,
            `${reopen ? 'Reopened' : this.statusLabel(to)}: ${dto.note}`],
        );
      }
    });
    // let the reporter know their ticket moved, and the assignee if a reopen lands on them
    const notifyIds = [Number(cur.created_by), Number(cur.assignee_id)].filter((n) => n && n !== me.id);
    await this.notifier.notifyMany(notifyIds, {
      type: 'system', title: `Ticket ${cur.ticket_no} ${reopen ? 'reopened' : this.statusLabel(to).toLowerCase()}`,
      body: cur.subject, meta: { ticket_id: id },
    });
    return { id, status: to, reopened: reopen };
  }

  async addComment(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('A comment cannot be empty.');
    const isInternal = dto?.is_internal === true || dto?.is_internal === '1';
    const out = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO support_ticket_comment (org_id, ticket_id, author_id, body, is_internal)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5) RETURNING id`,
        [Number(cur.org_id), id, me.id, body, isInternal],
      );
      // first human touch that is not the reporter counts as the first response
      if (!cur.first_response_at && Number(cur.created_by) !== me.id && cur.status !== 'resolved' && cur.status !== 'closed') {
        await c.query(`UPDATE support_ticket SET first_response_at = now(), updated_at = now() WHERE id = $1::bigint`, [id]);
      } else {
        await c.query(`UPDATE support_ticket SET updated_at = now() WHERE id = $1::bigint`, [id]);
      }
      return { id: Number(r.rows[0].id) };
    });
    // notify the "other party": the reporter and the assignee, minus the author
    const notifyIds = [Number(cur.created_by), Number(cur.assignee_id)].filter((n) => n && n !== me.id);
    await this.notifier.notifyMany(notifyIds, {
      type: 'system', title: `New comment on ${cur.ticket_no}`, body: cur.subject, meta: { ticket_id: id },
    });
    return out;
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope); // 404 if out of scope
    await this.db.query(
      `UPDATE support_ticket SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id, me.id],
    );
    return { id, ok: true };
  }

  /* ---------------------------------------------------------------- helpers */

  private assertCreateInScope(scope: ResolvedScope, branchId: number | null, verticalId: number | null) {
    if (!scope.allowed) throw new ForbiddenException('Not allowed to create tickets.');
    if (scope.all) return;
    for (const f of scope.filters) {
      if (f.kind === 'own') return;   // an own-scoped user files their own ticket regardless of unit
      if (f.kind === 'branch' && branchId && Number(f.branchId) === Number(branchId)) return;
      if (f.kind === 'vertical' && verticalId && Number(f.verticalId) === Number(verticalId)) return;
    }
    // no matching unit — allow (a manager filing an org-general ticket with no unit is fine);
    // the read scope will still gate who can see it.
  }
}
