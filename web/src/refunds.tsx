/**
 * REFUNDS (Phase 3 Batch 4) — full or partial refunds of collected fees, behind an
 * approval hierarchy. India-first: ₹ (fmtINR), DD-MMM-YYYY, IST. FULL list treatment
 * (multi-select FilterMulti, Export with values not ids, TableCard column chooser, Refresh,
 * bulk-delete). A refund is REQUESTED, then APPROVED/REJECTED by a permitted role; a
 * high-value refund needs the senior approver (refund.approve_high). Nobody approves their
 * own request. On approval a REF- voucher is minted (PDF) and net collected reduces.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { DateRange, DateRangeValue } from './daterange';
import { fmtINR, parseRupees } from './money';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const dt = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const asOpts = (vals: Array<[string, string]>) => vals.map(([id, name]) => ({ id, name }));
const openPdf = (path: string) => { window.open(`/api${path}`, '_blank', 'noopener'); };

const STATUS_BADGE: Record<string, [string, string]> = {
  pending: ['Pending', 'b-amber'], approved: ['Approved', 'b-green'], rejected: ['Rejected', 'b-rose'], cancelled: ['Cancelled', 'b-gray'],
};

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title} onClick={(e) => { e.stopPropagation(); fn(); }}><Ic k={icon} /></button>
    ))}
  </div>
);

/* ==================================================================== */
/*  REFUNDS LIST                                                         */
/* ==================================================================== */

