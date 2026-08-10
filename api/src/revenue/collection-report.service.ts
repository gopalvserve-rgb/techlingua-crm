import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { assertDateRange } from '../common/date.util';
import { minorToRupeeString } from '../common/money.util';
import { buildXlsx, SheetColumn } from '../reports/xlsx.util';
import { reportPdf } from '../reports/report-pdf';
import { RevenueService, COLLECTION_DIMENSIONS, Dimension } from './revenue.service';

const RECEIPT_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'fr.branch_id',
  vertical: 'fr.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};
const REFUND_COLS: ScopeColumnMap = {
  owner: 'e.counsellor_id', team: 'e.team_id', branch: 'rf.branch_id',
  vertical: 'rf.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
};

const DIM_LABEL: Record<Dimension, string> = {
  day: 'Date', month: 'Month', branch: 'Branch', vertical: 'Vertical',
  course: 'Course', counsellor: 'Counsellor', mode: 'Payment mode',
};

/**
 * COLLECTION REPORTS + TALLY EXPORT (Phase 3 Batch 4). The collection reports are the
 * collection view grouped by each dimension (daily / monthly / branch / vertical / course /
 * counsellor / payment mode) with totals, exportable to Excel (real .xlsx), CSV and PDF -
 * VALUES, never ids. The Tally export writes the period's collections (Receipt vouchers) and
 * refunds (Payment vouchers) as a Tally-importable XML file that "Gateway of Tally > Import
 * Data > Vouchers" reads. LEDGER MAPPING (docs/dev/52): the deposit ledger is chosen by mode
 * - Cash -> "Cash", every other mode -> "Bank" - and the contra ledger is "Fees Received" for
 * a collection / "Fees Refund" for a refund. Amounts in rupees; a debit is a NEGATIVE amount
 * with ISDEEMEDPOSITIVE=Yes and a credit a POSITIVE amount with ISDEEMEDPOSITIVE=No.
 */
