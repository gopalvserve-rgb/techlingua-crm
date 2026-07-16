import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { rupeesToMinor } from '../common/money.util';

/**
 * MONTHLY TARGETS — per counsellor / branch / vertical (§5).
 *
 * WHAT AN "ACTUAL" IS, EXACTLY (one definition, used everywhere — the dashboard bar,
 * this screen and the Sprint-6 reports all read THIS service, so they cannot disagree):
 *   · an ENROLMENT counts when it is `active` and was created in the period.
 *     `pending_approval` does NOT count — an unapproved sale is not a sale.
 *     `cancelled` / `rejected` do not count, and a sale cancelled later stops counting.
 *   · REVENUE for a target is `net_fee_minor` of those enrolments — i.e. BOOKED revenue,
 *     what was sold, not what has been banked. COLLECTED cash is a different number and
 *     it lives on the Fee Collection screen, labelled as such. Conflating the two is the
 *     single most common way a sales dashboard lies, so both are shown and neither is
 *     called "revenue" without a qualifier.
 *     >> CLIENT DECISION: if Gopal wants targets measured on CASH COLLECTED instead of
 *        BOOKED, it is one SQL fragment here. Flagged in PROJECT_STATUS §4.
 *
 * SCOPE: a `user` target is attributed by `enrolment.counsellor_id`; a `branch` /
 * `vertical` target by the enrolment's own denormalised path. `period` is always the
 * 1st of the month (a CHECK enforces it), so "this month" is an equality test.
 */

export const TARGET_SCOPE_COLS: ScopeColumnMap = {
  owner: 't.user_id', branch: 't.branch_id', vertical: 't.vertical_id',
};

