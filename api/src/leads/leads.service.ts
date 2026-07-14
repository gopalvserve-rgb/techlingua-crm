import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { JourneyService } from '../journeys/journey.service';
import { IngestPayload } from '../ingestion/ingestion.types';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { looksLikePhoneQuery, normalizePhone, phoneQueryFragments } from '../common/phone.util';
import { ScoringService } from '../scoring/scoring.service';
import { SlaService } from '../sla/sla.service';

/**
 * Sprint 2 — minimal lead APIs backing the prototype-parity UI:
 * scoped list/detail/create/update, auto-logged lead_activity timeline,
 * follow-ups CRUD with today/overdue views and a scoped summary endpoint
 * that feeds the dashboard KPIs, funnel, 14-day chart and kanban counts.
 *
 * Record scope: every query filters through buildScopeWhere on the lead's
 * denormalised path columns; by-ID routes additionally pass through
 * @ScopedEntity('lead' | 'follow_up') so out-of-scope ids 404 (QA DEF-1 policy).
 */

/**
 * Scope columns now live in rbac/scope-cols.ts (a LEAF module) because Sprint 3 made
 * this service depend on Scoring/SLA, which need the same maps — importing them back
 * from here would be a cycle. Re-exported so every existing import site is unchanged.
 */
export { LEAD_SCOPE_COLS, FOLLOWUP_SCOPE_COLS } from '../rbac/scope-cols';
import { LEAD_SCOPE_COLS, FOLLOWUP_SCOPE_COLS } from '../rbac/scope-cols';

/**
 * Lead search clause (client update #2): `q` matches name (ILIKE), email (ILIKE)
 * and phone — digits-normalised CONTAINS, country-code agnostic (a fragment like
 * "7911 123456" or "07911123456" finds `+447911123456`). Pure SQL-fragment
 * builder so the matrix unit-tests without a DB; appends to `params`.
 */
export function buildLeadSearch(q: string, params: unknown[]): string {
  const qt = q.trim();
  params.push(`%${qt}%`);
  const like = `$${params.length}`;
  // OBS backlog (b): the email index is on lower(email) (migration 014); the
  // query must match it — lower(email) LIKE lower(...) hits idx_lead_email_trgm
  // (or the btree fallback) where a bare `email ILIKE` cannot use it.
  const clauses = [`l.full_name ILIKE ${like}`, `lower(l.email) LIKE lower(${like})`, `l.phone LIKE ${like}`];
  if (looksLikePhoneQuery(qt)) {
    // country-agnostic digit-contains: compare digits against digits, with the
    // 00/trunk-0 dialing prefixes of the QUERY stripped as extra variants
    for (const frag of phoneQueryFragments(qt)) {
      params.push(`%${frag}%`);
      clauses.push(`regexp_replace(l.phone, '\\D', '', 'g') LIKE $${params.length}`);
    }
  }
  return `(${clauses.join(' OR ')})`;
}

export interface LeadFilters {
  branch_id?: number; vertical_id?: number; pipeline_id?: number; campaign_id?: number;
  stage_id?: number; status_id?: number; owner_id?: number; source_id?: number;
  /** Sprint 3 — the Hot/Warm/Cold BAND, filterable (client requirement). */
  temperature?: string;
  /** Sprint 3 — only leads with an open SLA breach / an escalation flag. */
  sla_breached?: boolean;
  flagged?: boolean;
  /** Sprint 3 — the band must be SORTABLE too. */
  sort?: string;
  q?: string; limit?: number; offset?: number;
}

/**
 * Sprint 3 — the whitelisted sort columns. A whitelist (not a passthrough) because this
 * string goes straight into ORDER BY: an unlisted value falls back to `recent`, so a
 * crafted `?sort=` can never inject SQL.
 */
const LEAD_SORTS: Record<string, string> = {
  recent: 'l.created_at DESC',
  oldest: 'l.created_at ASC',
  score: 'l.score DESC NULLS LAST, l.created_at DESC',
  score_asc: 'l.score ASC NULLS LAST, l.created_at DESC',
  name: 'l.full_name ASC',
  followup: 'l.next_follow_up_at ASC NULLS LAST',
};

