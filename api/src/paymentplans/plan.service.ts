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
    if (f.q) { params.push(`%${f.q}%`); where.push(`(e.enrolment_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length} OR sp.full_name ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));
    return this.db.query<any>(
      `SELECT pp.id, pp.plan_type, pp.frequency, pp.total_minor, pp.down_payment_minor,
              pp.num_installments, pp.start_date, pp.status, pp.created_at,
              pp.enrolment_id, e.enrolment_no, e.net_fee_minor,
              COALESCE(l.full_name, sp.full_name) AS student_name, COALESCE(l.phone, sp.phone) AS student_phone,
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
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN student sp ON sp.id = e.student_profile_id
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

  async summary(scope: ResolvedScope, f: { branch_ids?: number[]; vertical_ids?: number[] } = {}) {
    const params: unknown[] = [];
    const scopeW = [this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params)];
    if (f.branch_ids?.length) { params.push(f.branch_ids); scopeW.push(`e.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); scopeW.push(`e.vertical_id = ANY($${params.length}::bigint[])`); }
    const w = scopeW.join(' AND ');
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
              COALESCE(l.full_name, sp.full_name) AS student_name, COALESCE(l.phone, sp.phone) AS student_phone, COALESCE(l.email, sp.email) AS student_email,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS counsellor_name
         FROM payment_plan pp
         JOIN enrolment e ON e.id = pp.enrolment_id
         LEFT JOIN lead l ON l.id = e.lead_id
         LEFT JOIN student sp ON sp.id = e.student_profile_id
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
    // client 5 Nov (1, 7): Fee setup on an enrolment that has ALREADY received money schedules
    // only the balance; what is paid is kept as a paid row, never spread over new instalments.
    if (dto?.balance_only && Number(e.paid_minor) > 0) {
      const live = await this.db.one(`SELECT 1 FROM payment_plan WHERE enrolment_id = $1::bigint AND status = 'active' AND deleted_at IS NULL`, [enrolmentId]);
      if (live) throw new ConflictException(`${e.enrolment_no} already has an active payment plan — use Re-setup plan to change it.`);
      return this.replan(enrolmentId, null, dto, me, 'created');
    }

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
    const startDate = toDateString(dto?.start_date) || toDateString(e.start_date) || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) /* IST today */;
    const customDates = Array.isArray(dto?.custom_dates)
      ? dto.custom_dates.map((d: unknown) => toDateString(d)).filter(Boolean) as string[] : undefined;
    // CUSTOM amounts (item 4): the client typed each installment's amount. Accept paise
    // (custom_amounts_minor) or rupees (custom_amounts); they must sum to (net − down) or
    // generateSchedule throws — which we surface as a 400.
    let customAmounts: number[] | undefined;
    if (Array.isArray(dto?.custom_amounts_minor) && dto.custom_amounts_minor.length) {
      customAmounts = dto.custom_amounts_minor.map((a: unknown) => Math.trunc(Number(a)));
    } else if (Array.isArray(dto?.custom_amounts) && dto.custom_amounts.length) {
      customAmounts = dto.custom_amounts.map((a: unknown) => rupeesToMinor(a));
    }
    const effInstallments = planType === 'custom' && customAmounts?.length ? customAmounts.length : numInstallments;

    // Build (and self-validate) the schedule BEFORE we write anything. A schedule that does
    // not sum to the net (custom amounts) is a BadRequest, not a 500.
    let schedule;
    try {
      schedule = generateSchedule({
        plan_type: planType, total_minor: total, down_payment_minor: downPayment,
        num_installments: effInstallments, frequency, start_date: startDate as string,
        custom_dates: customDates, custom_amounts: customAmounts,
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const orgId = await this.orgId();
    return this.db.tx(async (c) => {
      let planId: number;
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO payment_plan (org_id, enrolment_id, plan_type, frequency, total_minor,
                                     down_payment_minor, num_installments, start_date, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10) RETURNING id`,
          [orgId, enrolmentId, planType, frequency, total, downPayment, schedule.filter((r) => r.label !== 'Down payment').length || 1, startDate, dto?.note ?? null, me.id],
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
      await this.recordHistory(c, enrolmentId, planId, 'created', me.id, dto?.reason ?? null);
      return { id: planId, installments: schedule.length };
    });
  }

  /**
   * RE-SETUP the fee plan (client 3 Sep, point 2). The PAID part of the current schedule is
   * kept exactly as it happened — every paid / part-paid installment becomes a paid row on the
   * new plan, and the receipts that paid it stay attached to it (their allocation rows are
   * moved, not re-spread) — and ONLY the unpaid balance (net fee − paid) is re-scheduled with
   * the new terms. Works whether or not money has been collected, and is how a level added to
   * an enrolment with a balance due gets a fresh schedule. The old plan is kept as
   * `superseded`, and both versions are written to payment_plan_history.
   */
  async resetup(planId: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const old = await this.get(planId, scope);          // scope-enforced 404
    if (old.status !== 'active' && old.status !== 'completed') {
      throw new BadRequestException('Only the current payment plan can be set up again.');
    }
    return this.replan(Number(old.enrolment_id), old, dto, me, 'resetup');
  }

  /**
   * THE BALANCE-ONLY RE-PLAN (client 5 Nov, points 1 + 7: "20,000 fee, 10,000 already paid by
   * down payment or instalment -> only the 10,000 balance is re-scheduled, not the full fee").
   *
   * What has been paid is never re-scheduled:
   *   - every paid / part-paid instalment of the old plan becomes a PAID row on the new plan,
   *     and the receipts that paid it move with it (their allocation rows are re-pointed);
   *   - money received but sitting on no instalment (paid before any plan existed, or spread in
   *     without a receipt link when a plan was built after the money) becomes ONE paid row,
   *     "Paid · received before this plan", backed by those receipts. It is NOT spread over the
   *     new instalments, which is what made the old flow re-schedule the full fee.
   * Only `net - everything paid` is scheduled on the new terms (down payment, count, custom
   * amounts all apply to that balance). `old` is null when an enrolment that has already
   * received money gets its FIRST plan.
   */
  private async replan(enrolmentId: number, old: any | null, dto: any, me: { id: number }, action: PlanHistoryAction) {
    const e = await this.db.one<any>(
      `SELECT e.id, e.net_fee_minor, e.status, e.enrolment_no, e.start_date,
              COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                          WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS receipts_minor
         FROM enrolment e WHERE e.id = $1::bigint AND e.deleted_at IS NULL`, [enrolmentId]);
    if (!e) throw new NotFoundException('Enrolment not found');
    if (e.status !== 'active') throw new BadRequestException(`${e.enrolment_no} is ${e.status}; its fee plan cannot be set up again.`);

    const paidRows = (old?.installments ?? []).filter((i: any) => Number(i.paid_minor) > 0);
    const net = Number(e.net_fee_minor);
    const split = balanceSplit(net, paidRows.map((i: any) => Number(i.paid_minor)), Number(e.receipts_minor));
    if (split.over) throw new BadRequestException('More has been paid than the current net fee — record a refund instead of re-planning.');
    const { paidKept, earlier, balance } = split;

    const planType = String(dto?.plan_type ?? 'installment') as PlanType;
    if (!PLAN_TYPES.includes(planType)) throw new BadRequestException('Choose a valid plan type: Full, Installment, EMI or Custom.');
    let frequency = String(dto?.frequency ?? (planType === 'full' ? 'once' : 'monthly')) as Frequency;
    if (!FREQUENCIES.includes(frequency)) throw new BadRequestException('Choose a valid frequency.');
    if (planType === 'full') frequency = 'once';
    const downPayment = this.minor(dto?.down_payment, dto?.down_payment_minor, 'Down payment');
    if (downPayment > balance) throw new BadRequestException(`The down payment cannot exceed the balance still to be paid (${(balance / 100).toFixed(2)}).`);
    const numInstallments = planType === 'full' ? 1 : Math.max(1, Math.trunc(Number(dto?.num_installments ?? 3)));
    if (numInstallments > 240) throw new BadRequestException('That is an unreasonable number of installments.');
    const startDate = toDateString(dto?.start_date) || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) /* IST today */;
    const customDates = Array.isArray(dto?.custom_dates)
      ? dto.custom_dates.map((d: unknown) => toDateString(d)).filter(Boolean) as string[] : undefined;
    let customAmounts: number[] | undefined;
    if (Array.isArray(dto?.custom_amounts_minor) && dto.custom_amounts_minor.length) customAmounts = dto.custom_amounts_minor.map((a: unknown) => Math.trunc(Number(a)));
    else if (Array.isArray(dto?.custom_amounts) && dto.custom_amounts.length) customAmounts = dto.custom_amounts.map((a: unknown) => rupeesToMinor(a));
    const effInstallments = planType === 'custom' && customAmounts?.length ? customAmounts.length : numInstallments;

    let schedule: Array<{ seq_no: number; due_date: string; amount_minor: number; label: string }> = [];
    if (balance > 0) {
      try {
        schedule = generateSchedule({
          plan_type: planType, total_minor: balance, down_payment_minor: downPayment,
          num_installments: effInstallments, frequency, start_date: startDate as string,
          custom_dates: customDates, custom_amounts: customAmounts,
        });
      } catch (err) {
        const m = (err as Error).message;
        // custom amounts are checked against the BALANCE here: say so in rupees
        throw new BadRequestException(customAmounts?.length
          ? `The instalment amounts must add up to the balance still to be paid, ${(balance / 100).toFixed(2)} (already paid ${((paidKept + earlier) / 100).toFixed(2)} is kept). ${m}`
          : m);
      }
    }

    const orgId = await this.orgId();
    return this.db.tx(async (c) => {
      // the old plan steps aside first (one ACTIVE plan per enrolment is a unique index)
      if (old) await c.query(`UPDATE payment_plan SET status = 'superseded', updated_at = now() WHERE id = $1::bigint`, [Number(old.id)]);
      let newId: number;
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO payment_plan (org_id, enrolment_id, plan_type, frequency, total_minor,
                                     down_payment_minor, num_installments, start_date, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10) RETURNING id`,
          [orgId, enrolmentId, planType, frequency, net, downPayment,
            schedule.filter((x) => x.label !== 'Down payment').length || 1, startDate, dto?.note ?? null, me.id]);
        newId = Number(r.rows[0].id);
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw new ConflictException(`${e.enrolment_no} already has an active payment plan — use Re-setup plan to change it.`);
        }
        throw err;
      }
      let seq = 1;
      const paidIds: Array<{ id: number; amount: number }> = [];
      // 1) the paid history, as it happened: allocations move with it
      for (const o of paidRows) {
        const label = String(o.label ?? '').startsWith('Paid · ') ? String(o.label) : `Paid · ${o.label ?? `Installment ${o.seq_no}`}`;
        const ins = await c.query<{ id: string }>(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, paid_minor, label, status)
           VALUES ($1,$2,$3,$4::date,$5,$5,$6,'paid') RETURNING id`,
          [newId, enrolmentId, seq++, toDateString(o.due_date), Number(o.paid_minor), label]);
        const nid = Number(ins.rows[0].id);
        await c.query(`UPDATE installment_payment SET installment_id = $2::bigint WHERE installment_id = $1::bigint`, [Number(o.id), nid]);
        paidIds.push({ id: nid, amount: Number(o.paid_minor) });
      }
      // 2) money received that no instalment showed yet: one paid row, never re-scheduled
      if (earlier > 0) {
        const first = await c.query<{ d: string | null }>(
          `SELECT to_char(min(received_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d
             FROM fee_receipt WHERE enrolment_id = $1::bigint AND deleted_at IS NULL`, [enrolmentId]);
        const ins = await c.query<{ id: string }>(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, paid_minor, label, status)
           VALUES ($1,$2,$3,$4::date,$5,$5,$6,'paid') RETURNING id`,
          [newId, enrolmentId, seq++, first.rows[0]?.d ?? startDate, earlier, 'Paid · received before this plan']);
        paidIds.push({ id: Number(ins.rows[0].id), amount: earlier });
      }
      // 3) back every paid row with the receipts that paid it (rows spread in with no receipt
      //    link, i.e. a plan built after the money, get one now) so a later reversal stays exact
      await this.linkFreeReceipts(c, enrolmentId, paidIds);
      // 4) the unpaid balance on the new terms
      for (const row of schedule) {
        await c.query(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, label)
           VALUES ($1,$2,$3,$4::date,$5,$6)`,
          [newId, enrolmentId, seq++, row.due_date, row.amount_minor, row.label]);
      }
      if (old) {
        // the old plan's rows are now history (snapshot kept); drop them so nothing double-counts
        await c.query(`DELETE FROM installment WHERE plan_id = $1::bigint`, [Number(old.id)]);
        await c.query(`UPDATE payment_plan SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [Number(old.id), me.id]);
      }
      await this.recomputePlanStatus(c, newId);
      const kept = paidKept + earlier;
      await this.recordHistory(c, enrolmentId, newId, action, me.id,
        dto?.reason ? String(dto.reason).slice(0, 500)
          : kept > 0 ? `Paid ${inr(kept)} kept as paid; balance ${inr(balance)} scheduled`
          : action === 'resetup' ? 'Fee plan set up again' : null);
      return { id: newId, previous_plan_id: old ? Number(old.id) : null, paid_kept_minor: kept, balance_minor: balance, installments: seq - 1 };
    });
  }

  /**
   * Attach receipt money that sits on no instalment yet to the given paid rows, oldest receipt
   * first, up to each row's paid amount less what already backs it.
   */
  private async linkFreeReceipts(c: PoolClient, enrolmentId: number, rows: Array<{ id: number; amount: number }>): Promise<void> {
    if (!rows.length) return;
    const free = (await c.query<{ id: string; rest: string }>(
      `SELECT fr.id, fr.amount_minor - COALESCE((
                SELECT sum(ip.amount_minor) FROM installment_payment ip
                  JOIN installment i ON i.id = ip.installment_id
                  JOIN payment_plan pp ON pp.id = i.plan_id
                 WHERE ip.fee_receipt_id = fr.id AND pp.deleted_at IS NULL AND pp.status <> 'superseded'), 0) AS rest
         FROM fee_receipt fr
        WHERE fr.enrolment_id = $1::bigint AND fr.deleted_at IS NULL
        ORDER BY fr.received_at, fr.id`, [enrolmentId])).rows
      .map((r) => ({ id: Number(r.id), rest: Number(r.rest) })).filter((r) => r.rest > 0);
    for (const row of rows) {
      const backed = Number((await c.query<{ s: string }>(
        `SELECT COALESCE(sum(amount_minor), 0) AS s FROM installment_payment WHERE installment_id = $1::bigint`, [row.id])).rows[0]?.s ?? 0);
      let gap = row.amount - backed;
      for (const f of free) {
        if (gap <= 0) break;
        if (f.rest <= 0) continue;
        const take = Math.min(gap, f.rest);
        await c.query(`INSERT INTO installment_payment (installment_id, fee_receipt_id, amount_minor) VALUES ($1,$2,$3)`, [row.id, f.id, take]);
        f.rest -= take; gap -= take;
      }
    }
  }

  /** Every version of an enrolment's payment terms, oldest first. */
  async history(enrolmentId: number, scope: ResolvedScope) {
    const params: unknown[] = [enrolmentId];
    const w = this.resolver.buildScopeWhere(scope, PLAN_SCOPE_COLS, params);
    const ok = await this.db.one(`SELECT 1 FROM enrolment e WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`, params);
    if (!ok) throw new NotFoundException('Enrolment not found (or outside your access)');
    const rows = await this.db.query<any>(
      `SELECT h.id, h.version_no, h.action, h.plan_id, h.plan_type, h.total_minor, h.paid_minor, h.balance_minor,
              h.schedule, h.reason, h.created_at, u.name AS actor_name
         FROM payment_plan_history h LEFT JOIN "user" u ON u.id = h.actor_id
        WHERE h.enrolment_id = $1::bigint ORDER BY h.version_no, h.id`, [enrolmentId]);
    // client 5 Nov (5): a version is a snapshot of the moment it was made, so a down payment
    // collected AFTER the plan was created still read "₹0 · pending". The version that IS the
    // current plan now shows the live schedule: what is paid shows paid.
    const live = await this.db.one<{ id: string }>(
      `SELECT id FROM payment_plan WHERE enrolment_id = $1::bigint AND deleted_at IS NULL
          AND status IN ('active','completed') ORDER BY id DESC LIMIT 1`, [enrolmentId]);
    const cur = live ? [...rows].reverse().find((r) => Number(r.plan_id) === Number(live.id)) : null;
    if (cur) {
      const inst = await this.db.query<any>(
        `SELECT seq_no, label, due_date, amount_minor, paid_minor,
                CASE WHEN status = 'waived' THEN 'waived'
                     WHEN paid_minor >= amount_minor THEN 'paid'
                     WHEN due_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'overdue'
                     WHEN paid_minor > 0 THEN 'partial' ELSE 'pending' END AS status
           FROM installment WHERE plan_id = $1::bigint ORDER BY seq_no`, [Number(live!.id)]);
      const paid = inst.reduce((a: number, x: any) => a + Number(x.paid_minor), 0);
      const total = inst.reduce((a: number, x: any) => a + Number(x.amount_minor), 0);
      cur.live = true;
      cur.paid_minor = paid;
      cur.balance_minor = total - paid;
      cur.schedule = inst.map((x: any) => ({ seq_no: Number(x.seq_no), label: x.label, due_date: toDateString(x.due_date),
        amount_minor: Number(x.amount_minor), paid_minor: Number(x.paid_minor), status: x.status }));
    }
    return rows;
  }

  /** Snapshot the enrolment's CURRENT plan into payment_plan_history (same client / tx). */
  recordHistory(c: PoolClient, enrolmentId: number, planId: number | null, action: PlanHistoryAction, actorId: number | null, reason: string | null): Promise<void> {
    return recordPlanHistory(c, enrolmentId, planId, action, actorId, reason);
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
    await recordPlanHistory({ query: async (s: string, p?: unknown[]) => ({ rows: await this.db.query<any>(s, p ?? []) }) },
      Number(pp.enrolment_id), id, 'deleted', me.id, 'Payment plan deleted (nothing had been paid against it)');
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

  /**
   * RECONCILE an enrolment's active payment plan(s) to the enrolment's CURRENT net fee —
   * called when the net moves (e.g. an over-cap discount is approved, dev/103). Only plans
   * with NOTHING collected are rebuilt (a schedule with money applied is a fact, left as-is);
   * the fresh schedule reuses the plan's own type / frequency / installment count / down
   * payment against the new net. Best-effort per plan: a plan whose stored params cannot be
   * regenerated (a custom plan) is skipped rather than throwing. Runs inside the caller's tx.
   */
  async reconcileToNet(c: PoolClient, enrolmentId: number): Promise<void> {
    const plans = await c.query<any>(
      `SELECT pp.id, pp.plan_type, pp.frequency, pp.down_payment_minor, pp.num_installments,
              pp.start_date, e.net_fee_minor
         FROM payment_plan pp JOIN enrolment e ON e.id = pp.enrolment_id
        WHERE pp.enrolment_id = $1::bigint AND pp.status = 'active' AND pp.deleted_at IS NULL`,
      [enrolmentId],
    );
    for (const pp of plans.rows) {
      const paid = await c.query<{ p: string }>(
        `SELECT COALESCE(sum(paid_minor), 0) AS p FROM installment WHERE plan_id = $1::bigint`, [pp.id]);
      if (Number(paid.rows[0].p) > 0) continue;                 // money applied → leave the schedule alone
      const total = Number(pp.net_fee_minor);
      const startDate = toDateString(pp.start_date) || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) /* IST today */;
      let schedule;
      try {
        schedule = generateSchedule({
          plan_type: pp.plan_type as PlanType, total_minor: total,
          down_payment_minor: Number(pp.down_payment_minor),
          num_installments: Math.max(1, Number(pp.num_installments)),
          frequency: pp.frequency as Frequency, start_date: startDate,
        });
      } catch { continue; }
      await c.query(`DELETE FROM installment WHERE plan_id = $1::bigint`, [pp.id]);
      for (const row of schedule) {
        await c.query(
          `INSERT INTO installment (plan_id, enrolment_id, seq_no, due_date, amount_minor, label)
           VALUES ($1,$2,$3,$4::date,$5,$6)`,
          [pp.id, enrolmentId, row.seq_no, row.due_date, row.amount_minor, row.label]);
      }
      await c.query(`UPDATE payment_plan SET total_minor = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [pp.id, total]);
      await this.recomputePlanStatus(c, pp.id);
    }
  }
}

