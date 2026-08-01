import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ScoringService } from '../scoring/scoring.service';
import { SlaService } from '../sla/sla.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { normalizePhone } from '../common/phone.util';
import { assertDateRange, SQL_TODAY, istDay } from '../common/date.util';

/**
 * WALK-INS & REFERRALS — the two manual capture screens on the Dashboard.
 *
 * Both are REAL capture, not shells: each one CREATES A LEAD, through the single
 * `LeadIngestionService` every other channel uses. So a walk-in inherits the hierarchy
 * path, E.164 normalisation, the NeoDove §4 duplicate rules, the audit trail and
 * replay-idempotency for free — there is still exactly ONE way a lead comes into being.
 *
 * WALK-IN = ASSIGN ON ADD (Phase-1 scope says so explicitly). The counsellor is a
 * MANDATORY field and is passed as `ctx.owner_id`, which wins over campaign distribution:
 * the visitor standing at the desk is handed to the person talking to them, not queued
 * for round-robin. Walk-ins also score +25 by default (a rule the client can edit).
 *
 * REFERRAL = the referred person becomes a lead; the referral row keeps the referrer,
 * the relationship, the reward and the status (pending → converted → rewarded).
 *
 * SCOPE: both scope THROUGH THE LEAD they created (the follow-up pattern), so all six
 * record-scope kinds resolve through the central ScopeResolver.
 */

// campaign/pipeline used to be borrowed from the lead (`wl.*`). A walk-in with
// `convert_to_lead = false` has no lead, so the walk-in's OWN campaign is used and
// falls back to the lead's only for rows captured before migration 027.
export const WALKIN_SCOPE_COLS: ScopeColumnMap = {
  owner: 'COALESCE(wl.owner_id, w.counsellor_id)', team: 'wl.team_id',
  branch: 'w.branch_id', vertical: 'w.vertical_id',
  pipeline: 'COALESCE(cmp.pipeline_id, wl.pipeline_id)',
  campaign: 'COALESCE(w.campaign_id, wl.campaign_id)',
};
export const REFERRAL_SCOPE_COLS: ScopeColumnMap = {
  owner: 'rl.owner_id', team: 'rl.team_id', branch: 'r.branch_id', vertical: 'r.vertical_id',
  pipeline: 'COALESCE(cmp.pipeline_id, rl.pipeline_id)',
  campaign: 'COALESCE(r.campaign_id, rl.campaign_id)',
};

// #19 (UAT-R2) — walk-in status is now a MASTER (m_walkin_status). These four are the
// base fallback (they seed the master and match the old CHECK), so validation still works
// on a DB where the master has not been seeded yet (and in the unit doubles).
const WALKIN_STATUS_BASE = ['waiting', 'in_progress', 'converted', 'closed'];
const REFERRAL_STATUS = ['pending', 'converted', 'rewarded', 'rejected'];
const REFERRER_TYPES = ['Existing Student', 'Parent', 'Employee', 'Alumni', 'Partner'];

export interface WalkInDto {
  visitor_name: string;
  phone: string;
  email?: string;
  alt_phone?: string;
  whatsapp_phone?: string;
  branch_id: number;
  vertical_id: number;
  campaign_id: number;
  source_id: number;
  counsellor_id: number;            // MANDATORY — assign-on-add
  visited_at?: string;
  purpose?: string;
  course_id?: number;
  // DEF-S34-02 — the three fields the form rendered and silently threw away.
  course_fee?: number | string | null;
  /** how the visitor found us — the LEAD SOURCE MASTER (m_source), not the campaign-scoped source */
  heard_about_source_id?: number | null;
  /** default TRUE. FALSE = log the visit without creating a lead; flipping it to TRUE
   *  later (on the Edit form) converts through the ONE LeadIngestionService. */
  convert_to_lead?: boolean;
  status?: string;
  wait_minutes?: number;
  remarks?: string;
}

