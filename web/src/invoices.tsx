/**
 * INVOICES + FINANCE DASHBOARD — Phase 3 Batch 1.
 *
 * GST tax invoices raised against an enrolment/fee (or ad-hoc): seller GSTIN + state,
 * buyer GSTIN + place of supply, HSN/SAC, CGST+SGST (intra-state) or IGST (inter-state),
 * round-off, grand total, amount in words, branded PDF. India-first throughout: ₹ (fmtINR,
 * Indian grouping), GST %, HSN/SAC, GSTIN, place of supply, DD-MMM-YYYY.
 *
 * FULL list treatment on the invoices list: multi-select FilterMulti filters, Export
 * (values not ids), column chooser (TableCard fill+title), Refresh, and bulk-delete.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, HBars, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { fmtINR, parseRupees } from './money';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const dt = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const openPdf = (path: string) => { window.open(`/api${path}`, '_blank', 'noopener'); };
const asOpts = (vals: Array<[string, string]>) => vals.map(([id, name]) => ({ id, name }));

const STATUS_BADGE: Record<string, [string, string]> = {
  draft: ['Draft', 'b-gray'], issued: ['Issued', 'b-indigo'], paid: ['Paid', 'b-green'], cancelled: ['Cancelled', 'b-rose'],
};
const statusCell = (s: string): Cell => { const [l, c] = STATUS_BADGE[s] ?? [s, 'b-gray']; return { b: [l, c] }; };

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title} onClick={(e) => { e.stopPropagation(); fn(); }}><Ic k={icon} /></button>
    ))}
  </div>
);

/* ==================================================================== */
/*  INVOICES LIST                                                        */
/* ==================================================================== */

