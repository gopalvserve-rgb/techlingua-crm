/**
 * ONLINE PAYMENTS (Razorpay, per vertical) — Phase 3 Batch 3.
 *
 * India-first: ₹ (fmtINR, Indian grouping), amounts to Razorpay in paise, DD-MMM-YYYY, IST.
 * FULL list treatment (multi-select FilterMulti, Export with values not ids, TableCard column
 * chooser, Refresh, bulk-delete). Razorpay is credential-gated PER VERTICAL: creating a link on
 * a vertical with no key returns a clean 503 that this screen shows verbatim; everything lights
 * up the moment the client enters the key in Settings. Captured payments record a fee receipt +
 * auto-receipt via the webhook — this screen is where staff mint the link and watch it settle.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { fmtINR, parseRupees } from './money';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const dt = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const asOpts = (vals: Array<[string, string]>) => vals.map(([id, name]) => ({ id, name }));

const STATUS_BADGE: Record<string, [string, string]> = {
  pending: ['Pending', 'b-amber'], paid: ['Paid', 'b-green'], failed: ['Failed', 'b-rose'], cancelled: ['Cancelled', 'b-gray'],
};

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title} onClick={(e) => { e.stopPropagation(); fn(); }}><Ic k={icon} /></button>
    ))}
  </div>
);

/* ==================================================================== */
/*  ONLINE PAYMENTS LIST                                                 */
/* ==================================================================== */