export interface CreateLeadDto {
  full_name: string; phone: string; email?: string; alt_phone?: string; whatsapp_phone?: string; dob?: string;
  campaign_id: number; source_id: number;
  owner_id?: number; stage_id?: number; status_id?: number;
  priority?: 'low' | 'med' | 'high'; temperature?: 'hot' | 'warm' | 'cold'; score?: number;
  state_id?: number; city_id?: number; course_id?: number; qualification_id?: number; budget_id?: number;
  next_follow_up_at?: string; custom_fields?: Record<string, unknown>; note?: string;
}

const LEAD_UPDATABLE = [
  'full_name', 'phone', 'email', 'alt_phone', 'whatsapp_phone', 'priority', 'temperature', 'score',
  'state_id', 'city_id', 'course_id', 'qualification_id', 'budget_id',
  // Sprint 4: `dob` is what the `birthday` journey trigger fires on. It is on the Add Lead
  // form, so it must be persisted here — a field that renders and never saves is DEF-2.
  'dob',
  'next_follow_up_at', 'custom_fields', 'is_active',
] as const;

const LEAD_SELECT = `
  SELECT l.id, l.full_name, l.phone, l.email, l.alt_phone, l.whatsapp_phone, l.dob,
         l.priority, l.temperature, l.score,
         l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id, l.source_id,
         l.stage_id, l.status_id, l.owner_id, l.team_id,
         l.next_follow_up_at, l.last_activity_at, l.is_duplicate, l.custom_fields,
         l.duplicate_of_id, l.merged_into_id,
         l.score_breakdown, l.scored_at, l.is_flagged, l.flag_reason,
         EXISTS (SELECT 1 FROM lead_sla s
                  WHERE s.lead_id = l.id AND s.satisfied_at IS NULL AND s.due_at <= now()) AS sla_breached,
         l.state_id, l.city_id, l.course_id, l.qualification_id, l.budget_id,
         l.created_at, l.updated_at,
         b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name,
         c.name AS campaign_name, s.name AS source_name,
         st.name AS stage_name, st.stage_type, ms.name AS status_name,
         u.name AS owner_name, co.name AS course_name, ci.name AS city_name,
         (b.deleted_at IS NOT NULL) AS branch_deleted, (v.deleted_at IS NOT NULL) AS vertical_deleted,
         (p.deleted_at IS NOT NULL) AS pipeline_deleted, (c.deleted_at IS NOT NULL) AS campaign_deleted,
         (s.deleted_at IS NOT NULL) AS source_deleted
    FROM lead l
    JOIN branch b   ON b.id = l.branch_id
    JOIN vertical v ON v.id = l.vertical_id
    JOIN pipeline p ON p.id = l.pipeline_id
    JOIN campaign c ON c.id = l.campaign_id
    JOIN source s   ON s.id = l.source_id
    LEFT JOIN pipeline_stage st ON st.id = l.stage_id
    LEFT JOIN m_status ms ON ms.id = l.status_id
    LEFT JOIN "user" u  ON u.id = l.owner_id
    LEFT JOIN m_course co ON co.id = l.course_id
    LEFT JOIN city ci   ON ci.id = l.city_id`;

