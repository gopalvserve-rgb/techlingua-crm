import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** One payslip's arithmetic. Pure, unit-tested. All money in paise. */
export function computePayslip(
  s: { basic_minor: number; hra_minor: number; allowance_minor: number; pf_pct: number; esi_pct: number; pt_minor: number; tds_minor: number },
  daysInMonth: number, paidDays: number,
) {
  const ratio = daysInMonth > 0 ? Math.max(0, Math.min(1, paidDays / daysInMonth)) : 0;
  const basic = Math.round(Number(s.basic_minor) * ratio);
  const hra = Math.round(Number(s.hra_minor) * ratio);
  const allowance = Math.round(Number(s.allowance_minor) * ratio);
  const gross = basic + hra + allowance;
  const pf = Math.round((basic * Number(s.pf_pct)) / 100);
  const esi = Math.round((gross * Number(s.esi_pct)) / 100);
  const pt = gross > 0 ? Number(s.pt_minor) : 0;
  const tds = gross > 0 ? Number(s.tds_minor) : 0;
  const deductions = pf + esi + pt + tds;
  return {
    earnings: { basic, hra, allowance },
    deductions: { pf, esi, professional_tax: pt, tds },
    gross_minor: gross, deduction_minor: deductions, net_minor: gross - deductions,
  };
}

