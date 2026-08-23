import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { LeadMergeService } from '../ingestion/merge.service';
import { MERGEABLE_FIELDS } from '../ingestion/merge.util';
import { JourneyService } from '../journeys/journey.service';
import { NotificationEventService } from '../notificationevents/notification-event.service';
import { IngestPayload } from '../ingestion/ingestion.types';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { looksLikePhoneQuery, normalizePhone, phoneQueryFragments } from '../common/phone.util';
import { assertActiveUser } from './active-user.util';
import { assertDateRange, SQL_TODAY, istDay, assertFollowupPreset, followupWindowSql, FollowupPreset } from '../common/date.util';
import { DistributionConfig } from './distribution.util';
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
  /** Multi-select filters (client, Aug 2026): each list filter accepts an ARRAY of ids —
   *  `col IN (...)` (OR within a filter), ANDed across filters, on top of RBAC scope. The
   *  singular params above keep working (card links / back-compat) and fold into the IN. */
  branch_ids?: number[]; vertical_ids?: number[]; pipeline_ids?: number[]; campaign_ids?: number[];
  status_ids?: number[]; owner_ids?: number[]; source_ids?: number[]; stage_ids?: number[];
  /** Multi-select score band (Hot/Warm/Cold) — whitelisted, `l.temperature IN (...)`. */
  bands?: string[];
  /** Sprint 3 — only leads with an open SLA breach / an escalation flag. */
  sla_breached?: boolean;
  flagged?: boolean;
  /** Red-flag filter (client, Aug 2026): only leads currently RED-flagged. */
  red_flagged?: boolean;
  /** Client change (Jul 2026): the "Duplicates" filter — leads marked is_duplicate. */
  duplicate?: boolean;
  /** Bulk actions (Jul 2026): only leads currently PAUSED (parked out of distribution/SLA). */
  paused?: boolean;
  /** Dashboard card links (Aug 2026): only WON leads (current stage_type = 'won') — the
   *  Conversions cards; and only UNASSIGNED leads (owner_id IS NULL) — the Unassigned card. */
  won?: boolean;
  /** Quick Stats card link (Aug 2026): only LOST leads (current stage_type = 'lost'). */
  lost?: boolean;
  unassigned?: boolean;
  /** Sprint 3 — the band must be SORTABLE too. */
  sort?: string;
  /** UAT-R2 #26 — created-date range (YYYY-MM-DD), inclusive of both ends. */
  created_from?: string; created_to?: string;
  /** Follow-up date filter (client #3) — the lead's "next follow-up", evaluated over the
   *  lead's PENDING follow-ups in IST. preset + optional custom range (fu_from/fu_to). */
  followup?: FollowupPreset;
  fu_from?: string; fu_to?: string;
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
  status: 'ms.name ASC NULLS LAST, l.created_at DESC',
  created_asc: 'l.created_at ASC',
};