@Injectable()
export class LeadsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly ingestion: LeadIngestionService,
    // Sprint 3: the score and the SLA/TAT clocks are DERIVED state — they are refreshed
    // on every lead event, never on a nightly job only. Both are best-effort: a scoring
    // or SLA hiccup must never stop a lead being created or updated.
    private readonly scoring: ScoringService,
    private readonly sla: SlaService,
    /** Sprint 4 — a stage move is the second-most-used journey trigger after "new lead". */
    private readonly journeys?: JourneyService,
  ) {}

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  // ---- list ---------------------------------------------------------------

  async list(scope: ResolvedScope, f: LeadFilters) {
    const params: unknown[] = [];
    const where: string[] = [this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params), 'l.deleted_at IS NULL', 'l.is_active'];
    const eq = (col: string, val: unknown) => { params.push(val); where.push(`${col} = $${params.length}`); };
    if (f.branch_id) eq('l.branch_id', f.branch_id);
    if (f.vertical_id) eq('l.vertical_id', f.vertical_id);
    if (f.pipeline_id) eq('l.pipeline_id', f.pipeline_id);
    if (f.campaign_id) eq('l.campaign_id', f.campaign_id);
    if (f.stage_id) eq('l.stage_id', f.stage_id);
    if (f.status_id) eq('l.status_id', f.status_id);
    if (f.owner_id) eq('l.owner_id', f.owner_id);
    if (f.source_id) eq('l.source_id', f.source_id);
    if (f.temperature) eq('l.temperature', f.temperature);
    if (f.flagged) where.push('l.is_flagged');
    if (f.sla_breached) {
      where.push(`EXISTS (SELECT 1 FROM lead_sla s
                           WHERE s.lead_id = l.id AND s.satisfied_at IS NULL AND s.due_at <= now())`);
    }
    if (f.q) where.push(buildLeadSearch(f.q, params));
    const cond = where.join(' AND ');
    const total = await this.db.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM lead l WHERE ${cond}`, params.slice(),
    );
    params.push(Math.min(Number(f.limit) || 50, 500));
    const limIdx = params.length;
    params.push(Math.max(Number(f.offset) || 0, 0));
    const orderBy = LEAD_SORTS[String(f.sort ?? 'recent')] ?? LEAD_SORTS.recent;
    const rows = await this.db.query(
      `${LEAD_SELECT} WHERE ${cond}
        ORDER BY ${orderBy} LIMIT $${limIdx} OFFSET $${params.length}`,
      params,
    );
    return { total: total?.n ?? 0, rows };
  }

  async get(id: number) {
    const lead = await this.db.one(`${LEAD_SELECT} WHERE l.id = $1 AND l.deleted_at IS NULL`, [id]);
    if (!lead) throw new NotFoundException('lead not found');
    // stages of the lead's pipeline (for the stage stepper) — no extra permission needed
    const stages = await this.db.query(
      `SELECT id, name, sort_order, stage_type, is_default
         FROM pipeline_stage WHERE pipeline_id = $1 AND is_active ORDER BY sort_order`,
      [(lead as Record<string, unknown>).pipeline_id],
    );
    const activities = await this.activities(id);
    const followUps = await this.db.query(
      `SELECT f.*, ft.name AS type_name, d.name AS disposition_name, u.name AS owner_name
         FROM follow_up f
         LEFT JOIN m_followup_type ft ON ft.id = f.type_id
         LEFT JOIN m_disposition d ON d.id = f.disposition_id
         LEFT JOIN "user" u ON u.id = f.owner_id
        WHERE f.lead_id = $1 AND f.is_active AND f.deleted_at IS NULL
        ORDER BY f.scheduled_at DESC`,
      [id],
    );
    return { ...lead, stages, activities, follow_ups: followUps };
  }

  activities(leadId: number) {
    return this.db.query(
      `SELECT a.id, a.type, a.from_value, a.to_value, a.note, a.occurred_at, u.name AS actor_name
         FROM lead_activity a LEFT JOIN "user" u ON u.id = a.actor_id
        WHERE a.lead_id = $1 ORDER BY a.occurred_at DESC, a.id DESC LIMIT 200`,
      [leadId],
    );
  }

  // ---- create (manual / Quick Contact) -------------------------------------

  /**
   * The interactive "Add lead" entry point. Validation + RBAC live here; the
   * CRUX (phone normalisation, duplicate detection, the campaign distribution
   * engine, activity + audit, idempotency) is delegated to the ONE shared
   * LeadIngestionService that every capture channel uses — see
   * ingestion/ingestion.types.ts for the contract.
   *
   * duplicate_policy = 'always_create': a human deliberately adding a lead must
   * never be swallowed by a campaign's `ignore` rule — the lead is created and
   * FLAGGED (unchanged, client-verified behaviour). Automated channels pass
   * 'campaign' and obey duplicacy_config.on_duplicate.
   */
  async create(dto: CreateLeadDto, actorId: number, scope: ResolvedScope) {
    if (!dto?.full_name?.trim() || !dto?.phone?.trim()) {
      throw new BadRequestException('full_name and phone are required');
    }
    if (!dto.campaign_id || !dto.source_id) {
      throw new BadRequestException('campaign_id and source_id are required (leads carry the full path)');
    }
    // DEF-QA4-03: body-referenced entities must fall inside the creator's scope
    // (out-of-scope -> 404, consistent with the by-ID policy).
    await this.enforcer.assertRefInScope(scope, 'campaign', dto.campaign_id, actorId);
    await this.enforcer.assertRefInScope(scope, 'source', dto.source_id, actorId);
    await this.enforcer.assertRefInScope(scope, 'user', dto.owner_id, actorId);

    const payload: IngestPayload = {
      full_name: dto.full_name, phone: dto.phone, email: dto.email, alt_phone: dto.alt_phone,
      whatsapp_phone: dto.whatsapp_phone,
      dob: dto.dob,
      state: dto.state_id, city: dto.city_id, course: dto.course_id,
      qualification: dto.qualification_id, budget: dto.budget_id,
      status: dto.status_id, stage: dto.stage_id,
      priority: dto.priority, temperature: dto.temperature, score: dto.score,
      next_follow_up_at: dto.next_follow_up_at, note: dto.note,
      custom_fields: dto.custom_fields,
    };
    const { outcome, lead } = await this.ingestion.ingestAndReturn(payload, {
      channel: 'manual', campaign_id: dto.campaign_id, source_id: dto.source_id,
      actor_id: actorId, owner_id: dto.owner_id ?? null, duplicate_policy: 'always_create',
    });
    if (!lead) throw new BadRequestException(outcome.reason ?? 'lead could not be created');

    // Sprint 3 — a NEW lead: start its first-response SLA clock + TAT, then score it.
    await this.sla.safe(() => this.sla.onLeadCreated(Number(lead.id)), 'sla.onLeadCreated');
    await this.scoring.safeRescore(Number(lead.id));
    const scored = await this.db.one<Record<string, any>>(
      `SELECT score, temperature, score_breakdown FROM lead WHERE id = $1`, [Number(lead.id)],
    );
    return { ...lead, ...(scored ?? {}), duplicate_of: outcome.duplicate_of ?? null };
  }

  // ---- update (stage/status/owner/priority/temperature/fields) -------------

  async update(id: number, dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    const before = await this.db.one<Record<string, any>>(`SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!before) throw new NotFoundException('lead not found');
    // DEF-QA4-03: body-referenced users/teams must be inside the caller's scope.
    if (dto.owner_id != null && Number(dto.owner_id) !== Number(before.owner_id ?? 0)) {
      await this.enforcer.assertRefInScope(scope, 'user', Number(dto.owner_id), actorId);
    }
    if (dto.team_id != null && Number(dto.team_id) !== Number(before.team_id ?? 0)) {
      await this.enforcer.assertRefInScope(scope, 'team', Number(dto.team_id), actorId);
    }
    const org = Number(before.org_id);

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    const activities: Array<{ type: string; from: unknown; to: unknown }> = [];
    const fieldChanges: Record<string, { from: unknown; to: unknown }> = {};

    if (dto.stage_id !== undefined && Number(dto.stage_id) !== Number(before.stage_id)) {
      const stage = await this.db.one<{ id: string; name: string; pipeline_id: string }>(
        `SELECT id, name, pipeline_id FROM pipeline_stage WHERE id = $1`, [Number(dto.stage_id)],
      );
      if (!stage || Number(stage.pipeline_id) !== Number(before.pipeline_id)) {
        throw new BadRequestException('stage does not belong to the lead pipeline');
      }
      const from = await this.db.one<{ name: string }>(`SELECT name FROM pipeline_stage WHERE id = $1`, [before.stage_id]);
      set('stage_id', Number(dto.stage_id));
      activities.push({ type: 'stage_change', from: { id: before.stage_id, name: from?.name }, to: { id: stage.id, name: stage.name } });
    }
    if (dto.status_id !== undefined && Number(dto.status_id) !== Number(before.status_id)) {
      const to = await this.db.one<{ name: string }>(`SELECT name FROM m_status WHERE id = $1`, [Number(dto.status_id)]);
      if (!to) throw new BadRequestException('unknown status');
      const from = await this.db.one<{ name: string }>(`SELECT name FROM m_status WHERE id = $1`, [before.status_id]);
      set('status_id', Number(dto.status_id));
      activities.push({ type: 'status_change', from: { id: before.status_id, name: from?.name }, to: { id: dto.status_id, name: to.name } });
    }
    if (dto.owner_id !== undefined && Number(dto.owner_id ?? 0) !== Number(before.owner_id ?? 0)) {
      const ownerId = dto.owner_id == null ? null : Number(dto.owner_id);
      if (ownerId != null) {
        const u = await this.db.one(`SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [ownerId]);
        if (!u) throw new BadRequestException('unknown owner');
      }
      set('owner_id', ownerId);
      activities.push({ type: 'assign', from: { owner_id: before.owner_id }, to: { owner_id: ownerId } });
    }
    if (dto.team_id !== undefined) set('team_id', dto.team_id == null ? null : Number(dto.team_id));

    for (const col of LEAD_UPDATABLE) {
      if (dto[col] === undefined) continue;
      let val = col === 'custom_fields' ? JSON.stringify(dto[col] ?? {}) : dto[col];
      // DEF-QA4-02: phones are normalised on write everywhere, not only on create
      if ((col === 'phone' || col === 'alt_phone' || col === 'whatsapp_phone') && val != null) {
        val = String(val).trim() === '' ? null : normalizePhone(String(val));
      }
      if (col === 'priority' && !['low', 'med', 'high'].includes(String(val))) throw new BadRequestException('invalid priority');
      if (col === 'temperature' && val != null && !['hot', 'warm', 'cold'].includes(String(val))) throw new BadRequestException('invalid temperature');
      set(col, val as unknown);
      if (String(before[col] ?? '') !== String(dto[col] ?? '')) fieldChanges[col] = { from: before[col], to: dto[col] };
    }
    if (Object.keys(fieldChanges).length) activities.push({ type: 'field_change', from: null, to: fieldChanges });

    // DEF-QA4-04: a PATCH where every provided value equals the current one is a
    // 200 no-op returning the current entity (kanban drag-to-same-column,
    // double-save). 400 stays reserved for a body with nothing recognisable.
    if (!sets.length && !dto.note) {
      const recognised = ['stage_id', 'status_id', 'owner_id', 'team_id', 'note', ...LEAD_UPDATABLE];
      const touched = recognised.some((k) => dto[k] !== undefined);
      if (!touched) throw new BadRequestException('nothing to update');
      return before;
    }

    params.push(id);
    const saved = await this.db.tx(async (c) => {
      const upd = sets.length
        ? await c.query(
            `UPDATE lead SET ${sets.join(', ')}, last_activity_at = now(), updated_at = now()
              WHERE id = $${params.length} RETURNING *`, params,
          )
        : { rows: [before] };
      for (const a of activities) {
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, org, before.branch_id, actorId, a.type,
            a.from == null ? null : JSON.stringify(a.from), a.to == null ? null : JSON.stringify(a.to)],
        );
      }
      if (dto.note) {
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note)
           VALUES ($1,$2,$3,$4,'note',$5)`, [id, org, before.branch_id, actorId, String(dto.note)],
        );
      }

      // Sprint 3 — SLA/TAT inside the SAME transaction as the change that caused it, so
      // the stage TAT row and the stage move can never disagree.
      const stageMoved = activities.some((a) => a.type === 'stage_change');
      if (stageMoved) {
        const to = upd.rows[0]?.stage_id ?? null;
        await this.sla.safe(() => this.sla.onStageChanged(id, to ? Number(to) : null, c), 'sla.onStageChanged');
      } else if (activities.length || dto.note) {
        // any human touch (note, assign, field change, disposition) stops the
        // first-response clock — that IS the response
        await this.sla.safe(() => this.sla.onLeadTouched(id, c), 'sla.onLeadTouched');
      }
      return upd.rows[0];
    });

    // the score depends on stage/priority/course/budget/email/whatsapp — all updatable
    await this.scoring.safeRescore(id);
    const rescored = await this.db.one<Record<string, any>>(
      `SELECT score, temperature, score_breakdown, is_flagged, flag_reason FROM lead WHERE id = $1`, [id],
    );

    // Sprint 4 — fire `stage_changed` AFTER the transaction commits and AFTER the rescore,
    // so a journey conditioned on the new stage (or on the score that stage produced) sees
    // the lead as it now IS. Best-effort: automation must never fail a save.
    if (dto.stage_id !== undefined && Number(dto.stage_id) !== Number(before.stage_id)) {
      await this.journeys?.safeFire('stage_changed', id, { stage_id: Number(dto.stage_id) });
    }
    return { ...saved, ...(rescored ?? {}) };
  }

  /** Append a free-text note to the timeline. */
  async addNote(id: number, note: string, actorId: number) {
    if (!note?.trim()) throw new BadRequestException('note is required');
    const lead = await this.db.one<{ org_id: string; branch_id: string }>(`SELECT org_id, branch_id FROM lead WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!lead) throw new NotFoundException('lead not found');
    await this.db.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note) VALUES ($1,$2,$3,$4,'note',$5)`,
      [id, Number(lead.org_id), Number(lead.branch_id), actorId, note.trim()],
    );
    await this.db.query(`UPDATE lead SET last_activity_at = now() WHERE id = $1`, [id]);
    // a note is a human touch: it stops the first-response clock and refreshes the score
    // (the no-response penalty must lift the moment somebody actually responds)
    await this.sla.safe(() => this.sla.onLeadTouched(id), 'sla.onLeadTouched(note)');
    await this.scoring.safeRescore(id);
    return { ok: true };
  }

  // ---- dashboard summary (all scope-filtered) ------------------------------

  async summary(scope: ResolvedScope, userId: number) {
    const p1: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p1);
    const kpis = await this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE l.created_at::date = CURRENT_DATE)::int AS today,
              COUNT(*) FILTER (WHERE l.created_at >= date_trunc('month', now()))::int AS mtd,
              COUNT(*) FILTER (WHERE st.stage_type = 'won')::int AS won,
              COUNT(*) FILTER (WHERE st.stage_type = 'won' AND l.updated_at::date = CURRENT_DATE)::int AS won_today,
              COUNT(*) FILTER (WHERE l.temperature = 'hot')::int AS hot,
              COUNT(*) FILTER (WHERE l.temperature = 'warm')::int AS warm,
              COUNT(*) FILTER (WHERE l.temperature = 'cold')::int AS cold,
              COUNT(*) FILTER (WHERE ms.code = 'WALKIN')::int AS walkins
         FROM lead l
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
         LEFT JOIN source so ON so.id = l.source_id
         LEFT JOIN m_source ms ON ms.id = so.master_source_id
        WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL`, p1.slice(),
    );
    const byStage = await this.db.query(
      `SELECT st.id AS stage_id, st.name, st.stage_type, st.sort_order, st.pipeline_id, COUNT(l.id)::int AS ct
         FROM lead l JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL
        GROUP BY st.id, st.name, st.stage_type, st.sort_order, st.pipeline_id
        ORDER BY st.sort_order`, p1.slice(),
    );
    const series = await this.db.query(
      `SELECT d::date AS day,
              (SELECT COUNT(*)::int FROM lead l
                WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL AND l.created_at::date = d::date) AS leads,
              (SELECT COUNT(*)::int FROM lead l JOIN pipeline_stage st ON st.id = l.stage_id
                WHERE (${w}) AND l.is_active AND l.deleted_at IS NULL AND st.stage_type = 'won'
                  AND l.updated_at::date = d::date) AS won
         FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, '1 day') d
        ORDER BY d`, p1.slice(),
    );

    // follow-up KPIs under the followup.read scope would need a second resolve;
    // dashboards use the lead scope (leads the user can see -> their follow-ups).
    const p2: unknown[] = [];
    const wf = this.resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, p2);
    p2.push(userId);
    const fu = await this.db.one(
      `SELECT COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at::date = CURRENT_DATE)::int AS due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.scheduled_at < date_trunc('day', now()))::int AS overdue,
              COUNT(*) FILTER (WHERE f.status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at::date = CURRENT_DATE)::int AS done_today,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at >= date_trunc('week', now()))::int AS done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${p2.length})::int AS my_open
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${wf}) AND f.is_active AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, p2,
    );
    return { kpis, by_stage: byStage, series, follow_ups: fu };
  }
}
