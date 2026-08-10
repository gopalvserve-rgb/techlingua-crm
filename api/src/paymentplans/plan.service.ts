import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { rupeesToMinor } from '../common/money.util';
import { toDateString } from '../common/date.util';
import { Frequency, PlanType, generateSchedule } from './schedule.util';

/**
 * PAYMENT PLANS (Phase 3 Batch 2). A plan turns an enrolment's payment INTENT
 * (`enrolment.payment_plan` + `first_payment_minor`, agreed at the desk in Sprint 5) into
 * a real installment SCHEDULE with due dates and amounts, against which collections are
 * applied oldest-due first.
 *
 * MONEY IS EXACT: `total_minor` is the enrolment's NET fee; the schedule sums to it to the
 * paisa (generateSchedule asserts it). Collections flow in through fee_receipt → applied
 * to installments here, so `installment.paid_minor` is always the sum of its allocations
 * and the plan can never drift from the receipts that back it.
 */

// Plans scope on the enrolment they belong to — same columns the enrolment list uses.
export const PLAN_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const PLAN_TYPES: PlanType[] = ['full', 'installment', 'emi', 'custom'];
export const FREQUENCIES: Frequency[] = ['once', 'weekly', 'monthly', 'custom'];

/** Base status from paid vs amount. 'waived' is preserved by the caller, never set here. */
const STATUS_SQL = `CASE WHEN paid_minor >= amount_minor THEN 'paid'
                         WHEN paid_minor > 0 THEN 'partial' ELSE 'pending' END`;

