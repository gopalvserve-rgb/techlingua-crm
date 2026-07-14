import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ScoringService } from '../scoring/scoring.service';
import { SlaService } from '../sla/sla.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

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

export const WALKIN_SCOPE_COLS: ScopeColumnMap = {
  owner: 'wl.owner_id', team: 'wl.team_id', branch: 'w.branch_id', vertical: 'w.vertical_id',
  pipeline: 'wl.pipeline_id', campaign: 'wl.campaign_id',
};
export const REFERRAL_SCOPE_COLS: ScopeColumnMap = {
  owner: 'rl.owner_id', team: 'rl.team_id', branch: 'r.branch_id', vertical: 'r.vertical_id',
  pipeline: 'rl.pipeline_id', campaign: 'rl.campaign_id',
};

const WALKIN_STATUS = ['waiting', 'in_progress', 'converted', 'closed'];
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

  async listWalkIns(scope: ResolvedScope, q: { today?: boolean; status?: string; limit?: number }) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, WALKIN_SCOPE_COLS, params);
    const where = [w, 'w.deleted_at IS NULL'];
    if (q.today) where.push(`w.visited_at::date = CURRENT_DATE`);
    if (q.status) { params.push(q.status); where.push(`w.status = $${params.length}`); }
    params.push(Math.min(Number(q.limit) || 100, 500));
    return this.db.query(
      `SELECT w.id, w.visitor_name, w.phone, w.email, w.visited_at, w.purpose, w.status,
              w.wait_minutes, w.remarks, w.lead_id, w.counsellor_id, w.course_id,
              w.branch_id, w.vertical_id, w.created_at,
              u.name AS counsellor_name, c.name AS course_name, b.name AS branch_name,
              v.name AS vertical_name, wl.temperature, wl.score, wl.full_name AS lead_name,
              st.name AS stage_name
         FROM walk_in w
         LEFT JOIN lead wl ON wl.id = w.lead_id
         LEFT JOIN "user" u ON u.id = w.counsellor_id
         LEFT JOIN m_course c ON c.id = w.course_id
         LEFT JOIN branch b ON b.id = w.branch_id
         LEFT JOIN vertical v ON v.id = w.vertical_id
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
      `SELECT COUNT(*) FILTER (WHERE w.visited_at::date = CURRENT_DATE)::int AS today,
              COUNT(*) FILTER (WHERE w.status = 'converted')::int AS converted,
              COUNT(*) FILTER (WHERE w.status = 'waiting')::int AS waiting,
              COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(w.wait_minutes) FILTER (WHERE w.wait_minutes IS NOT NULL))::int, 0) AS avg_wait
         FROM walk_in w LEFT JOIN lead wl ON wl.id = w.lead_id
        WHERE (${w}) AND w.deleted_at IS NULL`, params,
    );
  }

  async createWalkIn(dto: WalkInDto, actorId: number, scope: ResolvedScope) {
    for (const f of ['visitor_name', 'phone', 'branch_id', 'vertical_id', 'campaign_id', 'source_id', 'counsellor_id'] as const) {
      if (!dto?.[f]) throw new BadRequestException(`${f} is required`);
    }
    if (dto.status && !WALKIN_STATUS.includes(String(dto.status))) {
      throw new BadRequestException(`status must be one of: ${WALKIN_STATUS.join(', ')}`);
    }
    // RBAC: the campaign, source and counsellor must all be inside the caller's scope
    await this.enforcer.assertRefInScope(scope, 'campaign', Number(dto.campaign_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'source', Number(dto.source_id), actorId);
    await this.enforcer.assertRefInScope(scope, 'user', Number(dto.counsellor_id), actorId);
    const c = await this.db.one<{ id: string }>(
      `SELECT id FROM "user" WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, [Number(dto.counsellor_id)],
    );
    if (!c) throw new BadRequestException('counsellor must be an active user');

    // ONE ingestion path — the lead is created exactly as a CSV/webhook lead would be,
    // except the owner is FORCED to the counsellor (assign on add).
    const outcome = await this.ingestion.ingest(
      {
        full_name: dto.visitor_name,
        phone: dto.phone,
        email: dto.email,
        alt_phone: dto.alt_phone,
        whatsapp_phone: dto.whatsapp_phone,
        course: dto.course_id,
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

    const org = await this.orgId();
    const row = await this.db.one(
      `INSERT INTO walk_in (org_id, branch_id, vertical_id, lead_id, visitor_name, phone, email,
                            visited_at, purpose, course_id, counsellor_id, status, wait_minutes, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), $9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [org, Number(dto.branch_id), Number(dto.vertical_id), outcome.lead_id ?? null,
        dto.visitor_name, dto.phone, dto.email ?? null, dto.visited_at ?? null, dto.purpose ?? null,
        dto.course_id ?? null, Number(dto.counsellor_id), dto.status ?? 'waiting',
        dto.wait_minutes ?? null, dto.remarks ?? null, actorId],
    );

    // the walk_in row now exists -> the `walk_in` scoring rule (+25) can see it
    await this.scoring.safeRescore(outcome.lead_id);
    return { ...row, lead_id: outcome.lead_id, duplicate_of: outcome.duplicate_of ?? null };
  }

  async updateWalkIn(id: number, dto: Partial<WalkInDto>, actorId: number, scope: ResolvedScope) {
    const before = await this.db.one<Record<string, any>>(
      `SELECT * FROM walk_in WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!before) throw new NotFoundException('walk-in not found');
    if (dto.status && !WALKIN_STATUS.includes(String(dto.status))) {
      throw new BadRequestException(`status must be one of: ${WALKIN_STATUS.join(', ')}`);
    }
    if (dto.counsellor_id != null && Number(dto.counsellor_id) !== Number(before.counsellor_id)) {
      await this.enforcer.assertRefInScope(scope, 'user', Number(dto.counsellor_id), actorId);
    }
    const cols: Array<keyof WalkInDto> = [
      'visitor_name', 'phone', 'email', 'visited_at', 'purpose', 'course_id',
      'counsellor_id', 'status', 'wait_minutes', 'remarks',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      if (dto[c] === undefined) continue;
      params.push(dto[c] === '' ? null : dto[c]);
      sets.push(`${c} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const row = await this.db.one(
      `UPDATE walk_in SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
    // reassigning the walk-in reassigns the lead — assign-on-add stays true after an edit
    if (dto.counsellor_id != null && before.lead_id) {
      await this.db.query(`UPDATE lead SET owner_id = $2, updated_at = now() WHERE id = $1`,
        [Number(before.lead_id), Number(dto.counsellor_id)]);
      await this.sla.safe(() => this.sla.onLeadTouched(Number(before.lead_id)), 'walkin reassign');
    }
    return row;
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
      `SELECT r.id, r.referrer_type, r.referrer_name, r.referrer_phone, r.referred_name,
              r.referred_phone, r.relationship, r.incentive, r.status, r.lead_id,
              r.branch_id, r.vertical_id, r.course_id, r.created_at,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              rl.temperature, rl.score, rl.owner_id, u.name AS owner_name, st.name AS stage_name
         FROM referral r
         LEFT JOIN lead rl ON rl.id = r.lead_id
         LEFT JOIN "user" u ON u.id = rl.owner_id
         LEFT JOIN m_course c ON c.id = r.course_id
         LEFT JOIN branch b ON b.id = r.branch_id
         LEFT JOIN vertical v ON v.id = r.vertical_id
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
         FROM referral r LEFT JOIN lead rl ON rl.id = r.lead_id
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
      `INSERT INTO referral (org_id, branch_id, vertical_id, lead_id, referrer_type, referrer_name,
                             referrer_phone, referred_name, referred_phone, relationship, course_id,
                             incentive, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [org, Number(dto.branch_id), Number(dto.vertical_id), outcome.lead_id ?? null,
        dto.referrer_type, dto.referrer_name, dto.referrer_phone ?? null, dto.referred_name,
        dto.referred_phone, dto.relationship ?? null, dto.course_id ?? null,
        dto.incentive ?? null, dto.status ?? 'pending', actorId],
    );
    await this.scoring.safeRescore(outcome.lead_id);   // the +20 referral rule can now see it
    return { ...row, lead_id: outcome.lead_id, duplicate_of: outcome.duplicate_of ?? null };
  }

  async updateReferral(id: number, dto: Partial<ReferralDto>, actorId: number, _scope: ResolvedScope) {
    const before = await this.db.one(`SELECT * FROM referral WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!before) throw new NotFoundException('referral not found');
    if (dto.status && !REFERRAL_STATUS.includes(String(dto.status))) {
      throw new BadRequestException(`status must be one of: ${REFERRAL_STATUS.join(', ')}`);
    }
    if (dto.referrer_type && !REFERRER_TYPES.includes(String(dto.referrer_type))) {
      throw new BadRequestException(`referrer_type must be one of: ${REFERRER_TYPES.join(', ')}`);
    }
    const cols: Array<keyof ReferralDto> = [
      'referrer_type', 'referrer_name', 'referrer_phone', 'referred_name', 'referred_phone',
      'relationship', 'course_id', 'incentive', 'status',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      if (dto[c] === undefined) continue;
      params.push(dto[c] === '' ? null : dto[c]);
      sets.push(`${c} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    return this.db.one(
      `UPDATE referral SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
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
