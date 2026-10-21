/**
 * ENROLMENT FEES — the one enrolment list shape + fee actions shared by Sale Closure, Direct
 * Enrolments, Master Directory, the student profile's Course Enrollment and Fee Management
 * (client feedback 3 & 4 Sep 2026).
 *
 *  · FeeCards            — Amount Collected / Outstanding / Overdue / Due Today / Collection Rate /
 *                          Avg discount, for the SELECTED date range (not always month-to-date).
 *  · enrolmentColumns /
 *    enrolmentCells      — the same columns everywhere: Enrolment ID, Student (+ Student ID),
 *                          Course, Level(s), Batch, Gross, Discount (₹ / %), Net, Paid, Balance,
 *                          Next due, Payment status (coloured), Enrolment status, Actions.
 *  · EnrolmentActions    — primary "Collect Payment" (or "View Details" once paid) + the ⋮ menu:
 *                          View Enrolment, Details, Fee Ledger, Installments, Create / View /
 *                          Download Invoice, Generate Receipt, Send Reminder, Audit History.
 *  · FeeLedgerModal      — every receipt (reversed ones struck through), REVERSE PAYMENT with a
 *                          reason (request → finance approval), and Re-setup plan.
 *  · PlanResetupModal    — keep what is paid, re-schedule only the balance (new plan version).
 *  · AuditHistoryModal   — the payment-terms history (every plan version) + the level history.
 *
 * A posted payment is never edited or deleted from here — only reversed, with a reason.
 */
import { ReactNode, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch } from './refdata';
import { DetailModal, RowMenu, RowMenuItem } from './rowactions';
import { fmtINR } from './money';
import { fmtDateTimeIST } from './daterange';
import { CollectModal } from './sprint5';
import { FeeConfigFields, ViewEnrolmentModal, feePlanBody, useFeeConfig } from './dyn';
import { PlanDetailModal } from './paymentplans';

const dmy = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', bank_transfer: 'Bank transfer', neft: 'NEFT', online: 'Online' };

export async function openPdf(path: string, print = false) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Could not open the PDF (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    const w = window.open(url, '_blank', 'noopener');
    if (print && w) { try { w.addEventListener('load', () => { try { w.print(); } catch { /* blocked */ } }); } catch { /* noop */ } }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e: any) { toast(e.message, true); }
}

/* ------------------------------------------------------------ payment status */

/** Paid green · Partial blue · Due Soon orange · Overdue red · Unpaid grey (client 4 Sep). */
export const PAYMENT_STATUS_BADGE: Record<string, string> = {
  Paid: 'b-green', Partial: 'b-blue', Unpaid: 'b-gray', Overdue: 'b-red', 'Due Soon': 'b-orange',
};
/** Payment plan in words — "3 Installments", never "3 EMI" (an EMI suggests a loan with interest). */
export const PLAN_WORDS: Record<string, string> = { full: 'Full payment', emi_3: '3 Installments', emi_6: '6 Installments', custom: 'Custom' };
export const PAYMENT_STATUSES = ['Paid', 'Partial', 'Unpaid', 'Overdue', 'Due Soon'];
const ENR_STATUS_BADGE: Record<string, string> = {
  active: 'b-green', pending_approval: 'b-amber', cancelled: 'b-gray', rejected: 'b-rose', completed: 'b-indigo',
};
export const enrolmentStatusCell = (st?: string): Cell => {
  const s = String(st ?? '');
  const label = s === 'pending_approval' ? 'Pending approval' : s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—';
  return { b: [label, ENR_STATUS_BADGE[s] ?? 'b-gray'] };
};
export const paymentStatusCell = (ps?: string): Cell => ({ b: [ps || '—', PAYMENT_STATUS_BADGE[String(ps)] ?? 'b-gray'] });

/* ------------------------------------------------------------------ fee cards */