export function InvoicesScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fSupply, setFSupply] = useState<string[]>([]);
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fStatus.length) qs.set('statuses', fStatus.join(','));
  if (fSupply.length) qs.set('supply_type', fSupply[0]);
  if (fBranches.length) qs.set('branch_ids', fBranches.join(','));
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const key = `${qs.toString()}~${tick}`;
  const list = useFetch<any[]>(`/invoices?${qs.toString()}`, [key]);
  const summary = useFetch<any>('/invoices/summary', [tick]);
  const rows = list.data ?? [];
  const s = summary.data;

  const ids = rows.map((r) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Invoice', '/invoices/bulk-delete/impact', '/invoices/bulk-delete', () => { after(); clear(); }, 'ids');

  const del = async (r: any) => {
    if (!confirm(`Delete draft invoice ${r.invoice_no || '(draft)'}?`)) return;
    try { await api.del(`/invoices/${r.id}`); toast('Invoice deleted'); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const issue = async (r: any) => {
    if (!confirm(`Issue this invoice? A GST invoice number will be allocated and the document is frozen.`)) return;
    try { const res = await api.post<any>(`/invoices/${r.id}/issue`); toast(`Issued ${res.invoice_no}`); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const markPaid = async (r: any) => {
    try { await api.post(`/invoices/${r.id}/mark-paid`); toast('Marked paid'); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const cancel = async (r: any) => {
    const reason = prompt(`Cancel ${r.invoice_no}? Enter a reason:`);
    if (reason == null) return;
    try { await api.post(`/invoices/${r.id}/cancel`, { reason }); toast('Invoice cancelled'); after(); } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      {can('invoice.create') && (
        <div className="page-actions"><button className="btn primary" onClick={() => setCreate(true)}><Ic k="plus" />New invoice</button></div>
      )}
      <Kpis items={[
        { lab: 'Invoiced (issued+paid)', val: s ? fmtINR(s.invoiced_minor) : '—', ic: 'rupee' },
        { lab: 'GST charged', val: s ? fmtINR(s.gst_minor) : '—', ic: 'rupee' },
        { lab: 'Issued', val: String(s?.issued ?? 0), ic: 'doc' },
        { lab: 'Drafts', val: String(s?.draft ?? 0), ic: 'note' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="search" /><input placeholder="Search invoice # / buyer" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts([['draft', 'Draft'], ['issued', 'Issued'], ['paid', 'Paid'], ['cancelled', 'Cancelled']]) as any} onChange={setFStatus as any} />
        <FilterMulti label="Supply" icon="grid" value={fSupply as any} options={asOpts([['intra', 'Intra-state (CGST+SGST)'], ['inter', 'Inter-state (IGST)']]) as any} onChange={setFSupply as any} />
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <DateRange value={range} onChange={setRange} idPrefix="inv-dr" />
      </div>
      <BulkBar count={count} entityLabel="Invoice" onDelete={() => openBulk(selected)} onClear={clear} note="Only draft / cancelled invoices are deleted; issued & paid are skipped." />
      <TableCard fill title="Tax Invoices" icon="rupee"
        select={can('invoice.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('invoices.csv', rows.map((r) => ({
          invoice_no: r.invoice_no || '(draft)', date: dt(r.invoice_date), status: r.status,
          buyer: r.buyer_name, buyer_gstin: r.buyer_gstin || '', supply: r.supply_type,
          place_of_supply: r.pos_state_name || '', branch: r.branch_name, vertical: r.vertical_name,
          taxable: (Number(r.taxable_minor) / 100).toFixed(2), cgst: (Number(r.cgst_minor) / 100).toFixed(2),
          sgst: (Number(r.sgst_minor) / 100).toFixed(2), igst: (Number(r.igst_minor) / 100).toFixed(2),
          total: (Number(r.total_minor) / 100).toFixed(2),
        })))} onRefresh={after} />}
        cols={['Invoice #', 'Date', 'Buyer', 'Supply', 'Taxable', 'GST', 'Total', 'Branch', 'Status', 'Actions']}
        empty="No invoices yet — raise a GST tax invoice from an enrolment."
        rows={rows.map((r): Cell[] => [
          { node: <b className="mono">{r.invoice_no || 'Draft'}</b> },
          dt(r.invoice_date),
          { node: <div><b className="nm">{r.buyer_name}</b>{r.buyer_gstin ? <div className="sub mono">{r.buyer_gstin}</div> : null}</div> },
          { b: [r.supply_type === 'inter' ? 'IGST' : 'CGST+SGST', r.supply_type === 'inter' ? 'b-amber' : 'b-cyan'] },
          { mono: fmtINR(r.taxable_minor) },
          { mono: fmtINR(Number(r.cgst_minor) + Number(r.sgst_minor) + Number(r.igst_minor)) },
          { mono: fmtINR(r.total_minor) },
          r.branch_name,
          statusCell(r.status),
          {
            node: <RowBtns items={[
              ['eye', 'View', () => setDetail(Number(r.id))],
              ['doc', 'PDF', () => openPdf(`/invoices/${r.id}/pdf`)],
              ...(r.status === 'draft' && can('invoice.issue') ? [['check', 'Issue', () => void issue(r)] as [string, string, () => void]] : []),
              ...(r.status === 'issued' && can('invoice.issue') ? [['rupee', 'Mark paid', () => void markPaid(r)] as [string, string, () => void]] : []),
              ...(['issued', 'paid'].includes(r.status) && can('invoice.cancel') ? [['x', 'Cancel', () => void cancel(r)] as [string, string, () => void]] : []),
              ...(['draft', 'cancelled'].includes(r.status) && can('invoice.delete') ? [['trash', 'Delete', () => void del(r)] as [string, string, () => void]] : []),
            ]} />,
          },
        ])} />
      {create && <InvoiceCreateModal onClose={() => setCreate(false)} onSaved={() => { setCreate(false); after(); }} />}
      {detail != null && <InvoiceDetailModal id={detail} onClose={() => setDetail(null)} onChanged={after} />}
      {bulkModal}
    </>
  );
}

/* ==================================================================== */
/*  CREATE (from enrolment, or ad-hoc)                                   */
/* ==================================================================== */

export function InvoiceCreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const ref = useRef_();
  const enrolments = useFetch<any[]>('/enrolments?status=active');
  const [mode, setMode] = useState<'enrolment' | 'adhoc'>('enrolment');
  const [enrolment, setEnrolment] = useState('');
  const [branch, setBranch] = useState('');
  const [vertical, setVertical] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [buyerGstin, setBuyerGstin] = useState('');
  const [buyerAddress, setBuyerAddress] = useState('');
  const [posState, setPosState] = useState('');
  const [desc, setDesc] = useState('');
  const [hsn, setHsn] = useState('999293');
  const [amount, setAmount] = useState('');
  const [gst, setGst] = useState('18');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const list = enrolments.data ?? [];
  const chosen = list.find((e) => String(e.id) === enrolment);

  // client-side estimate (server re-computes authoritatively)
  const est = useMemo(() => {
    const taxable = mode === 'enrolment' && chosen && !amount ? Number(chosen.net_fee_minor) : (parseRupees(amount) ?? 0);
    const g = Number(gst) || 0;
    const tax = Math.round((taxable * g) / 100);
    return { taxable, tax, total: taxable + tax };
  }, [mode, chosen, amount, gst]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const items = (desc || amount)
        ? [{ description: desc || (chosen?.course_name ? `${chosen.course_name} — course fee` : 'Course fee'), hsn_sac: hsn || null, qty: 1, unit_price: amount || undefined, gst_pct: gst }]
        : undefined;
      const body: any = {
        buyer_name: buyerName || undefined, buyer_gstin: buyerGstin || undefined,
        buyer_address: buyerAddress || undefined, pos_state_id: posState ? Number(posState) : undefined,
        notes: notes || undefined,
        items,
      };
      if (mode === 'enrolment') {
        if (!enrolment) throw new Error('Choose the enrolment to invoice.');
        body.enrolment_id = Number(enrolment);
        // when the default line is used, still let the counsellor set GST/HSN
        if (!items) body.items = [{ description: chosen?.course_name ? `${chosen.course_name} — course fee` : 'Course fee', hsn_sac: hsn || null, qty: 1, unit_price_minor: Number(chosen?.net_fee_minor ?? 0), gst_pct: gst }];
      } else {
        body.branch_id = Number(branch); body.vertical_id = Number(vertical);
        if (!branch || !vertical) throw new Error('Pick a branch and vertical.');
        if (!buyerName) throw new Error('Enter the buyer name.');
        if (!items) throw new Error('Add a line item (description + amount).');
      }
      const r = await api.post<any>('/invoices', body);
      toast(`Draft invoice created (${r.supply_type === 'inter' ? 'IGST' : 'CGST+SGST'}). Review, then Issue.`);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 680 }}>
        <div className="ah"><h3><Ic k="rupee" />New GST tax invoice</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="seg" style={{ marginBottom: 12 }}>
            <button className={`seg-btn ${mode === 'enrolment' ? 'on' : ''}`} onClick={() => setMode('enrolment')}>From enrolment</button>
            <button className={`seg-btn ${mode === 'adhoc' ? 'on' : ''}`} onClick={() => setMode('adhoc')}>Ad-hoc</button>
          </div>
          <div className="form-grid">
            {mode === 'enrolment' ? (
              <div className="fld span2">
                <label htmlFor="i-enr">Enrolment <span className="star">*</span></label>
                <select id="i-enr" className="ainp" value={enrolment} onChange={(e) => setEnrolment(e.target.value)}>
                  <option value="">—</option>
                  {list.map((e) => <option key={e.id} value={e.id}>{e.enrolment_no} · {e.lead_name}{e.course_name ? ` · ${e.course_name}` : ''} — net {fmtINR(e.net_fee_minor)}</option>)}
                </select>
                {chosen ? <div className="fhint">Buyer, branch/vertical and the course-fee line are taken from this enrolment. Net fee {fmtINR(chosen.net_fee_minor)} becomes the taxable value; GST is added on top.</div> : <div className="fhint">The buyer & seller are derived from the enrolment.</div>}
              </div>
            ) : (
              <>
                <div className="fld"><label htmlFor="i-br">Branch <span className="star">*</span></label>
                  <select id="i-br" className="ainp" value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">—</option>{(ref.branches ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                <div className="fld"><label htmlFor="i-vr">Vertical <span className="star">*</span></label>
                  <select id="i-vr" className="ainp" value={vertical} onChange={(e) => setVertical(e.target.value)}><option value="">—</option>{(ref.verticals ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
                <div className="fld span2"><label htmlFor="i-bn">Buyer name <span className="star">*</span></label><input id="i-bn" className="ainp" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} /></div>
              </>
            )}
            <div className="fld"><label htmlFor="i-bg">Buyer GSTIN</label><input id="i-bg" className="ainp" value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value)} placeholder="optional (B2B)" /></div>
            <div className="fld"><label htmlFor="i-pos">Place of supply (state)</label>
              <select id="i-pos" className="ainp" value={posState} onChange={(e) => setPosState(e.target.value)}>
                <option value="">Same as seller (intra-state)</option>
                {(ref.states ?? []).map((st: any) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <div className="fhint">A state different from the seller's makes it inter-state → IGST.</div>
            </div>
            <div className="fld span2"><label htmlFor="i-ba">Buyer address</label><input id="i-ba" className="ainp" value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} /></div>
            <div className="fld span2"><label htmlFor="i-de">Line description{mode === 'adhoc' ? <span className="star">*</span> : ''}</label><input id="i-de" className="ainp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={chosen?.course_name ? `${chosen.course_name} — course fee` : 'e.g. IELTS course fee'} /></div>
            <div className="fld"><label htmlFor="i-hsn">HSN/SAC</label><input id="i-hsn" className="ainp" value={hsn} onChange={(e) => setHsn(e.target.value)} placeholder="999293" /></div>
            <div className="fld"><label htmlFor="i-am">Amount (₹){mode === 'adhoc' ? <span className="star">*</span> : ''}</label><input id="i-am" className="ainp" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={mode === 'enrolment' && chosen ? String((Number(chosen.net_fee_minor) / 100).toFixed(2)) : '0.00'} /><div className="fhint">Taxable value (GST is added on top).</div></div>
            <div className="fld"><label htmlFor="i-gst">GST %</label><input id="i-gst" className="ainp" value={gst} onChange={(e) => setGst(e.target.value)} placeholder="18" /></div>
            <div className="fld span2"><label htmlFor="i-nt">Notes</label><input id="i-nt" className="ainp" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
          <div className="notice" style={{ marginTop: 10 }}><Ic k="rupee" /><div>Estimated — taxable {fmtINR(est.taxable)} · GST {fmtINR(est.tax)} · <b>total {fmtINR(est.total)}</b>. The server re-computes the CGST/SGST or IGST split and round-off authoritatively.</div></div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Create draft'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  DETAIL                                                               */
/* ==================================================================== */

export function InvoiceDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const { data, reload } = useFetch<any>(`/invoices/${id}`);
  const [busy, setBusy] = useState(false);
  const gi = data;
  const after = () => { reload(); onChanged(); };

  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); after(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 760 }}>
        <div className="ah"><h3><Ic k="rupee" />Invoice {gi?.invoice_no || '(draft)'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          {!gi ? <div className="fhint">Loading…</div> : (
            <>
              <div className="kv-grid">
                <div><span className="kl">Status</span><span className="kvv">{(STATUS_BADGE[gi.status]?.[0]) ?? gi.status}</span></div>
                <div><span className="kl">Date</span><span className="kvv">{dt(gi.invoice_date)}</span></div>
                <div><span className="kl">Supply</span><span className="kvv">{gi.supply_type === 'inter' ? 'Inter-state (IGST)' : 'Intra-state (CGST+SGST)'}</span></div>
                <div><span className="kl">Place of supply</span><span className="kvv">{gi.pos_state_name || '—'}{gi.pos_state_code ? ` (${gi.pos_state_code})` : ''}</span></div>
              </div>
              <div className="split2" style={{ marginTop: 12 }}>
                <div className="card-lite">
                  <b>Seller</b>
                  <div className="fhint">{gi.seller_legal_name || gi.branch_name}</div>
                  <div className="fhint mono">GSTIN {gi.seller_gstin || '— (set on the branch)'}</div>
                  <div className="fhint">{gi.seller_state_name || ''}</div>
                </div>
                <div className="card-lite">
                  <b>Buyer</b>
                  <div className="fhint">{gi.buyer_name}</div>
                  <div className="fhint mono">{gi.buyer_gstin ? `GSTIN ${gi.buyer_gstin}` : 'Unregistered (B2C)'}</div>
                  <div className="fhint">{gi.buyer_address || ''}</div>
                </div>
              </div>
              <TableCard title="Line items" icon="list"
                cols={['#', 'Description', 'HSN/SAC', 'Qty', 'Taxable', 'GST %', gi.supply_type === 'inter' ? 'IGST' : 'CGST', gi.supply_type === 'inter' ? '' : 'SGST', 'Total'].filter(Boolean) as string[]}
                empty="No lines"
                rows={(gi.items ?? []).map((it: any): Cell[] => ([
                  String(it.line_no),
                  it.description,
                  it.hsn_sac || '—',
                  String(it.qty),
                  { mono: fmtINR(it.taxable_minor) },
                  `${Number(it.gst_pct)}%`,
                  { mono: fmtINR(gi.supply_type === 'inter' ? it.igst_minor : it.cgst_minor) },
                  ...(gi.supply_type === 'inter' ? [] : [{ mono: fmtINR(it.sgst_minor) } as Cell]),
                  { mono: fmtINR(it.total_minor) },
                ]))} />
              <div className="totals-box" style={{ marginTop: 10 }}>
                <div><span>Taxable value</span><b>{fmtINR(gi.taxable_minor)}</b></div>
                {gi.supply_type === 'inter'
                  ? <div><span>IGST</span><b>{fmtINR(gi.igst_minor)}</b></div>
                  : <><div><span>CGST</span><b>{fmtINR(gi.cgst_minor)}</b></div><div><span>SGST</span><b>{fmtINR(gi.sgst_minor)}</b></div></>}
                {Number(gi.round_off_minor) !== 0 ? <div><span>Round off</span><b>{fmtINR(gi.round_off_minor)}</b></div> : null}
                <div className="grand"><span>Grand total</span><b>{fmtINR(gi.total_minor)}</b></div>
              </div>
              {gi.amount_in_words ? <div className="fhint" style={{ marginTop: 8 }}><b>Amount in words:</b> {gi.amount_in_words}</div> : null}
            </>
          )}
        </div>
        <div className="af">
          <button className="btn ghost" onClick={() => openPdf(`/invoices/${id}/pdf`)}><Ic k="doc" />PDF</button>
          {gi?.status === 'draft' && can('invoice.issue') ? <button className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/invoices/${id}/issue`), 'Invoice issued')}><Ic k="check" />Issue</button> : null}
          {gi?.status === 'issued' && can('invoice.issue') ? <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/invoices/${id}/mark-paid`), 'Marked paid')}><Ic k="rupee" />Mark paid</button> : null}
          {['issued', 'paid'].includes(gi?.status) && can('invoice.cancel') ? <button className="btn danger" disabled={busy} onClick={() => { const reason = prompt('Cancel reason:'); if (reason != null) act(() => api.post(`/invoices/${id}/cancel`, { reason }), 'Cancelled'); }}><Ic k="x" />Cancel</button> : null}
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  FINANCE DASHBOARD                                                    */
/* ==================================================================== */