export interface ReferralDto {
  referrer_type: string;
  referrer_name: string;
  referrer_phone?: string;
  referred_name: string;
  referred_phone: string;
  // DEF-S34-03 — these two were sent to the LEAD but never stored on the referral,
  // so the Edit form could neither prefill nor persist them.
  referred_email?: string;
  referred_whatsapp?: string;
  relationship?: string;
  branch_id: number;
  vertical_id: number;
  campaign_id: number;
  source_id: number;
  course_id?: number;
  owner_id?: number;
  incentive?: string;
  status?: string;
}

@Injectable()
export class CaptureService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ingestion: LeadIngestionService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly scoring: ScoringService,
    private readonly sla: SlaService,
  ) {}

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  /* ================================ WALK-INS ================================ */

  async listWalkIns(scope: ResolvedScope, q: { today?: boolean; status?: string; from?: string; to?: string; limit?: number }) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, WALKIN_SCOPE_COLS, params);
    const where = [w, 'w.deleted_at IS NULL'];
    if (q.today) where.push(`(w.visited_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    if (q.status) { params.push(q.status); where.push(`w.status = $${params.length}`); }
    // Shared date range — filters by the VISIT date (visited_at). Bad date -> 400; either bound optional.
    const dr = assertDateRange(q.from, q.to);
    if (dr.from) { params.push(dr.from); where.push(`w.visited_at::date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`w.visited_at::date <= $${params.length}::date`); }
    params.push(Math.min(Number(q.limit) || 100, 500));
    return this.db.query(
      // DEF-S34-03: the Edit form prefills from this row, so EVERY editable column is
      // selected here — including the ones DEF-S34-02 added.
      `SELECT w.id, w.visitor_name, w.phone, w.alt_phone, w.whatsapp_phone, w.email,
              w.visited_at, w.purpose, w.status, w.wait_minutes, w.remarks, w.lead_id,
              w.counsellor_id, w.course_id, w.course_fee, w.heard_about_source_id,
              w.convert_to_lead, w.branch_id, w.vertical_id, w.campaign_id, w.source_id,
              w.created_at,
              u.name AS counsellor_name, c.name AS course_name, b.name AS branch_name,
              v.name AS vertical_name, ms.name AS heard_about_name,
              cmp.name AS campaign_name, cmp.pipeline_id, pl.name AS pipeline_name,
              sr.name AS source_name,
              wl.temperature, wl.score, wl.full_name AS lead_name,
              st.name AS stage_name
         FROM walk_in w
         LEFT JOIN lead wl ON wl.id = w.lead_id
         LEFT JOIN "user" u ON u.id = w.counsellor_id
         LEFT JOIN m_course c ON c.id = w.course_id
         LEFT JOIN m_source ms ON ms.id = w.heard_about_source_id
         LEFT JOIN branch b ON b.id = w.branch_id
         LEFT JOIN vertical v ON v.id = w.vertical_id
         LEFT JOIN campaign cmp ON cmp.id = w.campaign_id
         LEFT JOIN pipeline pl ON pl.id = cmp.pipeline_id
         LEFT JOIN source sr ON sr.id = w.source_id
         LEFT JOIN pipeline_stage st ON st.id = wl.stage_id
        WHERE ${where.join(' AND ')}
        ORDER BY w.visited_at DESC
        LIMIT $${params.length}`, params,
    );
  }

  async walkInSummary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, WALKIN_SCOPE_COLS, params);
    return this.db.one(
      `SELECT COUNT(*) FILTER (WHERE (w.visited_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
              COUNT(*) FILTER (WHERE w.status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE w.status = 'waiting')::int AS waiting,
              COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(w.wait_minutes) FILTER (WHERE w.wait_minutes IS NOT NULL))::int, 0) AS avg_wait
         FROM walk_in w
         LEFT JOIN lead wl ON wl.id = w.lead_id
         LEFT JOIN campaign cmp ON cmp.id = w.campaign_id
        WHERE (${w}) AND w.deleted_at IS NULL`, params,
    );
  }

  /** #19 — allowed walk-in statuses = the base four + any active m_walkin_status code the
   *  client has added. A DB without the master (or a unit double) falls back to the base. */
  private async allowedWalkInStatuses(): Promise<Set<string>> {
    const allowed = new Set<string>(WALKIN_STATUS_BASE);
    try {
      const rows = await this.db.query<{ code: string | null }>(
        `SELECT code FROM m_walkin_status WHERE is_active AND deleted_at IS NULL AND code IS NOT NULL`);
      for (const r of rows) if (r.code) allowed.add(String(r.code));
    } catch { /* master table absent — the base set stands */ }
    return allowed;
  }

  async createWalkIn(dto: WalkInDto, actorId: number, scope: ResolvedScope) {
    for (const f of ['visitor_name', 'phone', 'branch_id', 'vertical_id', 'campaign_id', 'source_id', 'counsellor_id'] as const) {
      if (!dto?.[f]) throw new BadRequestException(`${f} is required`);
    }
    if (dto.status) {
      const allowed = await this.allowedWalkInStatuses();
      if (!allowed.has(String(dto.status))) {
        throw new BadRequestException(`status must be one of: ${[...allowed].join(', ')}`);
      }
    }
    this.assertNotPastVisit(dto.visited_at);   // #19 — no past Date of Visit
    // RBAC: the campaign, source and counsellor must all be inside the caller's scope
    await this.enforcer.assertRefInScope(scope, 'campaign', Number(dto.campaign_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'source', Number(dto.source_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'user', Number(dto.counsellor_id), actorId);
    const c = await this.db.one<{ id: string }>(
      `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [Number(dto.counsellor_id)],
    );
    if (!c) throw new BadRequestException('counsellor must be an active user');

    const fee = this.fee(dto.course_fee);
    const heard = await this.heardAboutId(dto.heard_about_source_id);
    // DEF-S34-02 — "Convert to Lead" is a REAL flag now, and it DEFAULTS TO TRUE
    // (assign-on-add is the whole premise of this screen; the checkbox ships ticked).
    const convert = dto.convert_to_lead !== false;

    // ONE ingestion path — the lead is created exactly as a CSV/webhook lead would be,
    // except the owner is FORCED to the counsellor (assign on add).
    const outcome = convert
      ? await this.ingestWalkInLead(dto, fee, actorId)
      : null;

    const org = await this.orgId();
    const row = await this.db.one(
      `INSERT INTO walk_in (org_id, branch_id, vertical_id, campaign_id, source_id, lead_id,
                            visitor_name, phone, alt_phone, whatsapp_phone, email,
                            visited_at, purpose, course_id, course_fee, heard_about_source_id,
                            convert_to_lead, counsellor_id, status, wait_minutes, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()),
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [org, Number(dto.branch_id), Number(dto.vertical_id), Number(dto.campaign_id),
        Number(dto.source_id), outcome?.lead_id ?? null,
        dto.visitor_name, dto.phone, dto.alt_phone ?? null, dto.whatsapp_phone ?? null,
        dto.email ?? null, dto.visited_at ?? null, dto.purpose ?? null,
        dto.course_id ?? null, fee, heard, convert,
        Number(dto.counsellor_id), dto.status ?? 'waiting',
        dto.wait_minutes ?? null, dto.remarks ?? null, actorId],
    );

    // the walk_in row now exists -> the `walk_in` scoring rule (+25) can see it
    if (outcome?.lead_id) await this.scoring.safeRescore(outcome.lead_id);
    return { ...row, lead_id: outcome?.lead_id ?? null, duplicate_of: outcome?.duplicate_of ?? null };
  }

  /**
   * UAT-R2 #19 — a walk-in's Date of Visit may NOT be in the past. The visit is
   * happening now (or is being scheduled for today), so a date before today is a
   * data-entry error. Compared on the UTC calendar day; the form also sets the
   * input's min to today, so this is the server-side backstop.
   */
  private assertNotPastVisit(visited_at: string | null | undefined): void {
    if (visited_at == null || String(visited_at).trim() === '') return;
    const d = new Date(visited_at);
    if (isNaN(d.getTime())) throw new BadRequestException('Date of Visit is not a valid date/time');
    // A `datetime-local` value carries no timezone — it is wall-clock in the process's
    // local zone, so the "today" comparison must use LOCAL calendar days (not UTC), or
    // a picked time before the UTC midnight of a non-UTC zone reads as yesterday.
    const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
    if (day(d) < day(new Date())) {
      throw new BadRequestException('Date of Visit cannot be in the past');
    }
  }

  /** Course Fee arrives from a number input as a string; '' means "cleared". */
  private fee(v: number | string | null | undefined): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException('course_fee must be a positive number');
    return n;
  }

  /**
   * "How did you hear about us?" maps to the LEAD SOURCE MASTER (m_source) — the same
   * master `source.master_source_id` points at, i.e. how sources work everywhere else.
   * It is NOT the campaign-scoped `source` row (that is the separate "Lead Source" field).
   */
  private async heardAboutId(id: number | null | undefined): Promise<number | null> {
    if (id === undefined || id === null || (id as unknown as string) === '') return null;
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM m_source WHERE id = $1 AND deleted_at IS NULL`, [Number(id)],
    );
    if (!row) throw new BadRequestException('heard_about_source_id must be a Lead Source master entry');
    return Number(row.id);
  }

  /**
   * THE ONE PATH a walk-in lead is created by — used on create AND on a later
   * "Convert to Lead" from the Edit form. There is no second way to make a lead
   * (that is the whole point of LeadIngestionService).
   */
  private async ingestWalkInLead(
    dto: Pick<WalkInDto, 'visitor_name' | 'phone' | 'email' | 'alt_phone' | 'whatsapp_phone'
      | 'course_id' | 'remarks' | 'campaign_id' | 'source_id' | 'counsellor_id'>,
    fee: number | null,
    actorId: number,
  ) {
    const outcome = await this.ingestion.ingest(
      {
        full_name: dto.visitor_name,
        phone: dto.phone,
        email: dto.email,
        alt_phone: dto.alt_phone,
        whatsapp_phone: dto.whatsapp_phone,
        course: dto.course_id,
        // the fee the counsellor quoted at the desk travels to the lead, in the same
        // custom_fields slot the Add Lead form uses (`course_fee`)
        custom_fields: fee != null ? { course_fee: fee } : undefined,
        note: dto.remarks ? `Walk-in: ${dto.remarks}` : 'Walk-in visitor',
      },
      {
        channel: 'manual',
        campaign_id: Number(dto.campaign_id),
        source_id: Number(dto.source_id),
        actor_id: actorId,
        owner_id: Number(dto.counsellor_id),      // ASSIGN ON ADD
        duplicate_policy: 'always_create',        // a human at the desk is never swallowed
      },
    );
    if (outcome.status === 'failed') throw new BadRequestException(outcome.reason || 'could not create the walk-in lead');
    return outcome;
  }

  /**
   * DEF-S34-03 — THE EDIT PATH. Before this, "Edit" on a walk-in opened the LEAD, so no
   * walk-in field (visitor name, email, purpose, course, remarks, visited-at…) could
   * ever be corrected — the DEF-2 family again, on a screen a receptionist uses daily.
   *
   * The WHITELIST BELOW IS THE WHOLE POINT: it must contain every field the Edit form
   * renders as an editable control, or we have re-created the bug. The hierarchy path
   * (branch / vertical / campaign / source) is deliberately NOT here — it is the lead's
   * immutable parent link, and the form renders it locked, per the qa/09 rule.
   * `web/src/qa10matrix.test.tsx` fails the build if the form renders something this
   * list does not carry.
   */
  async updateWalkIn(id: number, dto: Partial<WalkInDto>, actorId: number, scope: ResolvedScope) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT * FROM walk_in WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!before) throw new NotFoundException('walk-in not found');
    if (dto.status) {
      const allowed = await this.allowedWalkInStatuses();
      if (!allowed.has(String(dto.status))) {
        throw new BadRequestException(`status must be one of: ${[...allowed].join(', ')}`);
      }
    }
    // #19 — a walk-in's Date of Visit may not be moved into the past. Only checked
    // when it actually CHANGES, so re-saving an older walk-in is never blocked.
    if (dto.visited_at !== undefined && String(dto.visited_at ?? '') !== String(before.visited_at ?? '')) {
      this.assertNotPastVisit(dto.visited_at);
    }
    if (dto.counsellor_id != null && Number(dto.counsellor_id) !== Number(before.counsellor_id)) {
      await this.enforcer.assertRefInScope(scope, 'user', Number(dto.counsellor_id), actorId);
      const c = await this.db.one(
        `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [Number(dto.counsellor_id)],
      );
      if (!c) throw new BadRequestException('counsellor must be an active user');
    }

    const patch: Record<string, unknown> = {};
    const cols: Array<keyof WalkInDto> = [
      'visitor_name', 'phone', 'alt_phone', 'whatsapp_phone', 'email', 'visited_at',
      'purpose', 'course_id', 'counsellor_id', 'status', 'wait_minutes', 'remarks',
    ];
    for (const c of cols) if (dto[c] !== undefined) patch[c] = dto[c] === '' ? null : dto[c];
    // DEF-S34-02 — the three fields that used to be discarded
    if (dto.course_fee !== undefined) patch.course_fee = this.fee(dto.course_fee);
    if (dto.heard_about_source_id !== undefined) {
      patch.heard_about_source_id = await this.heardAboutId(dto.heard_about_source_id);
    }
    if (dto.convert_to_lead !== undefined) patch.convert_to_lead = dto.convert_to_lead !== false;

    // "Convert to Lead" ticked on a walk-in that has no lead yet -> CONVERT IT NOW,
    // through the SAME LeadIngestionService every other channel uses. No second path.
    let newLeadId: number | null = null;
    if (patch.convert_to_lead === true && !before.lead_id) {
      const merged = {
        visitor_name: (patch.visitor_name as string) ?? before.visitor_name,
        phone: (patch.phone as string) ?? before.phone,
        email: (patch.email as string) ?? before.email,
        alt_phone: (patch.alt_phone as string) ?? before.alt_phone,
        whatsapp_phone: (patch.whatsapp_phone as string) ?? before.whatsapp_phone,
        course_id: (patch.course_id as number) ?? before.course_id,
        remarks: (patch.remarks as string) ?? before.remarks,
        campaign_id: Number(before.campaign_id),
        source_id: Number(before.source_id),
        counsellor_id: Number(patch.counsellor_id ?? before.counsellor_id),
      };
      if (!merged.campaign_id || !merged.source_id) {
        throw new BadRequestException('this walk-in has no campaign/source to convert under');
      }
      const feeNow = patch.course_fee !== undefined
        ? (patch.course_fee as number | null)
        : this.fee(before.course_fee);
      const outcome = await this.ingestWalkInLead(merged as never, feeNow, actorId);
      newLeadId = outcome.lead_id ?? null;
      patch.lead_id = newLeadId;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const row = await this.db.one<Record<string, any>>(
      `UPDATE walk_in SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );

    const leadId = newLeadId ?? (before.lead_id ? Number(before.lead_id) : null);
    if (leadId) {
      // the walk-in IS the lead's person: a corrected name/phone/email/course must not
      // leave the lead showing the typo the receptionist just fixed.
      await this.syncLeadFromWalkIn(leadId, dto, patch);
      // reassigning the walk-in reassigns the lead — assign-on-add stays true after an edit
      if (dto.counsellor_id != null && !newLeadId) {
        await this.db.query(`UPDATE lead SET owner_id = $2, updated_at = now() WHERE id = $1`,
          [leadId, Number(dto.counsellor_id)]);
        await this.sla.safe(() => this.sla.onLeadTouched(leadId), 'walkin reassign');
      }
      await this.scoring.safeRescore(leadId);   // a fresh conversion earns the +25 walk-in rule
    }
    return { ...row, lead_id: leadId };
  }

  /** Push the corrected visitor details onto the lead the walk-in created. */
  private async syncLeadFromWalkIn(
    leadId: number, dto: Partial<WalkInDto>, patch: Record<string, unknown>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [leadId];
    const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (dto.visitor_name !== undefined) put('full_name', patch.visitor_name);
    // phones go through the SAME normaliser the ingestion path uses — a lead's phone is
    // always canonical E.164 (it is the dedupe key)
    if (dto.phone !== undefined) put('phone', normalizePhone(String(patch.phone ?? '')) || null);
    if (dto.alt_phone !== undefined) put('alt_phone', patch.alt_phone ? normalizePhone(String(patch.alt_phone)) : null);
    if (dto.whatsapp_phone !== undefined) put('whatsapp_phone', patch.whatsapp_phone ? normalizePhone(String(patch.whatsapp_phone)) : null);
    if (dto.email !== undefined) put('email', patch.email);
    if (dto.course_id !== undefined) put('course_id', patch.course_id);
    if (dto.course_fee !== undefined) {
      params.push(JSON.stringify({ course_fee: patch.course_fee }));
      sets.push(`custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $${params.length}::jsonb`);
    }
    if (!sets.length) return;
    await this.db.query(
      `UPDATE lead SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params,
    );
  }

  async removeWalkIn(id: number, actorId: number) {
    const row = await this.db.one(
      `UPDATE walk_in SET deleted_at = now(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, visitor_name, lead_id`, [id, actorId],
    );
    if (!row) throw new NotFoundException('walk-in not found');
    // the LEAD survives (soft-delete rule #20: children are never cascaded) but it is no
    // longer a walk-in, so the +25 walk-in rule must stop applying.
    await this.scoring.safeRescore((row as any).lead_id);
    return row;
  }

  /* ================================ REFERRALS ================================ */

  async listReferrals(scope: ResolvedScope, q: { status?: string; limit?: number }) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, REFERRAL_SCOPE_COLS, params);
    const where = [w, 'r.deleted_at IS NULL'];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    params.push(Math.min(Number(q.limit) || 100, 500));
    return this.db.query(
      // DEF-S34-03: the Edit form prefills from this row, so EVERY editable column is
      // selected here — including referred_whatsapp / referred_email and the path.
      `SELECT r.id, r.referrer_type, r.referrer_name, r.referrer_phone, r.referred_name,
              r.referred_phone, r.referred_whatsapp, r.referred_email, r.relationship,
              r.incentive, r.status, r.lead_id, r.assigned_counsellor_id,
              r.branch_id, r.vertical_id, r.campaign_id, r.source_id, r.course_id, r.created_at,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              cmp.name AS campaign_name, cmp.pipeline_id, pl.name AS pipeline_name,
              sr.name AS source_name,
              rl.temperature, rl.score, rl.owner_id, u.name AS owner_name, st.name AS stage_name
         FROM referral r
         LEFT JOIN lead rl ON rl.id = r.lead_id
         LEFT JOIN "user" u ON u.id = rl.owner_id
         LEFT JOIN m_course c ON c.id = r.course_id
         LEFT JOIN branch b ON b.id = r.branch_id
         LEFT JOIN vertical v ON v.id = r.vertical_id
         LEFT JOIN campaign cmp ON cmp.id = r.campaign_id
         LEFT JOIN pipeline pl ON pl.id = cmp.pipeline_id
         LEFT JOIN source sr ON sr.id = r.source_id
         LEFT JOIN pipeline_stage st ON st.id = rl.stage_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}`, params,
    );
  }

  async referralSummary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, REFERRAL_SCOPE_COLS, params);
    return this.db.one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE r.created_at >= date_trunc('month', now()))::int AS mtd,
              COUNT(*) FILTER (WHERE r.status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE r.status = 'rewarded')::int AS rewarded,
              COUNT(*) FILTER (WHERE r.status = 'converted')::int AS rewards_due
         FROM referral r
         LEFT JOIN lead rl ON rl.id = r.lead_id
         LEFT JOIN campaign cmp ON cmp.id = r.campaign_id
        WHERE (${w}) AND r.deleted_at IS NULL`, params,
    );
  }

  async createReferral(dto: ReferralDto, actorId: number, scope: ResolvedScope) {
    for (const f of ['referrer_type', 'referrer_name', 'referred_name', 'referred_phone',
      'branch_id', 'vertical_id', 'campaign_id', 'source_id'] as const) {
      if (!dto?.[f]) throw new BadRequestException(`${f} is required`);
    }
    if (!REFERRER_TYPES.includes(String(dto.referrer_type))) {
      throw new BadRequestException(`referrer_type must be one of: ${REFERRER_TYPES.join(', ')}`);
    }
    if (dto.status && !REFERRAL_STATUS.includes(String(dto.status))) {
      throw new BadRequestException(`status must be one of: ${REFERRAL_STATUS.join(', ')}`);
    }
    await this.enforcer.assertRefInScope(scope, 'campaign', Number(dto.campaign_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'source', Number(dto.source_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'user', dto.owner_id ? Number(dto.owner_id) : undefined, actorId);

    const outcome = await this.ingestion.ingest(
      {
        full_name: dto.referred_name,
        phone: dto.referred_phone,
        email: dto.referred_email,
        whatsapp_phone: dto.referred_whatsapp,
        course: dto.course_id,
        note: `Referred by ${dto.referrer_name} (${dto.referrer_type})`,
      },
      {
        channel: 'manual',
        campaign_id: Number(dto.campaign_id),
        source_id: Number(dto.source_id),
        actor_id: actorId,
        owner_id: dto.owner_id ? Number(dto.owner_id) : null,   // else campaign distribution decides
        duplicate_policy: 'always_create',
      },
    );
    if (outcome.status === 'failed') throw new BadRequestException(outcome.reason || 'could not create the referred lead');

    const org = await this.orgId();
    const row = await this.db.one(
      // DEF-S34-03: referred_whatsapp / referred_email / campaign_id / source_id are now
      // STORED, so the Edit form can prefill and persist every field it renders.
      `INSERT INTO referral (org_id, branch_id, vertical_id, campaign_id, source_id, lead_id,
                             referrer_type, referrer_name, referrer_phone, referred_name,
                             referred_phone, referred_whatsapp, referred_email, relationship,
                             course_id, incentive, status, created_by, assigned_counsellor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [org, Number(dto.branch_id), Number(dto.vertical_id), Number(dto.campaign_id),
        Number(dto.source_id), outcome.lead_id ?? null,
        dto.referrer_type, dto.referrer_name, dto.referrer_phone ?? null, dto.referred_name,
        dto.referred_phone, dto.referred_whatsapp ?? null, dto.referred_email ?? null,
        dto.relationship ?? null, dto.course_id ?? null,
        dto.incentive ?? null, dto.status ?? 'pending', actorId,
        dto.owner_id ? Number(dto.owner_id) : null],
    );
    await this.scoring.safeRescore(outcome.lead_id);   // the +20 referral rule can now see it
    return { ...row, lead_id: outcome.lead_id, duplicate_of: outcome.duplicate_of ?? null };
  }

  /**
   * DEF-S34-03 — Referrals had NO Edit action at all (View only), so a wrong Referrer
   * Name / Relationship / Incentive could never be fixed. The whitelist below carries
   * every field the Edit form renders (the path stays locked — it is the lead's parent
   * link), and `web/src/qa10matrix.test.tsx` fails the build if the two drift apart.
   */
  async updateReferral(id: number, dto: Partial<ReferralDto>, actorId: number, scope: ResolvedScope) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT * FROM referral WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!before) throw new NotFoundException('referral not found');
    if (dto.status && !REFERRAL_STATUS.includes(String(dto.status))) {
      throw new BadRequestException(`status must be one of: ${REFERRAL_STATUS.join(', ')}`);
    }
    if (dto.referrer_type && !REFERRER_TYPES.includes(String(dto.referrer_type))) {
      throw new BadRequestException(`referrer_type must be one of: ${REFERRER_TYPES.join(', ')}`);
    }
    const cols: Array<keyof ReferralDto> = [
      'referrer_type', 'referrer_name', 'referrer_phone', 'referred_name', 'referred_phone',
      'referred_whatsapp', 'referred_email', 'relationship', 'course_id', 'incentive', 'status',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      if (dto[c] === undefined) continue;
      params.push(dto[c] === '' ? null : dto[c]);
      sets.push(`${c} = $${params.length}`);
    }
    // #20 — Assigned Counsellor. Validated (active, in scope) exactly like the
    // walk-in counsellor; persisted on the referral and (below) applied to the
    // lead's owner so re-assigning a referral re-assigns its lead.
    let reassignOwner: number | null | undefined;
    if (dto.owner_id !== undefined) {
      reassignOwner = dto.owner_id ? Number(dto.owner_id) : null;
      if (reassignOwner != null) {
        await this.enforcer.assertRefInScope(scope, 'user', reassignOwner, actorId);
        const u = await this.db.one(
          `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [reassignOwner]);
        if (!u) throw new BadRequestException('assigned counsellor must be an active user');
      }
      params.push(reassignOwner);
      sets.push(`assigned_counsellor_id = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const row = await this.db.one<Record<string, any>>(
      `UPDATE referral SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );

    // the referred person IS the lead: a corrected name/phone/email/course must show there too
    if (before.lead_id) {
      const lsets: string[] = [];
      const lp: unknown[] = [Number(before.lead_id)];
      const put = (col: string, v: unknown) => { lp.push(v); lsets.push(`${col} = $${lp.length}`); };
      if (dto.referred_name !== undefined) put('full_name', dto.referred_name || null);
      if (dto.referred_phone !== undefined) put('phone', normalizePhone(String(dto.referred_phone ?? '')) || null);
      if (dto.referred_whatsapp !== undefined) {
        put('whatsapp_phone', dto.referred_whatsapp ? normalizePhone(String(dto.referred_whatsapp)) : null);
      }
      if (dto.referred_email !== undefined) put('email', dto.referred_email || null);
      if (dto.course_id !== undefined) put('course_id', dto.course_id || null);
      if (lsets.length) {
        await this.db.query(`UPDATE lead SET ${lsets.join(', ')}, updated_at = now() WHERE id = $1`, lp);
      }
      // #20 — re-assigning the referral re-assigns its lead (assign-on-add stays true).
      if (reassignOwner !== undefined) {
        await this.db.query(`UPDATE lead SET owner_id = $2, updated_at = now() WHERE id = $1`,
          [Number(before.lead_id), reassignOwner]);
        await this.sla.safe(() => this.sla.onLeadTouched(Number(before.lead_id)), 'referral reassign');
      }
      await this.scoring.safeRescore(Number(before.lead_id));
    }
    return row;
  }

  async removeReferral(id: number, actorId: number) {
    const row = await this.db.one(
      `UPDATE referral SET deleted_at = now(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, referrer_name, lead_id`, [id, actorId],
    );
    if (!row) throw new NotFoundException('referral not found');
    await this.scoring.safeRescore((row as any).lead_id);
    return row;
  }
}
