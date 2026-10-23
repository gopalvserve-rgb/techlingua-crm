import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { PlanService } from '../paymentplans/plan.service';

const SCH_SCOPE: ScopeColumnMap = {
  owner: 'sc.counsellor_id', team: 'sc.team_id', branch: 'sc.branch_id',
  vertical: 'sc.vertical_id', pipeline: 'sc.pipeline_id', campaign: 'sc.campaign_id',
};
const ENR_SCOPE: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

/** The ₹ (paise) a scholarship takes off a net fee. Pure, unit-tested. */
export function scholarshipAmount(netMinor: number, type: string, value: number): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) throw new BadRequestException('Enter a scholarship value above zero.');
  if (type === 'percent') {
    if (v > 100) throw new BadRequestException('A percentage scholarship cannot exceed 100%.');
    return Math.round((Number(netMinor) * v) / 100);
  }
  return Math.round(v * 100);
}

/**
 * SCHOLARSHIPS (client, Oct 2026 — was a "Phase 2" placeholder). Percentage or fixed, reason
 * mandatory, on an enrolment. A counsellor REQUESTS (scholarship.request); a manager APPROVES
 * (scholarship.approve) — the enrolment's net fee drops by the amount and its payment plan
 * reconciles — or REJECTS with remarks. Nobody approves their own request. Scope-enforced
 * through the enrolment's own branch / vertical / counsellor columns.
 */
