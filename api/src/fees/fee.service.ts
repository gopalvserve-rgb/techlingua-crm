import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { formatINR, rupeesToMinor } from '../common/money.util';
import { Letterhead, receiptPdf } from '../pdf/documents';
import { paidAsAtMinor } from './as-at';
import { assertDateRange } from '../common/date.util';
import { PlanService } from '../paymentplans/plan.service';

/**
 * LITE FEE — a collection entry and a receipt. That is the WHOLE Phase-1 scope
 * ("Lite finance (enabling enrolment): basic fee receipt + collection entry (full
 * accounting deferred to Phase 3)" — PROJECT_DOCUMENTATION §5).
 *
 * =============================================================================
 * WHAT IS DELIBERATELY *NOT* HERE — ALL OF IT IS PHASE 3
 * =============================================================================
 *   · RAZORPAY / any live online collection. The credentials are ALREADY stored per
 *     vertical in `channel_config` and the Settings screen already verifies them
 *     read-only — so Phase 3 is not waiting on the client. But NO code here charges a
 *     card, creates an order, or handles a payment webhook. `mode: 'online'` means "the
 *     client reconciled a bank transfer by hand and typed it in", and the `gateway_*`
 *     columns on fee_receipt are the seam Phase 3 fills. Taking money is not something
 *     to half-build.
 *   · GST tax invoices · dues & ageing buckets · installment schedules · REFUNDS ·
 *     scholarships · accrual revenue · Tally export.
 *
 * OVER-COLLECTION IS REFUSED, inside the same transaction that inserts, behind a
 * `SELECT ... FOR UPDATE` on the enrolment. Two clerks collecting the last ₹5,000 at the
 * same instant cannot jointly collect ₹10,000 — the second one waits on the row lock and
 * then loses. A check-then-insert would let both through, and the client would find out
 * from a customer.
 *
 * PARTIAL PAYMENTS ARE THE NORM: every receipt is an independent row; `paid` is always
 * `sum(receipts)` and is never a running column that could drift from its own history.
 */

export const RECEIPT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'fr.branch_id',
  vertical: 'fr.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'online'] as const;
export const MODE_LABELS: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online transfer',
};
/** Modes where a reference (UTR / cheque number) is the difference between a receipt
 *  and a rumour. Cash and card-at-desk legitimately have none. */
const REFERENCE_REQUIRED = ['cheque', 'upi', 'online'];

