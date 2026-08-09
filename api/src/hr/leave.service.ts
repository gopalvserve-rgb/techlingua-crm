import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { requireDateString, toDateString } from '../common/date.util';
import { NotifierService } from '../notifications/notifier.service';

/**
 * LEAVES (Phase 2 ERP Batch 6, Basic HR).
 *
 *   - LEAVE TYPES     configurable org-wide master (Casual / Sick / Earned / Unpaid seeded).
 *   - LEAVE BALANCE   per employee, per type, per calendar year (allocated / used).
 *   - APPLICATION     an employee applies (type, from–to, days, reason) → PENDING → a manager
 *                     approves or rejects. On APPROVAL it deducts the balance AND marks those
 *                     days as 'leave' in hr_attendance, then notifies the employee. On APPLY the
 *                     reporting manager is notified. A manager approves their reports' leaves;
 *                     NOBODY can approve their own (enforced), which is the enrolment-approval rule.
 *
 * Branch-scoped (+ owner = applied_by), so a Counsellor granted leave.* at 'own' sees and applies
 * for their own leave, and a manager sees their unit's.
 */
export const LEAVE_SCOPE_COLS: ScopeColumnMap = { branch: 'la.branch_id', vertical: 'la.vertical_id', owner: 'la.applied_by' };
const EMP_SCOPE_COLS: ScopeColumnMap = { branch: 'e.branch_id', vertical: 'e.vertical_id' };

