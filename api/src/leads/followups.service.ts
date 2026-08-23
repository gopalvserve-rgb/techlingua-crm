import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS } from '../rbac/scope-cols';
import { ScoringService } from '../scoring/scoring.service';
import { SlaService } from '../sla/sla.service';
import { SettingsService } from '../common/settings.service';
import { assertActiveUser } from './active-user.util';
import { assertDateRange, SQL_TODAY, istDay, assertFollowupPreset, followupWindowSql, FollowupPreset } from '../common/date.util';

export interface FollowUpFilters {
  lead_id?: number; owner_id?: number; status?: string;
  due?: 'today' | 'overdue' | 'upcoming'; mine?: boolean; limit?: number;
  /** client update #4 — My Tasks tabs: assigned (owner_id = me) | reported (created_by = me) */
  view?: 'assigned' | 'reported';
  priority?: 'low' | 'medium' | 'high';
  /** Global scope narrow (top-bar selector) — ANDed on top of the RBAC scope, never widens it. */
  branch_id?: number; vertical_id?: number; pipeline_id?: number; campaign_id?: number;
  /** Multi-select filters (client UAT, Aug 2026) — Follow-ups list gets the same treatment as
   *  Leads: OR within a filter, AND across filters. Numeric-id arrays + string enum arrays. */
  branch_ids?: number[]; vertical_ids?: number[]; pipeline_ids?: number[]; campaign_ids?: number[];
  owner_ids?: number[]; type_ids?: number[]; disposition_ids?: number[];
  priorities?: string[]; statuses?: string[];
  /** Shared date-range control — filters by the task's DUE date (scheduled_at). */
  from?: string; to?: string;
  /** Follow-up date filter (client #3) — a preset window on the DUE date (scheduled_at, IST),
   *  plus an optional custom range (fu_from/fu_to) used when followup='custom'. */
  followup?: FollowupPreset;
  fu_from?: string; fu_to?: string;
  /** Today's Follow-ups KPI bucket (client Aug 2026) — one of FOLLOWUP_BUCKETS. Applies the
   *  SAME predicate the /follow-ups/stats card counts use, so a card opens exactly its list. */
  bucket?: string;
}

/**
 * Today's Follow-ups KPI buckets (client Aug 2026). ONE definition drives both the
 * /follow-ups/stats counts and the /follow-ups?bucket=… list filter, so every card's number
 * equals the length of the list it opens. All windows are IST calendar days.
 *   overdue · due_today · next7 · no_shows · done_today · rescheduled · hot_leads · unreachable
 * The disposition-driven buckets (no_shows / rescheduled / unreachable) match on the disposition
 * NAME (ILIKE) so any client-defined disposition with that wording rolls into the right bucket.
 */
export const FOLLOWUP_BUCKETS = [
  'overdue', 'due_today', 'next7', 'no_shows', 'done_today', 'rescheduled', 'hot_leads', 'unreachable',
] as const;
export type FollowupBucket = (typeof FOLLOWUP_BUCKETS)[number];

/** The SQL predicate for a KPI bucket (no bind params — literal windows + ILIKE literals).
 *  Assumes the query joins follow_up f, lead l and m_disposition d (LEFT). */
export function followupBucketSql(bucket: string): string | null {
  const ist = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
  const today = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
  switch (bucket) {
    case 'overdue': return `f.status = 'pending' AND ${ist('f.scheduled_at')} < ${today}`;
    case 'due_today': return `f.status = 'pending' AND ${ist('f.scheduled_at')} = ${today}`;
    case 'next7': return `f.status = 'pending' AND ${ist('f.scheduled_at')} BETWEEN ${today} AND ${today} + 7`;
    case 'no_shows': return `(d.name ILIKE '%no show%' OR d.name ILIKE '%no-show%' OR d.name ILIKE '%noshow%')`;
    case 'done_today': return `f.status = 'done' AND ${ist('f.completed_at')} = ${today}`;
    case 'rescheduled': return `(d.name ILIKE '%reschedul%' OR d.name ILIKE '%call back%' OR d.name ILIKE '%callback%')`;
    case 'hot_leads': return `f.status = 'pending' AND l.temperature = 'hot'`;
    case 'unreachable': return `(d.name ILIKE '%not reachable%' OR d.name ILIKE '%unreachable%' OR d.name ILIKE '%switched off%')`;
    default: return null;
  }
}

