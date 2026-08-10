import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';
import { safeEqual } from '../common/crypto.util';
import { formatINR, rupeesToMinor } from '../common/money.util';
import { assertDateRange } from '../common/date.util';
import { FeeService } from '../fees/fee.service';
import { NotifierService } from '../notifications/notifier.service';
import { NotificationEventService } from '../notificationevents/notification-event.service';

/** injectable HTTP so the tests never hit the real Razorpay API. */
export type HttpFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A trusted, unrestricted scope for the verified-webhook capture path. */
const SYSTEM_SCOPE: ResolvedScope = {
  permissionKey: 'payment.create', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

/** payment list scope — vertical/branch on the payment row, owner/team via the enrolment. */
export const PAYMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'p.branch_id',
  vertical: 'p.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled'] as const;

/**
 * RAZORPAY ONLINE COLLECTION — per vertical, credential-gated, idempotent.
 *
 * ONE money path. A captured payment does not invent a second way to record a receipt:
 * it calls the SAME FeeService.collect() a front-desk clerk uses, so partial application
 * to the installment schedule (oldest-due first), the FOR UPDATE over-collection guard,
 * the receipt number series and the lead_activity trail are all reused verbatim. Online
 * is just a different *trigger*, not a different ledger.
 *
 * PER VERTICAL: the order / payment link is minted with the enrolment's vertical's
 * Razorpay key (channel_config, encrypted, most-specific-wins). No key for that vertical
 * -> a clean 503 (NotConfiguredException), never a 500. Everything lights up the moment
 * the client enters the key in Settings.
 *
 * IDEMPOTENT: the webhook claims the payment row with a conditional UPDATE
 * (status <> 'paid'); a replay finds nothing to claim and no second receipt is written.
 */
