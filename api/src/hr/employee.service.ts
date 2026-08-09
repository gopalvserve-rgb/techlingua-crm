import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { requireDateString } from '../common/date.util';

/**
 * EMPLOYEE DIRECTORY — the staff register (Phase 2 ERP Batch 6, Basic HR). Branch-scoped
 * (ScopeResolver). Employee code is auto-minted (EMP-) from the numbering series per branch/
 * vertical, or supplied manually. Optionally links to a "user" account (staff ARE users; an
 * employee record may or may not carry a login). India-first: Indian mobile/E.164 phone.
 */
export const EMPLOYEE_SCOPE_COLS: ScopeColumnMap = { branch: 'e.branch_id', vertical: 'e.vertical_id' };
const DEPARTMENTS = ['Sales', 'Academics', 'Finance', 'Admin', 'Marketing'];
const EMP_TYPES = ['full_time', 'part_time', 'contract'];
const GENDERS = ['male', 'female', 'other'];
const STATUSES = ['active', 'inactive'];

@Injectable()
export class EmployeeService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService, private readonly numbering: NumberingService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(scope: ResolvedScope, q: { branch_id?: string; vertical_id?: string; department?: string; designation?: string; status?: string; employment_type?: string; q?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`e.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, EMPLOYEE_SCOPE_COLS, params)];
    const multi = (col: string, raw?: string, txt = false) => {
      const vals = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) return;
      if (txt) { params.push(vals); where.push(`${col} = ANY($${params.length}::text[])`); }
      else { const ids = vals.map(Number).filter((n) => Number.isFinite(n) && n > 0); if (!ids.length) return; params.push(ids); where.push(`${col} = ANY($${params.length}::bigint[])`); }
    };
    multi('e.branch_id', q.branch_id);
    multi('e.vertical_id', q.vertical_id);
    multi('e.department', q.department, true);
    multi('e.designation', q.designation, true);
    multi('e.status', q.status, true);
    multi('e.employment_type', q.employment_type, true);
    if (q.q) { params.push(`%${q.q}%`); where.push(`(e.name ILIKE $${params.length} OR e.employee_code ILIKE $${params.length} OR e.email ILIKE $${params.length} OR e.phone ILIKE $${params.length})`); }
    params.push(Math.min(Number(q.limit ?? 500), 2000));
    return this.db.query<any>(
      `SELECT e.id, e.employee_code, e.name, e.designation, e.department, e.branch_id, e.vertical_id,
              e.date_of_joining, e.employment_type, e.phone, e.email, e.status, e.user_id,
              e.reporting_manager_id, e.created_at,
              b.name AS branch_name, v.name AS vertical_name, m.name AS manager_name, u.name AS user_name
         FROM employee e
         LEFT JOIN branch b ON b.id = e.branch_id
         LEFT JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN employee m ON m.id = e.reporting_manager_id
         LEFT JOIN "user" u ON u.id = e.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.name ASC
        LIMIT $${params.length}`, params);
  }

  async summary(scope: ResolvedScope, q: { branch_id?: string } = {}) {
    const params: unknown[] = [];
    const where = [`e.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, EMPLOYEE_SCOPE_COLS, params)];
    const ids = String(q.branch_id ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) { params.push(ids); where.push(`e.branch_id = ANY($${params.length}::bigint[])`); }
    const kpi = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE e.status = 'active') AS active,
              count(*) FILTER (WHERE e.status = 'inactive') AS inactive,
              count(*) FILTER (WHERE e.employment_type = 'full_time') AS full_time
         FROM employee e WHERE ${where.join(' AND ')}`, params);
    return {
      total: Number(kpi?.total ?? 0), active: Number(kpi?.active ?? 0),
      inactive: Number(kpi?.inactive ?? 0), full_time: Number(kpi?.full_time ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, EMPLOYEE_SCOPE_COLS, params);
    const row = await this.db.one<any>(
      `SELECT e.*, b.name AS branch_name, v.name AS vertical_name, m.name AS manager_name, u.name AS user_name
         FROM employee e
         LEFT JOIN branch b ON b.id = e.branch_id
         LEFT JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN employee m ON m.id = e.reporting_manager_id
         LEFT JOIN "user" u ON u.id = e.user_id
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`, params);
    if (!row) throw new NotFoundException('Employee not found (or outside your access).');
    return row;
  }

  private async assertHierarchy(branchId: number, verticalId: number | null) {
    if (!branchId) throw new BadRequestException('Choose a branch.');
    const b = await this.db.one<any>(`SELECT id FROM branch WHERE id = $1::bigint AND deleted_at IS NULL`, [branchId]);
    if (!b) throw new BadRequestException('That branch does not exist.');
    if (verticalId) {
      const v = await this.db.one<any>(`SELECT id FROM vertical WHERE id = $1::bigint AND branch_id = $2::bigint AND deleted_at IS NULL`, [verticalId, branchId]);
      if (!v) throw new BadRequestException('That vertical does not belong to the chosen branch.');
    }
  }

  private mapDate(dto: any, k: string, label: string): string | null | undefined {
    if (dto?.[k] === undefined) return undefined;
    if (dto[k] == null || String(dto[k]).trim() === '') return null;
    return requireDateString(dto[k], () => { throw new BadRequestException(`${label} is not a valid date.`); });
  }

  private str(dto: any, k: string, max: number): string | null {
    return dto?.[k] != null && String(dto[k]).trim() !== '' ? String(dto[k]).trim().slice(0, max) : null;
  }

  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const branchId = Number(dto?.branch_id);
    const verticalId = dto?.vertical_id ? Number(dto.vertical_id) : null;
    await this.assertHierarchy(branchId, verticalId);
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Employee name is required.');
    const empType = EMP_TYPES.includes(dto?.employment_type) ? dto.employment_type : 'full_time';
    const status = STATUSES.includes(dto?.status) ? dto.status : 'active';
    const department = dto?.department && DEPARTMENTS.includes(dto.department) ? dto.department : (this.str(dto, 'department', 40));
    const gender = dto?.gender && GENDERS.includes(dto.gender) ? dto.gender : null;
    const orgId = await this.orgId();
    const manual = dto?.employee_code != null && String(dto.employee_code).trim() !== '' ? String(dto.employee_code).trim().slice(0, 48) : null;
    const doj = this.mapDate(dto, 'date_of_joining', 'Date of Joining') ?? null;
    const dob = this.mapDate(dto, 'dob', 'Date of Birth') ?? null;

    return this.db.tx(async (c) => {
      const code = manual ?? await this.numbering.allocate('employee', { branch_id: branchId, vertical_id: verticalId }, c);
      const dup = await c.query(`SELECT 1 FROM employee WHERE org_id = $1::bigint AND lower(employee_code) = lower($2) AND deleted_at IS NULL`, [orgId, code]);
      if (dup.rows.length) throw new BadRequestException(`Employee code "${code}" already exists.`);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO employee (org_id, employee_code, name, user_id, designation, department, branch_id, vertical_id,
                               date_of_joining, employment_type, phone, email, dob, gender, status, reporting_manager_id, notes, created_by)
         VALUES ($1::bigint,$2,$3,$4::bigint,$5,$6,$7::bigint,$8::bigint,$9::date,$10,$11,$12,$13::date,$14,$15,$16::bigint,$17,$18::bigint)
         RETURNING id`,
        [orgId, code, name, dto?.user_id ? Number(dto.user_id) : null, this.str(dto, 'designation', 120), department,
          branchId, verticalId, doj, empType, this.str(dto, 'phone', 24), this.str(dto, 'email', 160), dob, gender, status,
          dto?.reporting_manager_id ? Number(dto.reporting_manager_id) : null, this.str(dto, 'notes', 4000), me.id]);
      return { id: Number(ins.rows[0].id), employee_code: code };
    });
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    const setStr = (col: string, k: string, max: number) => { if (dto?.[k] !== undefined) set(col, this.str(dto, k, max)); };

    if (dto?.name !== undefined) { const n = String(dto.name).trim(); if (!n) throw new BadRequestException('Employee name is required.'); set('name', n); }
    if (dto?.employee_code !== undefined && String(dto.employee_code).trim() !== '') set('employee_code', String(dto.employee_code).trim().slice(0, 48));
    setStr('designation', 'designation', 120);
    setStr('department', 'department', 40);
    setStr('phone', 'phone', 24);
    setStr('email', 'email', 160);
    setStr('notes', 'notes', 4000);
    if (dto?.user_id !== undefined) set('user_id', dto.user_id ? Number(dto.user_id) : null);
    if (dto?.reporting_manager_id !== undefined) {
      const mgr = dto.reporting_manager_id ? Number(dto.reporting_manager_id) : null;
      if (mgr && mgr === id) throw new BadRequestException('An employee cannot report to themselves.');
      set('reporting_manager_id', mgr);
    }
    if (dto?.employment_type !== undefined) { if (!EMP_TYPES.includes(dto.employment_type)) throw new BadRequestException('Employment type must be full_time, part_time or contract.'); set('employment_type', dto.employment_type); }
    if (dto?.status !== undefined) { if (!STATUSES.includes(dto.status)) throw new BadRequestException('Status must be active or inactive.'); set('status', dto.status); }
    if (dto?.gender !== undefined) set('gender', dto.gender && GENDERS.includes(dto.gender) ? dto.gender : null);
    const doj = this.mapDate(dto, 'date_of_joining', 'Date of Joining'); if (doj !== undefined) set('date_of_joining', doj);
    const dob = this.mapDate(dto, 'dob', 'Date of Birth'); if (dob !== undefined) set('dob', dob);
    if (dto?.branch_id !== undefined || dto?.vertical_id !== undefined) {
      const branchId = Number(dto.branch_id ?? cur.branch_id);
      const verticalId = dto?.vertical_id !== undefined ? (dto.vertical_id ? Number(dto.vertical_id) : null) : (cur.vertical_id ? Number(cur.vertical_id) : null);
      await this.assertHierarchy(branchId, verticalId);
      set('branch_id', branchId); set('vertical_id', verticalId);
    }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE employee SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.get(id, scope);
    await this.db.query(`UPDATE employee SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  private idList(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async inScopeIds(ids: number[], scope: ResolvedScope): Promise<number[]> {
    if (!ids.length) return [];
    const params: unknown[] = [ids];
    const w = this.resolver.buildScopeWhere(scope, EMPLOYEE_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(`SELECT e.id FROM employee e WHERE e.id = ANY($1::bigint[]) AND e.deleted_at IS NULL AND ${w}`, params);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown, scope: ResolvedScope) {
    const req = this.idList(raw); const ok = await this.inScopeIds(req, scope);
    return { entity: 'employee', label: 'Employee', requested: req.length, in_scope: ok.length, out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }, scope: ResolvedScope) {
    const ok = await this.inScopeIds(this.idList(raw), scope);
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me, scope); deleted++; }
    return { deleted, skipped: this.idList(raw).length - deleted };
  }
}