export interface CreateFollowUpDto {
  lead_id: number; scheduled_at: string;
  type_id?: number; disposition_id?: number; owner_id?: number; remind_at?: string; notes?: string;
  priority?: 'low' | 'medium' | 'high';
  /** client update #5 — the person the assignee reports task progress to.
   *  Optional, NULL when not supplied (the UI defaults it to the current user).
   *  Independent of created_by — "Reported by Me" still keys off created_by. */
  report_to_id?: number | null;
  /** Client Aug 2026 (#2) — Branch + Vertical on the task; optional, nullable. */
  branch_id?: number | null;
  vertical_id?: number | null;
}

export const FOLLOWUP_PRIORITIES = ['low', 'medium', 'high'] as const;

/** Validate an incoming priority value (create/update APIs). */
export function assertPriority(value: unknown): 'low' | 'medium' | 'high' {
  if (!FOLLOWUP_PRIORITIES.includes(value as any)) {
    throw new BadRequestException(`invalid priority — expected one of: ${FOLLOWUP_PRIORITIES.join(', ')}`);
  }
  return value as 'low' | 'medium' | 'high';
}

/**
 * UAT-R2 #12 — a task / follow-up due date may not be back-dated (today or later only).
 * A `datetime-local` value carries no timezone (wall-clock in the process zone), so the
 * "today" comparison uses LOCAL calendar days, exactly like the walk-in Date-of-Visit guard.
 * Empty/undefined passes (nothing to check); an invalid date is a 400.
 */
export function assertNotPastSchedule(scheduled_at: string | null | undefined): void {
  if (scheduled_at == null || String(scheduled_at).trim() === '') return;
  const d = new Date(scheduled_at);
  if (isNaN(d.getTime())) throw new BadRequestException('Due date is not a valid date/time');
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  if (day(d) < day(new Date())) {
    throw new BadRequestException('Due date cannot be in the past');
  }
}

const FU_SELECT = `
  SELECT f.id, f.lead_id, f.owner_id, f.type_id, f.disposition_id, f.scheduled_at, f.completed_at,
         f.status, f.priority, f.remind_at, f.notes, f.created_at, f.created_by, f.report_to_id,
         ft.name AS type_name, d.name AS disposition_name, u.name AS owner_name, cu.name AS creator_name,
         ru.name AS report_to_name,
         l.full_name AS lead_name, l.phone AS lead_phone, l.temperature, l.score,
         co.name AS course_name, st.name AS stage_name,
         -- Client Aug 2026 (#2) — task carries its OWN branch/vertical; fall back to the lead's
         -- path when unset. The effective id is exposed so the Edit form prefills consistently.
         COALESCE(f.branch_id, l.branch_id) AS branch_id,
         COALESCE(f.vertical_id, l.vertical_id) AS vertical_id,
         COALESCE(fb.name, b.name) AS branch_name, COALESCE(fv.name, v.name) AS vertical_name,
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
    JOIN vertical v ON v.id = l.vertical_id
    LEFT JOIN branch fb ON fb.id = f.branch_id
    LEFT JOIN vertical fv ON fv.id = f.vertical_id`;