@Injectable()
export class PaymentService {
  private readonly log = new Logger('PaymentService');
  /** overridable in tests — the Razorpay REST call. */
  http: HttpFn = (url, init) => (globalThis as any).fetch(url, init);

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly configs: ChannelConfigService,
    private readonly fees: FeeService,
    private readonly notifier: NotifierService,
    /** Notification Events — fires payment_failed on a failed capture. Optional. */
    private readonly notifEvents?: NotificationEventService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string[]; enrolment_id?: number; q?: string; from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[]; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`p.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, PAYMENT_SCOPE_COLS, params)];
    if (f.status?.length) { params.push(f.status); where.push(`p.status = ANY($${params.length}::varchar[])`); }
    if (f.enrolment_id) { params.push(Number(f.enrolment_id)); where.push(`p.enrolment_id = $${params.length}::bigint`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`p.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`p.vertical_id = ANY($${params.length}::bigint[])`); }
    const _dr = assertDateRange(f.from, f.to);
    if (_dr.from) { params.push(_dr.from); where.push(`p.created_at >= $${params.length}::timestamptz`); }
    if (_dr.to) { params.push(_dr.to); where.push(`p.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(l.full_name ILIKE $${params.length} OR e.enrolment_no ILIKE $${params.length} OR p.gateway_payment_id ILIKE $${params.length} OR p.gateway_order_id ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT p.id, p.amount_minor, p.currency, p.status, p.gateway, p.gateway_order_id,
              p.gateway_payment_id, p.gateway_link_id, p.short_url, p.fee_receipt_id,
              p.created_at, p.paid_at, p.failed_reason, p.enrolment_id, p.installment_id,
              e.enrolment_no, e.net_fee_minor, l.full_name AS student_name, l.phone AS student_phone,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name,
              fr.receipt_no, u.name AS created_by_name
         FROM payment p
         JOIN enrolment e ON e.id = p.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = p.branch_id
         JOIN vertical v ON v.id = p.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN fee_receipt fr ON fr.id = p.fee_receipt_id
         LEFT JOIN "user" u ON u.id = p.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, PAYMENT_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT COALESCE(sum(p.amount_minor) FILTER (WHERE p.status = 'paid'), 0) AS collected_minor,
              count(*) FILTER (WHERE p.status = 'paid') AS paid_n,
              count(*) FILTER (WHERE p.status = 'pending') AS pending_n,
              count(*) FILTER (WHERE p.status = 'failed') AS failed_n
         FROM payment p
         JOIN enrolment e ON e.id = p.enrolment_id
        WHERE p.deleted_at IS NULL AND ${w}`,
      params,
    );
    return {
      collected_minor: Number(r?.collected_minor ?? 0),
      paid_n: Number(r?.paid_n ?? 0),
      pending_n: Number(r?.pending_n ?? 0),
      failed_n: Number(r?.failed_n ?? 0),
    };
  }

  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, PAYMENT_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT p.*, e.enrolment_no, e.net_fee_minor, l.full_name AS student_name,
              c.name AS course_name, b.name AS branch_name, v.name AS vertical_name, fr.receipt_no
         FROM payment p
         JOIN enrolment e ON e.id = p.enrolment_id
         JOIN lead l ON l.id = e.lead_id
         JOIN branch b ON b.id = p.branch_id
         JOIN vertical v ON v.id = p.vertical_id
         LEFT JOIN m_course c ON c.id = e.course_id
         LEFT JOIN fee_receipt fr ON fr.id = p.fee_receipt_id
        WHERE p.id = $1::bigint AND p.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!r) throw new NotFoundException('Payment not found');
    return r;
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * Mint a Razorpay PAYMENT LINK for a due / installment on an enrolment, using THAT
   * enrolment's vertical's Razorpay key. A `payment` row (pending) is created first, so
   * even if the gateway call fails the attempt is durable and visible. Amount is paise
   * (Razorpay's own unit); a PARTIAL amount (< outstanding) is allowed.
   */
  async createLink(dto: any, me: { id: number }, scope: ResolvedScope) {
    const enrolmentId = Number(dto?.enrolment_id);
    if (!enrolmentId) throw new BadRequestException('Choose the enrolment this payment is for.');

    // scope-check + read the enrolment (payment.create scope)
    const eParams: unknown[] = [enrolmentId];
    const ew = this.resolver.buildScopeWhere(scope, {
      owner: 'e.counsellor_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    }, eParams);
    const e = await this.db.one<any>(
      `SELECT e.id, e.enrolment_no, e.net_fee_minor, e.branch_id, e.vertical_id, e.lead_id, e.status,
              l.full_name AS student_name, l.phone AS student_phone, l.email AS student_email,
              COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr
                         WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor
         FROM enrolment e JOIN lead l ON l.id = e.lead_id
        WHERE e.id = $1::bigint AND e.deleted_at IS NULL AND ${ew}`,
      eParams,
    );
    if (!e) throw new NotFoundException('Enrolment not found (or outside your access)');
    if (e.status !== 'active') throw new BadRequestException(`${e.enrolment_no} is ${e.status}; an online payment can only be collected against an active enrolment.`);

    const net = Number(e.net_fee_minor);
    const outstanding = net - Number(e.paid_minor);
    if (outstanding <= 0) throw new BadRequestException(`${e.enrolment_no} is already paid in full (${formatINR(net)}). Nothing is outstanding.`);

    let amount_minor: number;
    try {
      amount_minor = dto?.amount_minor !== undefined && dto?.amount_minor !== null
        ? Math.trunc(Number(dto.amount_minor)) : rupeesToMinor(dto?.amount);
    } catch (err) { throw new BadRequestException(`Amount: ${(err as Error).message}`); }
    if (!amount_minor || amount_minor <= 0) amount_minor = outstanding;   // default: the whole due
    if (amount_minor > outstanding) {
      throw new BadRequestException(`That is more than the outstanding balance. Outstanding ${formatINR(outstanding)} — collect ${formatINR(outstanding)} or less (partial payments are allowed).`);
    }
    const installmentId = dto?.installment_id ? Number(dto.installment_id) : null;

    // RESOLVE THE VERTICAL'S RAZORPAY KEY — or degrade cleanly (503).
    const cfg = await this.configs.resolve('payment', Number(e.vertical_id), 'razorpay');
    const keyId = String(cfg?.config?.key_id ?? '').trim();
    const keySecret = String(cfg?.secrets?.key_secret ?? '').trim();
    if (!cfg || !keyId || !keySecret) {
      throw new NotConfiguredException('Razorpay is not configured for this vertical — add the Key ID / Key Secret in Administration › Settings › Channels (per vertical), then this online payment link will work.');
    }
    const currency = String(cfg.config?.currency ?? 'INR').trim() || 'INR';
    const orgId = await this.orgId();

    // durable attempt row FIRST
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO payment (org_id, enrolment_id, installment_id, lead_id, branch_id, vertical_id,
                            amount_minor, currency, gateway, status, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'razorpay','pending',$9,$10) RETURNING id`,
      [orgId, enrolmentId, installmentId, e.lead_id, e.branch_id, e.vertical_id,
        amount_minor, currency, me.id, dto?.note ?? null],
    );
    const paymentId = Number(row!.id);

    // create the Razorpay payment link (amount in PAISE)
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const body = {
      amount: amount_minor, currency,
      description: `Fee payment — ${e.enrolment_no}`,
      reference_id: `pay_${paymentId}`,
      customer: {
        name: e.student_name || undefined,
        contact: e.student_phone || undefined,
        email: e.student_email || undefined,
      },
      notify: { sms: !!e.student_phone, email: !!e.student_email },
      reminder_enable: true,
      notes: { payment_id: String(paymentId), enrolment_id: String(enrolmentId) },
    };
    let resText = '';
    try {
      const res = await this.http('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      resText = await res.text();
      if (!res.ok) {
        await this.db.query(`UPDATE payment SET status='failed', failed_reason=$2, updated_at=now() WHERE id=$1`,
          [paymentId, `Razorpay HTTP ${res.status}: ${resText.slice(0, 300)}`]);
        throw new BadRequestException(`Razorpay could not create the payment link (HTTP ${res.status}). ${this.rzpError(resText)}`);
      }
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotConfiguredException) throw err;
      await this.db.query(`UPDATE payment SET status='failed', failed_reason=$2, updated_at=now() WHERE id=$1`,
        [paymentId, `Could not reach Razorpay: ${(err as Error).message}`.slice(0, 300)]);
      throw new BadRequestException(`Could not reach Razorpay: ${(err as Error).message}`);
    }

    const j = this.safeJson(resText) ?? {};
    await this.db.query(
      `UPDATE payment SET gateway_link_id=$2, gateway_order_id=$3, short_url=$4, updated_at=now() WHERE id=$1`,
      [paymentId, j.id ?? null, j.order_id ?? null, j.short_url ?? null],
    );
    return {
      id: paymentId, status: 'pending', amount_minor, currency,
      short_url: j.short_url ?? null, gateway_link_id: j.id ?? null, enrolment_no: e.enrolment_no,
    };
  }

  /** Cancel/void a pending online payment (soft delete). Not a refund (Phase-3 Batch-4). */
  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const p = await this.get(id, scope);
    if (p.status === 'paid') throw new BadRequestException('A paid online payment cannot be deleted here — reverse the fee receipt instead. Refunds arrive in the next batch.');
    await this.db.query(`UPDATE payment SET deleted_at=now(), deleted_by=$2, status = CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE id=$1`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deletable: [], blocked: [], count: 0 };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, PAYMENT_SCOPE_COLS, params);
    const rows = await this.db.query<any>(
      `SELECT p.id, p.status, e.enrolment_no
         FROM payment p JOIN enrolment e ON e.id = p.enrolment_id
        WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL AND ${w}`, params);
    const deletable: number[] = []; const blocked: Array<{ id: number; reason: string }> = [];
    for (const r of rows) {
      if (r.status === 'paid') blocked.push({ id: Number(r.id), reason: `${r.enrolment_no} is a captured payment (reverse the receipt / refund instead)` });
      else deletable.push(Number(r.id));
    }
    return { deletable, blocked, count: deletable.length };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const { deletable } = await this.bulkDeleteImpact(ids, scope);
    if (!deletable.length) return { deleted: 0 };
    await this.db.query(
      `UPDATE payment SET deleted_at = now(), deleted_by = $2::bigint,
              status = CASE WHEN status='pending' THEN 'cancelled' ELSE status END
        WHERE id = ANY($1::bigint[])`, [deletable, me.id]);
    return { deleted: deletable.length };
  }

  /* --------------------------------------------------------------- webhook */

  /**
   * THE RAZORPAY WEBHOOK. A single public endpoint serves every vertical: the payment
   * row (found by the link / order / notes we minted) tells us WHICH vertical, and that
   * vertical's stored webhook secret is what verifies the HMAC over the RAW body. An
   * event we cannot tie to a row, or cannot verify, changes nothing.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ http: number; body: any }> {
    const raw = rawBody ?? Buffer.from('');
    let evt: any;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); } catch { return { http: 400, body: { error: 'Malformed JSON' } }; }
    const event = String(evt?.event ?? '');
    const pe = evt?.payload?.payment?.entity ?? null;
    const le = evt?.payload?.payment_link?.entity ?? null;

    // locate OUR payment row (most reliable first: the notes we set, then the ids we stored)
    const noteId = Number(pe?.notes?.payment_id ?? le?.notes?.payment_id ?? 0) || null;
    const refId = String(le?.reference_id ?? pe?.notes?.reference_id ?? '').replace(/^pay_/, '');
    const p = await this.db.one<any>(
      `SELECT * FROM payment WHERE deleted_at IS NULL AND (
          ($1::bigint IS NOT NULL AND id = $1::bigint)
          OR ($2::varchar <> '' AND id = NULLIF($2,'')::bigint)
          OR ($3::varchar IS NOT NULL AND gateway_link_id = $3::varchar)
          OR ($4::varchar IS NOT NULL AND gateway_order_id = $4::varchar)
       ) ORDER BY id DESC LIMIT 1`,
      [noteId, /^\d+$/.test(refId) ? refId : '', le?.id ?? pe?.order_id ?? null, pe?.order_id ?? null],
    );
    if (!p) {
      this.log.warn(`Razorpay webhook "${event}" for an unknown payment (ignored)`);
      return { http: 200, body: { received: true, ignored: 'unknown payment' } };
    }

    // the vertical's webhook secret verifies the signature
    const cfg = await this.configs.resolve('payment', Number(p.vertical_id), 'razorpay');
    const secret = String(cfg?.secrets?.webhook_secret ?? '').trim();
    if (!secret) {
      this.log.warn(`Razorpay webhook for vertical ${p.vertical_id} but no webhook secret configured`);
      return { http: 400, body: { error: 'Webhook secret not configured for this vertical' } };
    }
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    if (!signature || !safeEqual(signature, expected)) {
      this.log.warn(`Razorpay webhook signature mismatch for payment ${p.id}`);
      return { http: 401, body: { error: 'Invalid signature' } };
    }

    if (event === 'payment.captured' || event === 'payment_link.paid' || event === 'order.paid') {
      return this.onCaptured(p, pe, le);
    }
    if (event === 'payment.failed') {
      return this.onFailed(p, pe);
    }
    return { http: 200, body: { received: true, ignored: event } };
  }

  /** CAPTURE -> claim the row (idempotent), collect the fee, auto-receipt, notify. */
  private async onCaptured(p: any, pe: any, le: any): Promise<{ http: number; body: any }> {
    const gatewayPaymentId = String(pe?.id ?? le?.id ?? `link_${p.id}`);
    const orderId = pe?.order_id ?? p.gateway_order_id ?? null;
    const captured = Number(pe?.amount ?? le?.amount_paid ?? p.amount_minor);
    const amount = Number.isFinite(captured) && captured > 0 ? Math.trunc(captured) : Number(p.amount_minor);

    // ATOMIC CLAIM — only the first webhook flips pending -> paid. A replay claims nothing.
    const claim = await this.db.query<any>(
      `UPDATE payment SET status='paid', gateway_payment_id=$2, gateway_order_id=COALESCE($3, gateway_order_id),
              paid_at=now(), updated_at=now()
        WHERE id=$1 AND status <> 'paid' RETURNING id, enrolment_id, installment_id, created_by`,
      [p.id, gatewayPaymentId, orderId],
    );
    if (!claim.length) {
      return { http: 200, body: { received: true, idempotent: true, payment_id: Number(p.id) } };
    }
    const claimed = claim[0];

    // record the fee collection via the ONE collect path (partial-applies to installments)
    try {
      const rec = await this.fees.collect(
        {
          enrolment_id: Number(claimed.enrolment_id),
          amount_minor: amount, mode: 'online',
          reference: gatewayPaymentId,
          gateway: 'razorpay', gateway_order_id: orderId, gateway_payment_id: gatewayPaymentId,
          installment_id: claimed.installment_id ?? undefined,
          note: 'Razorpay online payment',
        },
        { id: Number(claimed.created_by) || (null as any) },
        SYSTEM_SCOPE,
        { allowGateway: true, system: true },
      );
      await this.db.query(`UPDATE payment SET fee_receipt_id=$2, updated_at=now() WHERE id=$1`, [p.id, rec.id]);
      await this.notifyPaid(p, rec).catch((e) => this.log.warn(`notify (paid) failed: ${(e as Error).message}`));
      // prove the receipt PDF renders (auto-receipt). Best-effort — never blocks the webhook.
      try { await this.fees.pdf(Number(rec.id), SYSTEM_SCOPE); } catch (e) { this.log.warn(`auto-receipt PDF: ${(e as Error).message}`); }
      return { http: 200, body: { received: true, paid: true, payment_id: Number(p.id), fee_receipt_id: Number(rec.id), receipt_no: rec.receipt_no } };
    } catch (e) {
      // Money IS captured at Razorpay; keep the payment 'paid' but flag that the receipt
      // could not be written (e.g. the enrolment was fully paid meanwhile). Surfaces in the list.
      await this.db.query(`UPDATE payment SET failed_reason=$2, updated_at=now() WHERE id=$1`,
        [p.id, `Captured, but the fee receipt could not be recorded: ${(e as Error).message}`.slice(0, 400)]);
      this.log.warn(`payment ${p.id} captured but collect failed: ${(e as Error).message}`);
      return { http: 200, body: { received: true, paid: true, payment_id: Number(p.id), receipt_error: (e as Error).message } };
    }
  }

  private async onFailed(p: any, pe: any): Promise<{ http: number; body: any }> {
    const reason = String(pe?.error_description ?? pe?.error_reason ?? 'Payment failed at Razorpay').slice(0, 400);
    const claim = await this.db.query<any>(
      `UPDATE payment SET status='failed', failed_reason=$2, gateway_payment_id=COALESCE($3, gateway_payment_id), updated_at=now()
        WHERE id=$1 AND status='pending' RETURNING id`,
      [p.id, reason, pe?.id ?? null],
    );
    if (!claim.length) return { http: 200, body: { received: true, idempotent: true } };
    await this.notifyFailed(p, reason).catch(() => undefined);
    // Notification Events — tell the student their online payment failed. Best-effort.
    await this.notifEvents?.safeFire('payment_failed', {
      lead_id: p.lead_id ? Number(p.lead_id) : null,
      vertical_id: p.vertical_id ? Number(p.vertical_id) : null,
      dedupe: `payfail:${p.id}`,
      vars: { amount: formatINR(Number(p.amount_minor)), reason },
    });
    return { http: 200, body: { received: true, failed: true, payment_id: Number(p.id) } };
  }

  /* --------------------------------------------------------------- helpers */

  /** Notify the enrolment's counsellor that money came in (in-app always; email/SMS/WA per matrix). */
  private async notifyPaid(p: any, rec: { id: number; receipt_no: string }) {
    const u = await this.db.one<any>(`SELECT counsellor_id, enrolment_no FROM enrolment WHERE id = $1`, [p.enrolment_id]);
    if (!u?.counsellor_id) return;
    await this.notifier.notify({
      userId: Number(u.counsellor_id), type: 'system', severity: 'info',
      title: `Payment received — ${u.enrolment_no}`,
      body: `${formatINR(Number(p.amount_minor))} paid online (Razorpay). Receipt ${rec.receipt_no}.`,
      link: p.lead_id ? { type: 'lead', id: Number(p.lead_id) } : undefined,
      meta: { event: 'payment_success', payment_id: Number(p.id), fee_receipt_id: Number(rec.id) },
    });
  }

  private async notifyFailed(p: any, reason: string) {
    const u = await this.db.one<any>(`SELECT counsellor_id, enrolment_no FROM enrolment WHERE id = $1`, [p.enrolment_id]);
    if (!u?.counsellor_id) return;
    await this.notifier.notify({
      userId: Number(u.counsellor_id), type: 'system', severity: 'warn',
      title: `Online payment failed — ${u.enrolment_no}`,
      body: reason,
      link: p.lead_id ? { type: 'lead', id: Number(p.lead_id) } : undefined,
      meta: { event: 'payment_failed', payment_id: Number(p.id) },
    });
  }

  private safeJson(t: string): any { try { return JSON.parse(t); } catch { return null; } }
  private rzpError(t: string): string { const j = this.safeJson(t); return j?.error?.description ? String(j.error.description) : ''; }
}