@Injectable()
export class CollectionReportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly revenue: RevenueService,
  ) {}

  private async orgName(): Promise<string> {
    const r = await this.db.one<{ name: string }>(`SELECT name FROM organisation ORDER BY id LIMIT 1`);
    return r?.name ?? 'Organisation';
  }

  async report(scope: ResolvedScope, opts: { dimension?: string; from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[] }) {
    const dim = (opts.dimension ?? 'day') as Dimension;
    if (!(COLLECTION_DIMENSIONS as readonly string[]).includes(dim)) throw new BadRequestException(`Unknown report dimension "${dim}"`);
    const data = await this.revenue.collection(scope, { ...opts, group_by: dim });
    return { dimension: dim, dimension_label: DIM_LABEL[dim], ...data };
  }

  private async exportRows(scope: ResolvedScope, opts: { dimension?: string; from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[] }) {
    const rep = await this.report(scope, opts);
    const dimLabel = rep.dimension_label;
    const columns: Array<{ key: string; label: string; type: 'text' | 'money' | 'number' }> = [
      { key: 'label', label: dimLabel, type: 'text' },
      { key: 'gross_minor', label: 'Gross collected', type: 'money' },
      { key: 'refunds_minor', label: 'Refunds', type: 'money' },
      { key: 'net_minor', label: 'Net collected', type: 'money' },
      { key: 'receipts_n', label: 'Receipts', type: 'number' },
    ];
    const rows: unknown[][] = (rep.rows as any[]).map((r) => [r.label, r.gross_minor, r.refunds_minor, r.net_minor, r.receipts_n]);
    const t = rep.totals as any;
    rows.push(['TOTAL', t.gross_minor, t.refunds_minor, t.net_minor, t.receipts_n]);
    return { rep, columns, rows, dimLabel };
  }

  async export(scope: ResolvedScope, format: string, opts: { dimension?: string; from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[] }): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const { rep, columns, rows, dimLabel } = await this.exportRows(scope, opts);
    const org = await this.orgName();
    const range = `${rep.range.from ?? 'start'} to ${rep.range.to ?? 'today'}`;
    const base = `collection-by-${rep.dimension}`;
    if (format === 'xlsx') {
      const cols: SheetColumn[] = columns.map((c) => ({ label: c.label, type: c.type }));
      const buffer = buildXlsx({
        name: `Collection by ${dimLabel}`.slice(0, 28), columns: cols, rows,
        preamble: [`Collection report - by ${dimLabel}`, `${org}`, `Period: ${range}`, `Amounts in Indian Rupees (paise-accurate)`],
      });
      return { buffer, filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    if (format === 'csv') {
      const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const head = columns.map((c) => c.label);
      const body = rows.map((r) => r.map((v, i) => columns[i].type === 'money' ? minorToRupeeString(Number(v ?? 0)) : String(v ?? '')));
      const csv = [head, ...body].map((r) => r.map(esc).join(',')).join('\r\n');
      return { buffer: Buffer.from(csv, 'utf8'), filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8' };
    }
    if (format === 'pdf') {
      const buffer = reportPdf({
        title: `Collection report - by ${dimLabel}`, subtitle: `Period: ${range}`,
        columns: columns.map((c) => ({ key: c.key, label: c.label, type: c.type })) as any, rows,
        footnotes: [`${org}`, `Generated ${new Date().toLocaleString('en-IN')}`, 'Net collected is gross receipts less approved refunds.'],
        org_name: org,
      });
      return { buffer, filename: `${base}.pdf`, contentType: 'application/pdf' };
    }
    throw new BadRequestException('Unknown export format - use xlsx, csv or pdf.');
  }

  private xesc(s: unknown): string {
    const CTRL = new RegExp('[\\u0000-\\u001F]', 'g');
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(CTRL, '');
  }
  private tallyDate(v: unknown): string {
    const d = v ? new Date(String(v)) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
  }
  private depositLedger(mode: string): string { return mode === 'cash' ? 'Cash' : 'Bank'; }

  private voucher(kind: 'Receipt' | 'Payment', v: { date: unknown; number: string; party: string; amountMinor: number; depositLedger: string; contraLedger: string; narration: string }): string {
    const amt = minorToRupeeString(v.amountMinor);
    const debitLedger = kind === 'Receipt' ? v.depositLedger : v.contraLedger;
    const creditLedger = kind === 'Receipt' ? v.contraLedger : v.depositLedger;
    return [
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
      `<VOUCHER VCHTYPE="${kind}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
      `<DATE>${this.tallyDate(v.date)}</DATE>`,
      `<EFFECTIVEDATE>${this.tallyDate(v.date)}</EFFECTIVEDATE>`,
      `<VOUCHERTYPENAME>${kind}</VOUCHERTYPENAME>`,
      `<VOUCHERNUMBER>${this.xesc(v.number)}</VOUCHERNUMBER>`,
      `<PARTYLEDGERNAME>${this.xesc(v.party)}</PARTYLEDGERNAME>`,
      `<NARRATION>${this.xesc(v.narration)}</NARRATION>`,
      '<ALLLEDGERENTRIES.LIST>',
      `<LEDGERNAME>${this.xesc(debitLedger)}</LEDGERNAME>`,
      '<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>',
      `<AMOUNT>-${amt}</AMOUNT>`,
      '</ALLLEDGERENTRIES.LIST>',
      '<ALLLEDGERENTRIES.LIST>',
      `<LEDGERNAME>${this.xesc(creditLedger)}</LEDGERNAME>`,
      '<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>',
      `<AMOUNT>${amt}</AMOUNT>`,
      '</ALLLEDGERENTRIES.LIST>',
      '</VOUCHER>',
      '</TALLYMESSAGE>',
    ].join('\n');
  }

  async tally(scope: ResolvedScope, opts: { from?: string; to?: string; branch_ids?: number[]; vertical_ids?: number[] }): Promise<{ xml: string; filename: string; receipts: number; refunds: number }> {
    const dr = assertDateRange(opts.from, opts.to);
    const org = await this.orgName();

    const narrow = (bCol: string, vCol: string, params: unknown[]): string => {
      const parts: string[] = [];
      const bv = [...new Set((opts.branch_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      const vv = [...new Set((opts.vertical_ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (bv.length) { params.push(bv); parts.push(`${bCol} = ANY($${params.length}::bigint[])`); }
      if (vv.length) { params.push(vv); parts.push(`${vCol} = ANY($${params.length}::bigint[])`); }
      return parts.length ? ' AND ' + parts.join(' AND ') : '';
    };

    const rp: unknown[] = [];
    const rw = this.resolver.buildScopeWhere(scope, RECEIPT_COLS, rp) + narrow('fr.branch_id', 'fr.vertical_id', rp);
    let rDate = '';
    if (dr.from) { rp.push(dr.from); rDate += ` AND fr.received_at >= $${rp.length}::date`; }
    if (dr.to) { rp.push(dr.to); rDate += ` AND fr.received_at < ($${rp.length}::date + 1)`; }
    const receipts = await this.db.query<any>(
      `SELECT fr.receipt_no, fr.amount_minor, fr.mode, fr.reference, fr.received_at,
              l.full_name AS party, e.enrolment_no
         FROM fee_receipt fr JOIN enrolment e ON e.id = fr.enrolment_id JOIN lead l ON l.id = e.lead_id
        WHERE fr.deleted_at IS NULL AND ${rw}${rDate}
        ORDER BY fr.received_at`, rp);

    const fp: unknown[] = [];
    const fw = this.resolver.buildScopeWhere(scope, REFUND_COLS, fp) + narrow('rf.branch_id', 'rf.vertical_id', fp);
    let fDate = '';
    if (dr.from) { fp.push(dr.from); fDate += ` AND rf.refunded_at >= $${fp.length}::date`; }
    if (dr.to) { fp.push(dr.to); fDate += ` AND rf.refunded_at < ($${fp.length}::date + 1)`; }
    const refunds = await this.db.query<any>(
      `SELECT rf.refund_no, rf.amount_minor, rf.mode, rf.reference, rf.refunded_at,
              l.full_name AS party, e.enrolment_no
         FROM refund rf JOIN enrolment e ON e.id = rf.enrolment_id JOIN lead l ON l.id = e.lead_id
        WHERE rf.deleted_at IS NULL AND rf.status = 'approved' AND ${fw}${fDate}
        ORDER BY rf.refunded_at`, fp);

    const messages: string[] = [];
    for (const r of receipts) {
      messages.push(this.voucher('Receipt', {
        date: r.received_at, number: r.receipt_no, party: r.party, amountMinor: Number(r.amount_minor),
        depositLedger: this.depositLedger(r.mode), contraLedger: 'Fees Received',
        narration: `Fee ${r.enrolment_no} via ${r.mode}${r.reference ? ` ref ${r.reference}` : ''}`,
      }));
    }
    for (const r of refunds) {
      messages.push(this.voucher('Payment', {
        date: r.refunded_at, number: r.refund_no, party: r.party, amountMinor: Number(r.amount_minor),
        depositLedger: this.depositLedger(r.mode), contraLedger: 'Fees Refund',
        narration: `Refund ${r.enrolment_no} via ${r.mode}${r.reference ? ` ref ${r.reference}` : ''}`,
      }));
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ENVELOPE>',
      '<HEADER>',
      '<TALLYREQUEST>Import Data</TALLYREQUEST>',
      '</HEADER>',
      '<BODY>',
      '<IMPORTDATA>',
      '<REQUESTDESC>',
      '<REPORTNAME>Vouchers</REPORTNAME>',
      '<STATICVARIABLES>',
      `<SVCURRENTCOMPANY>${this.xesc(org)}</SVCURRENTCOMPANY>`,
      '</STATICVARIABLES>',
      '</REQUESTDESC>',
      '<REQUESTDATA>',
      messages.join('\n'),
      '</REQUESTDATA>',
      '</IMPORTDATA>',
      '</BODY>',
      '</ENVELOPE>',
    ].join('\n');
    return { xml, filename: `tally-collections-${dr.from ?? 'start'}-to-${dr.to ?? 'today'}.xml`, receipts: receipts.length, refunds: refunds.length };
  }
}