export interface CreateLeadDto {
  full_name: string; phone: string; email?: string; alt_phone?: string; whatsapp_phone?: string; dob?: string;
  campaign_id: number; source_id: number;
  owner_id?: number; stage_id?: number; status_id?: number;
  /** dev/84 item 3 — round-robin on a MANUAL lead: when true, any picked owner_id is
   *  ignored and the campaign distribution engine assigns the owner (reuses the walk-in /
   *  campaign round-robin — no re-implementation). */
  round_robin?: boolean;
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
         l.is_red_flagged, l.red_flagged_at,
         l.paused, l.paused_at,
         l.is_existing_student, l.existing_student_id,
         es.full_name AS existing_student_name, es.student_no AS existing_student_no,
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
    LEFT JOIN city ci   ON ci.id = l.city_id
    LEFT JOIN student es ON es.id = l.existing_student_id`;

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
    /** Notification Events — fires `lead_assigned` when a lead's owner (counsellor) is set. */
    private readonly notifEvents?: NotificationEventService,
    // dev/129: re-parent (Transfer / edit-change-campaign) re-runs the NEW campaign's duplicate
    // rule against the new scope; the merge core folds/reopens through this service. Optional +
    // trailing so the in-memory unit doubles that construct LeadsService by hand stay unchanged
    // (Nest resolves it by type from IngestionModule in the running app).
    private readonly merge?: LeadMergeService,
  ) {}

  /** Hard cap on the size of ONE bulk action / select-all, so a runaway selection cannot
   *  block the event loop or a transaction. The UI narrows the filter past this. */
  static readonly BULK_MAX = 2000;

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  // ---- list ---------------------------------------------------------------

  /** Shared list/select filter WHERE (scope + the Batch-B filters). Reused by list() and
   *  selectIds() so the "select all matching filter" affordance and the paged list can
   *  never diverge on which leads a filter matches. Appends to `params`. */
  private leadFilterWhere(scope: ResolvedScope, f: LeadFilters, params: unknown[]): string {
    const where: string[] = [this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params), 'l.deleted_at IS NULL', 'l.is_active'];
    const eq = (col: string, val: unknown) => { params.push(val); where.push(`${col} = $${params.length}`); };
    // Multi-select filters (client, Aug 2026): each accepts an ARRAY -> `col IN (...)` (OR
    // within a filter), ANDed across filters, all on top of the RBAC scope above. A present
    // singular param (card links / back-compat) is folded into the same IN. Ints only.
    const inCol = (col: string, single: number | undefined, arr: number[] | undefined) => {
      const vals = [...new Set([...(arr ?? []), ...(single != null ? [single] : [])])]
        .map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!vals.length) return;
      const ph = vals.map((v) => { params.push(v); return `$${params.length}`; });
      where.push(`${col} IN (${ph.join(',')})`);
    };
    inCol('l.branch_id', f.branch_id, f.branch_ids);
    inCol('l.vertical_id', f.vertical_id, f.vertical_ids);
    inCol('l.pipeline_id', f.pipeline_id, f.pipeline_ids);
    inCol('l.campaign_id', f.campaign_id, f.campaign_ids);
    inCol('l.stage_id', f.stage_id, f.stage_ids);
    inCol('l.status_id', f.status_id, f.status_ids);
    inCol('l.owner_id', f.owner_id, f.owner_ids);
    inCol('l.source_id', f.source_id, f.source_ids);
    // Band (Hot/Warm/Cold) is multi-select too: whitelist the 3 valid values (this reaches a
    // WHERE, so never trusted) -> `l.temperature IN (...)`; the legacy singular ?temperature=
    // still emits `= $` for back-compat with card links + existing tests.
    {
      const bands = [...new Set(f.bands ?? [])].filter((x) => x === 'hot' || x === 'warm' || x === 'cold');
      if (bands.length) {
        const ph = bands.map((v) => { params.push(v); return `$${params.length}`; });
        where.push(`l.temperature IN (${ph.join(',')})`);
      } else if (f.temperature) { eq('l.temperature', f.temperature); }
    }
    // UAT-R2 #26 — created-date range: `to` is made inclusive by using < next day.
    // DEF-DR-02: route through the ONE strict validator so a malformed date is a 400, not a 500.
    const _dr = assertDateRange(f.created_from, f.created_to);
    if (_dr.from) { params.push(_dr.from); where.push(`l.created_at >= $${params.length}::date`); }
    if (_dr.to) { params.push(_dr.to); where.push(`l.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (f.flagged) where.push('l.is_flagged');
    if (f.red_flagged) where.push('l.is_red_flagged');
    if (f.duplicate) where.push('l.is_duplicate');
    // Bulk actions (Jul 2026): the paused-only filter (find parked leads to resume).
    if (f.paused) where.push('l.paused');
    // Dashboard card links (Aug 2026): Conversions -> won (current stage is a 'won' stage,
    // via EXISTS so the COUNT query needs no pipeline_stage join); Unassigned -> no owner.
    if (f.won) where.push(`EXISTS (SELECT 1 FROM pipeline_stage ps WHERE ps.id = l.stage_id AND ps.stage_type = 'won')`);
    if (f.lost) where.push(`EXISTS (SELECT 1 FROM pipeline_stage ps WHERE ps.id = l.stage_id AND ps.stage_type = 'lost')`);
    if (f.unassigned) where.push('l.owner_id IS NULL');
    if (f.sla_breached) {
      where.push(`EXISTS (SELECT 1 FROM lead_sla s
                           WHERE s.lead_id = l.id AND s.satisfied_at IS NULL AND s.due_at <= now())`);
    }
    // Follow-up date filter (client #3): "next follow-up" is a lead attribute. We evaluate it
    // over the lead's PENDING follow-ups (robust to a stale next_follow_up_at cache), in IST,
    // so a preset selects exactly the same window the follow-ups list uses on scheduled_at.
    const fup = assertFollowupPreset(f.followup);
    if (fup) {
      const PEND = `SELECT 1 FROM follow_up fu WHERE fu.lead_id = l.id AND fu.status = 'pending' AND fu.deleted_at IS NULL AND fu.is_active`;
      if (fup === 'no_followup') where.push(`NOT EXISTS (${PEND})`);
      else if (fup === 'missed') where.push(`EXISTS (${PEND} AND fu.scheduled_at < now())`);
      else {
        const fdr = assertDateRange(f.fu_from, f.fu_to);
        const win = followupWindowSql(fup, 'fu.scheduled_at', params, fdr.from, fdr.to);
        where.push(`EXISTS (${PEND} AND (${win}))`);
      }
    }
    if (f.q) where.push(buildLeadSearch(f.q, params));
    return where.join(' AND ');
  }

  async list(scope: ResolvedScope, f: LeadFilters) {
    const params: unknown[] = [];
    const cond = this.leadFilterWhere(scope, f, params);
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

  /**
   * Bulk actions (Jul 2026) — "select all matching filter". Returns just the lead IDs that
   * match the SAME filters + record scope as list(), capped at BULK_MAX, so the UI can turn
   * a filtered view into a bulk selection without paging. Ids only (small payload).
   */
  async selectIds(scope: ResolvedScope, f: LeadFilters) {
    const params: unknown[] = [];
    const cond = this.leadFilterWhere(scope, f, params);
    const total = await this.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM lead l WHERE ${cond}`, params.slice());
    params.push(LeadsService.BULK_MAX);
    const rows = await this.db.query<{ id: string }>(
      `SELECT l.id FROM lead l WHERE ${cond} ORDER BY l.id LIMIT $${params.length}`, params,
    );
    const ids = rows.map((r) => Number(r.id));
    return { ids, total: total?.n ?? 0, capped: (total?.n ?? 0) > ids.length };
  }

  /** Rows for the CSV export — same filters + record scope as list(), capped at BULK_MAX.
   *  Client (Aug 2026): the CSV must read the way the screen does — every column is a NAME /
   *  label / formatted value, never a bare foreign-key id. We keep selecting the denormalised
   *  *_name columns (owner_name, branch_name, status_name, …) and project each row onto an
   *  ordered set of display columns, expanding lead.custom_fields by their admin-defined labels. */
  async exportRows(scope: ResolvedScope, f: LeadFilters) {
    const params: unknown[] = [];
    const cond = this.leadFilterWhere(scope, f, params);
    params.push(LeadsService.BULK_MAX);
    const rows = await this.db.query(
      `${LEAD_SELECT} WHERE ${cond} ORDER BY l.created_at DESC LIMIT $${params.length}`, params,
    );
    // custom-field DEFINITIONS for leads → export their VALUES under the human label.
    const cfDefs = await this.db.query<{ field_key: string; label: string; data_type: string }>(
      `SELECT field_key, label, data_type FROM custom_field_def
        WHERE entity = 'lead' AND deleted_at IS NULL AND is_active
        ORDER BY sort_order ASC, id ASC`,
    );
    const out = rows.map((r) => LeadsService.toExportRow(r as Record<string, unknown>, cfDefs));
    return { rows: out, count: out.length, capped: rows.length >= LeadsService.BULK_MAX };
  }

  /** Title-case a snake/lower code for display ("hot" → "Hot", "high" → "High"). */
  private static titleCase(v: unknown): string {
    const s = v == null ? '' : String(v).trim();
    if (!s) return '';
    return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Format a timestamp as IST "dd/mm/yyyy, hh:mm" (blank when empty/invalid). */
  private static fmtDateTime(v: unknown): string {
    if (v == null || v === '') return '';
    const d = new Date(v as string);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  private static yesNo(v: unknown): string { return v ? 'Yes' : 'No'; }

  /** Project a raw LEAD_SELECT row → ordered, human-readable export columns (names, not ids). */
  private static toExportRow(
    r: Record<string, unknown>,
    cfDefs: { field_key: string; label: string; data_type: string }[],
  ): Record<string, string | number> {
    const TEMP: Record<string, string> = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };
    const temp = r.temperature != null && r.temperature !== ''
      ? (TEMP[String(r.temperature).toLowerCase()] ?? LeadsService.titleCase(r.temperature)) : '';
    const out: Record<string, string | number> = {
      'Name': (r.full_name as string) ?? '',
      'Phone': (r.phone as string) ?? '',
      'Alt Phone': (r.alt_phone as string) ?? '',
      'WhatsApp': (r.whatsapp_phone as string) ?? '',
      'Email': (r.email as string) ?? '',
      'Owner': (r.owner_name as string) ?? '',
      'Branch': (r.branch_name as string) ?? '',
      'Vertical': (r.vertical_name as string) ?? '',
      'Pipeline': (r.pipeline_name as string) ?? '',
      'Campaign': (r.campaign_name as string) ?? '',
      'Source': (r.source_name as string) ?? '',
      'Stage': (r.stage_name as string) ?? '',
      'Status': (r.status_name as string) ?? '',
      'Course': (r.course_name as string) ?? '',
      'City': (r.city_name as string) ?? '',
      'Temperature': temp,
      'Priority': LeadsService.titleCase(r.priority),
      'Score': (r.score as number) ?? 0,
      'Duplicate': LeadsService.yesNo(r.is_duplicate),
      'Red Flagged': LeadsService.yesNo(r.is_red_flagged),
      'Paused': LeadsService.yesNo(r.paused),
      'Next Follow-up': LeadsService.fmtDateTime(r.next_follow_up_at),
      'Last Activity': LeadsService.fmtDateTime(r.last_activity_at),
      'Created At': LeadsService.fmtDateTime(r.created_at),
      'Updated At': LeadsService.fmtDateTime(r.updated_at),
    };
    const cf = (r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {}) as Record<string, unknown>;
    for (const d of cfDefs) {
      let val = cf[d.field_key];
      if (Array.isArray(val)) val = val.join('; ');
      else if (d.data_type === 'bool') val = val ? 'Yes' : 'No';
      out[d.label] = val == null ? '' : String(val);
    }
    return out;
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
    const redFlags = await this.redFlags(id);
    return { ...lead, stages, activities, follow_ups: followUps, red_flags: redFlags };
  }

  activities(leadId: number) {
    return this.db.query(
      `SELECT a.id, a.type, a.from_value, a.to_value, a.note, a.occurred_at, a.actor_name
         FROM lead_activity a
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
    // dev/84 item 3 — round-robin on a manual lead: when the user ticks "Assign via
    // round-robin" we DROP any picked owner and let the campaign distribution engine
    // (equal round-robin / conditional) assign the owner, exactly like a walk-in with
    // round_robin=true or a CSV/webhook lead. No re-implementation — the same engine.
    const forcedOwner = dto.round_robin ? null : (dto.owner_id ?? null);
    await this.enforcer.assertRefInScope(scope, 'user', forcedOwner ?? undefined, actorId);

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
      actor_id: actorId, owner_id: forcedOwner, duplicate_policy: 'always_create',
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

  /**
   * UAT-R3 #23 — reassign a lead's OWNER to another user. Delegates to update() so the
   * owner-change path is exactly the tested one: the target must be ACTIVE and inside the
   * caller's scope (assertRefInScope), an 'assign' lead_activity is written to the timeline,
   * the first-response SLA clock is touched, and audit_log is written by the global
   * interceptor. The controller gates this on `lead.assign` (not `lead.update`), so only a
   * user who may reassign can. Per the NeoDove open-lead rule, reassigning an open lead
   * moves ownership immediately.
   */
  async reassign(id: number, ownerId: number, actorId: number, scope: ResolvedScope) {
    if (!Number.isInteger(Number(ownerId)) || Number(ownerId) <= 0) {
      throw new BadRequestException('owner_id (the user to reassign the lead to) is required');
    }
    const out = await this.update(id, { owner_id: Number(ownerId) }, actorId, scope);
    // Notification Events — a counsellor was assigned. dedupe on owner so re-assigning to a
    // DIFFERENT counsellor fires again, but a no-op re-save does not.
    await this.notifEvents?.safeFire('lead_assigned', { lead_id: Number(id), dedupe: `${id}:${ownerId}` });
    return out;
  }

  /**
   * Users row action #7 — BULK hand-off: reassign EVERY lead currently owned by user X
   * to user Y. Scope-safe (only leads the caller may see are moved), reuses the per-lead
   * reassign path (update → active-user guard + 'assign' timeline activity + SLA touch),
   * and writes one audit_log 'transfer' row per lead. Returns the moved count.
   */
  async reassignAllOwned(fromUserId: number, toUserId: number, actorId: number, scope: ResolvedScope) {
    const from = Number(fromUserId);
    const to = Number(toUserId);
    if (!Number.isInteger(from) || from <= 0) throw new BadRequestException('from_user_id (the user whose leads move) is required');
    if (!Number.isInteger(to) || to <= 0) throw new BadRequestException('to_user_id (the user to reassign the leads to) is required');
    if (from === to) throw new BadRequestException('to_user_id must be different from from_user_id');
    // target must be an ACTIVE user AND inside the caller's scope (same guards as single reassign)
    await assertActiveUser(this.db, to, 'to_user_id');
    await this.enforcer.assertRefInScope(scope, 'user', to, actorId);
    // the leads to move: owned by `from` AND visible to the caller (scope WHERE)
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    params.push(from);
    const owned = await this.db.query<{ id: string; org_id: string }>(
      `SELECT l.id, l.org_id FROM lead l
        WHERE (${where}) AND l.deleted_at IS NULL AND l.is_active AND l.owner_id = $${params.length}
        ORDER BY l.id`,
      params,
    );
    let moved = 0;
    for (const l of owned) {
      await this.update(Number(l.id), { owner_id: to }, actorId, scope);
      await this.db.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
         VALUES ($1,$2,'lead',$3,'transfer',$4,$5)`,
        [Number(l.org_id), actorId, Number(l.id),
          JSON.stringify({ owner_id: from }), JSON.stringify({ owner_id: to })],
      );
      moved++;
    }
    return { moved, from_user_id: from, to_user_id: to };
  }

  // ==========================================================================
  // LEAD TRANSFER + BULK ACTIONS (client request, Jul 2026)
  // ==========================================================================
  // Transfer moves a lead to another Branch/Vertical/(Pipeline)/Campaign, re-denormalising
  // the full path in one transaction exactly like the pipeline re-parent. Bulk actions run
  // the same per-lead primitives over a scoped id set, RBAC-skipping anything the caller may
  // not see, writing per-lead audit + activity, idempotent, returning counts.

  /** "Branch > Vertical > Campaign" label for a campaign, for the timeline note. */
  private async pathLabel(campaignId: number): Promise<string> {
    const r = await this.db.one<{ b: string; v: string; c: string }>(
      `SELECT b.name AS b, v.name AS v, c.name AS c
         FROM campaign c JOIN branch b ON b.id = c.branch_id JOIN vertical v ON v.id = c.vertical_id
        WHERE c.id = $1`, [campaignId]);
    return r ? `${r.b} › ${r.v} › ${r.c}` : `campaign #${campaignId}`;
  }

  /** Resolve (and RBAC-check) a transfer target from a campaign_id. Branch/Vertical/Pipeline
   *  are DERIVED from the campaign; a mismatching id in the body is a 400. Picks/creates the
   *  in-campaign source. Returns the fully-derived target the transfer applies. */
  private async resolveTransferTarget(dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    const campaignId = Number(dto.campaign_id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      throw new BadRequestException('campaign_id (the target campaign) is required');
    }
    const camp = await this.db.one<any>(
      `SELECT id, org_id, branch_id, vertical_id, pipeline_id, distribution_config, duplicacy_config, name
         FROM campaign WHERE id = $1 AND is_active AND deleted_at IS NULL`, [campaignId]);
    if (!camp) throw new NotFoundException('target campaign not found');
    const mismatch = (k: string, v: unknown) =>
      dto[k] != null && String(dto[k]) !== '' && Number(dto[k]) !== Number(v);
    if (mismatch('branch_id', camp.branch_id) || mismatch('vertical_id', camp.vertical_id) || mismatch('pipeline_id', camp.pipeline_id)) {
      throw new BadRequestException('branch/vertical/pipeline do not match the target campaign');
    }
    // RBAC: the caller can only transfer INTO a campaign inside their scope.
    await this.enforcer.assertRefInScope(scope, 'campaign', campaignId, actorId);
    const source_id = await this.resolveTargetSource(camp, dto.source_id, actorId);
    const st = await this.db.one<{ id: string }>(
      `SELECT id FROM pipeline_stage WHERE pipeline_id = $1 AND is_active
        ORDER BY is_default DESC, sort_order ASC LIMIT 1`, [Number(camp.pipeline_id)]);
    return {
      org_id: Number(camp.org_id), branch_id: Number(camp.branch_id), vertical_id: Number(camp.vertical_id),
      pipeline_id: Number(camp.pipeline_id), campaign_id: campaignId, source_id,
      distribution: (camp.distribution_config ?? {}) as DistributionConfig,
      duplicacy: (camp.duplicacy_config ?? {}) as {
        check_scope?: string; on_duplicate?: string; open_reassign_same_user?: boolean;
      },
      default_stage_id: st ? Number(st.id) : null,
      label: await this.pathLabel(campaignId),
    };
  }

  /** A source under the target campaign: an explicit one (validated), else an existing active
   *  one (preferring a manual source), else a freshly-created "Transferred in" manual source. */
  private async resolveTargetSource(camp: any, explicit: unknown, actorId: number): Promise<number> {
    const campaignId = Number(camp.id);
    if (explicit != null && String(explicit) !== '') {
      const s = await this.db.one<{ id: string }>(
        `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`,
        [Number(explicit), campaignId]);
      if (!s) throw new BadRequestException('source does not belong to the target campaign');
      return Number(s.id);
    }
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM source WHERE campaign_id = $1 AND deleted_at IS NULL AND is_active
        ORDER BY (channel = 'manual') DESC, id ASC LIMIT 1`, [campaignId]);
    if (existing) return Number(existing.id);
    const created = await this.db.one<{ id: string }>(
      `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, name, channel,
                           config, cost_per_lead, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,'Transferred in','manual','{}'::jsonb,0,TRUE,$6) RETURNING id`,
      [Number(camp.org_id), Number(camp.branch_id), Number(camp.vertical_id), Number(camp.pipeline_id), campaignId, actorId]);
    if (!created) throw new BadRequestException('could not create a source under the target campaign');
    return Number(created.id);
  }

  /** Apply ONE lead transfer in a single transaction (path re-denormalisation + owner
   *  behaviour + activity + audit). Shared by the single and bulk transfer endpoints. */
  private async transferOneLead(
    leadId: number, target: Awaited<ReturnType<LeadsService['resolveTransferTarget']>>,
    ownerMode: 'keep' | 'distribute', actorId: number,
  ) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [leadId]);
    if (!before) throw new NotFoundException('lead not found');
    const org = Number(before.org_id);
    const fromLabel = await this.pathLabel(Number(before.campaign_id));
    const crossPipeline = Number(before.pipeline_id) !== target.pipeline_id;
    const prevOwner = before.owner_id == null ? null : Number(before.owner_id);

    // distribute owner: resolve the eligible pool up front (pool hygiene queries), pick inside tx.
    let pool: number[] = [];
    let assignNote: string | null = null;
    if (ownerMode === 'distribute') {
      const ctx: Record<string, unknown> = {
        course_id: before.course_id, city_id: before.city_id, state_id: before.state_id,
        budget_id: before.budget_id, temperature: before.temperature, priority: before.priority,
      };
      const r = await this.ingestion.resolvePool(
        { campaign_id: target.campaign_id, distribution: target.distribution } as any, ctx);
      pool = r.pool; assignNote = r.note;
    }

    const saved = await this.db.tx(async (c) => {
      let ownerId = prevOwner;
      if (ownerMode === 'distribute' && pool.length) {
        const picked = await this.ingestion.pickOwner(c, target.campaign_id, pool);
        if (picked != null) ownerId = Number(picked);
      }
      const newStage = crossPipeline ? target.default_stage_id : (before.stage_id == null ? null : Number(before.stage_id));
      const upd = await c.query(
        `UPDATE lead SET branch_id = $1, vertical_id = $2, pipeline_id = $3, campaign_id = $4,
                source_id = $5, stage_id = $6, owner_id = $7, updated_at = now(), last_activity_at = now()
          WHERE id = $8 RETURNING *`,
        [target.branch_id, target.vertical_id, target.pipeline_id, target.campaign_id,
          target.source_id, newStage, ownerId, leadId]);
      // the transfer timeline event
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
         VALUES ($1,$2,$3,$4,'transfer',$5,$6,$7)`,
        [leadId, org, target.branch_id, actorId,
          JSON.stringify({ branch_id: Number(before.branch_id), vertical_id: Number(before.vertical_id),
            pipeline_id: Number(before.pipeline_id), campaign_id: Number(before.campaign_id),
            source_id: Number(before.source_id), owner_id: prevOwner }),
          JSON.stringify({ branch_id: target.branch_id, vertical_id: target.vertical_id,
            pipeline_id: target.pipeline_id, campaign_id: target.campaign_id,
            source_id: target.source_id, owner_id: ownerId }),
          `Transferred from ${fromLabel} to ${target.label}`]);
      // owner-change event when distribution moved it
      if (ownerMode === 'distribute' && ownerId !== prevOwner) {
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
           VALUES ($1,$2,$3,$4,'assign',$5,$6,$7)`,
          [leadId, org, target.branch_id, actorId,
            JSON.stringify({ owner_id: prevOwner }), JSON.stringify({ owner_id: ownerId }),
            assignNote ? `Transfer: ${assignNote}` : 'Transfer: assigned via the target campaign distribution']);
      }
      // crossing pipelines resets the stage to the target pipeline's entry stage — record the
      // stage move + drive the SLA/TAT clocks in the SAME transaction.
      if (crossPipeline) {
        if (Number(before.stage_id ?? 0) !== Number(newStage ?? 0)) {
          await c.query(
            `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value)
             VALUES ($1,$2,$3,$4,'stage_change',$5,$6)`,
            [leadId, org, target.branch_id, actorId,
              JSON.stringify({ id: before.stage_id }), JSON.stringify({ id: newStage })]);
        }
        await this.sla.safe(() => this.sla.onStageChanged(leadId, newStage ? Number(newStage) : null, c), 'sla.onStageChanged');
      }
      // per-lead audit row (the interceptor writes ONE summary row for the request; this is the
      // per-lead trail the client can audit — matching reassign-all's shape).
      await c.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
         VALUES ($1,$2,'lead',$3,'transfer',$4,$5)`,
        [org, actorId, leadId,
          JSON.stringify({ branch_id: Number(before.branch_id), vertical_id: Number(before.vertical_id),
            pipeline_id: Number(before.pipeline_id), campaign_id: Number(before.campaign_id), owner_id: prevOwner }),
          JSON.stringify({ branch_id: target.branch_id, vertical_id: target.vertical_id,
            pipeline_id: target.pipeline_id, campaign_id: target.campaign_id, owner_id: ownerId })]);
      return upd.rows[0];
    });
    await this.scoring.safeRescore(leadId);
    // dev/129 (bug #1): the lead now lives under a NEW Branch/Vertical/Campaign, so the
    // duplicate rule must be re-evaluated against the NEW scope — a lead that was unique in
    // its old campaign may be a duplicate here (or vice-versa). Only fires when the scope
    // actually changed (a re-parent always changes the campaign), so there is no loop.
    const scopeChanged = Number(before.campaign_id) !== target.campaign_id
      || Number(before.branch_id) !== target.branch_id
      || Number(before.vertical_id) !== target.vertical_id;
    if (scopeChanged) {
      try { await this.reEvaluateDuplicateOnReparent(leadId, target, actorId); }
      catch (e) { /* re-dedup is best-effort: it must never fail a transfer that already committed */ void e; }
    }
    return saved;
  }

  /**
   * dev/129 (bug #1) — after a re-parent (Transfer, or editing a lead's Campaign/Branch/
   * Vertical which routes through Transfer), re-run the NEW campaign's duplicate rule against
   * the NEW scope so the Duplicates panel and the configured action reflect where the lead now
   * lives. Non-destructive: the moved lead is never tombstoned (a human is editing it) — it is
   * (re)linked/flagged, and merge/merge_and_reopen additionally fold its data into the in-scope
   * match, with a CLOSED match re-opened and handed to the next round-robin agent of ITS OWN
   * campaign. If no duplicate exists in the new scope, a stale is_duplicate/link is cleared.
   */
  private async reEvaluateDuplicateOnReparent(
    leadId: number,
    target: Awaited<ReturnType<LeadsService['resolveTransferTarget']>>,
    actorId: number,
  ): Promise<void> {
    const lead = await this.db.one<Record<string, any>>(
      `SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [leadId]);
    if (!lead) return;
    const nums = [...new Set([lead.phone, lead.whatsapp_phone].filter(Boolean) as string[])];
    const rawScope = String((target.duplicacy?.check_scope ?? 'this_campaign'));
    const scope = rawScope === 'this_pipeline' ? 'this_campaign' : rawScope;
    const action = String(target.duplicacy?.on_duplicate ?? 'ignore');
    const ACTION_LABEL: Record<string, string> = {
      ignore: 'ignore duplicate', create: 'create duplicate leads', merge: 'merge duplicate',
      merge_and_reopen: 'merge & reopen closed leads', flag: 'flag duplicates',
    };

    // find a DIFFERENT lead with the same phone/WhatsApp in the new scope; prefer a CLOSED
    // match (so merge & reopen has a lead to re-open), then the oldest.
    let match: { id: string; owner_id: string | null; stage_type: string | null; pipeline_id: string; campaign_id: string } | null = null;
    if (nums.length) {
      const params: unknown[] = [nums, leadId];
      let extra = '';
      if (scope === 'this_campaign') { params.push(target.campaign_id); extra = `AND l.campaign_id = $${params.length}`; }
      else if (scope === 'this_vertical') { params.push(target.vertical_id); extra = `AND l.vertical_id = $${params.length}`; }
      else if (scope === 'this_branch') { params.push(target.branch_id); extra = `AND l.branch_id = $${params.length}`; }
      // 'global' → no extra clause (match anywhere in the org)
      match = await this.db.one(
        `SELECT l.id, l.owner_id, l.pipeline_id, l.campaign_id, st.stage_type
           FROM lead l LEFT JOIN pipeline_stage st ON st.id = l.stage_id
          WHERE (l.phone = ANY($1::text[]) OR l.whatsapp_phone = ANY($1::text[]))
            AND l.id <> $2 AND l.is_active AND l.deleted_at IS NULL ${extra}
          ORDER BY (st.stage_type IN ('won','lost')) DESC, l.id ASC LIMIT 1`,
        params,
      );
    }

    const org = Number(lead.org_id);
    const branch = Number(lead.branch_id);
    const log = (c: any, type: string, from: unknown, to: unknown, note: string | null) => c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [leadId, org, branch, actorId, type,
        from == null ? null : JSON.stringify(from), to == null ? null : JSON.stringify(to), note]);

    if (!match) {
      // no duplicate in the new scope — clear any stale flag/link so the panel is truthful
      if (lead.is_duplicate || lead.duplicate_of_id != null) {
        await this.db.tx(async (c) => {
          await c.query(`UPDATE lead SET is_duplicate = FALSE, duplicate_of_id = NULL, updated_at = now() WHERE id = $1`, [leadId]);
          await log(c, 'note', null, null,
            `Re-evaluated duplicates for the new scope (${scope}) — no duplicate found; duplicate flag cleared`);
        });
      }
      return;
    }

    const matchId = Number(match.id);
    const matchClosed = ['won', 'lost'].includes(String(match.stage_type ?? ''));
    const doFold = !!this.merge && (action === 'merge' || action === 'merge_and_reopen');
    // load the survivor row OUTSIDE the tx (the merge core folds INTO it)
    const matchRow = doFold
      ? await this.db.one<Record<string, any>>(`SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [matchId])
      : null;
    await this.db.tx(async (c) => {
      // (re)link the moved lead to its in-scope match so the Duplicates panel reflects it
      await c.query(`UPDATE lead SET is_duplicate = TRUE, duplicate_of_id = $2, updated_at = now() WHERE id = $1`, [leadId, matchId]);
      await log(c, 'note', null, { duplicate_of_id: matchId },
        `Re-evaluated duplicates for the new scope (${scope}) — matches lead #${matchId} (campaign rule: ${ACTION_LABEL[action] ?? action})`);

      if (doFold && this.merge) {
        if (matchRow) {
          // fold the moved lead's data into the in-scope match (non-destructive; existing wins)
          const res = await this.merge.applyMerge(c, matchRow, this.asReparentIncoming(lead), {
            action: action as 'merge' | 'merge_and_reopen', channel: 'reparent', actorId,
            sourceLeadId: leadId, note: null,
          });
          // merge & reopen — a CLOSED match is handed to the next round-robin agent of ITS campaign
          if (action === 'merge_and_reopen' && res.reopened && matchClosed) {
            const mc = await this.db.one<any>(
              `SELECT distribution_config FROM campaign WHERE id = $1`, [Number(match.campaign_id)]);
            const { pool } = await this.ingestion.resolvePool(
              { campaign_id: Number(match.campaign_id), distribution: (mc?.distribution_config ?? {}) } as any,
              { phone: lead.phone });
            const nextOwner = await this.ingestion.pickOwner(c, Number(match.campaign_id), pool);
            if (nextOwner != null) {
              const prev = matchRow.owner_id == null ? null : Number(matchRow.owner_id);
              await c.query(`UPDATE lead SET owner_id = $1, updated_at = now() WHERE id = $2`, [nextOwner, matchId]);
              await c.query(
                `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
                 VALUES ($1,$2,$3,$4,'assign',$5,$6,$7)`,
                [matchId, Number(matchRow.org_id), Number(matchRow.branch_id), actorId,
                  prev == null ? null : JSON.stringify({ owner_id: prev }), JSON.stringify({ owner_id: nextOwner }),
                  'Re-opened duplicate assigned to the next round-robin agent (re-parent duplicate rule: merge & reopen)']);
            }
          }
        }
      }
    });
    if (match) await this.scoring.safeRescore(matchId);
  }

  /** The moved lead in the "incoming" column shape the merge core consumes. */
  private asReparentIncoming(lead: Record<string, any>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of MERGEABLE_FIELDS) out[f] = lead[f as string];
    out.custom_fields = lead.custom_fields ?? {};
    return out;
  }

  /** Single-lead transfer (controller gates on lead.transfer + @ScopedEntity(:id)). */
  async transfer(id: number, dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    const target = await this.resolveTransferTarget(dto, actorId, scope);
    const ownerMode = dto.owner_mode === 'distribute' ? 'distribute' : 'keep';
    await this.transferOneLead(Number(id), target, ownerMode, actorId);
    return this.get(Number(id));
  }

  // ---- shared bulk helpers -------------------------------------------------

  /** Normalise a bulk id list: unique positive ints, non-empty, capped at BULK_MAX. */
  private normIds(leadIds: unknown): number[] {
    if (!Array.isArray(leadIds)) throw new BadRequestException('lead_ids must be an array of lead ids');
    const ids = [...new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) throw new BadRequestException('lead_ids is required (a non-empty array of lead ids)');
    if (ids.length > LeadsService.BULK_MAX) {
      throw new BadRequestException(`too many leads in one bulk action (max ${LeadsService.BULK_MAX}) — narrow the selection`);
    }
    return ids;
  }

  /** The subset of `ids` the caller may actually see (record scope), with the columns the
   *  bulk primitives need. Ids absent from the result were out of scope / gone -> "skipped". */
  private async scopedLeadRows(ids: number[], scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    params.push(ids);
    return this.db.query<Record<string, any>>(
      `SELECT l.id, l.org_id, l.branch_id, l.owner_id, l.paused, l.campaign_id, l.pipeline_id
         FROM lead l
        WHERE (${where}) AND l.deleted_at IS NULL AND l.is_active AND l.id = ANY($${params.length}::bigint[])
        ORDER BY l.id`, params);
  }

  /** Bulk TRANSFER — every in-scope selected lead to one target campaign. */
  async bulkTransfer(leadIds: unknown, dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    const ids = this.normIds(leadIds);
    const target = await this.resolveTransferTarget(dto, actorId, scope);
    const ownerMode = dto.owner_mode === 'distribute' ? 'distribute' : 'keep';
    const rows = await this.scopedLeadRows(ids, scope);
    let transferred = 0;
    for (const r of rows) { await this.transferOneLead(Number(r.id), target, ownerMode as any, actorId); transferred++; }
    return { transferred, skipped: ids.length - rows.length, requested: ids.length,
             owner_mode: ownerMode, campaign_id: target.campaign_id };
  }

  /** Bulk REASSIGN — every in-scope selected lead to one active, in-scope user. Reuses the
   *  per-lead reassign path (active-user guard + 'assign' activity + SLA touch); idempotent
   *  (a lead already owned by the target is skipped). */
  async bulkReassign(leadIds: unknown, toUserId: number, actorId: number, scope: ResolvedScope) {
    const ids = this.normIds(leadIds);
    const to = Number(toUserId);
    if (!Number.isInteger(to) || to <= 0) throw new BadRequestException('to_user_id (the user to reassign to) is required');
    await assertActiveUser(this.db, to, 'to_user_id');
    await this.enforcer.assertRefInScope(scope, 'user', to, actorId);
    const rows = await this.scopedLeadRows(ids, scope);
    let reassigned = 0;
    for (const r of rows) {
      if (Number(r.owner_id ?? 0) === to) continue; // already there — idempotent no-op
      await this.update(Number(r.id), { owner_id: to }, actorId, scope);
      await this.db.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
         VALUES ($1,$2,'lead',$3,'transfer',$4,$5)`,
        [Number(r.org_id), actorId, Number(r.id),
          JSON.stringify({ owner_id: r.owner_id == null ? null : Number(r.owner_id) }), JSON.stringify({ owner_id: to })]);
      reassigned++;
    }
    return { reassigned, skipped: ids.length - rows.length,
             already: rows.length - reassigned, requested: ids.length, to_user_id: to };
  }

  /** Bulk PAUSE / RESUME — park (or un-park) the selected leads. A paused lead is excluded
   *  from the hand-out pool and the SLA-breach / overdue-escalation sweeps until resumed.
   *  Idempotent (a lead already in the target state is skipped) with per-lead activity+audit. */
  async bulkSetPaused(leadIds: unknown, paused: boolean, actorId: number, scope: ResolvedScope) {
    const ids = this.normIds(leadIds);
    const rows = await this.scopedLeadRows(ids, scope);
    const toChange = rows.filter((r) => Boolean(r.paused) !== paused);
    for (const r of toChange) {
      await this.db.tx(async (c) => {
        const upd = await c.query(
          `UPDATE lead SET paused = $2, paused_at = $3, paused_by = $4, updated_at = now()
            WHERE id = $1 AND paused = $5 RETURNING id`,
          [Number(r.id), paused, paused ? new Date() : null, paused ? actorId : null, !paused]);
        if (!upd.rows.length) return; // lost a race — someone else flipped it; stays idempotent
        await c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [Number(r.id), Number(r.org_id), Number(r.branch_id), actorId, paused ? 'pause' : 'resume',
            paused ? 'Lead paused — excluded from distribution and the SLA / escalation sweeps until resumed'
                   : 'Lead resumed — back in distribution and the SLA / escalation sweeps']);
        await c.query(
          `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
           VALUES ($1,$2,'lead',$3,'update',$4,$5)`,
          [Number(r.org_id), actorId, Number(r.id), JSON.stringify({ paused: !paused }), JSON.stringify({ paused })]);
      });
    }
    const key = paused ? 'paused' : 'resumed';
    return { [key]: toChange.length, already: rows.length - toChange.length,
             skipped: ids.length - rows.length, requested: ids.length } as Record<string, number>;
  }

  /** Bulk DELETE preview — aggregate child-record counts (follow-ups + timeline activities)
   *  across the IN-SCOPE selected leads, for the confirm dialog. Out-of-scope ids excluded. */
  async bulkDeleteImpact(leadIds: unknown, actorId: number, scope: ResolvedScope) {
    const ids = this.normIds(leadIds);
    const rows = await this.scopedLeadRows(ids, scope);
    const inIds = rows.map((r) => Number(r.id));
    let followUps = 0, activities = 0;
    if (inIds.length) {
      const c = await this.db.one<{ f: number; a: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM follow_up f WHERE f.lead_id = ANY($1::bigint[]) AND f.deleted_at IS NULL) AS f,
           (SELECT COUNT(*)::int FROM lead_activity a WHERE a.lead_id = ANY($1::bigint[])) AS a`,
        [inIds]);
      followUps = Number(c?.f ?? 0); activities = Number(c?.a ?? 0);
    }
    const impact = [
      { key: 'follow_ups', label: 'Follow-ups', count: followUps },
      { key: 'activities', label: 'Timeline activities', count: activities },
    ];
    return {
      entity: 'lead', label: 'Lead',
      requested: ids.length, in_scope: inIds.length, out_of_scope: ids.length - inIds.length,
      total_associations: followUps + activities, impact,
    };
  }

  /** Bulk soft-DELETE — every in-scope selected lead is soft-deleted (deleted_at/deleted_by ->
   *  Deleted Items, restorable). Children are kept (registry semantics). Per-record audit row.
   *  Idempotent (a lost race / already-deleted row is a no-op); a paused / flagged lead CAN be
   *  deleted. Out-of-scope ids are reported as skipped. */
  async bulkDelete(leadIds: unknown, actorId: number, scope: ResolvedScope) {
    const ids = this.normIds(leadIds);
    const rows = await this.scopedLeadRows(ids, scope);
    let deleted = 0;
    const deleted_ids: number[] = [];
    for (const r of rows) {
      const upd = await this.db.query<{ id: string }>(
        `UPDATE lead SET deleted_at = now(), deleted_by = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [Number(r.id), actorId]);
      if (!upd.length) continue; // already deleted / lost race — idempotent
      await this.db.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
         VALUES ($1,$2,'lead',$3,'delete',$4,$5)`,
        [Number(r.org_id), actorId, Number(r.id), JSON.stringify({}), JSON.stringify({ deleted: true })]);
      deleted++; deleted_ids.push(Number(r.id));
    }
    return { entity: 'lead', label: 'Lead', requested: ids.length, deleted,
             skipped: ids.length - deleted, deleted_ids };
  }

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

    // dev/95 item 2 — the auto-status rule keys off the new stage's TYPE (won|lost|open),
    // NOT a configurable stage name. A move to a WON stage forces Lead Status = Won; a move
    // to a LOST/closed stage forces Status = Lost. Resolved here so the forced status flows
    // through the SAME set()/activity path as a manual status change.
    let newStageType: string | null = null;
    if (dto.stage_id !== undefined && Number(dto.stage_id) !== Number(before.stage_id)) {
      const stage = await this.db.one<{ id: string; name: string; pipeline_id: string; stage_type: string }>(
        `SELECT id, name, pipeline_id, stage_type FROM pipeline_stage WHERE id = $1`, [Number(dto.stage_id)],
      );
      if (!stage || Number(stage.pipeline_id) !== Number(before.pipeline_id)) {
        throw new BadRequestException('stage does not belong to the lead pipeline');
      }
      const from = await this.db.one<{ name: string }>(`SELECT name FROM pipeline_stage WHERE id = $1`, [before.stage_id]);
      set('stage_id', Number(dto.stage_id));
      activities.push({ type: 'stage_change', from: { id: before.stage_id, name: from?.name }, to: { id: stage.id, name: stage.name } });
      newStageType = stage.stage_type ?? null;
    }
    // Effective target status: the auto-rule (won→Won, lost→Lost) WINS over an explicit
    // status in the same PATCH, so convert / a stage move to Enrolled always lands on Won.
    // An 'open' (unrelated) stage move never touches status — a manually set status is kept.
    const forcedStatusCode: 'WON' | 'LOST' | null =
      newStageType === 'won' ? 'WON' : newStageType === 'lost' ? 'LOST' : null;
    let targetStatusId: number | null = null;
    if (forcedStatusCode) {
      const row = await this.db.one<{ id: string }>(
        `SELECT id FROM m_status WHERE org_id = $1 AND code = $2`, [org, forcedStatusCode]);
      if (row) targetStatusId = Number(row.id);
    } else if (dto.status_id !== undefined) {
      targetStatusId = Number(dto.status_id);
    }
    if (targetStatusId != null && targetStatusId !== Number(before.status_id)) {
      const to = await this.db.one<{ name: string }>(`SELECT name FROM m_status WHERE id = $1`, [targetStatusId]);
      if (!to) throw new BadRequestException('unknown status');
      const from = await this.db.one<{ name: string }>(`SELECT name FROM m_status WHERE id = $1`, [before.status_id]);
      set('status_id', targetStatusId);
      activities.push({ type: 'status_change', from: { id: before.status_id, name: from?.name }, to: { id: targetStatusId, name: to.name } });
    }
    if (dto.owner_id !== undefined && Number(dto.owner_id ?? 0) !== Number(before.owner_id ?? 0)) {
      const ownerId = dto.owner_id == null ? null : Number(dto.owner_id);
      if (ownerId != null) {
        // DEF-R3-01: the reassign/owner target must be an ACTIVE user (status='active',
        // not soft-deleted). Shared guard names the field in the 400.
        await assertActiveUser(this.db, ownerId, 'owner_id');
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

  // ---- RED FLAG (client request, Aug 2026) ---------------------------------
  //
  // A RED flag is a deliberate human "watch this lead" mark, DISTINCT from the amber
  // duplicate/SLA `is_flagged` badge. Each flag is a remark by a user at a time, kept as a
  // conversation on `lead_red_flag`; raising one sets the lead's `is_red_flagged` state and
  // writes a `red_flag` lead_activity so it also shows on the MAIN timeline. Gated on
  // `lead.flag` at the controller; the record itself is scope-checked by @ScopedEntity.

  /** The red-flag conversation for a lead (newest first), with the author's name. */
  redFlags(leadId: number) {
    return this.db.query(
      `SELECT rf.id, rf.remark, rf.created_at, rf.created_by, u.name AS created_by_name
         FROM lead_red_flag rf LEFT JOIN "user" u ON u.id = rf.created_by
        WHERE rf.lead_id = $1 AND rf.deleted_at IS NULL
        ORDER BY rf.created_at DESC, rf.id DESC LIMIT 200`,
      [leadId],
    );
  }

  /** Add a red-flag remark: store the entry, set the flagged state, log the timeline. */
  async addRedFlag(id: number, remark: string, actorId: number) {
    if (!remark?.trim()) throw new BadRequestException('remark is required');
    const lead = await this.db.one<{ org_id: string; branch_id: string }>(
      `SELECT org_id, branch_id FROM lead WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!lead) throw new NotFoundException('lead not found');
    const text = remark.trim();
    const entry = await this.db.tx(async (c) => {
      const rf = await c.query(
        `INSERT INTO lead_red_flag (lead_id, org_id, branch_id, remark, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, remark, created_at, created_by`,
        [id, Number(lead.org_id), Number(lead.branch_id), text, actorId]);
      // set / refresh the lead's red-flagged state (first flag stamps red_flagged_at)
      await c.query(
        `UPDATE lead SET is_red_flagged = TRUE,
                red_flagged_at = COALESCE(red_flagged_at, now()), last_activity_at = now()
          WHERE id = $1`, [id]);
      // main-timeline entry (note carries the remark so it reads inline)
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note)
         VALUES ($1,$2,$3,$4,'red_flag',$5,$6)`,
        [id, Number(lead.org_id), Number(lead.branch_id), actorId,
          JSON.stringify({ action: 'flagged' }), text]);
      return rf.rows[0];
    });
    return { ok: true, is_red_flagged: true, entry };
  }

  /** Clear the red-flagged STATE (the remark thread is kept as history). */
  async clearRedFlag(id: number, actorId: number) {
    const lead = await this.db.one<{ org_id: string; branch_id: string; is_red_flagged: boolean }>(
      `SELECT org_id, branch_id, is_red_flagged FROM lead WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!lead) throw new NotFoundException('lead not found');
    if (!lead.is_red_flagged) return { ok: true, is_red_flagged: false };
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE lead SET is_red_flagged = FALSE, red_flagged_at = NULL, last_activity_at = now() WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note)
         VALUES ($1,$2,$3,$4,'red_flag',$5,$6)`,
        [id, Number(lead.org_id), Number(lead.branch_id), actorId,
          JSON.stringify({ action: 'cleared' }), 'Red flag cleared']);
    });
    return { ok: true, is_red_flagged: false };
  }

  // ---- dashboard summary (all scope-filtered) ------------------------------

  async summary(scope: ResolvedScope, userId: number) {
    const p1: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, p1);
    const kpis = await this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
              COUNT(*) FILTER (WHERE l.created_at >= date_trunc('month', now()))::int AS mtd,
              COUNT(*) FILTER (WHERE st.stage_type = 'won')::int AS won,
              COUNT(*) FILTER (WHERE st.stage_type = 'won' AND (l.updated_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS won_today,
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
      `SELECT COUNT(*) FILTER (WHERE f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS due_today,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue,
              COUNT(*) FILTER (WHERE f.status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE f.status = 'done' AND (f.completed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS done_today,
              COUNT(*) FILTER (WHERE f.status = 'done' AND f.completed_at >= date_trunc('week', now()))::int AS done_week,
              COUNT(*) FILTER (WHERE f.status = 'pending' AND f.owner_id = $${p2.length})::int AS my_open
         FROM follow_up f JOIN lead l ON l.id = f.lead_id
        WHERE (${wf}) AND f.is_active AND f.deleted_at IS NULL AND l.deleted_at IS NULL`, p2,
    );
    return { kpis, by_stage: byStage, series, follow_ups: fu };
  }
}
