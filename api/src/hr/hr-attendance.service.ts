import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange, requireDateString, toDateString } from '../common/date.util';

/**
 * STAFF ATTENDANCE — daily attendance per EMPLOYEE (not students). Mirrors the academics
 * attendance pattern. Branch-scoped (ScopeResolver). A (employee, date) is unique; marking is an
 * upsert. Statuses: present / absent / half_day / leave / holiday. Modes: staff / self / system
 * ('system' is used when a leave approval stamps a day as leave). A monthly sheet per branch and
 * a per-employee summary (present days / absent / leaves) over a date range.
 */
export const HRATT_SCOPE_COLS: ScopeColumnMap = { branch: 'a.branch_id', vertical: 'a.vertical_id' };
const EMP_SCOPE_COLS: ScopeColumnMap = { branch: 'e.branch_id', vertical: 'e.vertical_id' };
const VALID = ['present', 'absent', 'half_day', 'leave', 'holiday'];
const MODES = ['staff', 'self', 'system'];

@Injectable()
export class HrAttendanceService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private day(v: unknown): string {
    return requireDateString(v, () => { throw new BadRequestException('That date is not a valid date.'); }) as string;
  }

  private async employeeInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, EMP_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.id, e.name, e.branch_id, e.vertical_id FROM employee e
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`, params);
    if (!e) throw new NotFoundException('Employee not found (or outside your access).');
    return e;
  }

  /** The marking roster: a branch's active employees, each with their mark for the date. */
  async roster(date: string, scope: ResolvedScope, q: { branch_id?: string; vertical_id?: string } = {}) {
    const d = this.day(date);
    const params: unknown[] = [d];
    const where = [`e.deleted_at IS NULL`, `e.status = 'active'`, this.resolver.buildScopeWhere(scope, EMP_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('e.branch_id', q.branch_id);
    multi('e.vertical_id', q.vertical_id);
    const rows = await this.db.query<any>(
      `SELECT e.id AS employee_id, e.name, e.employee_code, e.department, e.designation,
              a.id AS attendance_id, a.status, a.mode, a.remarks
         FROM employee e
         LEFT JOIN hr_attendance a ON a.employee_id = e.id AND a.att_date = $1::date AND a.deleted_at IS NULL
        WHERE ${where.join(' AND ')}
        ORDER BY e.name`, params);
    return { date: d, roster: rows };
  }

  /** Upsert a day's marks for a set of employees. */
  async mark(dto: any, me: { id: number }, scope: ResolvedScope) {
    const date = this.day(dto?.date);
    const mode = MODES.includes(String(dto?.mode)) ? String(dto.mode) : 'staff';
    const entries: any[] = Array.isArray(dto?.entries) ? dto.entries : [];
    if (!entries.length) throw new BadRequestException('No attendance entries to mark.');
    const orgId = await this.orgId();
    let marked = 0;
    await this.db.tx(async (c) => {
      for (const e of entries) {
        const eid = Number(e?.employee_id);
        const status = String(e?.status);
        if (!eid || !VALID.includes(status)) continue;
        // employee must be in scope (guards a tampered payload)
        const emp = await this.employeeInScope(eid, scope);
        await c.query(
          `INSERT INTO hr_attendance (org_id, employee_id, branch_id, vertical_id, att_date, status, mode, remarks, marked_by)
           VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,$5::date,$6,$7,$8,$9::bigint)
           ON CONFLICT (employee_id, att_date) WHERE deleted_at IS NULL
           DO UPDATE SET status = EXCLUDED.status, mode = EXCLUDED.mode, remarks = EXCLUDED.remarks,
                         branch_id = EXCLUDED.branch_id, vertical_id = EXCLUDED.vertical_id,
                         marked_by = EXCLUDED.marked_by, updated_at = now()`,
          [orgId, eid, emp.branch_id, emp.vertical_id, date, status, mode, e?.remarks ?? null, me.id]);
        marked++;
      }
    });
    return { marked };
  }

  /** Monthly sheet per branch: each employee's per-day status for the month. */
  async sheet(scope: ResolvedScope, q: { month?: string; branch_id?: string; vertical_id?: string } = {}) {
    const month = /^\d{4}-\d{2}$/.test(String(q.month ?? '')) ? String(q.month) : new Date().toISOString().slice(0, 7);
    const from = `${month}-01`;
    const [yy, mm] = month.split('-').map(Number);
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;

    const params: unknown[] = [];
    const where = [`e.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, EMP_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('e.branch_id', q.branch_id);
    multi('e.vertical_id', q.vertical_id);
    const emps = await this.db.query<any>(
      `SELECT e.id, e.name, e.employee_code, e.department FROM employee e
        WHERE ${where.join(' AND ')} ORDER BY e.name LIMIT 500`, params);
    if (!emps.length) return { month, days_in_month: daysInMonth, employees: [] };

    const empIds = emps.map((e) => Number(e.id));
    const recs = await this.db.query<any>(
      `SELECT a.employee_id, a.att_date, a.status
         FROM hr_attendance a
        WHERE a.deleted_at IS NULL AND a.employee_id = ANY($1::bigint[])
          AND a.att_date >= $2::date AND a.att_date <= $3::date`, [empIds, from, to]);
    const byEmp = new Map<number, Record<number, string>>();
    const tally = new Map<number, Record<string, number>>();
    for (const e of empIds) { byEmp.set(e, {}); tally.set(e, { present: 0, absent: 0, half_day: 0, leave: 0, holiday: 0 }); }
    for (const r of recs) {
      const eid = Number(r.employee_id);
      const iso = toDateString(r.att_date) as string;
      const dnum = Number(iso.slice(8, 10));
      byEmp.get(eid)![dnum] = r.status;
      tally.get(eid)![r.status] = (tally.get(eid)![r.status] ?? 0) + 1;
    }
    return {
      month, days_in_month: daysInMonth,
      employees: emps.map((e) => ({
        id: Number(e.id), name: e.name, employee_code: e.employee_code, department: e.department,
        marks: byEmp.get(Number(e.id)) ?? {}, ...tally.get(Number(e.id))!,
      })),
    };
  }

  /** Attendance records list — the records table + export. */
  async list(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, HRATT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string, txt = false) => {
      const vals = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      if (txt) { params.push(vals); where.push(`${col} = ANY($${params.length}::text[])`); }
      else { const ids = vals.map(Number).filter((n) => Number.isFinite(n) && n > 0); if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`); }
    };
    multi('a.employee_id', f.employee_id);
    multi('a.branch_id', f.branch_id);
    multi('a.vertical_id', f.vertical_id);
    multi('a.status', f.status, true);
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.att_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.att_date <= $${params.length}::date`); }
    params.push(Math.min(Number(f.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT a.id, a.att_date, a.status, a.mode, a.remarks,
              e.name AS employee_name, e.employee_code, b.name AS branch_name, v.name AS vertical_name, u.name AS marked_by_name
         FROM hr_attendance a
         JOIN employee e ON e.id = a.employee_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN "user" u ON u.id = a.marked_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.att_date DESC, e.name
        LIMIT $${params.length}`, params);
  }

  /** Per-employee summary over a date range (present days / absent / leaves). */
  async summary(scope: ResolvedScope, f: any = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, HRATT_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string) => {
      const ids = String(raw ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`);
    };
    multi('a.branch_id', f.branch_id);
    multi('a.employee_id', f.employee_id);
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`a.att_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`a.att_date <= $${params.length}::date`); }
    const w = where.join(' AND ');
    const kpi = await this.db.one<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.status = 'present')::int  AS present,
              count(*) FILTER (WHERE a.status = 'absent')::int   AS absent,
              count(*) FILTER (WHERE a.status = 'half_day')::int AS half_day,
              count(*) FILTER (WHERE a.status = 'leave')::int    AS leave,
              count(*) FILTER (WHERE a.status = 'holiday')::int  AS holiday
         FROM hr_attendance a WHERE ${w}`, params);
    const byEmp = await this.db.query<any>(
      `SELECT e.id AS employee_id, e.name, e.employee_code,
              count(*)::int AS marked,
              count(*) FILTER (WHERE a.status = 'present')::int  AS present,
              count(*) FILTER (WHERE a.status = 'absent')::int   AS absent,
              count(*) FILTER (WHERE a.status = 'half_day')::int AS half_day,
              count(*) FILTER (WHERE a.status = 'leave')::int    AS leave
         FROM hr_attendance a JOIN employee e ON e.id = a.employee_id
        WHERE ${w} GROUP BY e.id, e.name, e.employee_code ORDER BY e.name LIMIT 300`, params);
    return {
      kpis: {
        total: Number(kpi?.total ?? 0), present: Number(kpi?.present ?? 0), absent: Number(kpi?.absent ?? 0),
        half_day: Number(kpi?.half_day ?? 0), leave: Number(kpi?.leave ?? 0), holiday: Number(kpi?.holiday ?? 0),
      },
      by_employee: byEmp,
    };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, HRATT_SCOPE_COLS, params);
    const row = await this.db.one<any>(`SELECT a.id FROM hr_attendance a WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Attendance record not found (or outside your access).');
    await this.db.query(`UPDATE hr_attendance SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, HRATT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT a.id FROM hr_attendance a WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'hr_attendance', label: 'Attendance record', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
