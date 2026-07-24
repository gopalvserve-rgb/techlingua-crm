import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { LEAD_SCOPE_COLS } from '../rbac/scope-cols';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { assertActiveUser } from '../leads/active-user.util';

/**
 * CROSS-SELL — CRM-level, working on the leads/enrolments that exist today.
 *
 * A cross-sell CANDIDATE is a converted contact — a lead at a `won` stage OR a lead with
 * an enrolment — paired with a SUGGESTED course they do not already hold. The suggestion
 * comes from the Course master, narrowed by an admin rule map when one applies:
 *
 *   rule     if ANY cross_sell_rule maps one of the contact's CURRENT courses to a target,
 *            those (active) targets are the suggestions.
 *   vertical otherwise the fallback is every OTHER active course in the contact's vertical
 *            (m_course.meta->>'vertical_id'), minus the ones the contact already holds.
 *
 * A (contact, suggested course) pair drops off the list the moment it is acted on — an act
 * writes a cross_sell_attempt, and a live attempt row for that pair excludes it from
 * candidates (the UNIQUE index guarantees the same pair is never suggested twice).
 *
 * RBAC: the candidate/attempt list is scoped INSIDE the SQL via the SAME LEAD_SCOPE_COLS
 * every lead-shaped entity uses (owner/team/branch/vertical/pipeline/campaign), so a
 * counsellor only ever sees his own contacts. Rule management is admin-only (crosssell.manage).
 */

export const CROSS_SELL_ACTIONS = ['followup', 'lead', 'dismissed'] as const;
export type CrossSellAction = (typeof CROSS_SELL_ACTIONS)[number];

