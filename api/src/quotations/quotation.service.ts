import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NumberingService } from '../numbering/numbering.service';
import { TemplateService } from '../templates/template.service';
import { MessagingService } from '../messaging/messaging.service';
import { computeLine, computeTotals, LineComputed, rupeesToMinor } from '../common/money.util';
import { Letterhead, quotationPdf } from '../pdf/documents';
import { requireDateString } from '../common/date.util';
import { FinanceSettingsService } from '../finance/finance-settings.service';
import { PdfAssetService } from '../storage/pdf-asset.service';

/**
 * QUOTATIONS — fee proposals with line items, discounts, tax SHOWN, a validity date,
 * a PDF, a send, versioning, and a conversion seam.
 *
 * =============================================================================
 * WHAT IS DELIBERATELY *NOT* HERE (Phase 3 — PROJECT_DOCUMENTATION §5)
 * =============================================================================
 * Tax is a NUMBER ON A LINE. There is no CGST/SGST/IGST split, no place-of-supply,
 * no HSN/SAC, no reverse charge, no e-invoice IRN, no tax invoice. A quotation is a
 * proposal; a GST tax invoice is a legal document, and half-forging one is worse than
 * not having one. `convertToEnrolment()` below is the seam: an accepted quote becomes
 * the ENROLMENT (the lite artefact that carries the money), and Phase 3 raises its
 * invoice from that enrolment. The `invoice` numbering series already exists so Phase 3
 * needs no migration.
 *
 * MONEY: every amount is integer paise, computed by common/money.util.ts. The CLIENT
 * NEVER POSTS A TOTAL — totals are always re-derived from the lines here, so a total
 * can never disagree with the lines it is printed above.
 *
 * VERSIONING: a sent quote is EVIDENCE of what the customer was offered. It is never
 * edited in place. `revise()` writes a NEW row (version+1, parent_id) and marks the old
 * one `is_current = FALSE`; both stay readable for ever.
 */

export const QUOTATION_SCOPE_COLS: ScopeColumnMap = {
  owner: 'q.owner_id', team: 'q.team_id', branch: 'q.branch_id',
  vertical: 'q.vertical_id', pipeline: 'q.pipeline_id', campaign: 'q.campaign_id',
};

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

/** Which status may become which. A quotation is a document, not a free-for-all. */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft:    ['sent'],
  sent:     ['accepted', 'rejected', 'expired'],
  // terminal — a decided quote is revised, never re-opened. `revise()` is the way back.
  accepted: [],
  rejected: [],
  expired:  [],
};

export interface ItemInput {
  course_id?: number | null;
  description?: string;
  qty?: number | string;
  unit_price?: unknown;              // RUPEES from the UI
  unit_price_minor?: number;         // …or paise from a machine
  discount_type?: string;
  discount_value?: unknown;          // rupees when 'amount', a percentage when 'percent'
  tax_pct?: unknown;
}

