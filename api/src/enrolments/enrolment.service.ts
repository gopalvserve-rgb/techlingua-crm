import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { rupeesToMinor } from '../common/money.util';
import { ApprovalService, requiredSteps } from './approval.service';
import { requireDateString, assertDateRange } from '../common/date.util';
import { FinanceSettingsService } from '../finance/finance-settings.service';

/**
 * ENROLMENT — the SALE CLOSURE record. "Sale closure = enrolment" (§5).
 *
 * =============================================================================
 * THE SEAMS — read these before extending anything here
 * =============================================================================
 * PHASE 2 (student profile & academics): `enrolment.student_profile_id` is the seam.
 *   Phase 2 creates `student_profile` and POINTS THIS COLUMN AT IT. The enrolment is
 *   not re-created, not copied and not migrated: it already carries everything Phase 2
 *   needs about the sale (course, fee, discount, plan intent, start date, branch,
 *   vertical, counsellor, and the lead it came from). `batch_id` is the same seam for
 *   batches. NOTHING in Phase 1 writes either column and no screen shows them — an
 *   empty column is a seam; a half-populated one is a migration nobody planned.
 *
 * PHASE 3 (accounts): `payment_plan` + `first_payment_minor` are INTENT — what was
 *   agreed at the desk. Phase 3 turns them into an installment SCHEDULE with dues,
 *   ageing and reminders. We deliberately generate NO schedule now: a half-built
 *   schedule that nothing maintains is worse than none, and the client would build
 *   process around it. `quotation_id` is the link Phase 3 raises the GST invoice from.
 *
 * A LEAD ENROLS ONCE — enforced by the partial UNIQUE index `uq_enrolment_lead`, not by
 * a check-then-insert. Double-clicking "Enrol" cannot create two admissions (and two
 * revenue rows in the client's month). A cancelled/rejected enrolment frees the lead.
 *
 * WINNING THE LEAD: closing a sale moves the lead to its pipeline's WON stage — because
 * "sale closure = enrolment" means the two cannot disagree. If the pipeline has no won
 * stage the enrolment still happens (a stage taxonomy is not allowed to block revenue).
 */

export const ENROLMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
  vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const PAYMENT_PLANS = ['full', 'emi_3', 'emi_6', 'custom'] as const;
export const PLAN_LABELS: Record<string, string> = {
  full: 'Full payment', emi_3: '3 installments', emi_6: '6 installments', custom: 'Custom',
};