export function FeeCards({ range, origin, tick, onPending }: {
  range: { from?: string; to?: string }; origin?: string; tick?: number;
  /** show the Pending approval card, clickable (Sale Closure → the approval queue) */
  onPending?: () => void;
}) {
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  if (origin) p.set('origin', origin);
  const { data: s } = useFetch<any>(`/enrolments/fee-cards?${p.toString()}`, [p.toString(), tick ?? 0]);
  const period = range.from || range.to ? `${range.from ? dmy(range.from) : '…'} – ${range.to ? dmy(range.to) : 'today'}` : 'this month';
  return (
    <div data-testid="fee-cards">
      <Kpis items={[
        { lab: `Enrolments (${period})`, val: s ? String(s.enrolments_in_range) : '—', ic: 'check' },
        { lab: `Fees Booked (${period})`, val: s ? fmtINR(s.fees_booked_minor) : '—', ic: 'rupee' },
        { lab: `Amount Collected (${period})`, val: s ? fmtINR(s.collected_minor) : '—', ic: 'rupee' },
        { lab: 'Outstanding Balance', val: s ? fmtINR(s.outstanding_minor) : '—', ic: 'clock' },
        { lab: 'Overdue Amount', val: s ? fmtINR(s.overdue_minor) : '—', ic: 'flag' },
        { lab: 'Payments Due Today', val: s ? fmtINR(s.due_today_minor) : '—', ic: 'bell' },
        { lab: 'Collection Rate', val: s ? `${s.collection_rate_pct}%` : '—', ic: 'perf' },
        { lab: 'Avg Discount', val: s ? `${fmtINR(s.avg_discount_minor)} · ${s.avg_discount_pct}%` : '—', ic: 'tag' },
        ...(onPending ? [{ lab: 'Pending approval', val: s ? String(s.pending_approval) : '—', ic: 'clock', onClick: onPending, navLabel: 'Open the approval queue' }] : []),
      ]} />
    </div>
  );
}

/* ---------------------------------------------------------- shared columns */

export interface EnrolmentColOpts { showOrigin?: boolean; showOwner?: boolean; showBranch?: boolean }

export function enrolmentColumns(o: EnrolmentColOpts = {}): string[] {
  return ['Enrolment ID', 'Student', 'Course', 'Level(s)', 'Batch',
    ...(o.showBranch ? ['Branch', 'Vertical'] : []),
    'Enrolment Date', 'Gross Fee', 'Discount', 'Net Fee', 'Paid', 'Balance', 'Next Due', 'Last Payment', 'Payment Plan',
    'Payment Status', 'Enrolment Status',
    ...(o.showOwner ? ['Counsellor'] : []),
    ...(o.showOrigin ? ['Origin'] : []),
    'Actions'];
}

export function discountLabel(e: any): ReactNode {
  const d = Number(e.discount_minor ?? e.discount_amount_minor ?? 0);
  if (d <= 0) return <span className="sub">—</span>;
  const pct = e.discount_type === 'percent' && e.discount_scope !== 'level' ? ` (${Number(e.discount_value)}%)` : '';
  return <span className="mono">− {fmtINR(d)}{pct}{e.discount_scope === 'level' ? <div className="sub">per level</div> : null}</span>;
}

export function enrolmentCells(e: any, o: EnrolmentColOpts & { actions: ReactNode }): Cell[] {
  const bal = Number(e.balance_minor ?? 0);
  return [
    { node: <b className="mono">{e.enrolment_no}</b>, sort: e.enrolment_no },
    { node: <div><b className="nm">{e.lead_name ?? e.student_name ?? '—'}</b><div className="sub mono">{e.student_id || e.lead_phone || ''}</div></div>, sort: String(e.lead_name ?? '').toLowerCase() },
    // S7 (client 4 Sep): the Course column shows the course only — no Branch › Vertical path.
    e.course_name ?? '—',
    { node: e.level_summary ? <span>{e.level_summary}</span> : <span className="sub">—</span>, sort: e.level_summary ?? '' },
    e.batch_name ?? '—',
    ...(o.showBranch ? [e.branch_name ?? '—', e.vertical_name ?? '—'] as Cell[] : []),
    { node: <span className="mono">{dmy(e.created_at)}</span>, sort: e.created_at ?? '' },
    { mono: fmtINR(Number(e.gross_fee_minor ?? e.fee_minor ?? 0)) },
    { node: discountLabel(e), sort: Number(e.discount_minor ?? 0) },
    { mono: fmtINR(Number(e.net_fee_minor ?? 0)) },
    { mono: fmtINR(Number(e.paid_minor ?? 0)) },
    { node: <b className="mono" style={{ color: bal > 0 ? 'var(--rose, #be123c)' : 'var(--green, #15803d)' }}>{fmtINR(bal)}</b>, sort: bal },
    { node: e.next_due_date
        ? <span><span className="mono">{dmy(e.next_due_date)}</span>{e.next_due_minor != null ? <div className="sub mono">{fmtINR(Number(e.next_due_minor))}</div> : null}</span>
        : <span className="sub">—</span>, sort: e.next_due_date ?? '' },
    { node: e.last_paid_at
        ? <span><span className="mono">{dmy(e.last_paid_at)}</span><div className="sub">{MODE[String(e.last_mode)] ?? e.last_mode ?? ''}</div></span>
        : <span className="sub">—</span>, sort: e.last_paid_at ?? '' },
    PLAN_WORDS[String(e.payment_plan)] ?? e.payment_plan ?? '—',
    paymentStatusCell(e.payment_status),
    enrolmentStatusCell(e.status),
    ...(o.showOwner ? [e.counsellor_name ?? '—'] as Cell[] : []),
    ...(o.showOrigin ? [{ b: e.from_admission ? ['Online application', 'b-indigo'] : ['Direct enrolment', 'b-gray'] } as Cell] : []),
    { node: o.actions },
  ];
}