/** Follow-ups CRUD + today's/overdue lists. Scope flows through the lead path. */
@Injectable()
export class FollowUpsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly scoring: ScoringService,
    private readonly sla: SlaService,
    private readonly settings: SettingsService,
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
    // Global scope narrow — filters through the follow-up's lead path (l.*), ANDed on top of the
    // RBAC scope so it can only narrow within what the caller may already see.
    if (f.branch_id) { params.push(f.branch_id); where.push(`l.branch_id = $${params.length}`); }
    if (f.vertical_id) { params.push(f.vertical_id); where.push(`l.vertical_id = $${params.length}`); }
    if (f.pipeline_id) { params.push(f.pipeline_id); where.push(`l.pipeline_id = $${params.length}`); }
    if (f.campaign_id) { params.push(f.campaign_id); where.push(`l.campaign_id = $${params.length}`); }
    // Multi-select arrays (client UAT, Aug 2026) — OR within each, ANDed across. Guard invalid
    // priority/status values so a bad enum can't reach SQL.
    const anyId = (col: string, ids?: number[]) => {
      const clean = (ids ?? []).filter((n) => Number.isInteger(n) && n > 0);
      if (clean.length) { params.push(clean); where.push(`${col} = ANY($${params.length}::int[])`); }
    };
    anyId('l.branch_id', f.branch_ids); anyId('l.vertical_id', f.vertical_ids);
    anyId('l.pipeline_id', f.pipeline_ids); anyId('l.campaign_id', f.campaign_ids);
    anyId('f.owner_id', f.owner_ids); anyId('f.type_id', f.type_ids); anyId('f.disposition_id', f.disposition_ids);
    if (f.priorities?.length) {
      const clean = f.priorities.map((p) => assertPriority(p as any));
      params.push(clean); where.push(`f.priority = ANY($${params.length}::text[])`);
    }
    if (f.statuses?.length) {
      const ok = new Set(['pending', 'done', 'missed', 'cancelled']);
      const clean = f.statuses.filter((x) => ok.has(String(x)));
      if (clean.length) { params.push(clean); where.push(`f.status = ANY($${params.length}::text[])`); }
    }
    if (f.due === 'today') where.push(`f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    if (f.due === 'overdue') where.push(`f.status = 'pending' AND f.scheduled_at < now()`);
    if (f.due === 'upcoming') where.push(`f.status = 'pending' AND f.scheduled_at >= now()`);
    // Shared date range — filters tasks by their DUE date (scheduled_at). Bad date -> 400.
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`f.scheduled_at::date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`f.scheduled_at::date <= $${params.length}::date`); }
    // Follow-up date filter (client #3) — presets on the task's DUE date (scheduled_at), IST.
    // No Followup is meaningful only on the Leads list (a follow-up row IS a scheduled
    // follow-up), so here it selects nothing; Missed = a pending task now in the past.
    const fup = assertFollowupPreset(f.followup);
    if (fup === 'no_followup') {
      where.push('FALSE');
    } else if (fup === 'missed') {
      where.push(`f.status = 'pending' AND f.scheduled_at < now()`);
    } else if (fup) {
      const fdr = assertDateRange(f.fu_from, f.fu_to);
      where.push(`f.status = 'pending' AND (${followupWindowSql(fup, 'f.scheduled_at', params, fdr.from, fdr.to)})`);
    }
    // Today's Follow-ups KPI card → filtered list (client Aug 2026). Same predicate as the count.
    if (f.bucket) {
      const pred = followupBucketSql(String(f.bucket));
      if (!pred) throw new BadRequestException(`invalid bucket — expected one of: ${FOLLOWUP_BUCKETS.join(', ')}`);
      where.push(pred);
    }
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
              COUNT(*) FILTER (WHERE f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND (f.completed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS done_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at >= date_trunc('week', now())
                               AND f.scheduled_at < date_trunc('week', now()) + interval '7 days')::int AS this_week,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at >= date_trunc('week', now()))::int AS done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length})::int AS my_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS my_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${params.length}
                               AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS my_overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.owner_id = $${params.length}
                               AND f.completed_at >= date_trunc('week', now()))::int AS my_done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length})::int AS reported_open,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length}
                               AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS reported_due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.created_by = $${params.length}
                               AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS reported_overdue,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.created_by = $${params.length}
                               AND f.completed_at >= date_trunc('week', now()))::int AS reported_done_week
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${w}) AND f.is_active AND l.is_active
          AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, params,
    );
  }

  /**
   * 8-card KPI strip for the Today's Follow-ups screen (client Aug 2026): scope-enforced, IST.
   *   Overdue · Due Today · Next 7 Days · No-Shows · Done Today · Rescheduled · Hot Leads · Unreachable
   * Each count uses followupBucketSql(bucket) — the SAME predicate /follow-ups?bucket=… filters by —
   * so a card's number equals the length of the list it opens. Disposition buckets match on name.
   */
  async stats(scope: ResolvedScope, _userId: number) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, params);
    const cnt = (b: string) => `COUNT(*) FILTER (WHERE ${followupBucketSql(b)})::int AS ${b}`;
    return this.db.one(
      `SELECT ${FOLLOWUP_BUCKETS.map(cnt).join(',\n              ')}
         FROM follow_up f
         JOIN lead l ON l.id = f.lead_id
         LEFT JOIN m_disposition d ON d.id = f.disposition_id
        WHERE (${w}) AND f.is_active AND l.is_active
          AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, params,
    );
  }

  async create(dto: CreateFollowUpDto, actorId: number, scope: ResolvedScope) {
    if (!dto?.lead_id || !dto?.scheduled_at) throw new BadRequestException('lead_id and scheduled_at are required');
    assertNotPastSchedule(dto.scheduled_at);   // UAT-R2 #12 — no back-dated due dates
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
    // Sprint 3 — REMINDERS. When the user sets no explicit remind_at, derive one from the
    // escalation policy's `reminder_lead_minutes` (default: 30 min before it is due). The
    // worker sweeps `remind_at` and notifies the owner exactly once.
    const remindAt = dto.remind_at ?? await this.defaultRemindAt(dto.scheduled_at);
    const created = await this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO follow_up (lead_id, owner_id, type_id, disposition_id, scheduled_at, remind_at, notes, priority, created_by, report_to_id, branch_id, vertical_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [dto.lead_id, owner, dto.type_id ?? null, dto.disposition_id ?? null,
          dto.scheduled_at, remindAt, dto.notes ?? null, priority, actorId, reportTo,
          dto.branch_id ?? null, dto.vertical_id ?? null],
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
      // scheduling a follow-up IS the counsellor responding — it stops the
      // first-response SLA clock, inside this same transaction.
      await this.sla.safe(() => this.sla.onLeadTouched(dto.lead_id, c), 'sla.onLeadTouched(followup)');
      return ins.rows[0];
    });
    await this.scoring.safeRescore(dto.lead_id);
    return created;
  }

  /**
   * The default reminder time: `reminder_lead_minutes` before the follow-up is due
   * (app_setting `escalation_policy`, editable — no deploy). Never in the past relative
   * to the schedule itself, and never produced for an invalid date.
   */
  private async defaultRemindAt(scheduledAt: string): Promise<string | null> {
    const due = new Date(scheduledAt);
    if (Number.isNaN(due.getTime())) return null;
    const p = await this.settings.get('escalation_policy', { reminder_lead_minutes: 30 });
    const lead = Number((p as { reminder_lead_minutes?: number }).reminder_lead_minutes ?? 30);
    if (!Number.isFinite(lead) || lead < 0) return null;
    return new Date(due.getTime() - lead * 60_000).toISOString();
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
    if (dto.scheduled_at !== undefined) {
      // UAT-R2 #12 — moving a due date into the past is refused, but only when the due
      // DAY actually changes (re-saving an overdue task, or nudging the time within the
      // same day, is never blocked). A day-key compare — both sides parsed the same way
      // on the server — avoids the wall-clock/timezone fragility of an instant compare.
      const dayKey = (x: unknown) => { const d = new Date(x as string);
        return isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; };
      if (dayKey(dto.scheduled_at) !== dayKey(before.scheduled_at)) assertNotPastSchedule(dto.scheduled_at);
      set('scheduled_at', dto.scheduled_at);
    }
    if (dto.remind_at !== undefined) set('remind_at', dto.remind_at);
    if (dto.type_id !== undefined) set('type_id', dto.type_id);
    if (dto.disposition_id !== undefined) set('disposition_id', dto.disposition_id);
    if (dto.owner_id !== undefined) set('owner_id', dto.owner_id);
    if (dto.report_to_id !== undefined) set('report_to_id', await this.resolveReportTo(dto.report_to_id));
    // Client Aug 2026 (#2) — persist task Branch/Vertical (null clears them).
    if (dto.branch_id !== undefined) set('branch_id', dto.branch_id ?? null);
    if (dto.vertical_id !== undefined) set('vertical_id', dto.vertical_id ?? null);
    if (dto.priority !== undefined) set('priority', assertPriority(dto.priority));
    if (dto.notes !== undefined) set('notes', dto.notes);
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const saved = await this.db.tx(async (c) => {
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
      // completing / dispositioning a follow-up is the clearest possible "human touch"
      await this.sla.safe(() => this.sla.onLeadTouched(Number(before.lead_id), c), 'sla.onLeadTouched(followup update)');
      // a RESCHEDULE re-arms the reminder + escalation (they fired for the old due time)
      if (dto.scheduled_at !== undefined || dto.remind_at !== undefined) {
        await c.query(
          `UPDATE follow_up SET reminded_at = NULL, escalated_at = NULL, escalation_level = 0 WHERE id = $1`, [id],
        );
      }
      return upd.rows[0];
    });
    // followups_done feeds the engagement rule; completing one must move the score now
    await this.scoring.safeRescore(Number(before.lead_id));
    return saved;
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
    // Delegates to the shared guard (leads/active-user.util) so the "active user" rule
    // lives in exactly one place — reused by lead reassign and follow-up owner/report_to.
    await assertActiveUser(this.db, id, field);
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