@Injectable()
export class QuotationService {
  private readonly log = new Logger('Quotations');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly numbering: NumberingService,
    private readonly templates?: TemplateService,
    private readonly messaging?: MessagingService,
    private readonly finance?: FinanceSettingsService,
    private readonly pdfAssets?: PdfAssetService,
  ) {}

  /**
   * Run every line's discount through the Finance Settings cap (percent AND amount).
   * A normal user exceeding the cap is REJECTED with a clear message; a user holding
   * `finance.override` passes. No-op when the finance service is absent (bare unit tests).
   */
  private async enforceDiscountCaps(
    verticalId: number, userId: number,
    items: Array<{ computed: LineComputed }>,
  ): Promise<void> {
    if (!this.finance) return;
    const guard = await this.finance.guardFor(verticalId, userId);
    items.forEach((it, i) =>
      guard.enforce('discount', it.computed.gross_minor, it.computed.discount_minor, `Line ${i + 1}`));
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ------------------------------------------------------------- normalising */

  /**
   * Turn whatever the UI sent into exact integer lines. Throws with a HUMAN message on
   * junk — `rupeesToMinor` refuses "abc" rather than storing 0 (the Campaign Budget bug,
   * QA-13 §4; with money it would be a wrong quotation, not a wrong report).
   */
  normaliseItems(raw: unknown): Array<ItemInput & { computed: LineComputed; description: string; qty: number; unit_price_minor: number; discount_type: 'amount' | 'percent'; discount_value: number; tax_pct: number }> {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) throw new BadRequestException('A quotation needs at least one line item.');
    if (list.length > 50) throw new BadRequestException('A quotation is limited to 50 line items.');

    return list.map((r: any, i) => {
      const n = i + 1;
      const description = String(r?.description ?? '').trim();
      if (!description) throw new BadRequestException(`Line ${n}: a description is required.`);

      const qty = Number(r?.qty ?? 1);
      if (!Number.isInteger(qty) || qty < 1) throw new BadRequestException(`Line ${n}: quantity must be a whole number of 1 or more.`);

      let unit_price_minor: number;
      try {
        unit_price_minor = r?.unit_price_minor !== undefined && r?.unit_price_minor !== null
          ? Math.trunc(Number(r.unit_price_minor))
          : rupeesToMinor(r?.unit_price);
      } catch (e) { throw new BadRequestException(`Line ${n}: ${(e as Error).message}`); }
      if (!Number.isFinite(unit_price_minor) || unit_price_minor < 0) throw new BadRequestException(`Line ${n}: the rate cannot be negative.`);

      const discount_type = String(r?.discount_type ?? 'amount') as 'amount' | 'percent';
      if (!['amount', 'percent'].includes(discount_type)) throw new BadRequestException(`Line ${n}: a discount is an amount or a percent.`);

      let discount_value: number;
      try {
        // 'amount' means RUPEES on the wire and PAISE in the column; 'percent' is a
        // percentage on both. One column, two meanings — disambiguated here, once.
        discount_value = discount_type === 'percent'
          ? Number(String(r?.discount_value ?? 0).trim() || 0)
          : rupeesToMinor(r?.discount_value);
      } catch (e) { throw new BadRequestException(`Line ${n}: ${(e as Error).message}`); }
      if (!Number.isFinite(discount_value) || discount_value < 0) throw new BadRequestException(`Line ${n}: a discount cannot be negative.`);
      if (discount_type === 'percent' && discount_value > 100) throw new BadRequestException(`Line ${n}: a percentage discount cannot exceed 100%.`);

      const tax_pct = Number(String(r?.tax_pct ?? 0).trim() || 0);
      if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) throw new BadRequestException(`Line ${n}: tax must be between 0 and 100%.`);

      const computed = computeLine({ qty, unit_price_minor, discount_type, discount_value, tax_pct });
      return {
        course_id: r?.course_id ? Number(r.course_id) : null,
        description: description.slice(0, 240),
        qty, unit_price_minor, discount_type, discount_value, tax_pct, computed,
      };
    });
  }

  /* ------------------------------------------------------------------ reads */

  async list(scope: ResolvedScope, f: { status?: string; lead_id?: number; q?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`q.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, QUOTATION_SCOPE_COLS, params)];
    if (f.status) { params.push(f.status); where.push(`q.status = $${params.length}`); }
    if (f.lead_id) { params.push(Number(f.lead_id)); where.push(`q.lead_id = $${params.length}::bigint`); }
    else where.push(`q.is_current`);     // the list shows the CURRENT revision; a lead's own sheet shows the history
    if (f.q) { params.push(`%${f.q}%`); where.push(`(q.quote_no ILIKE $${params.length} OR l.full_name ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 200), 500));

    return this.db.query<any>(
      `SELECT q.id, q.quote_no, q.version, q.parent_id, q.is_current, q.status, q.valid_until,
              q.subtotal_minor, q.discount_minor, q.tax_minor, q.total_minor, q.currency,
              q.created_at, q.sent_at, q.decided_at, q.lead_id, q.payment_plan,
              l.full_name AS lead_name, l.phone AS lead_phone,
              b.name AS branch_name, v.name AS vertical_name, u.name AS owner_name,
              (SELECT string_agg(DISTINCT c.name, ', ')
                 FROM quotation_item qi LEFT JOIN m_course c ON c.id = qi.course_id
                WHERE qi.quotation_id = q.id) AS course_names,
              (SELECT count(*) FROM quotation_item qi WHERE qi.quotation_id = q.id) AS item_count
         FROM quotation q
         JOIN lead l ON l.id = q.lead_id
         JOIN branch b ON b.id = q.branch_id
         JOIN vertical v ON v.id = q.vertical_id
         LEFT JOIN "user" u ON u.id = q.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY q.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, QUOTATION_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE q.status = 'draft')    AS draft,
              count(*) FILTER (WHERE q.status = 'sent')     AS sent,
              count(*) FILTER (WHERE q.status = 'accepted') AS accepted,
              count(*) FILTER (WHERE q.status = 'rejected') AS rejected,
              count(*) FILTER (WHERE q.status = 'expired')  AS expired,
              COALESCE(sum(q.total_minor) FILTER (WHERE q.status = 'accepted'), 0) AS accepted_minor,
              COALESCE(sum(q.total_minor) FILTER (WHERE q.status = 'sent'), 0)     AS open_minor
         FROM quotation q
        WHERE q.deleted_at IS NULL AND q.is_current AND ${w}`,
      params,
    );
    const num = (v: unknown) => Number(v ?? 0);
    return {
      draft: num(r?.draft), sent: num(r?.sent), accepted: num(r?.accepted),
      rejected: num(r?.rejected), expired: num(r?.expired),
      accepted_minor: num(r?.accepted_minor), open_minor: num(r?.open_minor),
    };
  }

  /** One quotation + its lines + its letterhead context. Scope-checked. */
  async get(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, QUOTATION_SCOPE_COLS, params);
    const q = await this.db.one<any>(
      `SELECT q.*, l.full_name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
              l.whatsapp_phone AS lead_whatsapp,
              b.name AS branch_name, b.address AS branch_address, b.contact_number AS branch_phone,
              b.email AS branch_email,
              v.name AS vertical_name, ca.name AS campaign_name,
              u.name AS owner_name, o.name AS org_name, o.gst_no AS org_gst
         FROM quotation q
         JOIN lead l ON l.id = q.lead_id
         JOIN branch b ON b.id = q.branch_id
         JOIN vertical v ON v.id = q.vertical_id
         JOIN organisation o ON o.id = q.org_id
         LEFT JOIN campaign ca ON ca.id = q.campaign_id
         LEFT JOIN "user" u ON u.id = q.owner_id
        WHERE q.id = $1::bigint AND q.deleted_at IS NULL AND ${w}`,
      params,
    );
    if (!q) throw new NotFoundException('Quotation not found');
    const items = await this.db.query<any>(
      `SELECT qi.*, c.name AS course_name
         FROM quotation_item qi
         LEFT JOIN m_course c ON c.id = qi.course_id
        WHERE qi.quotation_id = $1::bigint
        ORDER BY qi.line_no`,
      [id],
    );
    const versions = await this.db.query<any>(
      `SELECT id, quote_no, version, status, total_minor, created_at, is_current
         FROM quotation
        WHERE deleted_at IS NULL
          AND (id = $1::bigint OR parent_id = $1::bigint
               OR id = (SELECT parent_id FROM quotation WHERE id = $1::bigint)
               OR parent_id = (SELECT parent_id FROM quotation WHERE id = $1::bigint))
        ORDER BY version`,
      [id],
    );
    return { ...q, items, versions };
  }

  letterheadOf(q: any): Letterhead {
    return {
      org_name: q.org_name, org_gst: q.org_gst,
      vertical_name: q.vertical_name, branch_name: q.branch_name,
      branch_address: q.branch_address, branch_phone: q.branch_phone, branch_email: q.branch_email,
    };
  }

  async pdf(id: number, scope: ResolvedScope): Promise<{ buffer: Buffer; filename: string }> {
    const q = await this.get(id, scope);
    const out = {
      buffer: quotationPdf(q as any, this.letterheadOf(q)),
      filename: `${String(q.quote_no).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`,
    };
    await this.pdfAssets?.persist('quotation', id, q.quote_no ? String(q.quote_no) : null, out.buffer);
    return out;
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * CREATE. The PATH IS DERIVED FROM THE LEAD, server-side — the client cannot post a
   * branch that contradicts the lead's own hierarchy (the QA-12 §11 rule that already
   * governs every lead-shaped record here).
   */
  async create(dto: any, me: { id: number }, scope: ResolvedScope) {
    const leadId = Number(dto?.lead_id);
    if (!leadId) throw new BadRequestException('Choose the lead this quotation is for.');
    const lead = await this.leadInScope(leadId, scope);
    const items = this.normaliseItems(dto?.items);
    await this.enforceDiscountCaps(Number(lead.vertical_id), me.id, items);
    const totals = computeTotals(items.map((i) => i.computed));
    const orgId = await this.orgId();
    const validUntil = this.validUntil(dto?.valid_until);

    return this.db.tx(async (c) => {
      const quoteNo = await this.numbering.allocate(
        'quotation', { branch_id: Number(lead.branch_id), vertical_id: Number(lead.vertical_id) }, c,
      );
      const q = await this.insertQuotation(c, {
        orgId, quoteNo, version: 1, parentId: null, lead, dto, totals, validUntil, actorId: me.id,
      });
      await this.insertItems(c, q.id, items);
      await this.activity(c, leadId, me.id, `Quotation ${quoteNo} created (draft)`);
      return { id: q.id, quote_no: quoteNo };
    });
  }

  /**
   * UPDATE — DRAFTS ONLY, on purpose. Once a quotation has been SENT it is a record of
   * what the customer was offered; changing it silently would destroy that record and
   * let a dispute be won by whoever edited last. Use `revise()`.
   */
  async update(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    if (cur.status !== 'draft') {
      throw new BadRequestException(
        `${cur.quote_no} has already been ${cur.status}. A sent quotation is a record of what the customer was offered — create a revision instead.`,
      );
    }
    const items = this.normaliseItems(dto?.items ?? cur.items.map((i: any) => ({
      course_id: i.course_id, description: i.description, qty: i.qty,
      unit_price_minor: i.unit_price_minor, discount_type: i.discount_type,
      discount_value: i.discount_type === 'percent' ? Number(i.discount_value) : Number(i.discount_minor),
      tax_pct: Number(i.tax_pct),
    })));
    await this.enforceDiscountCaps(Number(cur.vertical_id), me.id, items);
    const totals = computeTotals(items.map((i) => i.computed));
    const validUntil = this.validUntil(dto?.valid_until ?? cur.valid_until);

    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE quotation
            SET valid_until = $2::date, notes = $3, terms = $4,
                subtotal_minor = $5::bigint, discount_minor = $6::bigint,
                tax_minor = $7::bigint, total_minor = $8::bigint, updated_at = now()
          WHERE id = $1::bigint`,
        [id, validUntil, dto?.notes ?? cur.notes, dto?.terms ?? cur.terms,
          totals.subtotal_minor, totals.discount_minor, totals.tax_minor, totals.total_minor],
      );
      await c.query(`DELETE FROM quotation_item WHERE quotation_id = $1::bigint`, [id]);
      await this.insertItems(c, id, items);
    });
    return { id, ok: true };
  }

  /**
   * REVISE — a new VERSION. The old row survives verbatim and stops being current.
   * The revision inherits the parent's lead and path (never re-derived from a client
   * payload) and starts as a draft, because a revision nobody has sent is not an offer.
   */
  async revise(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const cur = await this.get(id, scope);
    // revisions always chain to the ROOT, so `version` is a count and not a tree depth
    const rootId = Number(cur.parent_id ?? cur.id);
    const items = this.normaliseItems(dto?.items ?? cur.items.map((i: any) => ({
      course_id: i.course_id, description: i.description, qty: i.qty,
      unit_price_minor: i.unit_price_minor, discount_type: i.discount_type,
      discount_value: i.discount_type === 'percent' ? Number(i.discount_value) : Number(i.discount_minor),
      tax_pct: Number(i.tax_pct),
    })));
    await this.enforceDiscountCaps(Number(cur.vertical_id), me.id, items);
    const totals = computeTotals(items.map((i) => i.computed));
    const orgId = await this.orgId();
    const validUntil = this.validUntil(dto?.valid_until ?? cur.valid_until);

    return this.db.tx(async (c) => {
      const maxV = await c.query<{ v: number }>(
        `SELECT COALESCE(max(version), 1) AS v FROM quotation
          WHERE deleted_at IS NULL AND (id = $1::bigint OR parent_id = $1::bigint)`,
        [rootId],
      );
      const version = Number(maxV.rows[0]?.v ?? 1) + 1;
      const quoteNo = `${String(cur.quote_no).replace(/-R\d+$/, '')}-R${version}`;
      await c.query(`UPDATE quotation SET is_current = FALSE WHERE id = $1::bigint OR parent_id = $1::bigint`, [rootId]);
      const q = await this.insertQuotation(c, {
        orgId, quoteNo, version, parentId: rootId,
        lead: {
          id: cur.lead_id, branch_id: cur.branch_id, vertical_id: cur.vertical_id,
          pipeline_id: cur.pipeline_id, campaign_id: cur.campaign_id,
          owner_id: cur.owner_id, team_id: cur.team_id,
        },
        dto: { ...dto, notes: dto?.notes ?? cur.notes, terms: dto?.terms ?? cur.terms },
        totals, validUntil, actorId: me.id,
      });
      await this.insertItems(c, q.id, items);
      await this.activity(c, Number(cur.lead_id), me.id, `Quotation revised → ${quoteNo} (v${version})`);
      return { id: q.id, quote_no: quoteNo, version };
    });
  }

  /**
   * SEND via the Sprint-4 channels. A quotation is not a new pipeline — it is a message
   * built by the SAME TemplateService and despatched by the SAME MessagingService, so it
   * inherits opt-out, the per-vertical SMTP, the rate limits, the send log and the retry
   * button for free. When the channel is not configured, `sendNow` fails the message with
   * the provider's own reason and we hand that back verbatim — no invented error, no
   * Error-Log noise, and the quotation still moves to `sent` ONLY if it actually left.
   */
  async send(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const q = await this.get(id, scope);
    if (!['draft', 'sent'].includes(q.status)) {
      throw new BadRequestException(`${q.quote_no} has already been ${q.status} — a decided quotation is not re-sent. Create a revision.`);
    }
    if (!this.templates || !this.messaging) throw new BadRequestException('Messaging is not available on this build.');

    const channel = String(dto?.channel ?? 'email');
    if (!['email', 'whatsapp', 'sms'].includes(channel)) throw new BadRequestException('Send by email, WhatsApp or SMS.');

    const built = await this.templates.build({
      channel,
      lead_id: Number(q.lead_id),
      template_id: dto?.template_id ? Number(dto.template_id) : undefined,
      subject: dto?.subject ?? `Your fee quotation ${q.quote_no}`,
      body: dto?.body ?? this.defaultBody(q),
    });
    const res = await this.messaging.sendNow({ ...built, actor_id: me.id, guarded: false });

    const delivered = res.status === 'sent' || res.status === 'queued';
    if (delivered) {
      await this.db.tx(async (c) => {
        await c.query(
          `UPDATE quotation SET status = 'sent', sent_at = COALESCE(sent_at, now()), updated_at = now()
            WHERE id = $1::bigint AND status = 'draft'`,
          [id],
        );
        await this.activity(c, Number(q.lead_id), me.id, `Quotation ${q.quote_no} sent by ${channel}`);
      });
    }
    // `sent: false` + the provider's own words. The UI shows exactly this — the client
    // must never be told "sent" when a credential is missing.
    return { sent: delivered, status: res.status, message_id: res.id, reason: res.reason ?? null, channel };
  }

  private defaultBody(q: any): string {
    return `Hi {{lead.name}},\n\nThank you for your interest in {{vertical}}. Your fee quotation ${q.quote_no} is ready.\n\n`
      + `Total: {{quote_total}}\n${q.valid_until ? `Valid until: ${new Date(q.valid_until).toLocaleDateString('en-IN')}\n` : ''}`
      + `\nDo let me know if you have any questions.\n\n{{counsellor}}\n{{branch}} · {{org}}`;
  }

  /**
   * MARK AS SENT — "I gave it to him."
   *
   * THE LIVE SMOKE FOUND THE HOLE THIS FILLS. `send()` is the only other way out of
   * `draft`, and it only succeeds when a channel is configured. So on a system with no
   * SMTP and no WhatsApp — which is this client's system TODAY — a quotation could never
   * leave draft, could never be accepted, and could never become an enrolment. The whole
   * conversion flow was credential-blocked, which flatly contradicts the project's own
   * rule that everything is credential-blocked but nothing is BUILD-blocked.
   *
   * It is also just true to life: a counsellor prints the PDF and hands it across the
   * desk, or sends it from his own phone. That is a real "sent", and the CRM must be able
   * to record it rather than pretend it did not happen.
   *
   * It is deliberately a SEPARATE action from `send()`, and it records HOW it went out,
   * so the send log and the quotation never disagree about whether WE despatched it.
   */
  async markSent(id: number, dto: any, me: { id: number }, scope: ResolvedScope) {
    const q = await this.get(id, scope);
    if (q.status !== 'draft') {
      throw new BadRequestException(`${q.quote_no} is already ${q.status}.`);
    }
    const how = String(dto?.how ?? 'handed_over');
    const HOW: Record<string, string> = {
      handed_over: 'handed to the customer in person',
      emailed: 'emailed outside the CRM',
      whatsapp: 'sent on WhatsApp outside the CRM',
      other: 'sent outside the CRM',
    };
    if (!HOW[how]) throw new BadRequestException('Say how it went out: handed_over, emailed, whatsapp or other.');
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE quotation SET status = 'sent', sent_at = COALESCE(sent_at, now()), updated_at = now()
          WHERE id = $1::bigint AND status = 'draft'`,
        [id],
      );
      await this.activity(c, Number(q.lead_id), me.id, `Quotation ${q.quote_no} ${HOW[how]}`);
    });
    return { id, status: 'sent', how };
  }

  /** ACCEPT / REJECT / EXPIRE — the only status writes, and they obey QUOTE_TRANSITIONS. */
  async decide(id: number, to: QuoteStatus, dto: any, me: { id: number }, scope: ResolvedScope) {
    const q = await this.get(id, scope);
    const allowed = QUOTE_TRANSITIONS[q.status as QuoteStatus] ?? [];
    if (!allowed.includes(to)) {
      // "A accepted quotation" is what the client reads on his own screen. An/a matters.
      const article = /^[aeiou]/i.test(String(q.status)) ? 'An' : 'A';
      throw new BadRequestException(
        `${article} ${q.status} quotation cannot be marked ${to}.` +
        (allowed.length ? ` From ${q.status} it can only become: ${allowed.join(', ')}.` : ' It is already decided — create a revision instead.'),
      );
    }
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE quotation SET status = $2::varchar, decided_at = now(), decided_by = $3::bigint,
                              decision_note = $4, updated_at = now()
          WHERE id = $1::bigint`,
        [id, to, me.id, dto?.note ?? null],
      );
      await this.activity(c, Number(q.lead_id), me.id, `Quotation ${q.quote_no} ${to}`);
    });
    return { id, status: to };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    const q = await this.get(id, scope);
    await this.db.query(
      `UPDATE quotation SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`,
      [id, me.id],
    );
    return { id, ok: true };
  }

  /**
   * THE EXPIRY SWEEP. A quotation with a validity date that has passed is expired,
   * whether or not anybody opened the screen. Set-based, idempotent, and it only ever
   * touches `sent` rows — an accepted quote does not expire.
   */
  async sweepExpired(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE quotation
          SET status = 'expired', decided_at = now(), updated_at = now()
        WHERE status = 'sent' AND deleted_at IS NULL
          AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE
        RETURNING id`,
    );
    if (rows.length) this.log.log(`expired ${rows.length} quotation(s) past their validity date`);
    return rows.length;
  }

  /* ------------------------------------------------------ the Phase-3 seam */

  /**
   * CONVERT — THE SEAM, and the honest version of "convert to invoice".
   *
   * §5 puts GST invoicing in PHASE 3. So an accepted quotation does not become an
   * invoice here: it becomes the ENROLMENT — the lite artefact that actually carries
   * the money, against which Phase 1 collects fees and against which PHASE 3 will raise
   * the tax invoice (`enrolment.quotation_id` is already the link, and the `invoice`
   * numbering series already exists).
   *
   * This returns the PREFILL, it does not create anything: closure captures more than a
   * quotation knows (payment plan, start date, batch) and the counsellor must confirm it.
   * EnrolmentService.create() is what commits.
   */
  async convertPreview(id: number, scope: ResolvedScope) {
    const q = await this.get(id, scope);
    if (q.status !== 'accepted') {
      throw new BadRequestException(`Only an accepted quotation converts to an enrolment. ${q.quote_no} is ${q.status}.`);
    }
    const courseItem = q.items.find((i: any) => i.course_id) ?? q.items[0];
    return {
      quotation_id: Number(q.id),
      quote_no: q.quote_no,
      lead_id: Number(q.lead_id),
      lead_name: q.lead_name,
      branch_id: Number(q.branch_id),
      vertical_id: Number(q.vertical_id),
      course_id: courseItem?.course_id ? Number(courseItem.course_id) : null,
      course_name: courseItem?.course_name ?? null,
      // the enrolment's fee is the quotation's GROSS; its discount is the quotation's
      // discount. Tax is NOT carried: a tax invoice is Phase 3, and an enrolment that
      // pretended to know its GST would be a lie the client's accountant would find.
      fee_minor: Number(q.subtotal_minor),
      discount_minor: Number(q.discount_minor),
      net_fee_minor: Number(q.subtotal_minor) - Number(q.discount_minor),
      counsellor_id: q.owner_id ? Number(q.owner_id) : null,
      invoice: {
        available: false,
        phase: 3,
        note: 'A GST tax invoice (HSN/SAC, CGST/SGST/IGST, place of supply, e-invoice) is Phase 3. '
          + 'The enrolment created here is what Phase 3 raises that invoice from.',
      },
    };
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * DEF-S16-02. This used to be `String(v).slice(0, 10)`, and `update()`/`revise()` both
   * call it as `validUntil(dto?.valid_until ?? cur.valid_until)`. `cur.valid_until` is a
   * `date` column read back through `get()`, so node-postgres hands over a **Date** and
   * `String(aDate).slice(0, 10)` is `"Mon Aug 31"` — the regex refused it and the
   * fallback returned 400. The `??` safety net could never once execute.
   *
   * The parsing now lives in `common/date.util.ts` for the whole codebase; only the
   * client's sentence stays here.
   */
  private validUntil(v: unknown): string | null {
    return requireDateString(v, () => {
      throw new BadRequestException('The validity date must be a date.');
    });
  }

  /**
   * The lead must be inside the CALLER'S scope — checked with the LEAD's own columns
   * (the same `buildScopeWhere` the lead list uses), so a counsellor quoting somebody
   * else's lead gets a 404 rather than a quotation.
   */
  private async leadInScope(leadId: number, scope: ResolvedScope) {
    const params: unknown[] = [leadId];
    const lw = this.resolver.buildScopeWhere(scope, {
      owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
      vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
    }, params);
    const lead = await this.db.one<any>(
      `SELECT l.id, l.branch_id, l.vertical_id, l.pipeline_id, l.campaign_id, l.owner_id, l.team_id, l.full_name
         FROM lead l
        WHERE l.id = $1::bigint AND l.deleted_at IS NULL AND ${lw}`,
      params,
    );
    if (!lead) throw new NotFoundException('Lead not found (or outside your access)');
    return lead;
  }

  private async insertQuotation(c: PoolClient, a: {
    orgId: number; quoteNo: string; version: number; parentId: number | null;
    lead: any; dto: any; totals: any; validUntil: string | null; actorId: number;
  }) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO quotation (org_id, quote_no, version, parent_id, is_current, lead_id,
                              branch_id, vertical_id, pipeline_id, campaign_id, owner_id, team_id,
                              status, valid_until, currency, subtotal_minor, discount_minor,
                              tax_minor, total_minor, notes, terms, payment_plan, created_by)
       VALUES ($1::bigint, $2::varchar, $3::int, $4::bigint, TRUE, $5::bigint,
               $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint,
               'draft', $12::date, 'INR', $13::bigint, $14::bigint, $15::bigint, $16::bigint,
               $17, $18, $19, $20::bigint)
       RETURNING id`,
      [a.orgId, a.quoteNo, a.version, a.parentId, a.lead.id,
        a.lead.branch_id, a.lead.vertical_id, a.lead.pipeline_id ?? null, a.lead.campaign_id ?? null,
        a.lead.owner_id ?? a.actorId, a.lead.team_id ?? null,
        a.validUntil, a.totals.subtotal_minor, a.totals.discount_minor,
        a.totals.tax_minor, a.totals.total_minor,
        a.dto?.notes ?? null, a.dto?.terms ?? null, a.dto?.payment_plan ?? null, a.actorId],
    );
    return { id: Number(r.rows[0].id) };
  }

  private async insertItems(c: PoolClient, quotationId: number, items: ReturnType<QuotationService['normaliseItems']>) {
    let n = 0;
    for (const i of items) {
      n += 1;
      await c.query(
        `INSERT INTO quotation_item (quotation_id, line_no, course_id, description, qty,
                                     unit_price_minor, discount_type, discount_value, tax_pct,
                                     gross_minor, discount_minor, taxable_minor, tax_minor, total_minor)
         VALUES ($1::bigint, $2::int, $3::bigint, $4::varchar, $5::int, $6::bigint, $7::varchar,
                 $8::numeric, $9::numeric, $10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::bigint)`,
        [quotationId, n, i.course_id, i.description, i.qty, i.unit_price_minor,
          i.discount_type, i.discount_value, i.tax_pct,
          i.computed.gross_minor, i.computed.discount_minor, i.computed.taxable_minor,
          i.computed.tax_minor, i.computed.total_minor],
      );
    }
  }

  /**
   * The lead's own timeline — the Sprint-2 activity table, not a second history.
   *
   * `org_id` and `branch_id` are NOT NULL on lead_activity (005_lead.sql) and are
   * carried for scope/partitioning, so they are SELECTed from the lead rather than
   * passed in: a caller that forgot one would be a 500 that only real Postgres finds
   * (the DEF-S4-01 class of bug). quotation-sql-schema.spec.ts pins this query.
   */
  private async activity(c: PoolClient, leadId: number, actorId: number, note: string) {
    await c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, type, note, actor_id)
       SELECT l.id, l.org_id, l.branch_id, 'note', $2, $3::bigint
         FROM lead l WHERE l.id = $1::bigint`,
      [leadId, note, actorId],
    );
  }
}