export function enrolmentCsvRow(e: any) {
  return {
    enrolment_id: e.enrolment_no, student: e.lead_name, student_id: e.student_id || '', phone: e.lead_phone || '',
    course: e.course_name || '', levels: e.level_summary || '', batch: e.batch_name || '',
    branch: e.branch_name, vertical: e.vertical_name,
    gross_fee: (Number(e.gross_fee_minor ?? e.fee_minor ?? 0) / 100).toFixed(2),
    discount: (Number(e.discount_minor ?? 0) / 100).toFixed(2),
    discount_type: e.discount_scope === 'level' ? 'per level' : e.discount_type === 'percent' ? `${e.discount_value}%` : e.discount_type || '',
    net_fee: (Number(e.net_fee_minor ?? 0) / 100).toFixed(2),
    paid: (Number(e.paid_minor ?? 0) / 100).toFixed(2), balance: (Number(e.balance_minor ?? 0) / 100).toFixed(2),
    next_due: e.next_due_date ? dmy(e.next_due_date) : '', payment_plan: PLAN_WORDS[String(e.payment_plan)] ?? e.payment_plan ?? '',
    payment_status: e.payment_status || '',
    enrolment_status: e.status, counsellor: e.counsellor_name || '', enrolled_on: dmy(e.created_at),
  };
}

/* --------------------------------------------------------------- row actions */

type Open = null | 'view' | 'ledger' | 'installments' | 'collect' | 'audit';