@Injectable()
export class PlanService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string[]; plan_type?: string[]; enrolment_id?: number; q?: string; branch_ids?: number[]; vertical_ids?: number[]; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`pp.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params)];
    if (f.status?.length) { params.push(f.status); where.push(`pp.status = ANY($${params.length}::varchar[])`); }
    if (f.plan_type?.length) { params.push(f.plan_type); where.push(`pp.plan_type = ANY($${params.length}::varchar[])`); }
    if (f.enrolment_id) { params.push(Number(f.enrolment_id)); where.push(`pp.enrolment_id = $${params.length}::bigint`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`e.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`e.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(e.enrolment_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));
    return this.db.query<any>(
      `SELECT pp.id, pp.plan_type, pp.frequency, pp.total_minor, pp.down_payment_minor,
              pp.num_installments, pp.start_date, pp.status, pp.created_at,
              pp.enrolment_id, e.enrolment_no, e.net_fee_minor,
              l.full_name AS student_name, l.phone AS student_phone,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS counsellor_name,
              (SELECT count(*) FROM installment i WHERE i.plan_id = pp.id) AS installment_count,
              (SELECT COALESCE(sum(i.amount_minor),0) FROM installment i WHERE i.plan_id = pp.id) AS scheduled_minor,
              (SELECT COALESCE(sum(i.paid_minor),0) FROM installment i WHERE i.plan_id = pp.id) AS paid_minor,
              (SELECT count(*) FROM installment i WHERE i.plan_id = pp.id
                 AND i.status <> 'paid' AND i.status <> 'waived'
                 AND i.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue_count
         FROM payment_plan pp
         JOIN enrolment e ON e.id = pp.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
        WHERE ${where.join(' AND ')}
        ORDER BY pp.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE pp.status = 'active') AS active_plans,
              count(*) FILTER (WHERE pp.status = 'completed') AS completed_plans,
              COALESCE(sum(i.amount_minor),0) AS scheduled_minor,
              COALESCE(sum(i.paid_minor),0) AS collected_minor
         FROM payment_plan pp
         JOIN enrolment e ON e.id = pp.enrolment_id
         LEFT JOIN installment i ON i.plan_id = pp.id
        WHERE pp.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      active_plans: Number(r?.active_plans ?? 0),
      completed_plans: Number(r?.completed_plans ?? 0),
      scheduled_minor: Number(r?.scheduled_minor ?? 0),
      collected_minor: Number(r?.collected_minor ?? 0),
      outstanding_minor: Number(r?.scheduled_minor ?? 0) - Number(r?.collected_minor ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const pp = await this.db.one<any>(
      `SELECT pp.*, e.enrolment_no, e.net_fee_minor, e.lead_id,
              l.full_name AS student_name, l.phone AS student_phone, l.email AS student_email,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS counsellor_name
         FROM payment_plan pp
         JOIN enrolment e ON e.id = pp.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
        WHERE pp.id = $1::bigint AND pp.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!pp) throw new NotFoundException('Payment plan not found');
    const installments = await this.db.query<any>(
      `SELECT i.id, i.seq_no, i.due_date, i.amount_minor, i.paid_minor, i.label,
              (i.amount_minor - i.paid_minor) AS outstanding_minor,
              CASE WHEN i.status = 'waived' THEN 'waived'
                   WHEN i.paid_minor >= i.amount_minor THEN 'paid'
                   WHEN i.due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'overdue'
                   WHEN i.paid_minor > 0 THEN 'partial' ELSE 'pending' END AS effective_status
         FROM installment i WHERE i.plan_id = $1::bigint ORDER BY i.seq_no`,
      [id],
    );
    return { ...pp, installments };
  }

  /* ----------------------------------------------------------------- writes */

  /** Normalise a rupees-or-minor money field to integer paise. */
  private minor(rup: unknown, minor: unknown, label: string): number {
    try {
      const v = minor !== undefined && minor !== null ? Math.trunc(Number(minor)) : rupeesToMinor(rup);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${label} cannot be negative`);
      return v;
    } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
  }

  /**
   * CREATE a plan on an enrolment and generate its schedule. Total = enrolment NET fee
   * (recomputed server-side; the client never posts a total). If money has already been
   * collected against the enrolment, it is applied to the fresh schedule oldest-first, so
   * a plan created AFTER a first payment reflects reality.
   */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const enrolmentId = Number(dto?.enrolment_id);
    if (!enrolmentId) throw new BadRequestException('Choose the enrolment this plan is for.');

    const params: unknown[] = [enrolmentId];
    const ew = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.id, e.org_id, e.net_fee_minor, e.status, e.enrolment_no, e.start_date,
              COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                          WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor
         FROM enrolment e
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${ew}`,
      params,
    );
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');
    if (e.status !== 'active') throw new BadRequestException(`${e.enrolment_no} is ${e.status}; a payment plan can only be built on an active enrolment.`);

    const planType = String(dto?.plan_type ?? 'installment') as PlanType;
    if (!PLAN_TYPES.includes(planType)) throw new BadRequestException('Choose a valid plan type: Full, Installment, EMI or Custom.');
    let frequency = String(dto?.frequency ?? (planType === 'full' ? 'once' : 'monthly')) as Frequency;
    if (!FREQUENCIES.includes(frequency)) throw new BadRequestException('Choose a valid frequency.');
    if (planType === 'full') frequency = 'once';

    const total = Number(e.net_fee_minor);
    const downPayment = this.minor(dto?.down_payment, dto?.down_payment_minor, 'Down payment');
    if (downPayment > total) throw new BadRequestException('The down payment cannot exceed the net fee.');
    const numInstallments = planType === 'full' ? 1 : Math.max(1, Math.trunc(Number(dto?.num_installments ?? 3)));
    if (numInstallments > 240) throw new BadRequestException('That is an unreasonable number of installments.');
    const startDate = toDateString(dto?.start_date) || toDateString(e.start_date) || new Date().toISOString().slice(0, 10);
    const customDates = Array.isArray(dto?.custom_dates)
      ? dto.custom_dates.map((d: unknown) => toDateString(d)).filter(Boolean) as string[] : undefined;

    // Build (and self-validate) the schedule BEFORE we write anything.
    const schedule = generateSchedule({
      plan_type: planType, total_minor: total, down_payment_minor: downPayment,
      num_installments: numInstallments, frequency, start_date: startDate as string, custom_dates: customDates,
    });

    const orgId = await this.orgId();
    return this.db.tx(async (c) => {
      let planId: number;
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO payment_plan (org_id, enrolment_id, plan_type, frequency, total_minor,
                                     down_payment_minor, num_installments, start_date, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10) RETURNING id`,
          [orgId, enrolmentId, planType, frequency, total, downPayment, numInstallments, startDate, dto?.note ?? null, me.id],
        );
        planId = Number(r.rows[0].id);
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw new ConflictException(`${e.enrolment_no} already has an active payment plan. Delete it first to re-plan.`);
        }
        throw err;
      }
      for (const row of schedule) {
        await c.query(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, label)
           VALUES ($1,$2,$3,$4::date,$5,$6)`,
          [planId, enrolmentId, row.seq_no, row.due_date, row.amount_minor, row.label],
        );
      }
      // apply money already collected (if any) to the new schedule, oldest-first
      const alreadyPaid = Number(e.paid_minor);
      if (alreadyPaid > 0) await this.spread(c, planId, alreadyPaid);
      await this.recomputePlanStatus(c, planId);
      return { id: planId, installments: schedule.length };
    });
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const pp = await this.get(id, scope);
    const paid = (pp.installments ?? []).reduce((a: number, i: any) => a + Number(i.paid_minor), 0);
    if (paid > 0) {
      throw new BadRequestException('This plan has payments applied to it and cannot be deleted. Delete the receipts first if they were entered in error.');
    }
    await this.db.query(
      `UPDATE payment_plan SET deleted_at = now(), deleted_by = $2::bigint, status = 'cancelled' WHERE id = $1::bigint`,
      [id, me.id],
    );
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deletable: [], blocked: [] };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT pp.id, e.enrolment_no,
              COALESCE((SELECT sum(i.paid_minor) FROM installment i WHERE i.plan_id = pp.id), 0) AS paid_minor
         FROM payment_plan pp JOIN enrolment e ON e.id = pp.enrolment_id
        WHERE pp.id = ANY($1::bigint[]) AND pp.deleted_at IS NULL AND ${w}`, params);
    const deletable: number[] = []; const blocked: Array<{ id: number; reason: string }> = [];
    for (const r of rows) {
      if (Number(r.paid_minor) > 0) blocked.push({ id: Number(r.id), reason: `${r.enrolment_no} has payments applied` });
      else deletable.push(Number(r.id));
    }
    return { deletable, blocked, count: deletable.length };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const { deletable } = await this.bulkDeleteImpact(ids, scope);
    if (!deletable.length) return { deleted: 0 };
    await this.db.query(
      `UPDATE payment_plan SET deleted_at = now(), deleted_by = $2::bigint, status = 'cancelled'
        WHERE id = ANY($1::bigint[])`, [deletable, me.id]);
    return { deleted: deletable.length };
  }

  /* ----------------------------------------------- collection application */

  /**
   * APPLY a fee_receipt to the enrolment's active plan, oldest-due first (or a chosen
   * installment first, then overflow to oldest). Called INSIDE the fee service's collect
   * transaction, on the same client, so the receipt and its allocation commit together.
   * A no-op when the enrolment has no active plan (lite fee still works without a plan).
   */
  async applyReceipt(c: PoolClient, receiptId: number, enrolmentId: number, amountMinor: number, chosenInstallmentId?: number | null): Promise<void> {
    const plan = (await c.query<{ id: string }>(
      `SELECT id FROM payment_plan WHERE enrolment_id = $1::bigint AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [enrolmentId],
    )).rows[0];
    if (!plan) return;
    await this.spread(c, Number(plan.id), amountMinor, receiptId, chosenInstallmentId ? Number(chosenInstallmentId) : null);
    await this.recomputePlanStatus(c, Number(plan.id));
  }

  /**
   * REVERSE every allocation of a receipt (on soft-delete). installment_payment rows for a
   * SOFT-deleted receipt are not cascade-removed (the receipt row survives), so we delete
   * them explicitly and recompute the affected installments' paid_minor + status.
   */
  async reverseReceipt(c: PoolClient, receiptId: number): Promise<void> {
    const affected = (await c.query<{ installment_id: string; plan_id: string }>(
      `SELECT DISTINCT ip.installment_id, i.plan_id
         FROM installment_payment ip JOIN installment i ON i.id = ip.installment_id
        WHERE ip.fee_receipt_id = $1::bigint`,
      [receiptId],
    )).rows;
    if (!affected.length) return;
    await c.query(`DELETE FROM installment_payment WHERE fee_receipt_id = $1::bigint`, [receiptId]);
    const planIds = new Set<number>();
    for (const a of affected) {
      await this.recomputeInstallment(c, Number(a.installment_id));
      planIds.add(Number(a.plan_id));
    }
    for (const pid of planIds) await this.recomputePlanStatus(c, pid);
  }

  /** Distribute `amount` across a plan's installments, writing allocation rows if a
   *  receipt id is given (else it is the "money already paid" catch-up during create). */
  private async spread(c: PoolClient, planId: number, amount: number, receiptId?: number, chosenInstallmentId?: number | null): Promise<void> {
    let remaining = Math.trunc(amount);
    if (remaining <= 0) return;
    const rows = (await c.query<any>(
      `SELECT id, amount_minor, paid_minor, (id = $2) AS is_chosen
         FROM installment
        WHERE plan_id = $1::bigint AND status <> 'waived' AND paid_minor < amount_minor
        ORDER BY is_chosen DESC, due_date, seq_no
        FOR UPDATE`,
      [planId, chosenInstallmentId ?? -1],
    )).rows;
    for (const inst of rows) {
      if (remaining <= 0) break;
      const outstanding = Number(inst.amount_minor) - Number(inst.paid_minor);
      if (outstanding <= 0) continue;
      const alloc = Math.min(remaining, outstanding);
      const newPaid = Number(inst.paid_minor) + alloc;
      // waived installments are excluded from `rows`, so this never overrides 'waived'.
      await c.query(
        `UPDATE installment
            SET paid_minor = $2::bigint,
                status = CASE WHEN $2::bigint >= $3::bigint THEN 'paid'
                              WHEN $2::bigint > 0 THEN 'partial' ELSE 'pending' END,
                updated_at = now()
          WHERE id = $1::bigint`,
        [Number(inst.id), newPaid, Number(inst.amount_minor)],
      );
      if (receiptId) {
        await c.query(
          `INSERT INTO installment_payment (installment_id, fee_receipt_id, amount_minor) VALUES ($1,$2,$3)`,
          [Number(inst.id), receiptId, alloc],
        );
      }
      remaining -= alloc;
    }
  }

  /** Recompute one installment's paid_minor from its live (non-deleted-receipt) allocations. */
  private async recomputeInstallment(c: PoolClient, installmentId: number): Promise<void> {
    await c.query(
      `UPDATE installment i
          SET paid_minor = COALESCE((SELECT sum(ip.amount_minor) FROM installment_payment ip
                                       JOIN fee_receipt fr ON fr.id = ip.fee_receipt_id
                                      WHERE ip.installment_id = i.id AND fr.deleted_at IS NULL), 0),
              updated_at = now()
        WHERE i.id = $1::bigint`,
      [installmentId],
    );
    await c.query(
      `UPDATE installment SET status = CASE WHEN status = 'waived' THEN 'waived' ELSE ${STATUS_SQL} END
        WHERE id = $1::bigint`,
      [installmentId],
    );
  }

  /** A plan is 'completed' once every installment is paid/waived; else 'active'. */
  private async recomputePlanStatus(c: PoolClient, planId: number): Promise<void> {
    await c.query(
      `UPDATE payment_plan pp
          SET status = CASE
                WHEN pp.status = 'cancelled' THEN 'cancelled'
                WHEN NOT EXISTS (SELECT 1 FROM installment i
                                  WHERE i.plan_id = pp.id AND i.status NOT IN ('paid','waived'))
                  THEN 'completed' ELSE 'active' END,
              updated_at = now()
        WHERE pp.id = $1::bigint`,
      [planId],
    );
  }
}