@Injectable()
export class ScholarshipService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly plans: PlanService,
  ) {}

  async list(scope: ResolvedScope, f: { status?: string; q?: string } = {}) {
    const params: unknown[] = [];
    const where = [`sc.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, SCH_SCOPE, params)];
    if (f.status) { params.push(String(f.status)); where.push(`sc.status = $${params.length}`); }
    if (f.q) { params.push(`%${String(f.q).trim()}%`); where.push(`(e.enrolment_no ILIKE $${params.length} OR COALESCE(l.full_name, sp.full_name) ILIKE $${params.length})`); }
    const rows = await this.db.query<any>(
      `SELECT sc.id, sc.enrolment_id, e.enrolment_no, COALESCE(l.full_name, sp.full_name) AS student_name,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              sc.scholarship_type, sc.value, sc.amount_minor, sc.reason, sc.status, sc.remarks,
              e.fee_minor, e.net_fee_minor, ru.name AS requested_by_name, du.name AS decided_by_name,
              sc.requested_by, sc.created_at, sc.decided_at
         FROM scholarship sc
         JOIN enrolment e ON e.id = sc.enrolment_id
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN student sp ON sp.id = e.student_profile_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN branch b ON b.id = sc.branch_id
         LEFT JOIN vertical v ON v.id = sc.vertical_id
         LEFT JOIN "user" ru ON ru.id = sc.requested_by
         LEFT JOIN "user" du ON du.id = sc.decided_by
        WHERE ${where.join(' AND ')}
        ORDER BY sc.created_at DESC LIMIT 500`, params);
    const sum = rows.reduce((a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      if (r.status === 'approved') a.approved_minor += Number(r.amount_minor);
      return a;
    }, { pending: 0, approved: 0, rejected: 0, approved_minor: 0 } as Record<string, number>);
    return { rows, summary: sum };
  }

  private async enrolmentInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ENR_SCOPE, params);
    const e = await this.db.one<any>(
      `SELECT e.* FROM enrolment e WHERE e.id = $1 AND e.deleted_at IS NULL AND ${w}`, params);
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');
    return e;
  }

  async request(dto: any, me: { id: number }, scope: ResolvedScope) {
    const e = await this.enrolmentInScope(Number(dto?.enrolment_id), scope);
    if (e.status !== 'active' && e.status !== 'pending_approval') throw new BadRequestException(`${e.enrolment_no} is ${e.status}.`);
    const reason = String(dto?.reason ?? '').trim();
    if (!reason) throw new BadRequestException('A reason is mandatory for a scholarship.');
    const type = dto?.scholarship_type === 'percent' ? 'percent' : 'amount';
    const amount = scholarshipAmount(Number(e.net_fee_minor), type, Number(dto?.value));
    if (amount > Number(e.net_fee_minor)) throw new BadRequestException('The scholarship cannot exceed the net fee.');
    const open = await this.db.one(`SELECT 1 FROM scholarship WHERE enrolment_id = $1 AND status = 'pending' AND deleted_at IS NULL`, [e.id]);
    if (open) throw new BadRequestException(`${e.enrolment_no} already has a scholarship waiting for approval.`);
    return this.db.one<any>(
      `INSERT INTO scholarship (org_id, enrolment_id, branch_id, vertical_id, pipeline_id, campaign_id, counsellor_id, team_id,
                                scholarship_type, value, amount_minor, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [e.org_id, e.id, e.branch_id, e.vertical_id, e.pipeline_id ?? null, e.campaign_id ?? null, e.counsellor_id ?? null, e.team_id ?? null,
        type, Number(dto.value), amount, reason.slice(0, 1000), me.id]);
  }

  private async getInScope(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, SCH_SCOPE, params);
    const r = await this.db.one<any>(`SELECT sc.* FROM scholarship sc WHERE sc.id = $1 AND sc.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Scholarship not found (or outside your access)');
    return r;
  }

  async approve(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const sc = await this.getInScope(id, scope);
    if (sc.status !== 'pending') throw new BadRequestException(`This scholarship is already ${sc.status}.`);
    if (Number(sc.requested_by) === Number(me.id)) throw new BadRequestException('You cannot approve your own scholarship request — ask another approver.');
    await this.db.tx(async (c) => {
      const e = (await c.query(
        `SELECT e.id, e.net_fee_minor, COALESCE(e.exam_fee_minor,0) AS exam_fee_minor,
                COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid
           FROM enrolment e WHERE e.id = $1 FOR UPDATE`, [sc.enrolment_id])).rows[0];
      const newNet = Number(e.net_fee_minor) - Number(sc.amount_minor);
      if (newNet < 0) throw new BadRequestException('The scholarship is larger than the current net fee.');
      if (newNet + Number(e.exam_fee_minor) < Number(e.paid)) {
        throw new BadRequestException('After this scholarship the fee would be below what is already paid — record a refund for the difference first.');
      }
      await c.query(
        `UPDATE enrolment SET net_fee_minor = $2, scholarship_minor = COALESCE(scholarship_minor,0) + $3, updated_at = now() WHERE id = $1`,
        [sc.enrolment_id, newNet, Number(sc.amount_minor)]);
      await c.query(
        `UPDATE scholarship SET status = 'approved', decided_by = $2, decided_at = now(), remarks = $3 WHERE id = $1`,
        [id, me.id, dto?.remarks ? String(dto.remarks).slice(0, 1000) : null]);
      try { await this.plans.reconcileToNet(c, Number(sc.enrolment_id)); } catch { /* a plan reconciles best-effort */ }
    });
    return { id, status: 'approved' };
  }

  async reject(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const sc = await this.getInScope(id, scope);
    if (sc.status !== 'pending') throw new BadRequestException(`This scholarship is already ${sc.status}.`);
    const remarks = String(dto?.remarks ?? '').trim();
    if (!remarks) throw new BadRequestException('Give a reason for rejecting.');
    await this.db.query(
      `UPDATE scholarship SET status = 'rejected', decided_by = $2, decided_at = now(), remarks = $3 WHERE id = $1`,
      [id, me.id, remarks.slice(0, 1000)]);
    return { id, status: 'rejected' };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const sc = await this.getInScope(id, scope);
    if (sc.status === 'approved') throw new BadRequestException('An approved scholarship is part of the fee — it cannot be deleted.');
    await this.db.query(`UPDATE scholarship SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }
}