/** PURE — the 1st of the month a date belongs to, as YYYY-MM-DD. */
export function periodOf(v?: unknown): string {
  const d = v ? new Date(`${String(v).slice(0, 7)}-01T00:00:00Z`) : new Date();
  if (Number.isNaN(d.getTime())) throw new BadRequestException('The period must be a month (YYYY-MM).');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export const pct = (actual: number, target: number): number =>
  (target > 0 ? Math.round((actual * 1000) / target) / 10 : 0);

@Injectable()
export class TargetService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /**
   * TARGETS + ACTUALS for a period, scoped.
   *
   * A `user` target's actuals are joined on `counsellor_id`; a `branch`/`vertical`
   * target's on the path. One query per scope type would be three round trips and three
   * chances to define "actual" differently, so it is one LATERAL per row — correct by
   * construction, and the row counts here are per-counsellor, not per-lead.
   */
  async list(scope: ResolvedScope, f: { period?: string; scope_type?: string } = {}) {
    const period = periodOf(f.period);
    const params: unknown[] = [period];
    const where = [`t.deleted_at IS NULL`, `t.period = $1::date`,
      this.resolver.buildScopeWhere(scope, TARGET_SCOPE_COLS, params)];
    if (f.scope_type) { params.push(f.scope_type); where.push(`t.scope_type = $${params.length}::varchar`); }

    const rows = await this.db.query<any>(
      `SELECT t.id, t.period, t.scope_type, t.user_id, t.branch_id, t.vertical_id,
              t.enrolment_target, t.revenue_target_minor, t.note,
              u.name AS user_name, b.name AS branch_name, v.name AS vertical_name,
              a.enrolments AS actual_enrolments, a.revenue_minor AS actual_revenue_minor
         FROM monthly_target t
         LEFT JOIN "user" u ON u.id = t.user_id
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS enrolments,
                  COALESCE(sum(e.net_fee_minor), 0) AS revenue_minor
             FROM enrolment e
            WHERE e.deleted_at IS NULL
              AND e.status = 'active'
              AND e.created_at >= t.period
              AND e.created_at < (t.period + INTERVAL '1 month')
              AND ((t.scope_type = 'user'     AND e.counsellor_id = t.user_id)
                OR (t.scope_type = 'branch'   AND e.branch_id     = t.branch_id)
                OR (t.scope_type = 'vertical' AND e.vertical_id   = t.vertical_id))
         ) a ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY t.scope_type, COALESCE(u.name, b.name, v.name)`,
      params,
    );
    return rows.map((r) => {
      const ae = Number(r.actual_enrolments ?? 0);
      const ar = Number(r.actual_revenue_minor ?? 0);
      return {
        ...r,
        enrolment_target: Number(r.enrolment_target),
        revenue_target_minor: Number(r.revenue_target_minor),
        actual_enrolments: ae,
        actual_revenue_minor: ar,
        enrolment_pct: pct(ae, Number(r.enrolment_target)),
        revenue_pct: pct(ar, Number(r.revenue_target_minor)),
        label: r.user_name ?? r.branch_name ?? r.vertical_name ?? '—',
      };
    });
  }

  /**
   * THE DASHBOARD'S "This month vs target" BAR — per role, and per role it means
   * something different, which is the point:
   *   a counsellor  -> HIS OWN target (a counsellor shown his branch's bar learns nothing);
   *   anyone else   -> every target inside his scope.
   * Derived from the ScopeResolver, never from a role name — custom roles are first-class
   * here exactly as they are on the Sprint-3 dashboard.
   */
  async dashboard(scope: ResolvedScope, userId: number) {
    const rows = await this.list(scope, {});
    const own = rows.filter((r) => r.scope_type === 'user' && Number(r.user_id) === Number(userId));
    const use = own.length ? own : rows;
    return use.map((r) => ({
      label: r.label,
      scope_type: r.scope_type,
      enrolments: { actual: r.actual_enrolments, target: r.enrolment_target, pct: r.enrolment_pct },
      revenue: { actual_minor: r.actual_revenue_minor, target_minor: r.revenue_target_minor, pct: r.revenue_pct },
    }));
  }

  async save(dto: any, me: { id: number }, scope: ResolvedScope) {
    const period = periodOf(dto?.period);
    const scopeType = String(dto?.scope_type ?? '');
    if (!['user', 'branch', 'vertical'].includes(scopeType)) throw new BadRequestException('A target is for a counsellor, a branch or a vertical.');

    const userId = scopeType === 'user' ? Number(dto?.user_id) || null : null;
    const branchId = scopeType === 'branch' ? Number(dto?.branch_id) || null : null;
    const verticalId = scopeType === 'vertical' ? Number(dto?.vertical_id) || null : null;
    if (scopeType === 'user' && !userId) throw new BadRequestException('Choose the counsellor.');
    if (scopeType === 'branch' && !branchId) throw new BadRequestException('Choose the branch.');
    if (scopeType === 'vertical' && !verticalId) throw new BadRequestException('Choose the vertical.');

    const enrolmentTarget = Number(dto?.enrolment_target ?? 0);
    if (!Number.isInteger(enrolmentTarget) || enrolmentTarget < 0) throw new BadRequestException('The admissions target must be a whole number.');
    let revenueTargetMinor: number;
    try {
      revenueTargetMinor = dto?.revenue_target_minor !== undefined && dto?.revenue_target_minor !== null
        ? Math.trunc(Number(dto.revenue_target_minor))
        : rupeesToMinor(dto?.revenue_target);
    } catch (e) { throw new BadRequestException(`Revenue target: ${(e as Error).message}`); }
    if (!Number.isFinite(revenueTargetMinor) || revenueTargetMinor < 0) throw new BadRequestException('The revenue target cannot be negative.');
    if (!enrolmentTarget && !revenueTargetMinor) throw new BadRequestException('Set an admissions target, a revenue target, or both.');

    // A MANAGER MUST NOT SET A TARGET OUTSIDE HIS OWN SCOPE. `target.manage` is granted
    // at 'branch' to a Branch Manager, so this is what stops him targeting another branch.
    await this.assertTargetInScope(scopeType, { userId, branchId, verticalId }, scope);
    const orgId = await this.orgId();

    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO monthly_target (org_id, period, scope_type, user_id, branch_id, vertical_id,
                                   enrolment_target, revenue_target_minor, note, created_by)
       VALUES ($1::bigint, $2::date, $3::varchar, $4::bigint, $5::bigint, $6::bigint,
               $7::int, $8::bigint, $9, $10::bigint)
       ON CONFLICT (org_id, period, scope_type, COALESCE(user_id, 0), COALESCE(branch_id, 0), COALESCE(vertical_id, 0))
         WHERE deleted_at IS NULL
       DO UPDATE SET enrolment_target = EXCLUDED.enrolment_target,
                     revenue_target_minor = EXCLUDED.revenue_target_minor,
                     note = EXCLUDED.note, updated_at = now()
       RETURNING id`,
      [orgId, period, scopeType, userId, branchId, verticalId, enrolmentTarget, revenueTargetMinor,
        dto?.note ?? null, me.id],
    );
    return { id: Number(rows[0].id), period };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, TARGET_SCOPE_COLS, params);
    const t = await this.db.one<any>(
      `SELECT t.id FROM monthly_target t WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`, params,
    );
    if (!t) throw new NotFoundException('Target not found');
    await this.db.query(`UPDATE monthly_target SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  /**
   * Is this target inside the caller's scope? Reuses `buildScopeWhere` against a
   * one-row VALUES list, so the rule is the SAME rule the lists use — not a second
   * hand-written interpretation of the scope that could drift from it.
   */
  private async assertTargetInScope(
    scopeType: string, ids: { userId: number | null; branchId: number | null; verticalId: number | null },
    scope: ResolvedScope,
  ) {
    if (scope.all) return;
    const params: unknown[] = [ids.userId, ids.branchId, ids.verticalId];
    const w = this.resolver.buildScopeWhere(scope, TARGET_SCOPE_COLS, params);
    const ok = await this.db.one<{ ok: boolean }>(
      `SELECT ${w} AS ok FROM (SELECT $1::bigint AS user_id, $2::bigint AS branch_id, $3::bigint AS vertical_id) t`,
      params,
    );
    if (ok?.ok) return;
    // A branch target set by a Branch Manager is `t.branch_id = his branch` and passes
    // above. A USER target does not carry a branch, so it is checked through the user's
    // own assignments instead — otherwise a Branch Manager could never target his team.
    if (scopeType === 'user' && ids.userId) {
      const params2: unknown[] = [ids.userId];
      const w2 = this.resolver.buildScopeWhere(scope, {
        owner: 'ua.user_id', team: 'ua.team_id', branch: 'ua.branch_id',
        vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
      }, params2);
      const hit = await this.db.one<{ n: string }>(
        `SELECT count(*) AS n FROM user_assignment ua
          WHERE ua.user_id = $1::bigint AND ua.is_active AND ${w2}`,
        params2,
      );
      if (Number(hit?.n ?? 0) > 0) return;
    }
    throw new BadRequestException('That target is outside the part of the organisation you manage.');
  }
}