export function FinanceDashboard() {
  const { scope: gScope } = useScope();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  if ((gScope.branches ?? []).length) qs.set('branch_ids', gScope.branches.join(','));
  if ((gScope.verticals ?? []).length) qs.set('vertical_ids', gScope.verticals.join(','));
  const rangeKey = `${qs.toString()}`;
  const { data } = useFetch<any>(`/finance/dashboard?${qs.toString()}`, [rangeKey]);
  const k = data?.kpis;

  const MODE_LABELS: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online' };
  const modeTotal = (data?.by_mode ?? []).reduce((a: number, m: any) => a + m.total_minor, 0);
  const hbar = (rowsIn: any[], color: string) => {
    const max = Math.max(1, ...rowsIn.map((r) => r.total_minor));
    return rowsIn.map((r) => ({ label: r.label, val: fmtINR(r.total_minor), pct: Math.round((r.total_minor * 100) / max), color }));
  };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <DateRange value={range} onChange={setRange} idPrefix="fin-dr" />
      </div>
      <Kpis cols={5} items={[
        { lab: 'Total Invoiced', val: k ? fmtINR(k.total_invoiced_minor) : '—', ic: 'rupee' },
        { lab: 'Total Collected', val: k ? fmtINR(k.total_collected_minor) : '—', ic: 'rupee' },
        { lab: 'Collected (range)', val: k ? fmtINR(k.collected_in_range_minor) : '—', ic: 'rupee' },
        { lab: 'Outstanding dues', val: k ? fmtINR(k.outstanding_minor) : '—', ic: 'clock' },
        { lab: 'GST collected', val: k ? fmtINR(k.gst_collected_minor) : '—', ic: 'rupee' },
      ]} />
      <Kpis cols={4} items={[
        { lab: 'CGST', val: k ? fmtINR(k.cgst_minor) : '—', ic: 'rupee' },
        { lab: 'SGST', val: k ? fmtINR(k.sgst_minor) : '—', ic: 'rupee' },
        { lab: 'IGST', val: k ? fmtINR(k.igst_minor) : '—', ic: 'rupee' },
        { lab: 'Receipts', val: String(k?.receipts ?? 0), ic: 'doc' },
      ]} />
      <div className="split2">
        <HBars title="Collection by vertical" rows={hbar(data?.by_vertical ?? [], 'var(--indigo)')} empty="No collections in range" />
        <HBars title="Collection by branch" rows={hbar(data?.by_branch ?? [], 'var(--cyan)')} empty="No collections in range" />
      </div>
      <div className="split2">
        <HBars title="Collection by course" rows={hbar(data?.by_course ?? [], 'var(--green)')} empty="No collections in range" />
        <HBars title="Collection by mode"
          rows={(data?.by_mode ?? []).map((m: any) => ({ label: `${MODE_LABELS[m.mode] ?? m.mode} — ${m.n}`, val: fmtINR(m.total_minor), pct: modeTotal > 0 ? Math.round((m.total_minor * 100) / modeTotal) : 0, color: 'var(--amber)' }))}
          empty="No collections in range" />
      </div>
      <TableCard title="Recent receipts" icon="rupee"
        cols={['Receipt', 'Student', 'Enrolment', 'Amount', 'Mode', 'Received', 'Branch']}
        empty="No receipts yet"
        rows={(data?.recent_receipts ?? []).map((r: any): Cell[] => [
          { node: <b className="mono">{r.receipt_no}</b> }, r.lead_name, { mono: r.enrolment_no },
          { mono: fmtINR(r.amount_minor) }, { b: [String(r.mode).toUpperCase(), 'b-indigo'] }, dt(r.received_at), r.branch_name,
        ])} />
      <TableCard title="Top dues" icon="clock"
        cols={['Enrolment', 'Student', 'Course', 'Net fee', 'Paid', 'Balance']}
        empty="No outstanding dues"
        rows={(data?.top_dues ?? []).map((r: any): Cell[] => [
          { mono: r.enrolment_no }, r.lead_name, r.course_name ?? '—',
          { mono: fmtINR(r.net_fee_minor) }, { mono: fmtINR(r.paid_minor) }, { mono: fmtINR(r.balance_minor) },
        ])} />
    </>
  );
}
