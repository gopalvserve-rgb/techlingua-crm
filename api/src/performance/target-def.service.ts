import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { rupeesToMinor } from '../common/money.util';
import { toDateString } from '../common/date.util';
import { IncentiveService, resolveIncentive } from './incentive.service';

/**
 * TARGET & INCENTIVE — the rich target (dev/134, Part 1A & 1C).
 *
 * A target is a NAME + a Target-For (Individual / Team / Branch / Vertical /
 * Course) + a Period (Monthly / Quarterly / Half-Yearly / Yearly / Custom) +
 * SIX metrics (Leads, Walk-ins, Admissions, Revenue, Collection, Meetings) +
 * an optional Incentive Plan.
 *
 * WHAT AN "ACTUAL" IS — one definition, shared with Counsellor Performance and
 * the Sprint-6 reports (the same booked-vs-collected discipline):
 *   · Leads       — leads created in the period, attributed to the target entity.
 *   · Walk-ins    — walk_in rows in the period.
 *   · Admissions  — ACTIVE enrolments created in the period (pending ones do NOT count).
 *   · Revenue     — net_fee_minor of those admissions (BOOKED, before tax), not collected.
 *   · Collection  — fee_receipt cash in the period, attributed by the enrolment's entity.
 *   · Meetings    — calendar_event of type 'meeting' in the period.
 *
 * Period is a HALF-OPEN [period_start, period_end) span computed once and stored,
 * so every reader measures the identical window.
 */

export const TARGET_DEF_SCOPE_COLS: ScopeColumnMap = {
  owner: 't.user_id', branch: 't.branch_id', vertical: 't.vertical_id',
};

type PeriodType = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'custom';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * PURE — resolve a period preset to its [start, end) span (end EXCLUSIVE), from
 * an anchor date. Custom uses the supplied start/end verbatim. Exported for the
 * unit test.
 */
export function resolvePeriod(
  type: PeriodType,
  opts: { anchor?: string; start?: string; end?: string } = {},
): { start: string; end: string } {
  if (type === 'custom') {
    const start = opts.start;
    const end = opts.end;
    if (!start || !end) throw new BadRequestException('A custom period needs a start and an end date.');
    if (end <= start) throw new BadRequestException('The custom period must end after it starts.');
    return { start, end };
  }
  const rawAnchor = opts.anchor ? String(opts.anchor) : '';
  const normAnchor = /^\d{4}-\d{2}$/.test(rawAnchor) ? `${rawAnchor}-01` : rawAnchor;
  const a = normAnchor ? new Date(`${normAnchor}T00:00:00Z`) : new Date();
  if (Number.isNaN(a.getTime())) throw new BadRequestException('Invalid period anchor date.');
  const y = a.getUTCFullYear();
  const m0 = a.getUTCMonth(); // 0-based
  if (type === 'monthly') {
    const start = ymd(y, m0 + 1, 1);
    const em = m0 + 1; const ey = em > 11 ? y + 1 : y; const emm = (em % 12) + 1;
    return { start, end: ymd(ey, emm, 1) };
  }
  if (type === 'quarterly') {
    const qStart = Math.floor(m0 / 3) * 3; // 0,3,6,9
    const start = ymd(y, qStart + 1, 1);
    const endMonth0 = qStart + 3;
    const ey = endMonth0 > 11 ? y + 1 : y; const emm = (endMonth0 % 12) + 1;
    return { start, end: ymd(ey, emm, 1) };
  }
  if (type === 'half_yearly') {
    const hStart = m0 < 6 ? 0 : 6;
    const start = ymd(y, hStart + 1, 1);
    const endMonth0 = hStart + 6;
    const ey = endMonth0 > 11 ? y + 1 : y; const emm = (endMonth0 % 12) + 1;
    return { start, end: ymd(ey, emm, 1) };
  }
  // yearly
  return { start: ymd(y, 1, 1), end: ymd(y + 1, 1, 1) };
}