/** The primary button + ⋮ menu for one enrolment row. Owns its modals. */
export function EnrolmentActions({ e, onChanged, onDetails, extra }: {
  e: any; onChanged: () => void;
  /** open the student's profile (Details); omitted where the row already IS the profile */
  onDetails?: () => void;
  extra?: Array<RowMenuItem | false>;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState<Open>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const eid = Number(e.id ?? e.enrolment_id);
  const paid = Number(e.balance_minor ?? 1) <= 0;
  const active = e.status === 'active';

  const installments = async () => {
    try {
      const plans = await api.get<any[]>(`/payment-plans?enrolment_id=${eid}`);
      const p = (plans ?? []).find((x) => x.status !== 'superseded') ?? (plans ?? [])[0];
      if (!p) { toast('No instalment plan on this enrolment yet — set one up from Fee Management (Fee setup).', true); return; }
      setPlanId(Number(p.id)); setOpen('installments');
    } catch (err) { toast((err as Error).message, true); }
  };
  const invoice = async (mode: 'create' | 'view' | 'download') => {
    try {
      if (mode === 'create') {
        const res = await api.post<any>('/invoices/generate', { enrolment_id: eid });
        toast(res?.existing ? `Invoice ${res.invoice_no ?? ''} already exists.` : res?.issued ? `Invoice ${res.invoice_no} created.` : 'Draft invoice created — set the vertical GSTIN to issue it.');
        onChanged(); return;
      }
      const invs = await api.get<any[]>(`/invoices?enrolment_id=${eid}`);
      const inv = (invs ?? []).find((i) => i.status !== 'cancelled');
      if (!inv) { toast('No invoice yet — use Create Invoice first.', true); return; }
      void openPdf(`/invoices/${inv.id}/pdf`, mode === 'download');
    } catch (err) { toast((err as Error).message, true); }
  };
  const receipt = async () => {
    try {
      const recs = await api.get<any[]>(`/fees/receipts?enrolment_id=${eid}`);
      const rec = (recs ?? [])[0];
      if (!rec) { toast('No payment received yet — collect a payment first.', true); return; }
      void openPdf(`/fees/receipts/${rec.id}/pdf`);
    } catch (err) { toast((err as Error).message, true); }
  };
  const remind = async () => {
    try {
      const res = await api.post<any>('/fee-dues/remind', { enrolment_id: eid });
      if (res?.already) toast('A reminder was already sent to this student today.');
      else if (res?.skipped === 'no_outstanding') toast('Nothing outstanding — no reminder sent.');
      else if (res?.sent) toast(`Reminder sent on ${(res.channels ?? []).join(', ').toUpperCase()}.`);
      else toast('Reminder recorded — no reachable channel is configured yet.');
    } catch (err) { toast((err as Error).message, true); }
  };

  const items: Array<RowMenuItem | false> = [
    { label: 'View Enrolment', icon: 'eye', onClick: () => setOpen('view') },
    !!onDetails && { label: 'Details (student profile)', icon: 'user', onClick: () => onDetails!() },
    { label: 'Fee Ledger', icon: 'rupee', onClick: () => setOpen('ledger') },
    { label: 'Installments', icon: 'list', onClick: () => void installments() },
    'divider',
    can('invoice.create') && { label: 'Create Invoice', icon: 'plus', onClick: () => void invoice('create') },
    can('invoice.read') && { label: 'View Invoice', icon: 'doc', onClick: () => void invoice('view') },
    can('invoice.read') && { label: 'Download Invoice', icon: 'download', onClick: () => void invoice('download') },
    { label: 'Generate Receipt', icon: 'print', onClick: () => void receipt() },
    'divider',
    active && !paid && { label: 'Send Reminder', icon: 'bell', onClick: () => void remind() },
    { label: 'Audit History', icon: 'clock', onClick: () => setOpen('audit') },
    ...(extra ?? []),
  ];

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={(ev) => ev.stopPropagation()}>
      {!paid && active && can('fee.collect')
        ? <button className="btn sm primary" onClick={() => setOpen('collect')} data-testid={`enr-collect-${eid}`}><Ic k="rupee" />Collect Payment</button>
        : <button className="btn sm" onClick={() => setOpen('view')} data-testid={`enr-details-${eid}`}><Ic k="eye" />View Details</button>}
      <RowMenu label="Enrolment actions" items={items} />
      {open === 'view' && <ViewEnrolmentModal enrolment={e} studentId={e.student_profile_id ?? undefined} onClose={() => setOpen(null)} />}
      {open === 'collect' && <CollectModal enrolmentId={eid} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged(); }} />}
      {open === 'ledger' && <FeeLedgerModal enrolment={e} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {open === 'installments' && planId != null && <PlanDetailModal id={planId} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {open === 'audit' && <AuditHistoryModal enrolment={e} onClose={() => setOpen(null)} />}
    </span>
  );
}

/* --------------------------------------------------------- reverse payment */

/** Reverse a posted payment — reason required. A finance approver (fee.reverse) reverses at once;
 *  anyone else's reversal is a REQUEST that waits for approval (the payment still counts till then). */