export function RefundsScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const [range, setRange] = useState<DateRangeValue>({});
  const [create, setCreate] = useState(false);
  const [policy, setPolicy] = useState(false);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fStatus.length) qs.set('status', fStatus.join(','));
  if (fBranches.length) qs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) qs.set('vertical_ids', fVerticals.join(','));
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const key = `${qs.toString()}~${tick}`;
  const list = useFetch<any[]>(`/refunds?${qs.toString()}`, [key]);
  const summary = useFetch<any>('/refunds/summary', [tick]);
  const rows = list.data ?? [];
  const s = summary.data;

  const ids = rows.map((r) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Refund', '/refunds/bulk-delete/impact', '/refunds/bulk-delete', () => { after(); clear(); }, 'ids');

  const approve = async (r: any) => {
    const note = prompt(`Approve the ${fmtINR(r.amount_minor)} refund for ${r.enrolment_no}? Optional note:`, '');
    if (note === null) return;
    const path = r.requires_high && can('refund.approve_high') ? 'approve-high' : 'approve';
    try { await api.post(`/refunds/${r.id}/${path}`, { note: note || undefined }); toast('Refund approved — voucher generated'); after(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const reject = async (r: any) => {
    const note = prompt(`Reject this refund? Reason:`, '');
    if (note === null) return;
    try { await api.post(`/refunds/${r.id}/reject`, { note: note || undefined }); toast('Refund rejected'); after(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const del = async (r: any) => {
    if (r.status === 'approved') { toast('An approved refund cannot be deleted.', true); return; }
    if (!confirm(`Delete this ${fmtINR(r.amount_minor)} refund request?`)) return;
    try { await api.del(`/refunds/${r.id}`); toast('Refund request deleted'); after(); } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="page-actions">
        {can('refund.request') && <button className="btn primary" onClick={() => setCreate(true)}><Ic k="rupee" />New refund</button>}
        {can('settings.update') && <button className="btn ghost" onClick={() => setPolicy(true)}><Ic k="shield" />Approval settings</button>}
      </div>
      <Kpis items={[
        { lab: 'Refunded (approved)', val: s ? fmtINR(s.refunded_minor) : '—', ic: 'rupee' },
        { lab: 'Awaiting approval', val: String(s?.pending_n ?? 0), ic: 'clock' },
        { lab: 'Pending value', val: s ? fmtINR(s.pending_minor) : '—', ic: 'bolt' },
        { lab: 'Rejected', val: String(s?.rejected_n ?? 0), ic: 'x' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="search" /><input placeholder="Search voucher / student / enrolment / reason" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts([['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']]) as any} onChange={setFStatus as any} />
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
        <DateRange value={range} onChange={setRange} idPrefix="rf-dr" />
      </div>
      <BulkBar count={count} entityLabel="Refund" onDelete={() => openBulk(selected)} onClear={clear} note="Approved refunds are skipped — they are the record of money released." />
      <TableCard fill title="Refunds" icon="rupee"
        select={can('refund.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('refunds.csv', rows.map((r) => ({
          voucher: r.refund_no || '', enrolment: r.enrolment_no, student: r.student_name, course: r.course_name || '',
          amount: (Number(r.amount_minor) / 100).toFixed(2), mode: r.mode, reason: r.reason, status: r.status,
          requested_by: r.requested_by_name || '', approved_by: r.approver_name || '',
          requested: dt(r.requested_at), refunded: dt(r.refunded_at), branch: r.branch_name, vertical: r.vertical_name,
        })))} onRefresh={after} />}
        cols={['Voucher', 'Student', 'Amount', 'Mode', 'Reason', 'Status', 'Requested', 'Branch', 'Actions']}
        empty="No refunds yet — raise one from a student's collected fee."
        rows={rows.map((r): Cell[] => [
          r.refund_no ? { mono: r.refund_no } : { node: <span className="sub">—</span> },
          { node: <div><b className="nm">{r.student_name}</b><div className="sub">{r.enrolment_no}{r.course_name ? ` · ${r.course_name}` : ''}</div></div> },
          { mono: fmtINR(r.amount_minor) },
          { node: <span className="cap">{r.mode}</span> },
          { node: <span className="sub" title={r.reason}>{String(r.reason || '').slice(0, 40)}</span> },
          { b: [...(STATUS_BADGE[r.status] ?? [r.status, 'b-gray']), ...(r.requires_high && r.status === 'pending' ? [] : [])] as any },
          dt(r.requested_at),
          r.branch_name,
          {
            node: <RowBtns items={[
              ...(r.status === 'pending' && can('refund.approve') ? [['check', 'Approve', () => void approve(r)] as [string, string, () => void]] : []),
              ...(r.status === 'pending' && can('refund.approve') ? [['x', 'Reject', () => void reject(r)] as [string, string, () => void]] : []),
              ...(r.status === 'approved' && r.refund_no ? [['doc', 'Refund voucher PDF', () => openPdf(`/refunds/${r.id}/pdf`)] as [string, string, () => void]] : []),
              ...(can('refund.delete') && r.status !== 'approved' ? [['trash', 'Delete', () => void del(r)] as [string, string, () => void]] : []),
            ]} />,
          },
        ])} />
      {create && <RefundRequestModal onClose={() => setCreate(false)} onDone={() => { setCreate(false); after(); }} />}
      {policy && <RefundPolicyModal onClose={() => setPolicy(false)} />}
      {bulkModal}
    </>
  );
}

/* ==================================================================== */
/*  REQUEST A REFUND                                                     */
/* ==================================================================== */

export function RefundRequestModal({ onClose, onDone, enrolmentId }: { onClose: () => void; onDone: () => void; enrolmentId?: number }) {
  const enrolments = useFetch<any[]>('/enrolments?status=active');
  const meta = useFetch<any>('/refunds/meta');
  const [enrolment, setEnrolment] = useState(enrolmentId ? String(enrolmentId) : '');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('upi');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bal = useFetch<any>(enrolment ? `/refunds/refundable/${enrolment}` : '', [enrolment]);

  const listE = enrolments.data ?? [];
  const modes: Array<{ key: string; label: string }> = meta.data?.modes ?? [{ key: 'upi', label: 'UPI' }];
  const refundable = bal.data ? Number(bal.data.refundable) : null;

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (!enrolment) throw new Error('Choose the enrolment to refund against.');
      if (!reason.trim()) throw new Error('A refund needs a reason.');
      const amt = parseRupees(amount);
      if (!amt || amt <= 0) throw new Error('Enter the refund amount.');
      await api.post('/refunds', { enrolment_id: Number(enrolment), amount, mode, reason, reference: reference || undefined });
      toast('Refund requested — it is now awaiting approval.');
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah"><h3><Ic k="rupee" />New refund</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="rf-enr">Enrolment <span className="star">*</span></label>
              <select id="rf-enr" className="ainp" value={enrolment} onChange={(e) => setEnrolment(e.target.value)} disabled={!!enrolmentId}>
                <option value="">—</option>
                {listE.map((e) => <option key={e.id} value={e.id}>{e.enrolment_no} · {e.lead_name}{e.course_name ? ` · ${e.course_name}` : ''} — net {fmtINR(e.net_fee_minor)}</option>)}
              </select>
              {refundable !== null ? <div className="fhint">Refundable now: <b>{fmtINR(refundable)}</b> (collected minus refunds already approved or awaiting approval).</div> : null}
            </div>
            <div className="fld"><label htmlFor="rf-amt">Amount (₹) <span className="star">*</span> — partial allowed</label><input id="rf-amt" className="ainp" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
            <div className="fld"><label htmlFor="rf-mode">Refund mode <span className="star">*</span></label>
              <select id="rf-mode" className="ainp" value={mode} onChange={(e) => setMode(e.target.value)}>
                {modes.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
            <div className="fld span2"><label htmlFor="rf-reason">Reason <span className="star">*</span></label><input id="rf-reason" className="ainp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this refund being made?" /></div>
            <div className="fld span2"><label htmlFor="rf-ref">Payout reference (UTR / cheque no)</label><input id="rf-ref" className="ainp" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          </div>
          <div className="notice" style={{ marginTop: 10 }}><Ic k="shield" /><div>The refund is created as <b>pending</b> and must be approved by a permitted role before any money is released. A high-value refund needs a senior approver. Nobody can approve their own request.</div></div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Requesting…' : 'Request refund'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  APPROVAL SETTINGS                                                    */
/* ==================================================================== */

export function RefundPolicyModal({ onClose }: { onClose: () => void }) {
  const cur = useFetch<any>('/refunds/policy');
  const [threshold, setThreshold] = useState('');
  const [require_, setRequire] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cur.data) {
      setThreshold(String(Number(cur.data.high_value_over_minor ?? 0) / 100));
      setRequire(!!cur.data.require_approval);
    }
  }, [cur.data]);
  const save = async () => {
    setBusy(true);
    try {
      const amt = parseRupees(threshold);
      await api.post('/refunds/policy', { require_approval: require_, high_value_over_minor: amt });
      toast('Refund approval settings saved'); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 520 }}>
        <div className="ah"><h3><Ic k="shield" />Refund approval settings</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fhint">Refunds always require approval. Set the amount above which a <b>senior</b> approver (refund.approve_high) is required.</div>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <div className="fld span2"><label htmlFor="rf-th">High-value threshold (₹)</label><input id="rf-th" className="ainp" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="25000" /></div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />Save</button>
        </div>
      </div>
    </div>
  );
}