export const pct1 = (num: number, den: number): number =>
  (den > 0 ? Math.round((num * 1000) / den) / 10 : 0);

const TARGET_FOR = ['user', 'team', 'branch', 'vertical', 'course'];

@Injectable()
export class TargetDefService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly incentive: IncentiveService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** LIST targets in scope, each with its live actuals + % per metric. */
  async list(scope: ResolvedScope, f: { period_type?: string; target_for?: string } = {}) {
    const params: unknown[] = [];
    const where = [`t.deleted_at IS NULL`,
      this.resolver.buildScopeWhere(scope, TARGET_DEF_SCOPE_COLS, params)];
    if (f.period_type) { params.push(f.period_type); where.push(`t.period_type = $${params.length}`); }
    if (f.target_for) { params.push(f.target_for); where.push(`t.target_for = $${params.length}`); }

    const rows = await this.db.query<any>(
      `SELECT t.*, u.name AS user_name, b.name AS branch_name, v.name AS vertical_name,
              tm.name AS team_name, c.name AS course_name, p.name AS plan_name
         FROM target_definition t
         LEFT JOIN "user" u ON u.id = t.user_id
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN team tm ON tm.id = t.team_id
         LEFT JOIN m_course c ON c.id = t.course_id
         LEFT JOIN incentive_plan p ON p.id = t.incentive_plan_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.period_start DESC, t.id DESC`,
      params,
    );
    return Promise.all(rows.map((r) => this.decorate(r)));
  }

  private label(r: any): string {
    return r.user_name ?? r.team_name ?? r.branch_name ?? r.vertical_name ?? r.course_name ?? '—';
  }

  /** Compute actuals + % for a target row, plus the label. */
  private async decorate(r: any) {
    const a = await this.actuals(r);
    const targets = {
      leads: Number(r.leads_target), walkins: Number(r.walkins_target),
      admissions: Number(r.admissions_target), revenue_minor: Number(r.revenue_target_minor),
      collection_minor: Number(r.collection_target_minor), meetings: Number(r.meetings_target),
    };
    return {
      id: Number(r.id), name: r.name, target_for: r.target_for,
      user_id: r.user_id ? Number(r.user_id) : null,
      team_id: r.team_id ? Number(r.team_id) : null,
      branch_id: r.branch_id ? Number(r.branch_id) : null,
      vertical_id: r.vertical_id ? Number(r.vertical_id) : null,
      course_id: r.course_id ? Number(r.course_id) : null,
      period_type: r.period_type, period_start: r.period_start, period_end: r.period_end,
      incentive_plan_id: r.incentive_plan_id ? Number(r.incentive_plan_id) : null,
      plan_name: r.plan_name ?? null,
      note: r.note ?? null,
      label: this.label(r),
      targets,
      actuals: a,
      pct: {
        leads: pct1(a.leads, targets.leads), walkins: pct1(a.walkins, targets.walkins),
        admissions: pct1(a.admissions, targets.admissions),
        revenue: pct1(a.revenue_minor, targets.revenue_minor),
        collection: pct1(a.collection_minor, targets.collection_minor),
        meetings: pct1(a.meetings, targets.meetings),
      },
    };
  }

  /**
   * The scope predicate for a metric, given the target's Target-For.
   * `$1` is always the entity id; the column is chosen from a whitelist so
   * there is no injection surface.
   */
  private predicates(targetFor: string) {
    switch (targetFor) {
      case 'user':
        return { lead: 'l.owner_id = $1::bigint', walk: 'w.counsellor_id = $1::bigint',
          enr: 'e.counsellor_id = $1::bigint', meet: 'ce.owner_id = $1::bigint', meetJoinCourse: false };
      case 'branch':
        return { lead: 'l.branch_id = $1::bigint', walk: 'w.branch_id = $1::bigint',
          enr: 'e.branch_id = $1::bigint', meet: 'ce.branch_id = $1::bigint', meetJoinCourse: false };
      case 'vertical':
        return { lead: 'l.vertical_id = $1::bigint', walk: 'w.vertical_id = $1::bigint',
          enr: 'e.vertical_id = $1::bigint', meet: 'ce.vertical_id = $1::bigint', meetJoinCourse: false };
      case 'course':
        return { lead: 'l.course_id = $1::bigint', walk: 'w.course_id = $1::bigint',
          enr: 'e.course_id = $1::bigint', meet: 'ml.course_id = $1::bigint', meetJoinCourse: true };
      case 'team':
        return {
          lead: 'l.team_id = $1::bigint', enr: 'e.team_id = $1::bigint',
          walk: 'w.counsellor_id IN (SELECT user_id FROM team_member WHERE team_id = $1::bigint)',
          meet: 'ce.team_id = $1::bigint', meetJoinCourse: false,
        };
      default:
        throw new BadRequestException('Unknown Target-For.');
    }
  }

  private entityId(r: any): number {
    const id = r.target_for === 'user' ? r.user_id
      : r.target_for === 'team' ? r.team_id
      : r.target_for === 'branch' ? r.branch_id
      : r.target_for === 'vertical' ? r.vertical_id
      : r.course_id;
    return Number(id);
  }

  /** LIVE actuals for a target — one round trip, six scalar subqueries. */
  async actuals(r: any) {
    const p = this.predicates(r.target_for);
    const id = this.entityId(r);
    const from = toDateString(r.period_start) ?? String(r.period_start);
    const to = toDateString(r.period_end) ?? String(r.period_end);
    const meetFrom = p.meetJoinCourse
      ? `calendar_event ce JOIN lead ml ON ml.id = ce.lead_id`
      : `calendar_event ce`;
    const params = [id, from, to];
    const row = await this.db.one<any>(
      `SELECT
         (SELECT count(*) FROM lead l
           WHERE l.deleted_at IS NULL AND ${p.lead}
             AND l.created_at >= $2::date AND l.created_at < $3::date) AS leads,
         (SELECT count(*) FROM walk_in w
           WHERE w.deleted_at IS NULL AND ${p.walk}
             AND w.visited_at >= $2::date AND w.visited_at < $3::date) AS walkins,
         (SELECT count(*) FROM enrolment e
           WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${p.enr}
             AND e.created_at >= $2::date AND e.created_at < $3::date) AS admissions,
         (SELECT COALESCE(sum(e.net_fee_minor), 0) FROM enrolment e
           WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${p.enr}
             AND e.created_at >= $2::date AND e.created_at < $3::date) AS revenue_minor,
         (SELECT COALESCE(sum(fr.amount_minor), 0) FROM fee_receipt fr
            JOIN enrolment e ON e.id = fr.enrolment_id
           WHERE fr.deleted_at IS NULL AND e.deleted_at IS NULL AND ${p.enr}
             AND fr.received_at >= $2::date AND fr.received_at < $3::date) AS collection_minor,
         (SELECT count(*) FROM ${meetFrom}
           WHERE ce.deleted_at IS NULL AND ce.type = 'meeting' AND ${p.meet}
             AND ce.starts_at >= $2::date AND ce.starts_at < $3::date) AS meetings`,
      params,
    );
    return {
      leads: Number(row?.leads ?? 0),
      walkins: Number(row?.walkins ?? 0),
      admissions: Number(row?.admissions ?? 0),
      revenue_minor: Number(row?.revenue_minor ?? 0),
      collection_minor: Number(row?.collection_minor ?? 0),
      meetings: Number(row?.meetings ?? 0),
    };
  }

  /** DASHBOARD for one target — the six progress cards + the earned incentive. */
  async dashboard(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, TARGET_DEF_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT t.*, u.name AS user_name, b.name AS branch_name, v.name AS vertical_name,
              tm.name AS team_name, c.name AS course_name, p.name AS plan_name
         FROM target_definition t
         LEFT JOIN "user" u ON u.id = t.user_id
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN team tm ON tm.id = t.team_id
         LEFT JOIN m_course c ON c.id = t.course_id
         LEFT JOIN incentive_plan p ON p.id = t.incentive_plan_id
        WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!r) throw new NotFoundException('Target not found');
    const decorated = await this.decorate(r);

    // Earned incentive: resolve the linked plan's slabs against the achievement %
    // of the plan's OWN metric (a revenue plan measures revenue %, etc.).
    let incentive: any = null;
    if (r.incentive_plan_id) {
      const plan = await this.incentive.get(Number(r.incentive_plan_id)).catch(() => null);
      if (plan) {
        const metricPct: Record<string, number> = {
          admissions: decorated.pct.admissions, revenue: decorated.pct.revenue,
          collection: decorated.pct.collection, leads: decorated.pct.leads,
          walkin: decorated.pct.walkins, meeting: decorated.pct.meetings,
        };
        const achieved = metricPct[plan.metric] ?? decorated.pct.admissions;
        const res = resolveIncentive(plan.slabs, achieved);
        incentive = {
          plan_id: plan.id, plan_name: plan.name, metric: plan.metric,
          achievement_pct: achieved, amount_minor: res.amount_minor,
          slab: res.slab ? { label: res.slab.label, tier: res.slab.tier, emoji: res.slab.emoji } : null,
        };
      }
    }
    return { ...decorated, incentive };
  }

  /** Enforce the caller may target this entity (mirrors TargetService's rule). */
  private async assertInScope(
    targetFor: string, ids: { userId: number | null; branchId: number | null; verticalId: number | null },
    scope: ResolvedScope,
  ) {
    if (scope.all) return;
    // branch/vertical targets check their own column; user targets fall back to
    // the user's assignments; team/course are permitted for any in-scope manager
    // (they carry no branch column, and target.manage is already required).
    if (targetFor === 'branch' || targetFor === 'vertical' || targetFor === 'user') {
      const params: unknown[] = [ids.userId, ids.branchId, ids.verticalId];
      const wsql = this.resolver.buildScopeWhere(scope, TARGET_DEF_SCOPE_COLS, params);
      const ok = await this.db.one<{ ok: boolean }>(
        `SELECT ${wsql} AS ok FROM (SELECT $1::bigint AS user_id, $2::bigint AS branch_id, $3::bigint AS vertical_id) t`,
        params,
      );
      if (ok?.ok) return;
      if (targetFor === 'user' && ids.userId) {
        const p2: unknown[] = [ids.userId];
        const w2 = this.resolver.buildScopeWhere(scope, {
          owner: 'ua.user_id', team: 'ua.team_id', branch: 'ua.branch_id',
          vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
        }, p2);
        const hit = await this.db.one<{ n: string }>(
          `SELECT count(*) AS n FROM user_assignment ua WHERE ua.user_id = $1::bigint AND ua.is_active AND ${w2}`, p2,
        );
        if (Number(hit?.n ?? 0) > 0) return;
      }
      throw new BadRequestException('That target is outside the part of the organisation you manage.');
    }
    // team / course — allowed under an in-scope target.manage grant.
  }

  async save(dto: any, me: { id: number }, scope: ResolvedScope) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the target a name.');
    const targetFor = String(dto?.target_for ?? '');
    if (!TARGET_FOR.includes(targetFor)) throw new BadRequestException('Target For must be Individual, Team, Branch, Vertical or Course.');

    const userId = targetFor === 'user' ? Number(dto?.user_id) || null : null;
    const teamId = targetFor === 'team' ? Number(dto?.team_id) || null : null;
    const branchId = targetFor === 'branch' ? Number(dto?.branch_id) || null : null;
    const verticalId = targetFor === 'vertical' ? Number(dto?.vertical_id) || null : null;
    const courseId = targetFor === 'course' ? Number(dto?.course_id) || null : null;
    const needId: Record<string, number | null> = { user: userId, team: teamId, branch: branchId, vertical: verticalId, course: courseId };
    if (!needId[targetFor]) throw new BadRequestException(`Choose the ${targetFor}.`);

    const periodType = String(dto?.period_type ?? 'monthly') as PeriodType;
    if (!['monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'].includes(periodType)) throw new BadRequestException('Unknown period.');
    const { start, end } = resolvePeriod(periodType, {
      anchor: dto?.period_anchor ?? dto?.period_start, start: dto?.period_start, end: dto?.period_end,
    });

    const intMetric = (v: unknown, label: string): number => {
      const n = Number(v ?? 0);
      if (!Number.isInteger(n) || n < 0) throw new BadRequestException(`${label} must be a whole number.`);
      return n;
    };
    const moneyMetric = (minor: unknown, rupees: unknown, label: string): number => {
      try {
        const v = minor !== undefined && minor !== null && minor !== '' ? Math.trunc(Number(minor)) : rupeesToMinor(rupees ?? 0);
        if (!Number.isFinite(v) || v < 0) throw new Error('cannot be negative');
        return v;
      } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
    };

    const leads = intMetric(dto?.leads_target, 'Leads target');
    const walkins = intMetric(dto?.walkins_target, 'Walk-ins target');
    const admissions = intMetric(dto?.admissions_target, 'Admissions target');
    const revenue = moneyMetric(dto?.revenue_target_minor, dto?.revenue_target, 'Revenue target');
    const collection = moneyMetric(dto?.collection_target_minor, dto?.collection_target, 'Collection target');
    const meetings = intMetric(dto?.meetings_target, 'Meetings target');
    if (!leads && !walkins && !admissions && !revenue && !collection && !meetings) {
      throw new BadRequestException('Set at least one metric target.');
    }
    const planId = dto?.incentive_plan_id ? Number(dto.incentive_plan_id) || null : null;

    await this.assertInScope(targetFor, { userId, branchId, verticalId }, scope);
    const orgId = await this.orgId();
    const id = dto?.id ? Number(dto.id) : null;

    if (id) {
      const params: unknown[] = [id];
      const w = this.resolver.buildScopeWhere(scope, TARGET_DEF_SCOPE_COLS, params);
      const owns = await this.db.one<{ id: string }>(
        `SELECT id FROM target_definition t WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`, params,
      );
      if (!owns) throw new NotFoundException('Target not found');
      await this.db.query(
        `UPDATE target_definition SET name=$2, target_for=$3, user_id=$4, team_id=$5, branch_id=$6, vertical_id=$7,
                course_id=$8, period_type=$9, period_start=$10::date, period_end=$11::date,
                leads_target=$12, walkins_target=$13, admissions_target=$14,
                revenue_target_minor=$15, collection_target_minor=$16, meetings_target=$17,
                incentive_plan_id=$18, note=$19, updated_at=now()
          WHERE id=$1::bigint`,
        [id, name, targetFor, userId, teamId, branchId, verticalId, courseId, periodType, start, end,
          leads, walkins, admissions, revenue, collection, meetings, planId, dto?.note ?? null],
      );
      return { id, period_start: start, period_end: end };
    }
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO target_definition
         (org_id, name, target_for, user_id, team_id, branch_id, vertical_id, course_id,
          period_type, period_start, period_end,
          leads_target, walkins_target, admissions_target,
          revenue_target_minor, collection_target_minor, meetings_target,
          incentive_plan_id, note, created_by)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18,$19,$20::bigint)
       RETURNING id`,
      [orgId, name, targetFor, userId, teamId, branchId, verticalId, courseId, periodType, start, end,
        leads, walkins, admissions, revenue, collection, meetings, planId, dto?.note ?? null, me.id],
    );
    return { id: Number(rows[0].id), period_start: start, period_end: end };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, TARGET_DEF_SCOPE_COLS, params);
    const t = await this.db.one<{ id: string }>(
      `SELECT id FROM target_definition t WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`, params,
    );
    if (!t) throw new NotFoundException('Target not found');
    await this.db.query(`UPDATE target_definition SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }
}