export type PlanHistoryAction = 'created' | 'resetup' | 'level_added' | 'deleted';

/** Snapshot an enrolment's plan into payment_plan_history (same client / tx). Exported so the
 *  student service records the version it creates when a level is added to an enrolment. */
export async function recordPlanHistory(c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, enrolmentId: number, planId: number | null, action: PlanHistoryAction, actorId: number | null, reason: string | null): Promise<void> {
    const pp = planId ? (await c.query(
      `SELECT pp.org_id, pp.plan_type, pp.total_minor FROM payment_plan pp WHERE pp.id = $1::bigint`, [planId])).rows[0] : null;
    const rows = planId ? (await c.query(
      `SELECT seq_no, label, due_date, amount_minor, paid_minor, status FROM installment WHERE plan_id = $1::bigint ORDER BY seq_no`, [planId])).rows : [];
    const org = pp?.org_id ?? (await c.query(`SELECT org_id FROM enrolment WHERE id = $1::bigint`, [enrolmentId])).rows[0]?.org_id;
    if (org == null) return;
    const total = Number(pp?.total_minor ?? 0);
    const paid = rows.reduce((a: number, x: any) => a + Number(x.paid_minor ?? 0), 0);
    const ver = Number((await c.query(
      `SELECT COALESCE(max(version_no), 0) + 1 AS v FROM payment_plan_history WHERE enrolment_id = $1::bigint`, [enrolmentId])).rows[0]?.v ?? 1);
    await c.query(
      `INSERT INTO payment_plan_history (org_id, enrolment_id, plan_id, version_no, action, plan_type, total_minor, paid_minor, balance_minor, schedule, reason, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [org, enrolmentId, planId, ver, action, pp?.plan_type ?? null, total, paid, total - paid,
        JSON.stringify(rows.map((x: any) => ({ seq_no: Number(x.seq_no), label: x.label, due_date: toDateString(x.due_date),
          amount_minor: Number(x.amount_minor), paid_minor: Number(x.paid_minor), status: x.status }))), reason, actorId]);
}

/**
 * How a re-plan splits the money (pure, so the arithmetic is unit-tested):
 *   paidKept: what the old plan's paid / part-paid instalments carry (kept as paid rows)
 *   earlier:  receipts on the enrolment beyond that, on no instalment yet (one paid row)
 *   balance:  net - both, the only amount the new terms schedule
 * `over` when more has been received than the net fee (a refund case, not a re-plan).
 */
export function balanceSplit(netMinor: number, paidRowMinors: number[], receiptsMinor: number): {
  paidKept: number; earlier: number; balance: number; over: boolean;
} {
  const paidKept = paidRowMinors.reduce((a, x) => a + Math.max(0, Math.trunc(x)), 0);
  const earlier = Math.max(0, Math.trunc(receiptsMinor) - paidKept);
  const balance = Math.trunc(netMinor) - paidKept - earlier;
  return { paidKept, earlier, balance: Math.max(0, balance), over: balance < 0 };
}

/** ₹1,23,456.00 for history notes. */
const inr = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