@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    @Optional() private readonly notifier?: NotifierService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private day(v: unknown, label: string): string {
    return requireDateString(v, () => { throw new BadRequestException(`${label} is not a valid date.`); }) as string;
  }

  /** Inclusive whole-day count between two ISO dates. */
  private inclusiveDays(from: string, to: string): number {
    const a = new Date(`${from}T00:00:00Z`).getTime();
    const b = new Date(`${to}T00:00:00Z`).getTime();
    return Math.floor((b - a) / 86400000) + 1;
  }

  // -------------------------------------------------------------- leave types

  async listTypes(includeInactive = false) {
    const where = includeInactive ? 'lt.deleted_at IS NULL' : 'lt.deleted_at IS NULL AND lt.is_active';
    return this.db.query<any>(
      `SELECT lt.id, lt.name, lt.code, lt.is_paid, lt.default_annual_quota, lt.is_active
         FROM leave_type lt WHERE ${where} ORDER BY lt.name`);
  }

  async saveType(dto: any) {
    const name = String(dto?.name ?? '').trim();
    const code = String(dto?.code ?? '').trim().toUpperCase();
    if (!name) throw new BadRequestException('Leave type name is required.');
    if (!code) throw new BadRequestException('A short code is required (e.g. CL).');
    const quota = Number(dto?.default_annual_quota ?? 0);
    if (!Number.isFinite(quota) || quota < 0) throw new BadRequestException('Default annual quota must be zero or more.');
    const orgId = await this.orgId();
    if (dto?.id) {
      await this.db.query(
        `UPDATE leave_type SET name = $2, code = $3, is_paid = $4, default_annual_quota = $5, is_active = $6, updated_at = now()
          WHERE id = $1::bigint AND deleted_at IS NULL`,
        [Number(dto.id), name, code.slice(0, 16), dto?.is_paid !== false, quota, dto?.is_active !== false]);
      return { id: Number(dto.id) };
    }
    const dup = await this.db.one<any>(`SELECT id FROM leave_type WHERE org_id = $1::bigint AND lower(code) = lower($2) AND deleted_at IS NULL`, [orgId, code]);
    if (dup) throw new BadRequestException(`A leave type with code "${code}" already exists.`);
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO leave_type (org_id, name, code, is_paid, default_annual_quota, is_active)
       VALUES ($1::bigint,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, name, code.slice(0, 16), dto?.is_paid !== false, quota, dto?.is_active !== false]);
    return { id: Number(ins[0].id) };
  }

  async removeType(id: number) {
    const t = await this.db.one<any>(`SELECT id FROM leave_type WHERE id = $1::bigint AND deleted_at IS NULL`, [id]);
    if (!t) throw new NotFoundException('Leave type not found');
    const used = await this.db.one<any>(`SELECT 1 FROM leave_application WHERE leave_type_id = $1::bigint AND deleted_at IS NULL LIMIT 1`, [id]);
    if (used) throw new BadRequestException('This leave type is in use by leave applications — deactivate it instead of deleting.');
    await this.db.query(`UPDATE leave_type SET deleted_at = now(), is_active = FALSE WHERE id = $1::bigint`, [id]);
    return { id, deleted: true };
  }

  // ------------------------------------------------------------- leave balances

  private async employeeInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, EMP_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.id, e.name, e.branch_id, e.vertical_id, e.user_id, e.reporting_manager_id
         FROM employee e WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`, params);
    if (!e) throw new NotFoundException('Employee not found (or outside your access).');
    return e;
  }

  /** Balances for an employee this year, seeding a row per active type from the default quota. */
  async balances(employeeId: number, scope: ResolvedScope, year?: number) {
    await this.employeeInScope(employeeId, scope);
    const yr = Number(year) || new Date().getFullYear();
    const orgId = await this.orgId();
    // seed any missing (employee, type, year) rows from the type default — idempotent.
    await this.db.query(
      `INSERT INTO leave_balance (org_id, employee_id, leave_type_id, year, allocated, used)
       SELECT $1::bigint, $2::bigint, lt.id, $3::int, lt.default_annual_quota, 0
         FROM leave_type lt
        WHERE lt.deleted_at IS NULL AND lt.is_active
       ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
      [orgId, employeeId, yr]);
    return this.db.query<any>(
      `SELECT lb.id, lb.leave_type_id, lt.name AS type_name, lt.code, lt.is_paid, lb.year,
              lb.allocated, lb.used, (lb.allocated - lb.used) AS available
         FROM leave_balance lb JOIN leave_type lt ON lt.id = lb.leave_type_id
        WHERE lb.employee_id = $1::bigint AND lb.year = $2::int AND lt.deleted_at IS NULL
        ORDER BY lt.name`, [employeeId, yr]);
  }

  /** Set the allocated days for an employee/type/year (leave.manage). */
  async setBalance(dto: any, scope: ResolvedScope) {
    const employeeId = Number(dto?.employee_id);
    const typeId = Number(dto?.leave_type_id);
    const yr = Number(dto?.year) || new Date().getFullYear();
    const allocated = Number(dto?.allocated);
    if (!employeeId || !typeId) throw new BadRequestException('Employee and leave type are required.');
    if (!Number.isFinite(allocated) || allocated < 0) throw new BadRequestException('Allocated days must be zero or more.');
    await this.employeeInScope(employeeId, scope);
    const orgId = await this.orgId();
    await this.db.query(
      `INSERT INTO leave_balance (org_id, employee_id, leave_type_id, year, allocated, used)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::int,$5,0)
       ON CONFLICT (employee_id, leave_type_id, year)
       DO UPDATE SET allocated = EXCLUDED.allocated, updated_at = now()`,
      [orgId, employeeId, typeId, yr, allocated]);
    return { ok: true };
  }

  // --------------------------------------------------------- leave applications

  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`la.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, LEAVE_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string, txt = false) => {
      const vals = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      if (txt) { params.push(vals); where.push(`${col} = ANY($${params.length}::text[])`); }
      else { const ids = vals.map(Number).filter((n) => Number.isFinite(n) && n > 0); if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`); }
    };
    multi('la.branch_id', f.branch_id);
    multi('la.vertical_id', f.vertical_id);
    multi('la.employee_id', f.employee_id);
    multi('la.leave_type_id', f.leave_type_id);
    multi('la.status', f.status, true);
    params.push(Math.min(Number(f.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT la.id, la.employee_id, la.leave_type_id, la.branch_id, la.vertical_id, la.from_date, la.to_date,
              la.days, la.reason, la.status, la.decided_at, la.decision_note, la.created_at,
              e.name AS employee_name, e.employee_code, lt.name AS type_name, lt.code AS type_code,
              b.name AS branch_name, v.name AS vertical_name, du.name AS decided_by_name, au.name AS applied_by_name
         FROM leave_application la
         JOIN employee e ON e.id = la.employee_id
         JOIN leave_type lt ON lt.id = la.leave_type_id
         LEFT JOIN branch b ON b.id = la.branch_id
         LEFT JOIN vertical v ON v.id = la.vertical_id
         LEFT JOIN "user" du ON du.id = la.decided_by
         LEFT JOIN "user" au ON au.id = la.applied_by
        WHERE ${where.join(' AND ')}
        ORDER BY la.created_at DESC, la.id DESC
        LIMIT $${params.length}`, params);
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, LEAVE_SCOPE_COLS, params);
    const kpi = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE la.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE la.status = 'approved')::int AS approved,
              count(*) FILTER (WHERE la.status = 'rejected')::int AS rejected,
              count(*)::int AS total
         FROM leave_application la WHERE la.deleted_at IS NULL AND ${w}`, params);
    return { pending: Number(kpi?.pending ?? 0), approved: Number(kpi?.approved ?? 0), rejected: Number(kpi?.rejected ?? 0), total: Number(kpi?.total ?? 0) };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, LEAVE_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT la.*, e.name AS employee_name, e.employee_code, e.user_id AS employee_user_id,
              lt.name AS type_name, lt.code AS type_code
         FROM leave_application la
         JOIN employee e ON e.id = la.employee_id
         JOIN leave_type lt ON lt.id = la.leave_type_id
        WHERE la.id = $1::bigint AND la.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Leave application not found (or outside your access).');
    return row;
  }

  /** Apply for leave → PENDING, then notify the reporting manager. */
  async apply(dto: any, me: { id: number }, scope: ResolvedScope) {
    const employeeId = Number(dto?.employee_id);
    const typeId = Number(dto?.leave_type_id);
    if (!employeeId) throw new BadRequestException('Choose the employee.');
    if (!typeId) throw new BadRequestException('Choose a leave type.');
    const emp = await this.employeeInScope(employeeId, scope);
    const type = await this.db.one<any>(`SELECT id FROM leave_type WHERE id = $1::bigint AND deleted_at IS NULL AND is_active`, [typeId]);
    if (!type) throw new BadRequestException('That leave type is not available.');
    const from = this.day(dto?.from_date, 'From date');
    const to = this.day(dto?.to_date, 'To date');
    if (to < from) throw new BadRequestException('The "to" date cannot be before the "from" date.');
    let days = Number(dto?.days);
    if (!Number.isFinite(days) || days <= 0) days = this.inclusiveDays(from, to);
    const reason = dto?.reason != null && String(dto.reason).trim() !== '' ? String(dto.reason).trim().slice(0, 2000) : null;
    const orgId = await this.orgId();

    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO leave_application (org_id, employee_id, leave_type_id, branch_id, vertical_id, from_date, to_date, days, reason, status, applied_by)
       VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::bigint,$6::date,$7::date,$8,$9,'pending',$10::bigint)
       RETURNING id`,
      [orgId, employeeId, typeId, emp.branch_id, emp.vertical_id, from, to, days, reason, me.id]);
    const id = Number(ins[0].id);

    // notify the reporting manager (their linked user), best-effort.
    try {
      const mgrUser = await this.managerUserId(emp);
      if (mgrUser && this.notifier) {
        await this.notifier.notify({
          userId: mgrUser, type: 'approval', title: 'Leave request awaiting your approval',
          body: `${emp.name} applied for leave (${from} to ${to}, ${days} day${days === 1 ? '' : 's'}).`,
        });
      }
    } catch { /* a notification never fails the apply */ }
    return { id, status: 'pending', days };
  }

  private async managerUserId(emp: any): Promise<number | null> {
    if (!emp?.reporting_manager_id) return null;
    const m = await this.db.one<any>(`SELECT user_id FROM employee WHERE id = $1::bigint AND deleted_at IS NULL`, [emp.reporting_manager_id]);
    return m?.user_id ? Number(m.user_id) : null;
  }

  /** Approve → deduct balance + mark days as leave in attendance + notify the employee. */
  async approve(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const app = await this.get(id, scope);
    if (app.status !== 'pending') throw new BadRequestException(`This leave is already ${app.status}.`);
    // NOBODY approves their own leave (the enrolment-approval rule).
    if (Number(app.applied_by) === Number(me.id) || (app.employee_user_id && Number(app.employee_user_id) === Number(me.id))) {
      throw new ForbiddenException('You cannot approve your own leave — a manager must approve it.');
    }
    const note = dto?.note != null && String(dto.note).trim() !== '' ? String(dto.note).trim().slice(0, 2000) : null;
    const orgId = await this.orgId();
    const fromIso = toDateString(app.from_date) as string;
    const toIso = toDateString(app.to_date) as string;
    const year = Number(fromIso.slice(0, 4));

    await this.db.tx(async (c) => {
      const upd = await c.query(
        `UPDATE leave_application SET status = 'approved', decided_by = $2::bigint, decided_at = now(), decision_note = $3, updated_at = now()
          WHERE id = $1::bigint AND status = 'pending' AND deleted_at IS NULL RETURNING id`,
        [id, me.id, note]);
      if (!upd.rows.length) throw new BadRequestException('This leave is no longer pending.');

      // deduct the balance (seed the row from the type default if absent).
      await c.query(
        `INSERT INTO leave_balance (org_id, employee_id, leave_type_id, year, allocated, used)
         VALUES ($1::bigint,$2::bigint,$3::bigint,$4::int,
                 COALESCE((SELECT default_annual_quota FROM leave_type WHERE id = $3::bigint), 0), 0)
         ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING`,
        [orgId, app.employee_id, app.leave_type_id, year]);
      await c.query(
        `UPDATE leave_balance SET used = used + $4, updated_at = now()
          WHERE employee_id = $1::bigint AND leave_type_id = $2::bigint AND year = $3::int`,
        [app.employee_id, app.leave_type_id, year, Number(app.days)]);

      // mark each date in the range as 'leave' in staff attendance (upsert).
      let d = new Date(`${fromIso}T00:00:00Z`);
      const end = new Date(`${toIso}T00:00:00Z`);
      let guard = 0;
      while (d.getTime() <= end.getTime() && guard < 400) {
        const iso = d.toISOString().slice(0, 10);
        await c.query(
          `INSERT INTO hr_attendance (org_id, employee_id, branch_id, vertical_id, att_date, status, mode, remarks, marked_by)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::date,'leave','system',$6,$7::bigint)
           ON CONFLICT (employee_id, att_date) WHERE deleted_at IS NULL
           DO UPDATE SET status = 'leave', mode = 'system', remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by, updated_at = now()`,
          [orgId, app.employee_id, app.branch_id, app.vertical_id, iso, `Approved leave (${app.type_code})`, me.id]);
        d = new Date(d.getTime() + 86400000);
        guard++;
      }
    });

    // notify the employee, best-effort.
    try {
      if (app.employee_user_id && this.notifier) {
        await this.notifier.notify({
          userId: Number(app.employee_user_id), type: 'approval', title: 'Your leave was approved',
          body: `Your ${app.type_name} (${fromIso} to ${toIso}) was approved.${note ? ' Note: ' + note : ''}`,
        });
      }
    } catch { /* never fail the approval on a notification */ }
    return { id, status: 'approved' };
  }

  /** Reject → notify the employee. No balance change. */
  async reject(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const app = await this.get(id, scope);
    if (app.status !== 'pending') throw new BadRequestException(`This leave is already ${app.status}.`);
    if (Number(app.applied_by) === Number(me.id) || (app.employee_user_id && Number(app.employee_user_id) === Number(me.id))) {
      throw new ForbiddenException('You cannot decide your own leave — a manager must.');
    }
    const note = dto?.note != null && String(dto.note).trim() !== '' ? String(dto.note).trim().slice(0, 2000) : null;
    await this.db.query(
      `UPDATE leave_application SET status = 'rejected', decided_by = $2::bigint, decided_at = now(), decision_note = $3, updated_at = now()
        WHERE id = $1::bigint AND status = 'pending' AND deleted_at IS NULL`,
      [id, me.id, note]);
    try {
      if (app.employee_user_id && this.notifier) {
        await this.notifier.notify({
          userId: Number(app.employee_user_id), type: 'approval', severity: 'warn', title: 'Your leave was rejected',
          body: `Your ${app.type_name} request was rejected.${note ? ' Reason: ' + note : ''}`,
        });
      }
    } catch { /* ignore */ }
    return { id, status: 'rejected' };
  }

  /** Cancel a pending application (the applicant withdraws it). */
  async cancel(id: number, me: { id: number }, scope: ResolvedScope) {
    const app = await this.get(id, scope);
    if (app.status !== 'pending') throw new BadRequestException(`Only a pending leave can be cancelled (this is ${app.status}).`);
    await this.db.query(
      `UPDATE leave_application SET status = 'cancelled', decided_by = $2::bigint, decided_at = now(), updated_at = now()
        WHERE id = $1::bigint AND status = 'pending' AND deleted_at IS NULL`, [id, me.id]);
    return { id, status: 'cancelled' };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE leave_application SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, LEAVE_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT la.id FROM leave_application la WHERE la.id = ANY($1::bigint[]) AND la.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'leave_application', label: 'Leave application', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