/**
 * SALARY (client, Oct 2026 — HR › Salary was a "Phase 2" placeholder). A salary structure per
 * employee (basic, HRA, allowances; PF % of basic, ESI % of gross, professional tax, TDS), and a
 * monthly PAYROLL RUN that pro-rates by the HR attendance sheet: absent days and unpaid-leave
 * days are not paid, a half day counts 0.5; a day with no attendance mark counts as paid.
 * A run stays a DRAFT (re-runnable) until it is FINALISED.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  async structures(f: { branch_id?: string } = {}) {
    const params: unknown[] = [];
    let w = `e.deleted_at IS NULL AND e.status = 'active'`;
    if (f.branch_id) { params.push(Number(f.branch_id)); w += ` AND e.branch_id = $${params.length}`; }
    return this.db.query<any>(
      `SELECT e.id AS employee_id, e.employee_code, e.name, e.designation, e.department, b.name AS branch_name,
              s.basic_minor, s.hra_minor, s.allowance_minor, s.pf_pct, s.esi_pct, s.pt_minor, s.tds_minor, s.effective_from,
              (COALESCE(s.basic_minor,0) + COALESCE(s.hra_minor,0) + COALESCE(s.allowance_minor,0)) AS monthly_gross_minor
         FROM employee e
         LEFT JOIN branch b ON b.id = e.branch_id
         LEFT JOIN salary_structure s ON s.employee_id = e.id
        WHERE ${w}
        ORDER BY lower(e.name)`, params);
  }

  async saveStructure(employeeId: number, dto: any, actorId: number) {
    const emp = await this.db.one(`SELECT id FROM employee WHERE id = $1 AND deleted_at IS NULL`, [employeeId]);
    if (!emp) throw new NotFoundException('Employee not found');
    const rupees = (v: unknown) => { const n = Number(v ?? 0); if (!Number.isFinite(n) || n < 0) throw new BadRequestException('Amounts must be zero or more.'); return Math.round(n * 100); };
    const pct = (v: unknown) => { const n = Number(v ?? 0); if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException('Percentages must be between 0 and 100.'); return n; };
    await this.db.query(
      `INSERT INTO salary_structure (org_id, employee_id, basic_minor, hra_minor, allowance_minor, pf_pct, esi_pct, pt_minor, tds_minor, effective_from, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (employee_id) DO UPDATE SET basic_minor = EXCLUDED.basic_minor, hra_minor = EXCLUDED.hra_minor,
         allowance_minor = EXCLUDED.allowance_minor, pf_pct = EXCLUDED.pf_pct, esi_pct = EXCLUDED.esi_pct,
         pt_minor = EXCLUDED.pt_minor, tds_minor = EXCLUDED.tds_minor, effective_from = EXCLUDED.effective_from,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [await this.orgId(), employeeId, rupees(dto?.basic), rupees(dto?.hra), rupees(dto?.allowance),
        pct(dto?.pf_pct), pct(dto?.esi_pct), rupees(dto?.pt), rupees(dto?.tds),
        /^\d{4}-\d{2}-\d{2}$/.test(String(dto?.effective_from ?? '')) ? dto.effective_from : null, actorId]);
    return { employee_id: employeeId, ok: true };
  }

  async runs() {
    return this.db.query<any>(
      `SELECT r.id, r.period, r.branch_id, b.name AS branch_name, r.status, r.gross_minor, r.net_minor,
              (SELECT count(*) FROM payslip p WHERE p.run_id = r.id) AS payslips, r.created_at, r.finalised_at
         FROM payroll_run r LEFT JOIN branch b ON b.id = r.branch_id
        WHERE r.deleted_at IS NULL ORDER BY r.period DESC, r.id DESC`);
  }

  /** Create (or recompute, while draft) the run for a YYYY-MM period, optionally one branch. */
  async run(dto: any, actorId: number) {
    const period = String(dto?.period ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('Pick the month (YYYY-MM).');
    const branchId = Number(dto?.branch_id) || null;
    const [y, mo] = period.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const from = `${period}-01`; const to = `${period}-${String(daysInMonth).padStart(2, '0')}`;
    const orgId = await this.orgId();
    return this.db.tx(async (c) => {
      let run = (await c.query(
        `SELECT * FROM payroll_run WHERE period = $1 AND COALESCE(branch_id, 0) = COALESCE($2::bigint, 0) AND deleted_at IS NULL`,
        [period, branchId])).rows[0];
      if (run && run.status === 'finalised') throw new BadRequestException(`The ${period} payroll is already finalised.`);
      if (!run) {
        run = (await c.query(
          `INSERT INTO payroll_run (org_id, period, branch_id, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
          [orgId, period, branchId, actorId])).rows[0];
      }
      await c.query(`DELETE FROM payslip WHERE run_id = $1`, [run.id]);
      const emps = (await c.query(
        `SELECT e.id, s.basic_minor, s.hra_minor, s.allowance_minor, s.pf_pct, s.esi_pct, s.pt_minor, s.tds_minor
           FROM employee e JOIN salary_structure s ON s.employee_id = e.id
          WHERE e.deleted_at IS NULL AND e.status = 'active' ${branchId ? 'AND e.branch_id = $1' : ''}`,
        branchId ? [branchId] : [])).rows;
      let gross = 0; let net = 0;
      for (const e of emps) {
        const att = (await c.query(
          `SELECT count(*) FILTER (WHERE a.status = 'absent') AS absent,
                  count(*) FILTER (WHERE a.status = 'half_day') AS half,
                  count(*) FILTER (WHERE a.status = 'leave' AND EXISTS (
                    SELECT 1 FROM leave_application la JOIN leave_type lt ON lt.id = la.leave_type_id
                     WHERE la.employee_id = a.employee_id AND la.status = 'approved' AND NOT lt.is_paid
                       AND a.att_date BETWEEN la.from_date AND la.to_date)) AS unpaid_leave
             FROM hr_attendance a
            WHERE a.employee_id = $1 AND a.deleted_at IS NULL AND a.att_date BETWEEN $2::date AND $3::date`,
          [e.id, from, to])).rows[0];
        const paidDays = Math.max(0, daysInMonth - Number(att.absent) - Number(att.unpaid_leave) - 0.5 * Number(att.half));
        const p = computePayslip(e, daysInMonth, paidDays);
        await c.query(
          `INSERT INTO payslip (run_id, employee_id, days_in_month, paid_days, earnings, deductions, gross_minor, deduction_minor, net_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [run.id, e.id, daysInMonth, paidDays, JSON.stringify(p.earnings), JSON.stringify(p.deductions), p.gross_minor, p.deduction_minor, p.net_minor]);
        gross += p.gross_minor; net += p.net_minor;
      }
      await c.query(`UPDATE payroll_run SET gross_minor = $2, net_minor = $3 WHERE id = $1`, [run.id, gross, net]);
      return { id: Number(run.id), period, payslips: emps.length, gross_minor: gross, net_minor: net,
        note: emps.length ? null : 'No active employee has a salary structure yet — set salaries first.' };
    });
  }

  async payslips(runId: number) {
    const run = await this.db.one<any>(`SELECT * FROM payroll_run WHERE id = $1 AND deleted_at IS NULL`, [runId]);
    if (!run) throw new NotFoundException('Payroll run not found');
    const rows = await this.db.query<any>(
      `SELECT p.*, e.employee_code, e.name, e.designation, e.department, b.name AS branch_name
         FROM payslip p JOIN employee e ON e.id = p.employee_id LEFT JOIN branch b ON b.id = e.branch_id
        WHERE p.run_id = $1 ORDER BY lower(e.name)`, [runId]);
    return { run, rows };
  }

  async finalise(runId: number) {
    const run = await this.db.one<any>(`SELECT * FROM payroll_run WHERE id = $1 AND deleted_at IS NULL`, [runId]);
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === 'finalised') return { id: runId, status: 'finalised' };
    await this.db.query(`UPDATE payroll_run SET status = 'finalised', finalised_at = now() WHERE id = $1`, [runId]);
    return { id: runId, status: 'finalised' };
  }

  async removeRun(runId: number) {
    const run = await this.db.one<any>(`SELECT status FROM payroll_run WHERE id = $1 AND deleted_at IS NULL`, [runId]);
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status === 'finalised') throw new BadRequestException('A finalised payroll cannot be deleted.');
    await this.db.query(`UPDATE payroll_run SET deleted_at = now() WHERE id = $1`, [runId]);
    return { id: runId, deleted: true };
  }
}