export function PaymentsScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const [create, setCreate] = useState(false);
  const [link, setLink] = useState<{ short_url: string | null; enrolment_no?: string } | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fStatus.length) qs.set('status', fStatus.join(','));
  if (fBranches.length) qs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) qs.set('vertical_ids', fVerticals.join(','));
  const key = `${qs.toString()}~${tick}`;
  const list = useFetch<any[]>(`/payments?${qs.toString()}`, [key]);
  const summary = useFetch<any>('/payments/summary', [tick]);
  const rows = list.data ?? [];
  const s = summary.data;

  const ids = rows.map((r) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Online payment', '/payments/bulk-delete/impact', '/payments/bulk-delete', () => { after(); clear(); }, 'ids');

  const del = async (r: any) => {
    if (r.status === 'paid') { toast('A captured payment cannot be deleted — refund it in the next batch.', true); return; }
    if (!confirm(`Void the ${fmtINR(r.amount_minor)} payment link for ${r.enrolment_no}?`)) return;
    try { await api.del(`/payments/${r.id}`); toast('Payment voided'); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const copy = (url: string) => { navigator.clipboard?.writeText(url).then(() => toast('Payment link copied')).catch(() => undefined); };

  return (
    <>
      {can('payment.create') && (
        <div className="page-actions"><button className="btn primary" onClick={() => setCreate(true)}><Ic k="rupee" />New online payment</button></div>
      )}
      <Kpis items={[
        { lab: 'Collected online', val: s ? fmtINR(s.collected_minor) : '—', ic: 'rupee' },
        { lab: 'Paid', val: String(s?.paid_n ?? 0), ic: 'check' },
        { lab: 'Pending', val: String(s?.pending_n ?? 0), ic: 'clock' },
        { lab: 'Failed', val: String(s?.failed_n ?? 0), ic: 'bolt' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="search" /><input placeholder="Search student / enrolment / gateway ref" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts([['pending', 'Pending'], ['paid', 'Paid'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]) as any} onChange={setFStatus as any} />
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
      </div>
      <BulkBar count={count} entityLabel="Online payment" onDelete={() => openBulk(selected)} onClear={clear} note="Captured (paid) payments are skipped — refund them instead." />
      <TableCard fill title="Online Payments" icon="rupee"
        select={can('payment.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('online-payments.csv', rows.map((r) => ({
          enrolment: r.enrolment_no, student: r.student_name, course: r.course_name || '',
          amount: (Number(r.amount_minor) / 100).toFixed(2), status: r.status, mode: 'Razorpay',
          gateway_payment_id: r.gateway_payment_id || '', gateway_order_id: r.gateway_order_id || '',
          receipt: r.receipt_no || '', created: dt(r.created_at), paid_at: dt(r.paid_at),
          branch: r.branch_name, vertical: r.vertical_name,
        })))} onRefresh={after} />}
        cols={['Enrolment', 'Student', 'Amount', 'Status', 'Mode', 'Gateway ref', 'Receipt', 'Date', 'Branch', 'Actions']}
        empty="No online payments yet — create a Razorpay payment link on an enrolment."
        rows={rows.map((r): Cell[] => [
          { node: <b className="mono">{r.enrolment_no}</b> },
          { node: <div><b className="nm">{r.student_name}</b>{r.course_name ? <div className="sub">{r.course_name}</div> : null}</div> },
          { mono: fmtINR(r.amount_minor) },
          { b: STATUS_BADGE[r.status] ?? [r.status, 'b-gray'] },
          'Razorpay',
          { node: <span className="mono sub">{r.gateway_payment_id || r.gateway_order_id || '—'}</span> },
          r.receipt_no ? { mono: r.receipt_no } : '—',
          dt(r.paid_at || r.created_at),
          r.branch_name,
          {
            node: <RowBtns items={[
              ...(r.short_url && r.status === 'pending' ? [['link', 'Copy payment link', () => copy(r.short_url)] as [string, string, () => void]] : []),
              ...(can('payment.delete') && r.status !== 'paid' ? [['trash', 'Void', () => void del(r)] as [string, string, () => void]] : []),
            ]} />,
          },
        ])} />
      {create && <PaymentLinkModal onClose={() => setCreate(false)} onCreated={(l) => { setCreate(false); setLink(l); after(); }} />}
      {link && <LinkResultModal link={link} onClose={() => setLink(null)} />}
      {bulkModal}
    </>
  );
}

/* ==================================================================== */
/*  CREATE PAYMENT LINK                                                  */
/* ==================================================================== */

export function PaymentLinkModal({ onClose, onCreated, enrolmentId }: { onClose: () => void; onCreated: (l: { short_url: string | null; enrolment_no?: string }) => void; enrolmentId?: number }) {
  const enrolments = useFetch<any[]>('/enrolments?status=active');
  const [enrolment, setEnrolment] = useState(enrolmentId ? String(enrolmentId) : '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const listE = enrolments.data ?? [];
  const chosen = listE.find((e) => String(e.id) === enrolment);
  const net = chosen ? Number(chosen.net_fee_minor) : 0;

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (!enrolment) throw new Error('Choose the enrolment this online payment is for.');
      const body: any = { enrolment_id: Number(enrolment), note: note || undefined };
      const amt = parseRupees(amount);
      if (amt && amt > 0) body.amount = amount;          // partial allowed; blank = the whole due
      const r = await api.post<any>('/payments/link', body);
      toast(`Payment link created for ${r.enrolment_no}.`);
      onCreated({ short_url: r.short_url, enrolment_no: r.enrolment_no });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah"><h3><Ic k="rupee" />New online payment (Razorpay)</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="pl-enr">Enrolment <span className="star">*</span></label>
              <select id="pl-enr" className="ainp" value={enrolment} onChange={(e) => setEnrolment(e.target.value)} disabled={!!enrolmentId}>
                <option value="">—</option>
                {listE.map((e) => <option key={e.id} value={e.id}>{e.enrolment_no} · {e.lead_name}{e.course_name ? ` · ${e.course_name}` : ''} — net {fmtINR(e.net_fee_minor)}</option>)}
              </select>
              {chosen ? <div className="fhint">Net fee {fmtINR(net)}. Leave the amount blank to collect the whole outstanding, or enter a partial amount.</div> : null}
            </div>
            <div className="fld span2"><label htmlFor="pl-amt">Amount (₹) — partial allowed</label><input id="pl-amt" className="ainp" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="whole outstanding" /></div>
            <div className="fld span2"><label htmlFor="pl-note">Note</label><input id="pl-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          <div className="notice" style={{ marginTop: 10 }}><Ic k="rupee" /><div>The link is minted with THIS enrolment's vertical's Razorpay key. When the student pays, the payment is captured by the webhook, a fee receipt + auto-receipt PDF are generated, and it applies to the installment schedule (oldest-due first).</div></div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Creating…' : 'Create payment link'}</button>
        </div>
      </div>
    </div>
  );
}

export function LinkResultModal({ link, onClose }: { link: { short_url: string | null; enrolment_no?: string }; onClose: () => void }) {
  const copy = () => { if (link.short_url) navigator.clipboard?.writeText(link.short_url).then(() => toast('Copied')).catch(() => undefined); };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 520 }}>
        <div className="ah"><h3><Ic k="link" />Payment link ready</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fhint">Share this Razorpay link with the student{link.enrolment_no ? ` (${link.enrolment_no})` : ''}. On payment it is captured automatically and a receipt is generated.</div>
          {link.short_url ? (
            <div className="totals-box" style={{ marginTop: 10 }}>
              <div><span>Link</span><b><a href={link.short_url} target="_blank" rel="noreferrer">{link.short_url}</a></b></div>
            </div>
          ) : <div className="notice" style={{ marginTop: 10 }}><Ic k="bolt" /><div>The link was created but no URL was returned. Check the payment row.</div></div>}
        </div>
        <div className="af">
          {link.short_url ? <button className="btn" onClick={copy}><Ic k="link" />Copy link</button> : null}
          <button className="btn primary" onClick={onClose}><Ic k="check" />Done</button>
        </div>
      </div>
    </div>
  );
}