@Injectable()
export class FeeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    // Phase 3 Batch 2: apply/reverse a receipt against the installment schedule inside the
    // SAME transaction as the receipt. Optional so the unit tests can build FeeService
    // without the plans graph (they never touch a plan).
    private readonly plans?: PlanService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { mode?: string; enrolment_id?: number; q?: string; from?: string; to?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`fr.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, RECEIPT_SCOPE_COLS, params)];
    if (f.mode) { params.push(f.mode); where.push(`fr.mode = $${params.length}::varchar`); }
    if (f.enrolment_id) { params.push(Number(f.enrolment_id)); where.push(`fr.enrolment_id = $${params.length}::bigint`); }
    // DEF-DR-02: strict validation — malformed date -> 400, never a 500.
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`fr.received_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`fr.received_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(fr.receipt_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length} OR fr.reference ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT fr.id, fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at, fr.note,
              fr.enrolment_id, e.enrolment_no, e.net_fee_minor,
              l.full_name AS lead_name, c.name AS course_name,
              b.name AS branch_name, v.name AS vertical_name, u.name AS received_by_name
         FROM fee_receipt fr
         JOIN enrolment e ON e.id = fr.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = fr.branch_id
         JOIN vertical v ON v.id = fr.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = fr.received_by
        WHERE ${where.join(' AND ')}
        ORDER BY fr.received_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  /** The Fee Collection screen's KPIs + the by-mode donut. */
  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, RECEIPT_SCOPE_COLS, params);
    const base = `FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id
                  WHERE fr.deleted_at IS NULL AND ${w}`;
    const r = await this.db.one<any>(
      `SELECT COALESCE(sum(fr.amount_minor) FILTER (WHERE fr.received_at >= date_trunc('month', now())), 0) AS mtd_minor,
              COALESCE(sum(fr.amount_minor) FILTER (WHERE fr.received_at >= date_trunc('day', now())), 0) AS today_minor,
              count(*) AS receipts
       ${base}`,
      params,
    );
    const byMode = await this.db.query<any>(
      `SELECT fr.mode, COALESCE(sum(fr.amount_minor), 0) AS total_minor, count(*) AS n
       ${base}
        GROUP BY fr.mode ORDER BY 2 DESC`,
      params,
    );
    // OUTSTANDING = what is agreed minus what is in. Phase-3's dues/ageing is a much
    // bigger thing (installment-wise, bucketed, with reminders); this is the one honest
    // number Phase 1 can stand behind, and the screen labels it as such.
    const pOut: unknown[] = [];
    const wOut = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, pOut);
    const out = await this.db.one<any>(
      `SELECT COALESCE(sum(e.net_fee_minor - COALESCE(p.paid_minor, 0)), 0) AS outstanding_minor
         FROM enrolment e
         LEFT JOIN LATERAL (
           SELECT COALESCE(sum(fr.amount_minor), 0) AS paid_minor
             FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL
         ) p ON TRUE
        WHERE e.deleted_at IS NULL AND e.status = 'active' AND ${wOut}`,
      pOut,
    );
    return {
      mtd_minor: Number(r?.mtd_minor ?? 0),
      today_minor: Number(r?.today_minor ?? 0),
      receipts: Number(r?.receipts ?? 0),
      outstanding_minor: Number(out?.outstanding_minor ?? 0),
      by_mode: byMode.map((m) => ({ mode: m.mode, label: MODE_LABELS[m.mode] ?? m.mode, total_minor: Number(m.total_minor), n: Number(m.n) })),
    };
  }

  /**
   * One receipt, with `paid_minor` = **paid AS AT THIS RECEIPT** — not as at today.
   *
   * DEF-S5-02: this used to be a `LEFT JOIN LATERAL` keyed on `x.received_at <=
   * fr.received_at` with no tiebreak. The collect form posts a DATE, so same-day receipts
   * all sit at midnight, `<=` swept in the LATER ones too, and every same-day partial
   * printed the FINAL balance — a false financial document handed to a customer.
   *
   * The arithmetic now lives in `paidAsAtMinor()`, a pure function over the enrolment's
   * receipts, because **no unit test could reach it while it was SQL**: every fee spec
   * drives a db double that returns whatever `paid_minor` it likes and never parses a
   * predicate. Same-day partials are now pinned by fixtures in `as-at.spec.ts`, with no
   * database. The receipt list is tiny (one enrolment's receipts), so the second query is
   * cheap and this path is a receipt view / a PDF print, not a hot loop.
   */
  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, RECEIPT_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT fr.*, e.enrolment_no, e.net_fee_minor, e.lead_id,
              l.full_name AS student_name, l.phone AS student_phone,
              c.name AS course_name, u.name AS received_by_name,
              b.name AS branch_name, b.address AS branch_address, b.contact_number AS branch_phone,
              b.email AS branch_email, v.name AS vertical_name,
              o.name AS org_name, o.gst_no AS org_gst
         FROM fee_receipt fr
         JOIN enrolment e ON e.id = fr.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = fr.branch_id
         JOIN vertical v ON v.id = fr.vertical_id
         JOIN organisation o ON o.id = fr.org_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN "user" u ON u.id = fr.received_by
        WHERE fr.id = $1::bigint AND fr.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!r) throw new NotFoundException('Receipt not found');

    // Every LIVE receipt against the same enrolment. A soft-deleted receipt is not money,
    // so it is excluded here rather than filtered later.
    const siblings = await this.db.query<any>(
      `SELECT id, amount_minor, received_at FROM fee_receipt
        WHERE enrolment_id = $1::bigint AND deleted_at IS NULL`,
      [r.enrolment_id],
    );
    r.paid_minor = paidAsAtMinor(siblings ?? [], r);
    return r;
  }

  /**
   * The receipt PDF. `paid_minor` is deliberately "paid AS AT THIS RECEIPT", not "paid
   * today" — a receipt printed six months later must still show the balance it showed
   * on the day, or it is not a receipt, it is a report.
   */
  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const r = await this.get(id, scope);
    const lh: Letterhead = {
      org_name: r.org_name, org_gst: r.org_gst, vertical_name: r.vertical_name,
      branch_name: r.branch_name, branch_address: r.branch_address,
      branch_phone: r.branch_phone, branch_email: r.branch_email,
    };
    return {
      buffer: receiptPdf({
        receipt_no: r.receipt_no, received_at: r.received_at,
        amount_minor: Number(r.amount_minor), mode: r.mode, reference: r.reference, note: r.note,
        student_name: r.student_name, student_phone: r.student_phone,
        enrolment_no: r.enrolment_no, course_name: r.course_name,
        net_fee_minor: Number(r.net_fee_minor),
        paid_minor: Number(r.paid_minor),
        balance_minor: Number(r.net_fee_minor) - Number(r.paid_minor),
        received_by_name: r.received_by_name,
      }, lh),
      filename: `${String(r.receipt_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`,
    };
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * COLLECT. The whole thing is one transaction with the enrolment row LOCKED, so the
   * over-collection check cannot be raced. Everything else here is refusing bad input
   * with a sentence a front-desk clerk can act on.
   */
  async collect(dto: any, me: { id: number }, scope: ResolvedScope) {
    const enrolmentId = Number(dto?.enrolment_id);
    if (!enrolmentId) throw new BadRequestException('Choose the enrolment this payment is against.');

    let amount_minor: number;
    try {
      amount_minor = dto?.amount_minor !== undefined && dto?.amount_minor !== null
        ? Math.trunc(Number(dto.amount_minor))
        : rupeesToMinor(dto?.amount);
    } catch (e) { throw new BadRequestException(`Amount: ${(e as Error).message}`); }
    if (!Number.isFinite(amount_minor) || amount_minor <= 0) throw new BadRequestException('The amount must be more than zero.');

    const mode = String(dto?.mode ?? '');
    if (!(PAYMENT_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException(`Choose a payment mode: ${PAYMENT_MODES.map((m) => MODE_LABELS[m]).join(', ')}.`);
    }
    const reference = dto?.reference ? String(dto.reference).trim().slice(0, 64) : null;
    if (REFERENCE_REQUIRED.includes(mode) && !reference) {
      throw new BadRequestException(`A ${MODE_LABELS[mode]} payment needs a reference (UTR / cheque number) — without it the receipt cannot be reconciled.`);
    }
    // ONLINE means "reconciled by hand". Phase 3 is what makes it a gateway capture, and
    // this refusal is what stops a clerk believing otherwise.
    if (dto?.gateway || dto?.gateway_payment_id) {
      throw new BadRequestException('Online payment capture (Razorpay) arrives in Phase 3. Record the payment manually with its reference for now.');
    }
    const receivedAt = dto?.received_at ? new Date(String(dto.received_at)) : new Date();
    if (Number.isNaN(receivedAt.getTime())) throw new BadRequestException('The received date is not a date.');
    if (receivedAt.getTime() > Date.now() + 60_000) throw new BadRequestException('A payment cannot be received in the future.');

    // scope-check the enrolment BEFORE we lock anything
    const eParams: unknown[] = [enrolmentId];
    const ew = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, eParams);
    const pre = await this.db.one<any>(
      `SELECT e.id, e.status, e.enrolment_no FROM enrolment e
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${ew}`,
      eParams,
    );
    if (!pre) throw new NotFoundException('Enrolment not found (or outside your access)');
    if (pre.status !== 'active') {
      throw new BadRequestException(
        pre.status === 'pending_approval'
          ? `${pre.enrolment_no} is still waiting for approval — money cannot be collected against an unapproved enrolment.`
          : `${pre.enrolment_no} is ${pre.status}; money cannot be collected against it.`,
      );
    }
    const orgId = await this.orgId();

    return this.db.tx(async (c) => {
      // THE LOCK. Everything after this is serialised per enrolment.
      const lk = await c.query<any>(
        `SELECT e.id, e.enrolment_no, e.net_fee_minor, e.branch_id, e.vertical_id, e.lead_id, e.status,
                COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                           WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor
           FROM enrolment e WHERE e.id = $1::bigint FOR UPDATE`,
        [enrolmentId],
      );
      const e = lk.rows[0];
      if (!e) throw new NotFoundException('Enrolment not found');

      const paid = Number(e.paid_minor);
      const net = Number(e.net_fee_minor);
      const balance = net - paid;
      // OVER-COLLECTION — refused. Taking more than is owed creates a refund liability
      // and Phase 1 has no refund machinery (Phase 3 does). Better to refuse at the desk.
      if (amount_minor > balance) {
        throw new BadRequestException(
          balance <= 0
            ? `${e.enrolment_no} is already paid in full (${formatINR(net)}). Nothing is outstanding.`
            : `That is more than the outstanding balance. Net fee ${formatINR(net)}, already paid ${formatINR(paid)}, outstanding ${formatINR(balance)}. Collect ${formatINR(balance)} or less.`,
        );
      }

      const receiptNo = await this.numbering.allocate(
        'receipt', { branch_id: Number(e.branch_id), vertical_id: Number(e.vertical_id) }, c,
      );
      const r = await c.query<{ id: string }>(
        `INSERT INTO fee_receipt (org_id, receipt_no, enrolment_id, lead_id, branch_id, vertical_id,
                                  amount_minor, mode, reference, received_at, received_by, note)
         VALUES ($1::bigint, $2::varchar, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
                 $7::bigint, $8::varchar, $9, $10::timestamptz, $11::bigint, $12)
         RETURNING id`,
        [orgId, receiptNo, enrolmentId, e.lead_id, e.branch_id, e.vertical_id,
          amount_minor, mode, reference, receivedAt.toISOString(), me.id, dto?.note ?? null],
      );
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
         SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
           FROM lead l WHERE l.id = $1::bigint`,
        [e.lead_id, `Fee received ${formatINR(amount_minor)} (${MODE_LABELS[mode]}) — receipt ${receiptNo}`, me.id],
      );
      // Phase 3: apply this receipt to the enrolment's installment schedule (oldest-due
      // first, or a chosen installment). A no-op when there is no active plan.
      if (this.plans) {
        await this.plans.applyReceipt(c, Number(r.rows[0].id), enrolmentId, amount_minor, dto?.installment_id ? Number(dto.installment_id) : null);
      }
      return {
        id: Number(r.rows[0].id), receipt_no: receiptNo,
        paid_minor: paid + amount_minor,
        balance_minor: balance - amount_minor,
        fully_paid: balance - amount_minor === 0,
      };
    });
  }

  /**
   * DELETE a receipt. Soft-deleted like everything else, so it lands in Deleted Items and
   * the money is recoverable. NOT a refund — a refund moves money and is Phase 3; this is
   * "the clerk typed the wrong figure".
   */
  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const r = await this.get(id, scope);
    await this.db.tx(async (c) => {
      await c.query(`UPDATE fee_receipt SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
      // Phase 3: unwind this receipt's installment allocations so the schedule reflects
      // the (now soft-deleted) receipt — paid_minor drops back, statuses recompute.
      if (this.plans) await this.plans.reverseReceipt(c, id);
      await c.query(
        `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
         SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
           FROM lead l WHERE l.id = $1::bigint`,
        [r.lead_id, `Receipt ${r.receipt_no} (${formatINR(Number(r.amount_minor))}) deleted`, me.id],
      );
    });
    return { id, ok: true };
  }
}