export function ReversePaymentModal({ receipt, onClose, onDone }: { receipt: any; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const approver = can('fee.reverse');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!reason.trim()) { toast('Give a reason for the reversal.', true); return; }
    setBusy(true);
    try {
      const r = await api.post<any>(`/fees/receipts/${receipt.id}/reverse`, { reason: reason.trim() });
      toast(r?.reversal_status === 'reversed' ? `Payment ${receipt.receipt_no} reversed.` : `Reversal of ${receipt.receipt_no} sent for approval.`);
      onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Reverse payment — ${receipt.receipt_no}`} icon="ban" onClose={onClose} width={480}
      footer={<button className="btn primary" disabled={busy} onClick={go} data-testid="reverse-submit"
        style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}><Ic k="ban" />{approver ? 'Reverse payment' : 'Request reversal'}</button>}>
      <div className="notice warn" style={{ marginBottom: 10 }}><Ic k="shield" /><div>
        A posted payment is never edited or deleted. Reversing keeps the receipt and its number on record,
        marks it <b>Reversed</b> with your reason, and returns {fmtINR(Number(receipt.amount_minor))} to the balance.
        {approver ? '' : ' Your request goes to a finance approver; the payment keeps counting until it is approved.'}
      </div></div>
      <div className="fld"><label htmlFor="rev-reason">Reason <span className="star">*</span></label>
        <textarea id="rev-reason" className="ainp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Entered against the wrong student / cheque bounced / duplicate entry" data-testid="reverse-reason" /></div>
    </DetailModal>
  );
}

/* ---------------------------------------------------------------- fee ledger */

export function FeeLedgerModal({ enrolment: e, onClose, onChanged }: { enrolment: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const eid = Number(e.id ?? e.enrolment_id);
  const [tick, setTick] = useState(0);
  const recs = useFetch<any[]>(`/fees/receipts?enrolment_id=${eid}&include_reversed=1`, [eid, tick]);
  const plans = useFetch<any[]>(`/payment-plans?enrolment_id=${eid}`, [eid, tick]);
  const plan = (plans.data ?? []).find((p) => p.status === 'active' || p.status === 'completed');
  const [rev, setRev] = useState<any>(null);
  const [resetup, setResetup] = useState(false);
  const refresh = () => { setTick((t) => t + 1); onChanged(); };
  const decide = async (r: any, approve: boolean) => {
    try {
      if (approve) await api.post(`/fees/receipts/${r.id}/reverse/approve`, {});
      else {
        const remarks = window.prompt('Why is this reversal rejected?') ?? '';
        if (!remarks.trim()) return;
        await api.post(`/fees/receipts/${r.id}/reverse/reject`, { remarks });
      }
      toast(approve ? `Payment ${r.receipt_no} reversed.` : 'Reversal request rejected — the payment stands.');
      refresh();
    } catch (err) { toast((err as Error).message, true); }
  };
  const rows = recs.data ?? [];
  const live = rows.filter((r) => r.reversal_status !== 'reversed');
  return (
    <>
      <DetailModal title={`Fee ledger — ${e.enrolment_no}`} icon="rupee" onClose={onClose} width={900}
        footer={can('payment_plan.create') && plan ? <button className="btn" onClick={() => setResetup(true)} data-testid="ledger-resetup"><Ic k="cfg" />Re-setup plan</button> : undefined}>
        <div className="kv-grid" style={{ marginBottom: 10 }}>
          <div><span className="kl">Student</span><span className="kvv">{e.lead_name ?? e.student_name ?? '—'}</span></div>
          <div><span className="kl">Net fee</span><span className="kvv">{fmtINR(Number(e.net_fee_minor ?? 0) + Number(e.exam_fee_minor ?? 0))}</span></div>
          <div><span className="kl">Received</span><span className="kvv">{fmtINR(live.reduce((s, r) => s + Number(r.amount_minor), 0))}</span></div>
          <div><span className="kl">Balance</span><span className="kvv">{fmtINR(Number(e.balance_minor ?? 0))}</span></div>
        </div>
        <TableCard title="Payments received" icon="list" serial
          cols={['Receipt', 'Received Date', 'Payment Mode', 'Reference', 'Amount', 'Status', 'Actions']}
          empty="No payments received yet."
          rows={rows.map((r): Cell[] => {
            const reversed = r.reversal_status === 'reversed';
            const strike = reversed ? { textDecoration: 'line-through', opacity: 0.6 } : undefined;
            return [
              { node: <b className="mono" style={strike}>{r.receipt_no}</b>, sort: r.receipt_no },
              { node: <span className="mono" style={strike}>{dmy(r.received_at)}</span>, sort: r.received_at },
              MODE[String(r.mode)] ?? r.mode,
              r.reference || '—',
              { node: <span className="mono" style={strike}>{fmtINR(Number(r.amount_minor))}</span>, sort: Number(r.amount_minor) },
              { node: reversed
                  ? <span><span className="bdg b-rose">Reversed</span><div className="sub" style={{ fontSize: 11 }}>{r.reversal_reason}</div></span>
                  : r.reversal_status === 'requested'
                    ? <span><span className="bdg b-amber">Reversal requested</span><div className="sub" style={{ fontSize: 11 }}>{r.reversal_reason}</div></span>
                    : <span className="bdg b-green">Posted</span> },
              { node: (
                <span style={{ display: 'inline-flex', gap: 4 }}>
                  {!reversed && <button className="icon-btn sm" title="Receipt PDF" onClick={() => void openPdf(`/fees/receipts/${r.id}/pdf`)}><Ic k="doc" /></button>}
                  {!reversed && !r.reversal_status && can('fee.collect') && (
                    <button className="btn sm" onClick={() => setRev(r)} data-testid={`reverse-${r.id}`}><Ic k="ban" />Reverse Payment</button>)}
                  {r.reversal_status === 'requested' && can('fee.reverse') && <>
                    <button className="btn sm primary" onClick={() => void decide(r, true)} data-testid={`reverse-approve-${r.id}`}><Ic k="check" />Approve</button>
                    <button className="btn sm" onClick={() => void decide(r, false)}><Ic k="x" />Reject</button>
                  </>}
                </span>) },
            ];
          })} />
        <PlanHistory enrolmentId={eid} tick={tick} />
      </DetailModal>
      {rev && <ReversePaymentModal receipt={rev} onClose={() => setRev(null)} onDone={refresh} />}
      {resetup && plan && <PlanResetupModal plan={plan} enrolment={e} onClose={() => setResetup(false)} onDone={() => { setResetup(false); refresh(); }} />}
    </>
  );
}

/* ----------------------------------------------- payment terms history */

const HIST_LABEL: Record<string, [string, string]> = {
  created: ['Plan created', 'b-indigo'], resetup: ['Plan re-setup', 'b-amber'],
  level_added: ['Level added', 'b-green'], deleted: ['Plan deleted', 'b-rose'],
};

export function PlanHistory({ enrolmentId, tick }: { enrolmentId: number; tick?: number }) {
  const h = useFetch<any[]>(`/payment-plans/history?enrolment_id=${enrolmentId}`, [enrolmentId, tick ?? 0]);
  const [open, setOpen] = useState<number | null>(null);
  const rows = h.data ?? [];
  return (
    <div style={{ marginTop: 14 }} data-testid="plan-history">
      <div className="sechead" style={{ marginBottom: 6 }}>Payment terms history</div>
      {!rows.length ? <div className="empty-note">No payment plan has been set up yet.</div> : (
        <table className="minitbl" style={{ width: '100%' }}>
          <thead><tr><th>Version</th><th>When</th><th>What</th><th>Plan</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Paid then</th><th style={{ textAlign: 'right' }}>Balance</th><th>By</th><th /></tr></thead>
          <tbody>{rows.map((r: any) => {
            const lab = HIST_LABEL[String(r.action)] ?? [r.action, 'b-gray'];
            const sched: any[] = Array.isArray(r.schedule) ? r.schedule : [];
            return [
              <tr key={r.id}>
                <td className="mono">v{r.version_no}</td>
                <td>{fmtDateTimeIST(r.created_at)}</td>
                <td><span className={`bdg ${lab[1]}`}>{lab[0]}</span>{r.reason ? <div className="sub" style={{ fontSize: 11 }}>{r.reason}</div> : null}</td>
                <td>{r.plan_type ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{fmtINR(Number(r.total_minor))}</td>
                <td style={{ textAlign: 'right' }}>{fmtINR(Number(r.paid_minor))}</td>
                <td style={{ textAlign: 'right' }}>{fmtINR(Number(r.balance_minor))}</td>
                <td>{r.actor_name ?? '—'}</td>
                <td>{sched.length ? <button className="btn sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Schedule'}</button> : null}</td>
              </tr>,
              open === r.id ? (
                <tr key={`${r.id}-s`}><td colSpan={9}>
                  <table className="minitbl" style={{ width: '100%' }}>
                    <thead><tr><th>#</th><th>Label</th><th>Due</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Paid</th><th>Status</th></tr></thead>
                    <tbody>{sched.map((s, i) => (
                      <tr key={i}><td>{s.seq_no}</td><td>{s.label ?? ''}</td><td>{dmy(s.due_date)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtINR(Number(s.amount_minor))}</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(s.paid_minor))}</td><td>{s.status}</td></tr>
                    ))}</tbody>
                  </table>
                </td></tr>
              ) : null,
            ];
          })}</tbody>
        </table>
      )}
    </div>
  );
}

/* --------------------------------------------------------- plan re-setup */

/** RE-SETUP PLAN (client 3 Sep): what is paid stays exactly as it happened; only the balance is
 *  re-scheduled on the new terms. The old plan is kept as a superseded version in the history. */
export function PlanResetupModal({ plan, enrolment: e, onClose, onDone }: { plan: any; enrolment: any; onClose: () => void; onDone: () => void }) {
  const paid = Number(plan.paid_minor ?? e.paid_minor ?? 0);
  const net = Number(e.net_fee_minor ?? plan.total_minor ?? 0);
  const balance = Math.max(0, net - paid);
  const cfg = useFeeConfig({ fee: String(balance / 100), plan: 'installment' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (cfg.plan !== 'full' && !cfg.sched.balances) { toast(cfg.sched.error || 'The instalments must total the balance.', true); return; }
    setBusy(true);
    try {
      const body: any = feePlanBody(cfg, Number(e.id ?? e.enrolment_id));
      delete body.enrolment_id;
      await api.post(`/payment-plans/${plan.id}/resetup`, { ...body, reason: reason.trim() || undefined });
      toast('Fee plan set up again — paid instalments kept, balance re-scheduled.');
      onDone();
    } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Re-setup plan — ${e.enrolment_no}`} icon="cfg" onClose={onClose} width={680}
      footer={<button className="btn primary" disabled={busy} onClick={go} data-testid="resetup-save"><Ic k="check" />Save new plan</button>}>
      <div className="notice" style={{ marginBottom: 10 }}><Ic k="rupee" /><div>
        Paid so far <b>{fmtINR(paid)}</b> stays exactly as received. Only the balance <b>{fmtINR(balance)}</b> is
        re-scheduled below. The current plan is kept as an earlier version in the payment terms history.
      </div></div>
      <div className="form-grid">
        <FeeConfigFields cfg={cfg} disabled={busy} showFee={false} hideDiscount />
        <div className="fld span2"><label htmlFor="rs-reason">Reason</label>
          <input id="rs-reason" className="ainp" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Student asked for 6 monthly instalments" /></div>
      </div>
    </DetailModal>
  );
}