@Injectable()
export class CrossSellService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly ingestion: LeadIngestionService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private scopeWhere(scope: ResolvedScope, params: unknown[]): string {
    return this.resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
  }

  /* --------------------------------------------------------------- candidates */

  /**
   * The candidate view. One row per (contact, suggested course). Rule-based suggestions
   * win where a rule matches a held course; otherwise same-vertical active courses.
   * Held courses and already-acted pairs are excluded. RBAC-scoped on `lead l`.
   */
  async candidates(scope: ResolvedScope, f: {
    branch_id?: string | number; vertical_id?: string | number;
    owner_id?: string | number; course_id?: string | number; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const scopeSql = this.scopeWhere(scope, params);
    const extra: string[] = [];
    if (f.branch_id)   { params.push(Number(f.branch_id));   extra.push(`l.branch_id = $${params.length}::bigint`); }
    if (f.vertical_id) { params.push(Number(f.vertical_id)); extra.push(`l.vertical_id = $${params.length}::bigint`); }
    if (f.owner_id)    { params.push(Number(f.owner_id));    extra.push(`l.owner_id = $${params.length}::bigint`); }
    if (f.course_id)   { params.push(Number(f.course_id));   extra.push(`l.course_id = $${params.length}::bigint`); }
    params.push(Math.min(Number(f.limit ?? 300), 500));
    const limitIdx = params.length;

    return this.db.query<any>(
      `WITH cand AS (
         SELECT l.id AS lead_id, l.full_name, l.phone, l.email,
                l.branch_id, l.vertical_id, l.owner_id, l.course_id,
                b.name AS branch_name, v.name AS vertical_name, u.name AS owner_name,
                co.name AS current_course_name
           FROM lead l
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
           LEFT JOIN branch b   ON b.id = l.branch_id
           LEFT JOIN vertical v ON v.id = l.vertical_id
           LEFT JOIN "user" u   ON u.id = l.owner_id
           LEFT JOIN m_course co ON co.id = l.course_id
          WHERE l.is_active AND l.deleted_at IS NULL
            AND ${scopeSql}
            ${extra.length ? 'AND ' + extra.join(' AND ') : ''}
            AND ( st.stage_type = 'won'
                  OR EXISTS (SELECT 1 FROM enrolment e WHERE e.lead_id = l.id AND e.deleted_at IS NULL) )
       ),
       held AS (
         SELECT c.lead_id, c.course_id FROM cand c WHERE c.course_id IS NOT NULL
         UNION
         SELECT e.lead_id, e.course_id FROM enrolment e
           JOIN cand c ON c.lead_id = e.lead_id
          WHERE e.deleted_at IS NULL AND e.course_id IS NOT NULL
       ),
       ruled AS (   -- candidates that HAVE an applicable rule (so they skip the fallback)
         SELECT DISTINCT h.lead_id FROM held h
           JOIN cross_sell_rule r ON r.source_course_id = h.course_id AND r.is_active AND r.deleted_at IS NULL
       ),
       suggest AS (
         SELECT c.lead_id, r.target_course_id AS suggested_course_id, 'rule'::text AS basis
           FROM cand c
           JOIN held h ON h.lead_id = c.lead_id
           JOIN cross_sell_rule r ON r.source_course_id = h.course_id AND r.is_active AND r.deleted_at IS NULL
         UNION
         SELECT c.lead_id, oc.id AS suggested_course_id, 'vertical'::text AS basis
           FROM cand c
           JOIN m_course oc ON oc.is_active AND oc.deleted_at IS NULL
                AND (oc.meta->>'vertical_id') IS NOT NULL
                AND (oc.meta->>'vertical_id')::bigint = c.vertical_id
          WHERE c.lead_id NOT IN (SELECT lead_id FROM ruled)
       )
       SELECT c.lead_id, c.full_name, c.phone, c.email,
              c.branch_id, c.vertical_id, c.owner_id, c.course_id AS from_course_id,
              c.branch_name, c.vertical_name, c.owner_name, c.current_course_name,
              s.suggested_course_id, sc.name AS suggested_course_name, s.basis
         FROM suggest s
         JOIN cand c ON c.lead_id = s.lead_id
         JOIN m_course sc ON sc.id = s.suggested_course_id
        WHERE s.suggested_course_id NOT IN (SELECT h.course_id FROM held h WHERE h.lead_id = s.lead_id)
          AND NOT EXISTS (
                SELECT 1 FROM cross_sell_attempt a
                 WHERE a.lead_id = s.lead_id AND a.suggested_course_id = s.suggested_course_id
                   AND a.deleted_at IS NULL)
        ORDER BY c.full_name ASC, sc.name ASC
        LIMIT $${limitIdx}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const cand = await this.candidates(scope, { limit: 500 });
    const contacts = new Set(cand.map((r: any) => Number(r.lead_id)));
    const params: unknown[] = [];
    const scopeSql = this.scopeWhere(scope, params);
    const att = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE a.action = 'followup')  AS followups,
              count(*) FILTER (WHERE a.action = 'lead')      AS leads,
              count(*) FILTER (WHERE a.action = 'dismissed') AS dismissed
         FROM cross_sell_attempt a JOIN lead l ON l.id = a.lead_id
        WHERE a.deleted_at IS NULL AND ${scopeSql}`,
      params,
    );
    return {
      suggestions: cand.length,
      contacts: contacts.size,
      followups: Number(att?.followups ?? 0),
      leads: Number(att?.leads ?? 0),
      dismissed: Number(att?.dismissed ?? 0),
    };
  }

  /** Active courses (id + name), for the rule-builder selects and filters. */
  async meta() {
    const courses = await this.db.query<any>(
      `SELECT id, name, (meta->>'vertical_id') AS vertical_id, (meta->>'branch_id') AS branch_id
         FROM m_course WHERE deleted_at IS NULL AND is_active ORDER BY name ASC`,
    );
    return { courses, actions: CROSS_SELL_ACTIONS };
  }

  /* -------------------------------------------------------------------- rules */

  async listRules() {
    return this.db.query<any>(
      `SELECT r.id, r.source_course_id, r.target_course_id, r.is_active, r.note,
              sc.name AS source_course_name, tc.name AS target_course_name,
              r.created_at, r.updated_at
         FROM cross_sell_rule r
         LEFT JOIN m_course sc ON sc.id = r.source_course_id
         LEFT JOIN m_course tc ON tc.id = r.target_course_id
        WHERE r.deleted_at IS NULL
        ORDER BY sc.name ASC, tc.name ASC`,
    );
  }

  private async assertCourse(id: number, label: string) {
    const c = await this.db.one<{ id: string }>(
      `SELECT id FROM m_course WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!c) throw new BadRequestException(`${label} is not a valid course`);
  }

  async createRule(dto: any, me: { id: number }) {
    const source = Number(dto?.source_course_id);
    const target = Number(dto?.target_course_id);
    if (!source || !target) throw new BadRequestException('Pick both a current course and a course to suggest.');
    if (source === target) throw new BadRequestException('A rule cannot suggest the same course.');
    await this.assertCourse(source, 'Current course');
    await this.assertCourse(target, 'Suggested course');
    const orgId = await this.orgId();
    try {
      const r = await this.db.one<{ id: string }>(
        `INSERT INTO cross_sell_rule (org_id, source_course_id, target_course_id, note, created_by)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::bigint) RETURNING id`,
        [orgId, source, target, dto?.note ?? null, me.id],
      );
      return { id: Number(r!.id), ok: true };
    } catch (e: any) {
      if (String(e?.code) === '23505') throw new ConflictException('That cross-sell rule already exists.');
      throw e;
    }
  }

  async updateRule(id: number, dto: any) {
    const cur = await this.db.one<any>(`SELECT * FROM cross_sell_rule WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw new NotFoundException('Rule not found');
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.target_course_id !== undefined) {
      const t = Number(dto.target_course_id);
      if (t === Number(cur.source_course_id)) throw new BadRequestException('A rule cannot suggest the same course.');
      await this.assertCourse(t, 'Suggested course');
      set('target_course_id', t);
    }
    if (dto?.note !== undefined) set('note', dto.note || null);
    if (dto?.is_active !== undefined) set('is_active', dto.is_active === true || dto.is_active === '1' || dto.is_active === 1);
    if (!sets.length) return { id, ok: true };
    params.push(id);
    await this.db.query(`UPDATE cross_sell_rule SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id, ok: true };
  }

  async removeRule(id: number, me: { id: number }) {
    const cur = await this.db.one<{ id: string }>(`SELECT id FROM cross_sell_rule WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!cur) throw new NotFoundException('Rule not found');
    await this.db.query(`UPDATE cross_sell_rule SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  /* ----------------------------------------------------------------- attempts */

  async attempts(scope: ResolvedScope, f: {
    action?: string; status?: string; branch_id?: string | number;
    vertical_id?: string | number; owner_id?: string | number; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const scopeSql = this.scopeWhere(scope, params);
    const where = [`a.deleted_at IS NULL`, scopeSql];
    if (f.action)      { params.push(f.action);              where.push(`a.action = $${params.length}::varchar`); }
    if (f.status)      { params.push(f.status);              where.push(`a.status = $${params.length}::varchar`); }
    if (f.branch_id)   { params.push(Number(f.branch_id));   where.push(`a.branch_id = $${params.length}::bigint`); }
    if (f.vertical_id) { params.push(Number(f.vertical_id)); where.push(`a.vertical_id = $${params.length}::bigint`); }
    if (f.owner_id)    { params.push(Number(f.owner_id));    where.push(`a.owner_id = $${params.length}::bigint`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));
    const limitIdx = params.length;
    return this.db.query<any>(
      `SELECT a.id, a.lead_id, a.from_course_id, a.suggested_course_id, a.action, a.status,
              a.follow_up_id, a.new_lead_id, a.note, a.created_at,
              a.branch_id, a.vertical_id, a.owner_id,
              l.full_name, l.phone, u.name AS owner_name,
              b.name AS branch_name, v.name AS vertical_name,
              fc.name AS from_course_name, sc.name AS suggested_course_name
         FROM cross_sell_attempt a
         JOIN lead l ON l.id = a.lead_id
         LEFT JOIN "user" u   ON u.id = a.owner_id
         LEFT JOIN branch b   ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN m_course fc ON fc.id = a.from_course_id
         LEFT JOIN m_course sc ON sc.id = a.suggested_course_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${limitIdx}`,
      params,
    );
  }

  /* ---------------------------------------------------------------------- act */

  /** The scoped contact lead — 404 if outside the caller's access. */
  private async getLeadScoped(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const scopeSql = this.scopeWhere(scope, params);
    const l = await this.db.one<any>(
      `SELECT l.* FROM lead l WHERE l.id = $1::bigint AND l.is_active AND l.deleted_at IS NULL AND ${scopeSql}`,
      params,
    );
    if (!l) throw new NotFoundException('Contact not found (or outside your access)');
    return l;
  }

  /**
   * Act on a suggestion. Three real, wired actions, each recorded so the pair is never
   * suggested again:
   *   followup  a cross-sell follow-up/task on the contact for the suggested course,
   *             assigned to the contact's owner (via the existing follow_up model).
   *   lead      a NEW lead for the suggested course in that course's vertical/campaign,
   *             created through LeadIngestionService so dedup / distribution / audit apply,
   *             linked back to the original contact.
   *   dismiss   record that the suggestion was declined (drops it off the list).
   */
  async act(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    const suggestedCourseId = Number(dto?.suggested_course_id);
    const action = String(dto?.action ?? '') as CrossSellAction;
    if (!leadId || !suggestedCourseId) throw new BadRequestException('lead_id and suggested_course_id are required.');
    if (!(CROSS_SELL_ACTIONS as readonly string[]).includes(action)) throw new BadRequestException('Unknown action.');
    const lead = await this.getLeadScoped(leadId, scope);
    await this.assertCourse(suggestedCourseId, 'Suggested course');
    const orgId = Number(lead.org_id);

    // already acted? the UNIQUE (lead, course) index is the authority, but a friendly
    // 409 beats a raw constraint error.
    const dup = await this.db.one<{ id: string }>(
      `SELECT id FROM cross_sell_attempt WHERE lead_id = $1 AND suggested_course_id = $2 AND deleted_at IS NULL`,
      [leadId, suggestedCourseId],
    );
    if (dup) throw new ConflictException('This contact has already been actioned for that course.');

    const course = await this.db.one<any>(
      `SELECT id, name, (meta->>'vertical_id') AS vertical_id, (meta->>'branch_id') AS branch_id
         FROM m_course WHERE id = $1 AND deleted_at IS NULL`, [suggestedCourseId],
    );

    if (action === 'followup') return this.actFollowUp(lead, course, dto, me, orgId);
    if (action === 'lead')     return this.actNewLead(lead, course, dto, me, orgId);
    return this.actDismiss(lead, course, dto, me, orgId);
  }

  private timelineNote(course: any, extra?: string) {
    return [`Cross-sell: suggested "${course?.name ?? 'course'}"`, extra].filter(Boolean).join(' — ');
  }

  private async logAttempt(c: any, row: {
    lead: any; course: any; action: CrossSellAction; status: string;
    follow_up_id: number | null; new_lead_id: number | null; note: string | null; me: { id: number }; orgId: number;
  }) {
    const ins = await c.query(
      `INSERT INTO cross_sell_attempt (org_id, lead_id, from_course_id, suggested_course_id,
                                       branch_id, vertical_id, owner_id, action, status,
                                       follow_up_id, new_lead_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [row.orgId, row.lead.id, row.lead.course_id ?? null, row.course.id,
        row.lead.branch_id, row.lead.vertical_id, row.lead.owner_id ?? null,
        row.action, row.status, row.follow_up_id, row.new_lead_id, row.note, row.me.id],
    );
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, to_value, note)
       VALUES ($1,$2,$3,$4,'cross_sell',$5,$6)`,
      [row.lead.id, row.orgId, row.lead.branch_id, row.me.id,
        JSON.stringify({ suggested_course_id: row.course.id, action: row.action, follow_up_id: row.follow_up_id, new_lead_id: row.new_lead_id }),
        row.note],
    );
    return Number(ins.rows[0].id);
  }

  private async actFollowUp(lead: any, course: any, dto: any, me: { id: number }, orgId: number) {
    const ownerId = lead.owner_id ? Number(lead.owner_id) : me.id;
    if (lead.owner_id) await assertActiveUser(this.db, ownerId, 'Contact owner');
    // default the schedule to tomorrow 10:00 local if none supplied; never accept a past date.
    let scheduledAt = dto?.scheduled_at ? new Date(String(dto.scheduled_at)) : null;
    if (scheduledAt && isNaN(scheduledAt.getTime())) throw new BadRequestException('Invalid schedule date.');
    if (!scheduledAt) { scheduledAt = new Date(); scheduledAt.setDate(scheduledAt.getDate() + 1); scheduledAt.setHours(10, 0, 0, 0); }
    const note = this.timelineNote(course, dto?.note ? String(dto.note).trim() : undefined);
    const out = await this.db.tx(async (c) => {
      const fu = await c.query(
        `INSERT INTO follow_up (lead_id, owner_id, scheduled_at, status, notes, created_by, report_to_id)
         VALUES ($1::bigint, $2::bigint, $3::timestamptz, 'pending', $4, $5::bigint, $5::bigint) RETURNING id`,
        [lead.id, ownerId, scheduledAt.toISOString(), note, me.id],
      );
      const followUpId = Number(fu.rows[0].id);
      const attemptId = await this.logAttempt(c, {
        lead, course, action: 'followup', status: 'open',
        follow_up_id: followUpId, new_lead_id: null, note, me, orgId,
      });
      return { attempt_id: attemptId, follow_up_id: followUpId };
    });
    return { ok: true, id: out.attempt_id, action: 'followup', ...out };
  }

  private async actNewLead(lead: any, course: any, dto: any, me: { id: number }, orgId: number) {
    // find a campaign in the SUGGESTED course's vertical (its branch too when set), and a
    // source under it, to receive the cross-sell lead. Ingestion needs a campaign+source.
    const verticalId = course?.vertical_id ? Number(course.vertical_id) : Number(lead.vertical_id);
    const branchId = course?.branch_id ? Number(course.branch_id) : null;
    const camp = await this.db.one<any>(
      `SELECT c.id AS campaign_id,
              (SELECT s.id FROM source s WHERE s.campaign_id = c.id AND s.deleted_at IS NULL ORDER BY s.id LIMIT 1) AS source_id
         FROM campaign c
        WHERE c.is_active AND c.deleted_at IS NULL AND c.vertical_id = $1
          ${branchId ? 'AND c.branch_id = $2' : ''}
        ORDER BY c.id LIMIT 1`,
      branchId ? [verticalId, branchId] : [verticalId],
    );
    if (!camp || !camp.source_id) {
      throw new BadRequestException(
        'No active campaign with a source exists in the suggested course vertical to receive a cross-sell lead. '
        + 'Create one (or use "Create follow-up" instead).');
    }
    const { outcome } = await this.ingestion.ingestAndReturn(
      {
        full_name: lead.full_name,
        phone: lead.phone,
        email: lead.email ?? undefined,
        whatsapp_phone: lead.whatsapp_phone ?? undefined,
        course: course.name,
        note: `Cross-sell from lead #${lead.id} — suggested "${course.name}"`,
      } as any,
      {
        channel: 'manual',
        campaign_id: Number(camp.campaign_id),
        source_id: Number(camp.source_id),
        duplicate_policy: 'campaign',   // dedup / distribution / audit all apply
        actor_id: me.id,
        owner_id: lead.owner_id ? Number(lead.owner_id) : undefined,
      } as any,
    );
    const newLeadId = outcome?.lead_id ? Number(outcome.lead_id) : null;
    const note = this.timelineNote(
      course,
      newLeadId ? `new lead #${newLeadId} created (${outcome.status})` : `no lead created (${outcome?.status ?? 'unknown'})`,
    );
    const attemptId = await this.db.tx(async (c) => this.logAttempt(c, {
      lead, course, action: 'lead', status: 'open',
      follow_up_id: null, new_lead_id: newLeadId, note, me, orgId,
    }));
    return { ok: true, id: attemptId, action: 'lead', new_lead_id: newLeadId, outcome: outcome?.status };
  }

  private async actDismiss(lead: any, course: any, dto: any, me: { id: number }, orgId: number) {
    const note = this.timelineNote(course, dto?.note ? `dismissed: ${String(dto.note).trim()}` : 'dismissed');
    const attemptId = await this.db.tx(async (c) => this.logAttempt(c, {
      lead, course, action: 'dismissed', status: 'dismissed',
      follow_up_id: null, new_lead_id: null, note, me, orgId,
    }));
    return { ok: true, id: attemptId, action: 'dismissed' };
  }
}