@Injectable()
export class EnrolmentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalService,
    private readonly finance?: FinanceSettingsService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string; q?: string; from?: string; to?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`e.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params)];
    if (f.status) { params.push(f.status); where.push(`e.status = $${params.length}::varchar`); }
    // DEF-DR-02: one strict validator — malformed date -> 400, not a 500 at the ::date cast.
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`e.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`e.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(e.enrolment_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.start_date, e.payment_plan,
              e.fee_minor, e.discount_minor, e.net_fee_minor, e.first_payment_minor,
              e.created_at, e.lead_id, e.quotation_id, e.course_id,
              l.full_name AS lead_name, l.phone AS lead_phone,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS counsellor_name, q.quote_no,
              COALESCE(p.paid_minor, 0) AS paid_minor,
              e.net_fee_minor - COALESCE(p.paid_minor, 0) AS balance_minor
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
         LEFT JOIN quotation q ON q.id = e.quotation_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(fr.amount_minor), 0) AS paid_minor
             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL
         ) p ON TRUE
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    // "MTD" = this calendar month, in the org's timezone. date_trunc on the DB clock is
    // the same clock the targets use, so the dashboard and this card cannot disagree.
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE e.status = 'active'
                               AND e.created_at >= date_trunc('month', now())) AS mtd_count,
              COALESCE(sum(e.net_fee_minor) FILTER (WHERE e.status = 'active'
                               AND e.created_at >= date_trunc('month', now())), 0) AS mtd_revenue_minor,
              count(*) FILTER (WHERE e.status = 'pending_approval') AS pending_approval,
              COALESCE(round(avg(CASE WHEN e.status = 'active' AND e.fee_minor > 0
                                      THEN e.discount_minor::numeric * 100 / e.fee_minor END), 1), 0) AS avg_discount_pct
         FROM enrolment e
        WHERE e.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      mtd_count: Number(r?.mtd_count ?? 0),
      mtd_revenue_minor: Number(r?.mtd_revenue_minor ?? 0),
      pending_approval: Number(r?.pending_approval ?? 0),
      avg_discount_pct: Number(r?.avg_discount_pct ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ENROLMENT_SCOPE_COLS, params);
    const e = await this.db.one<any>(
      `SELECT e.*, l.full_name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS counsellor_name, q.quote_no,
              COALESCE(p.paid_minor, 0) AS paid_minor,
              e.net_fee_minor - COALESCE(p.paid_minor, 0) AS balance_minor
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = e.branch_id
         JOIN vertical v ON v.id = e.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = e.counsellor_id
         LEFT JOIN quotation q ON q.id = e.quotation_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(fr.amount_minor), 0) AS paid_minor
             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL
         ) p ON TRUE
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!e) throw new NotFoundException('Enrolment not found');
    const receipts = await this.db.query<any>(
      `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at,
              u.name AS received_by_name
         FROM fee_receipt fr LEFT JOIN "user" u ON u.id = fr.received_by
        WHERE fr.enrolment_id = $1::bigint AND fr.deleted_at IS NULL
        ORDER BY fr.received_at DESC`,
      [id],
    );
    const approvals = await this.approvals.forEntity('enrolment', id);
    return { ...e, receipts, approvals };
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * CLOSE THE SALE.
   *
   * Order matters and is deliberate:
   *   1. the lead must be in the caller's scope (a counsellor cannot enrol someone
   *      else's lead — 404, not a sale);
   *   2. the money is normalised to exact paise and CROSS-CHECKED (net = fee - discount,
   *      recomputed here; the client never gets to post a net that disagrees);
   *   3. the approval policy decides the STATUS before anything is written, so an
   *      enrolment is never briefly `active` and then demoted;
   *   4. number, row, approval requests and the lead's WON stage all commit TOGETHER.
   */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    if (!leadId) throw new BadRequestException('Choose the lead being enrolled.');

    const lead = await this.leadInScope(leadId, scope);
    const money = this.normaliseMoney(dto);
    if (this.finance) {
      await this.finance.assertAllowed({
        verticalId: Number(lead.vertical_id), userId: me.id, kind: 'discount',
        base: money.fee_minor, discount: money.discount_minor, label: 'Enrolment discount',
      });
    }
    const plan = String(dto?.payment_plan ?? 'full');
    if (!(PAYMENT_PLANS as readonly string[]).includes(plan)) throw new BadRequestException('Choose a valid payment plan.');
    if (money.first_payment_minor > money.net_fee_minor) {
      throw new BadRequestException('The first payment cannot be more than the net fee.');
    }
    const startDate = this.date(dto?.start_date);
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    const counsellorId = dto?.counsellor_id ? Number(dto.counsellor_id) : (lead.owner_id ? Number(lead.owner_id) : me.id);
    const quotationId = dto?.quotation_id ? Number(dto.quotation_id) : null;
    if (quotationId) await this.assertQuotationUsable(quotationId, leadId);

    const policy = await this.approvals.policy();
    const steps = requiredSteps(policy, money);
    const status = steps.length ? 'pending_approval' : 'active';
    const orgId = await this.orgId();

    const out = await this.db.tx(async (c) => {
      const enrolmentNo = await this.numbering.allocate(
        'enrolment', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c,
      );
      let id: number;
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO enrolment (org_id, enrolment_no, lead_id, quotation_id, branch_id, vertical_id,
                                  pipeline_id, campaign_id, counsellor_id, team_id, course_id,
                                  fee_minor, discount_minor, net_fee_minor, payment_plan,
                                  first_payment_minor, plan_note, start_date, status, remarks, created_by)
           VALUES ($1::bigint, $2::varchar, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
                   $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint,
                   $12::bigint, $13::bigint, $14::bigint, $15::varchar,
                   $16::bigint, $17, $18::date, $19::varchar, $20, $21::bigint)
           RETURNING id`,
          [orgId, enrolmentNo, leadId, quotationId, lead.branch_id, lead.vertical_id,
            lead.pipeline_id ?? null, lead.campaign_id ?? null, counsellorId, lead.team_id ?? null, courseId,
            money.fee_minor, money.discount_minor, money.net_fee_minor, plan,
            money.first_payment_minor, dto?.plan_note ?? null, startDate, status, dto?.remarks ?? null, me.id],
        );
        id = Number(r.rows[0].id);
      } catch (e) {
        // uq_enrolment_lead — a lead enrols ONCE. This is the double-click, and it is a
        // 409 with a sentence a human understands, not a raw constraint name.
        if ((e as { code?: string })?.code === '23505' && String((e as Error).message).includes('uq_enrolment_lead')) {
          throw new ConflictException(`${lead.full_name} is already enrolled. Cancel the existing enrolment first if this is a genuine re-admission.`);
        }
        throw e;
      }

      if (steps.length) {
        await this.approvals.open(c, {
          orgId, entityType: 'enrolment', entityId: id,
          branchId: Number(lead.branch_id), verticalId: Number(lead.vertical_id), requestedBy: me.id,
        }, steps);
      } else {
        await this.winLead(c, lead, me.id, enrolmentNo);
      }
      await this.activity(c, leadId, me.id,
        steps.length
          ? `Enrolment ${enrolmentNo} submitted for approval (${steps.map((s) => s.label).join(', ')})`
          : `Enrolled — ${enrolmentNo}`);
      return { id, enrolment_no: enrolmentNo };
    });

    // outside the transaction, on purpose — see notifyApprovers()
    if (steps.length) {
      await this.approvals.notifyApprovers(out.id, out.enrolment_no, Number(lead.branch_id), leadId, steps);
    }
    return { ...out, status, pending_steps: steps.map((s) => s.label) };
  }

  /**
   * SETTLE an enrolment after an approval decision. Called by the controller once
   * ApprovalService has recorded the vote.
   *   approved + nothing else pending -> active, and the lead is WON.
   *   rejected                        -> rejected (which frees the lead to enrol again).
   */
  async settleApproval(enrolmentId: number, approved: boolean, actorId: number) {
    // DEF-S5-01 (found by the LIVE smoke): this used to select `e.*` and hand the
    // ENROLMENT row to winLead(), which reads `lead.id` / `lead.stage_id`. So it ran
    //     UPDATE lead SET stage_id = <won> WHERE id = <the ENROLMENT's id>
    // — the WRONG ROW. It silently did nothing here only because no lead happened to
    // share an id with the enrolment; on the client's data it would eventually mark a
    // completely unrelated customer as Enrolled. The lead is now selected explicitly,
    // aliased, and its columns are named — see winLead()'s signature.
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.status, e.lead_id,
              l.id AS l_id, l.pipeline_id AS l_pipeline_id, l.stage_id AS l_stage_id, l.full_name
         FROM enrolment e
         JOIN lead l ON l.id = e.lead_id
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL`,
      [enrolmentId],
    );
    if (!e) throw new NotFoundException('Enrolment not found');
    const lead = { id: Number(e.l_id), pipeline_id: e.l_pipeline_id, stage_id: e.l_stage_id };

    if (!approved) {
      await this.db.tx(async (c) => {
        await c.query(`UPDATE enrolment SET status = 'rejected', updated_at = now() WHERE id = $1::bigint`, [enrolmentId]);
        await this.activity(c, Number(e.lead_id), actorId, `Enrolment ${e.enrolment_no} rejected`);
      });
      return { id: enrolmentId, status: 'rejected' };
    }
    if (!await this.approvals.allCleared('enrolment', enrolmentId)) {
      // a multi-step policy: approved this step, still waiting on another
      return { id: enrolmentId, status: e.status, still_pending: true };
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET status = 'active', updated_at = now()
          WHERE id = $1::bigint AND status = 'pending_approval'`,
        [enrolmentId],
      );
      await this.winLead(c, lead, actorId, e.enrolment_no);
      await this.activity(c, Number(e.lead_id), actorId, `Enrolment ${e.enrolment_no} approved — active`);
    });
    return { id: enrolmentId, status: 'active' };
  }

  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.status === 'cancelled' || cur.status === 'rejected') {
      throw new BadRequestException(`${cur.enrolment_no} is ${cur.status} and cannot be edited.`);
    }
    const money = this.normaliseMoney({
      fee: dto?.fee, fee_minor: dto?.fee_minor ?? (dto?.fee === undefined ? cur.fee_minor : undefined),
      discount: dto?.discount,
      discount_minor: dto?.discount_minor ?? (dto?.discount === undefined ? cur.discount_minor : undefined),
      first_payment: dto?.first_payment,
      first_payment_minor: dto?.first_payment_minor ?? (dto?.first_payment === undefined ? cur.first_payment_minor : undefined),
    });
    // MONEY ALREADY COLLECTED IS A FACT. Lowering the net fee below what the customer
    // has already paid would silently create a refund liability we have no Phase-1
    // machinery for (refunds are Phase 3) — so it is refused, loudly.
    if (money.net_fee_minor < Number(cur.paid_minor)) {
      throw new BadRequestException(
        `${cur.lead_name} has already paid ${(Number(cur.paid_minor) / 100).toFixed(2)}. `
        + 'The net fee cannot be set below what has been collected — refunds arrive in Phase 3.',
      );
    }
    if (this.finance) {
      await this.finance.assertAllowed({
        verticalId: Number(cur.vertical_id), userId: me.id, kind: 'discount',
        base: money.fee_minor, discount: money.discount_minor, label: 'Enrolment discount',
      });
    }
    const plan = dto?.payment_plan ?? cur.payment_plan;
    if (!(PAYMENT_PLANS as readonly string[]).includes(String(plan))) throw new BadRequestException('Choose a valid payment plan.');

    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment
            SET course_id = $2::bigint, fee_minor = $3::bigint, discount_minor = $4::bigint,
                net_fee_minor = $5::bigint, payment_plan = $6::varchar, first_payment_minor = $7::bigint,
                plan_note = $8, start_date = $9::date, counsellor_id = $10::bigint,
                remarks = $11, updated_at = now()
          WHERE id = $1::bigint`,
        [id, dto?.course_id === undefined ? cur.course_id : (dto.course_id || null),
          money.fee_minor, money.discount_minor, money.net_fee_minor, plan, money.first_payment_minor,
          dto?.plan_note === undefined ? cur.plan_note : dto.plan_note,
          dto?.start_date === undefined ? cur.start_date : this.date(dto.start_date),
          dto?.counsellor_id === undefined ? cur.counsellor_id : (dto.counsellor_id || null),
          dto?.remarks === undefined ? cur.remarks : dto.remarks],
      );
      await this.activity(c, Number(cur.lead_id), me.id, `Enrolment ${cur.enrolment_no} updated`);
    });
    return { id, ok: true };
  }

  /** CANCEL — the reversible end state. It frees the lead to enrol again (the partial
   *  unique index), which is what a genuine re-admission needs. */
  async cancel(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (Number(cur.paid_minor) > 0) {
      throw new BadRequestException(
        `${cur.enrolment_no} has ${(Number(cur.paid_minor) / 100).toFixed(2)} collected against it. `
        + 'Cancelling would leave money with no enrolment — refunds are Phase 3. Delete the receipts first if they were entered in error.',
      );
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE enrolment SET status = 'cancelled', remarks = COALESCE($2, remarks), updated_at = now()
          WHERE id = $1::bigint`,
        [id, dto?.reason ?? null],
      );
      await c.query(
        `UPDATE approval_request SET status = 'rejected', decided_at = now(), note = 'Enrolment cancelled'
          WHERE entity_type = 'enrolment' AND entity_id = $1::bigint AND status = 'pending'`,
        [id],
      );
      await this.activity(c, Number(cur.lead_id), me.id, `Enrolment ${cur.enrolment_no} cancelled`);
    });
    return { id, status: 'cancelled' };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (Number(cur.paid_minor) > 0) {
      throw new BadRequestException(`${cur.enrolment_no} has receipts against it and cannot be deleted.`);
    }
    await this.db.query(`UPDATE enrolment SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Money in, exactly. `net = fee - discount` is RECOMPUTED here — the client may send a
   * net, and we ignore it. A net that disagrees with its own fee and discount is the
   * kind of thing that is only discovered by an accountant, in April.
   */
  normaliseMoney(dto: any): { fee_minor: number; discount_minor: number; net_fee_minor: number; first_payment_minor: number } {
    const m = (rup: unknown, minor: unknown, label: string): number => {
      try {
        const v = minor !== undefined && minor !== null ? Math.trunc(Number(minor)) : rupeesToMinor(rup);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${label} cannot be negative`);
        return v;
      } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
    };
    const fee_minor = m(dto?.fee, dto?.fee_minor, 'Total fee');
    const discount_minor = m(dto?.discount, dto?.discount_minor, 'Discount');
    if (discount_minor > fee_minor) throw new BadRequestException('The discount cannot be more than the total fee.');
    const first_payment_minor = m(dto?.first_payment, dto?.first_payment_minor, 'First payment');
    return { fee_minor, discount_minor, net_fee_minor: fee_minor - discount_minor, first_payment_minor };
  }

  /** DEF-S16-02's sibling: identical shape, one call away from the identical bug. */
  private date(v: unknown): string | null {
    return requireDateString(v, () => {
      throw new BadRequestException('The start date must be a date.');
    });
  }

  private async assertQuotationUsable(quotationId: number, leadId: number) {
    const q = await this.db.one<any>(
      `SELECT id, lead_id, status, quote_no FROM quotation WHERE id = $1::bigint AND deleted_at IS NULL`,
      [quotationId],
    );
    if (!q) throw new NotFoundException('Quotation not found');
    if (Number(q.lead_id) !== leadId) throw new BadRequestException(`${q.quote_no} belongs to a different lead.`);
    if (q.status !== 'accepted') throw new BadRequestException(`${q.quote_no} is ${q.status} — only an accepted quotation converts to an enrolment.`);
  }

  private async leadInScope(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const lw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const lead = await this.db.one<any>(
      `SELECT l.id, l.org_id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id,
              l.owner_id, l.team_id, l.full_name, l.stage_id
         FROM lead l
        WHERE l.id = $1::bigint AND l.deleted_at IS NULL AND ${lw}`,
      params,
    );
    if (!lead) throw new NotFoundException('Lead not found (or outside your access)');
    return lead;
  }

  /**
   * "Sale closure = enrolment" means the LEAD must show as won. The won stage is found
   * from the pipeline's OWN stage set by its `stage_type` tag (migration 011) — not by a
   * hard-coded name, because the client edits his stages in the Stage Configurator.
   * If the pipeline has no won stage we do NOT invent one and we do NOT fail: a stage
   * taxonomy must never block revenue.
   */
  private async winLead(
    c: any,
    /** THE LEAD — explicitly typed, because the alternative was DEF-S5-01: an `any` let
     *  settleApproval() hand this the ENROLMENT row and update the wrong lead. */
    lead: { id: number; pipeline_id: number | string | null; stage_id: number | string | null },
    actorId: number,
    enrolmentNo: string,
  ) {
    if (!lead.id) throw new Error('winLead: no lead id — refusing to update an unknown row');
    if (!lead.pipeline_id) return;
    const st = await c.query(
      `SELECT id, name FROM pipeline_stage
        WHERE pipeline_id = $1::bigint AND stage_type = 'won' AND is_active
        ORDER BY sort_order LIMIT 1`,
      [lead.pipeline_id],
    );
    const stage = st.rows[0];
    if (!stage) return;
    if (Number(lead.stage_id) === Number(stage.id)) return;
    await c.query(`UPDATE lead SET stage_id = $2::bigint, updated_at = now() WHERE id = $1::bigint`, [lead.id, stage.id]);
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id, to_value)
       SELECT l.id, l.org_id, l.branch_id, 'stage_change', $2, $3::bigint, $4::jsonb
         FROM lead l WHERE l.id = $1::bigint`,
      [lead.id, `Won — enrolled (${enrolmentNo})`, actorId, JSON.stringify({ stage_id: Number(stage.id), stage: stage.name })],
    );
  }

  /** See QuotationService.activity — org_id/branch_id are NOT NULL and come from the lead. */
  private async activity(c: any, leadId: number, actorId: number, note: string) {
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
       SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
         FROM lead l WHERE l.id = $1::bigint`,
      [leadId, note, actorId],
    );
  }
}