/* ------------------------------------------------------------ audit history */

export function AuditHistoryModal({ enrolment: e, onClose }: { enrolment: any; onClose: () => void }) {
  const eid = Number(e.id ?? e.enrolment_id);
  const sid = e.student_profile_id ?? e.linked_student_id ?? e.student_id;
  const lv = useFetch<any[]>(sid ? `/students/${sid}/enrolments/${eid}/level-history` : null, [sid, eid]);
  return (
    <DetailModal title={`Audit history — ${e.enrolment_no}`} icon="clock" onClose={onClose} width={860}>
      <PlanHistory enrolmentId={eid} />
      {sid ? (
        <div style={{ marginTop: 14 }}>
          <div className="sechead" style={{ marginBottom: 6 }}>Level history</div>
          {!(lv.data ?? []).length ? <div className="empty-note">No level changes recorded.</div> : (
            <table className="minitbl" style={{ width: '100%' }}>
              <thead><tr><th>When</th><th>Level</th><th>What</th><th style={{ textAlign: 'right' }}>Fee</th><th>Discount type</th><th style={{ textAlign: 'right' }}>Discount</th><th>By</th></tr></thead>
              <tbody>{(lv.data ?? []).map((h: any) => (
                <tr key={h.id}>
                  <td>{fmtDateTimeIST(h.created_at)}</td><td><b>{h.code}</b></td><td>{h.action}{h.note ? <div className="sub" style={{ fontSize: 11 }}>{h.note}</div> : null}</td>
                  <td style={{ textAlign: 'right' }}>{fmtINR(Number(h.fee_minor))}</td>
                  <td>{Number(h.discount_minor) > 0 ? (h.discount_type === 'percent' ? `Percentage ${Number(h.discount_value)}%` : 'Amount ₹') : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{Number(h.discount_minor) > 0 ? `− ${fmtINR(Number(h.discount_minor))}` : '—'}</td>
                  <td>{h.actor_name ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ) : null}
    </DetailModal>
  );
}
