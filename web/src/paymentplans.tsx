/**
 * PAYMENT PLANS + FEE DUES & AGEING + AUTO REMINDERS — Phase 3 Batch 2.
 *
 * India-first throughout: ₹ (fmtINR, Indian grouping), DD-MMM-YYYY dates, IST ageing.
 * FULL list treatment on the Payment Plans list (multi-select FilterMulti filters, Export
 * with values not ids, TableCard column chooser, Refresh, bulk-delete). The Fee Dues view
 * is a derived/read-only ageing report (a "due" is cleared by collecting, not deleted), so
 * it carries every control EXCEPT bulk-delete — declared, not silently omitted.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, HBars, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { useScope } from './scope';
import { FilterMulti, EnumMulti, EnrolmentFeeSetupModal } from './dyn';
import { fmtINR, parseRupees } from './money';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';
import { CollectModal } from './sprint5';

const dt = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const openPdf = (path: string) => { window.open(`/api${path}`, '_blank', 'noopener'); };
const asOpts = (vals: Array<[string, string]>) => vals.map(([id, name]) => ({ id, name }));

const PLAN_TYPE_LABEL: Record<string, string> = { full: 'Full', installment: 'Installment', emi: 'EMI', custom: 'Custom' };
// The enrolment's payment-plan INTENT code (enrolment.payment_plan) → a readable Fee Plan label.
const FEE_PLAN_LABEL: Record<string, string> = { full: 'Full payment', emi_3: '3 installments', emi_6: '6 installments', custom: 'Custom' };
const PLAN_STATUS_BADGE: Record<string, [string, string]> = {
  active: ['Active', 'b-indigo'], completed: ['Completed', 'b-green'], cancelled: ['Cancelled', 'b-gray'],
};
const INST_BADGE: Record<string, [string, string]> = {
  pending: ['Pending', 'b-gray'], partial: ['Partial', 'b-amber'], paid: ['Paid', 'b-green'],
  overdue: ['Overdue', 'b-rose'], waived: ['Waived', 'b-cyan'],
};
const BUCKET_BADGE: Record<string, [string, string]> = {
  not_due: ['Not due', 'b-gray'], b_0_30: ['0–30d', 'b-amber'], b_31_60: ['31–60d', 'b-amber'],
  b_61_90: ['61–90d', 'b-rose'], b_90_plus: ['90+d', 'b-rose'],
};

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title} onClick={(e) => { e.stopPropagation(); fn(); }}><Ic k={icon} /></button>
    ))}
  </div>
);

/** Client-side preview split — mirrors api/schedule.util splitEvenly (server authoritative). */
function splitPreview(total: number, n: number): number[] {
  if (n < 1) return [total];
  const base = Math.floor(total / n); let left = total - base * n;
  return Array.from({ length: n }, () => base + (left-- > 0 ? 1 : 0));
}

/* ==================================================================== */
/*  PAYMENT PLANS LIST                                                   */
/* ==================================================================== */

export function PaymentPlansScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fType, setFType] = useState<string[]>([]);
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fStatus.length) qs.set('status', fStatus.join(','));
  if (fType.length) qs.set('plan_type', fType.join(','));
  if (fBranches.length) qs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) qs.set('vertical_ids', fVerticals.join(','));
  const key = `${qs.toString()}~${tick}`;
  const list = useFetch<any[]>(`/payment-plans?${qs.toString()}`, [key]);
  const summary = useFetch<any>('/payment-plans/summary', [tick]);
  const rows = list.data ?? [];
  const s = summary.data;

  const ids = rows.map((r) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Payment plan', '/payment-plans/bulk-delete/impact', '/payment-plans/bulk-delete', () => { after(); clear(); }, 'ids');

  const del = async (r: any) => {
    if (!confirm(`Delete the payment plan for ${r.enrolment_no}? (Only plans with no payments applied.)`)) return;
    try { await api.del(`/payment-plans/${r.id}`); toast('Plan deleted'); after(); } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      {can('payment_plan.create') && (
        <div className="page-actions"><button className="btn primary" onClick={() => setCreate(true)}><Ic k="plus" />New payment plan</button></div>
      )}
      <Kpis items={[
        { lab: 'Active plans', val: String(s?.active_plans ?? 0), ic: 'doc' },
        { lab: 'Scheduled', val: s ? fmtINR(s.scheduled_minor) : '—', ic: 'rupee' },
        { lab: 'Collected', val: s ? fmtINR(s.collected_minor) : '—', ic: 'rupee' },
        { lab: 'Outstanding', val: s ? fmtINR(s.outstanding_minor) : '—', ic: 'clock' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="search" /><input placeholder="Search enrolment / student" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts([['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled']]) as any} onChange={setFStatus as any} />
        <FilterMulti label="Type" icon="grid" value={fType as any} options={asOpts([['full', 'Full'], ['installment', 'Installment'], ['emi', 'EMI'], ['custom', 'Custom']]) as any} onChange={setFType as any} />
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
      </div>
      <BulkBar count={count} entityLabel="Payment plan" onDelete={() => openBulk(selected)} onClear={clear} note="Plans with payments applied are skipped." />
      <TableCard fill title="Payment Plans" icon="rupee"
        select={can('payment_plan.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('payment-plans.csv', rows.map((r) => ({
          enrolment: r.enrolment_no, student: r.student_name, course: r.course_name || '',
          type: PLAN_TYPE_LABEL[r.plan_type] || r.plan_type, frequency: r.frequency,
          installments: r.installment_count, total: (Number(r.total_minor) / 100).toFixed(2),
          paid: (Number(r.paid_minor) / 100).toFixed(2),
          outstanding: ((Number(r.scheduled_minor) - Number(r.paid_minor)) / 100).toFixed(2),
          overdue: r.overdue_count, branch: r.branch_name, vertical: r.vertical_name, status: r.status,
        })))} onRefresh={after} />}
        cols={['Enrolment', 'Student', 'Type', 'Installments', 'Total', 'Collected', 'Outstanding', 'Overdue', 'Branch', 'Status', 'Actions']}
        empty="No payment plans yet — build one on an enrolment to schedule installments."
        rows={rows.map((r): Cell[] => [
          { node: <b className="mono">{r.enrolment_no}</b> },
          { node: <div><b className="nm">{r.student_name}</b>{r.course_name ? <div className="sub">{r.course_name}</div> : null}</div> },
          { b: [PLAN_TYPE_LABEL[r.plan_type] || r.plan_type, 'b-cyan'] },
          { node: <span>{r.installment_count} · {r.frequency}</span> },
          { mono: fmtINR(r.total_minor) },
          { mono: fmtINR(r.paid_minor) },
          { mono: fmtINR(Number(r.scheduled_minor) - Number(r.paid_minor)) },
          Number(r.overdue_count) > 0 ? { b: [`${r.overdue_count} overdue`, 'b-rose'] } : '—',
          r.branch_name,
          { b: PLAN_STATUS_BADGE[r.status] ?? [r.status, 'b-gray'] },
          {
            node: <RowBtns items={[
              ['eye', 'View schedule', () => setDetail(Number(r.id))],
              ...(can('payment_plan.delete') ? [['trash', 'Delete', () => void del(r)] as [string, string, () => void]] : []),
            ]} />,
          },
        ])} />
      {create && <PlanCreateModal onClose={() => setCreate(false)} onSaved={() => { setCreate(false); after(); }} />}
      {detail != null && <PlanDetailModal id={detail} onClose={() => setDetail(null)} onChanged={after} />}
      {bulkModal}
    </>
  );
}

/* ==================================================================== */
/*  CREATE PLAN                                                          */
/* ==================================================================== */

export function PlanCreateModal({ onClose, onSaved, enrolmentId }: { onClose: () => void; onSaved: () => void; enrolmentId?: number }) {
  const enrolments = useFetch<any[]>('/enrolments?status=active');
  const [enrolment, setEnrolment] = useState(enrolmentId ? String(enrolmentId) : '');
  const [planType, setPlanType] = useState<'full' | 'installment' | 'emi' | 'custom'>('installment');
  const [frequency, setFrequency] = useState<'monthly' | 'weekly'>('monthly');
  const [num, setNum] = useState('3');
  const [down, setDown] = useState('');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const list = enrolments.data ?? [];
  const chosen = list.find((e) => String(e.id) === enrolment);
  const total = chosen ? Number(chosen.net_fee_minor) : 0;

  const preview = useMemo(() => {
    if (!chosen) return [] as Array<{ amount: number; label: string }>;
    if (planType === 'full') return [{ amount: total, label: 'Full payment' }];
    const n = Math.max(1, Number(num) || 1);
    const dp = parseRupees(down) ?? 0;
    const rows: Array<{ amount: number; label: string }> = [];
    if (dp > 0) rows.push({ amount: dp, label: 'Down payment' });
    splitPreview(total - Math.min(dp, total), n).forEach((a, i) => rows.push({ amount: a, label: `Installment ${i + 1}` }));
    return rows;
  }, [chosen, planType, num, down, total]);
  const previewSum = preview.reduce((a, r) => a + r.amount, 0);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (!enrolment) throw new Error('Choose the enrolment to build a plan for.');
      const body: any = {
        enrolment_id: Number(enrolment), plan_type: planType,
        frequency: planType === 'full' ? 'once' : frequency,
        num_installments: planType === 'full' ? 1 : Number(num), start_date: start,
        down_payment: down || undefined, note: note || undefined,
      };
      const r = await api.post<any>('/payment-plans', body);
      toast(`Plan created — ${r.installments} installment(s) scheduled.`);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah"><h3><Ic k="rupee" />New payment plan</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="pp-enr">Enrolment <span className="star">*</span></label>
              <select id="pp-enr" className="ainp" value={enrolment} onChange={(e) => setEnrolment(e.target.value)} disabled={!!enrolmentId}>
                <option value="">—</option>
                {list.map((e) => <option key={e.id} value={e.id}>{e.enrolment_no} · {e.lead_name}{e.course_name ? ` · ${e.course_name}` : ''} — net {fmtINR(e.net_fee_minor)}</option>)}
              </select>
              {chosen ? <div className="fhint">The schedule totals the net fee {fmtINR(total)} exactly.</div> : null}
            </div>
            <div className="fld"><label htmlFor="pp-type">Plan type</label>
              <select id="pp-type" className="ainp" value={planType} onChange={(e) => setPlanType(e.target.value as any)}>
                <option value="full">Full payment</option><option value="installment">Installment</option>
                <option value="emi">EMI</option><option value="custom">Custom</option>
              </select></div>
            {planType !== 'full' && (
              <>
                <div className="fld"><label htmlFor="pp-freq">Frequency</label>
                  <select id="pp-freq" className="ainp" value={frequency} onChange={(e) => setFrequency(e.target.value as any)}>
                    <option value="monthly">Monthly</option><option value="weekly">Weekly</option>
                  </select></div>
                <div className="fld"><label htmlFor="pp-num">No. of installments</label><input id="pp-num" className="ainp" value={num} onChange={(e) => setNum(e.target.value)} /></div>
                <div className="fld"><label htmlFor="pp-down">Down payment (₹)</label><input id="pp-down" className="ainp" value={down} onChange={(e) => setDown(e.target.value)} placeholder="0.00" /></div>
              </>
            )}
            <div className="fld"><label htmlFor="pp-start">First due date</label><input id="pp-start" type="date" className="ainp" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="fld span2"><label htmlFor="pp-note">Note</label><input id="pp-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          {chosen && (
            <div className="totals-box" style={{ marginTop: 10 }}>
              {preview.map((r, i) => <div key={i}><span>{r.label}</span><b>{fmtINR(r.amount)}</b></div>)}
              <div className="grand"><span>Total scheduled</span><b>{fmtINR(previewSum)}</b></div>
            </div>
          )}
          <div className="notice" style={{ marginTop: 10 }}><Ic k="rupee" /><div>Preview only — the server generates the authoritative schedule (installments sum EXACTLY to the net fee).</div></div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Create plan'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  PLAN DETAIL — the schedule                                           */
/* ==================================================================== */

export function PlanDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { data } = useFetch<any>(`/payment-plans/${id}`);
  const pp = data;
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 760 }}>
        <div className="ah"><h3><Ic k="rupee" />Plan — {pp?.enrolment_no || ''}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          {!pp ? <div className="fhint">Loading…</div> : (
            <>
              <div className="kv-grid">
                <div><span className="kl">Student</span><span className="kvv">{pp.student_name}</span></div>
                <div><span className="kl">Course</span><span className="kvv">{pp.course_name || '—'}</span></div>
                <div><span className="kl">Type</span><span className="kvv">{PLAN_TYPE_LABEL[pp.plan_type] || pp.plan_type} · {pp.frequency}</span></div>
                <div><span className="kl">Net fee</span><span className="kvv">{fmtINR(pp.net_fee_minor)}</span></div>
              </div>
              <TableCard title="Installment schedule" icon="list"
                cols={['#', 'Due date', 'Amount', 'Paid', 'Outstanding', 'Status']}
                empty="No installments"
                rows={(pp.installments ?? []).map((it: any): Cell[] => ([
                  String(it.seq_no),
                  dt(it.due_date),
                  { mono: fmtINR(it.amount_minor) },
                  { mono: fmtINR(it.paid_minor) },
                  { mono: fmtINR(it.outstanding_minor) },
                  { b: INST_BADGE[it.effective_status] ?? [it.effective_status, 'b-gray'] },
                ]))} />
              <div className="fhint" style={{ marginTop: 8 }}>Collections recorded in Fee Collection are applied to these installments oldest-due first. Ageing is computed in IST on the Fee Dues screen.</div>
            </>
          )}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  FEE DUES & AGEING                                                    */
/* ==================================================================== */

export function FeeDuesScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [fBucket, setFBucket] = useState<string[]>([]);
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const [fCourses, setFCourses] = useState<number[]>([]);
  const [fOwners, setFOwners] = useState<number[]>([]);
  // client feedback item 3 — Trainer (batch trainer) + Status (per-course enrolment status) filters
  const [fTrainers, setFTrainers] = useState<number[]>([]);
  const [fStatus, setFStatus] = useState<string[]>([]);
  const statusCat = useFetch<any[]>('/students/enrolment-status-catalog', []);
  const [cfg, setCfg] = useState(false);
  // client feedback item 5 — row Actions (fee setup / edit / reminder / collect / receipt)
  const [planFor, setPlanFor] = useState<number | null>(null);       // Fee setup → create a payment plan
  const [planEditFor, setPlanEditFor] = useState<number | null>(null); // Edit → the plan schedule
  const [collectFor, setCollectFor] = useState<number | null>(null);   // Collect fee → the collect modal
  const after = () => setTick((t) => t + 1);

  const remind = async (r: any) => {
    try {
      const res = await api.post<any>('/fee-dues/remind', { enrolment_id: Number(r.enrolment_id) });
      if (res?.already) toast('A reminder was already sent to this student today.');
      else if (res?.skipped === 'no_outstanding') toast('Nothing outstanding — no reminder sent.');
      else if (res?.sent) toast(`Reminder queued on ${(res.channels ?? []).join(', ').toUpperCase()}.`);
      else toast('Reminder recorded — no reachable channel is configured yet.');
    } catch (e) { toast((e as Error).message, true); }
  };
  const downloadReceipt = async (r: any) => {
    try {
      const recs = await api.get<any[]>(`/fees/receipts?enrolment_id=${Number(r.enrolment_id)}`);
      const latest = (recs ?? [])[0];
      if (!latest) { toast('No receipt yet for this enrolment.', true); return; }
      openPdf(`/fees/receipts/${latest.id}/pdf`);
    } catch (e) { toast((e as Error).message, true); }
  };

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (fBucket.length) qs.set('bucket', fBucket.join(','));
  if (fBranches.length) qs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) qs.set('vertical_ids', fVerticals.join(','));
  if (fCourses.length) qs.set('course_ids', fCourses.join(','));
  if (fOwners.length) qs.set('owner_ids', fOwners.join(','));
  if (fTrainers.length) qs.set('trainer_ids', fTrainers.join(','));
  if (fStatus.length) qs.set('course_status', fStatus.join(','));
  const key = `${qs.toString()}~${tick}`;
  const list = useFetch<any[]>(`/fee-dues?${qs.toString()}`, [key]);
  const sQs = new URLSearchParams();
  if (fBranches.length) sQs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) sQs.set('vertical_ids', fVerticals.join(','));
  const summary = useFetch<any>(`/fee-dues/summary?${sQs.toString()}`, [`${sQs.toString()}~${tick}`]);
  const rows = list.data ?? [];
  const s = summary.data;

  const owners = selectableUsers(ref.users ?? []);
  // Trainer filter offers ONLY Trainer-role users (dev/81); falls back to all if role data absent.
  const trainerOpts = (() => {
    const trs = selectableUsers(ref.users ?? []).filter((u: any) =>
      String((u as any).role_names ?? '').split(',').map((r) => r.trim().toLowerCase()).includes('trainer'));
    return trs.length ? trs : selectableUsers(ref.users ?? []);
  })();
  const statusOpts = (statusCat.data ?? []).map((s: any) => ({ id: String(s.code), name: String(s.label ?? s.code) }));
  const bucketBar = (s?.by_bucket ?? []).map((b: any) => ({
    label: `${b.label} — ${b.n}`, val: fmtINR(b.total_minor),
    pct: s && s.outstanding_minor > 0 ? Math.round((b.total_minor * 100) / s.outstanding_minor) : 0,
    color: b.bucket === 'not_due' ? 'var(--indigo)' : (b.bucket === 'b_61_90' || b.bucket === 'b_90_plus') ? 'var(--rose)' : 'var(--amber)',
  }));
  const hbar = (rowsIn: any[], color: string) => {
    const max = Math.max(1, ...rowsIn.map((r) => r.total_minor));
    return rowsIn.map((r) => ({ label: r.label, val: fmtINR(r.total_minor), pct: Math.round((r.total_minor * 100) / max), color }));
  };

  return (
    <>
      {can('payment_plan.update') && (
        <div className="page-actions"><button className="btn" onClick={() => setCfg(true)}><Ic k="bell" />Reminder settings</button></div>
      )}
      <Kpis items={[
        { lab: 'Total outstanding', val: s ? fmtINR(s.outstanding_minor) : '—', ic: 'rupee' },
        { lab: 'Defaulters (>30d)', val: String(s?.defaulters ?? 0), ic: 'flag' },
        { lab: 'Overdue dues', val: String(s?.overdue_count ?? 0), ic: 'clock' },
        { lab: 'Overdue >30d', val: s ? fmtINR(s.overdue_30_minor) : '—', ic: 'clock' },
      ]} />
      <div className="split2">
        <HBars title="Dues ageing (IST)" rows={bucketBar} empty="No outstanding dues" />
        <HBars title="Dues by branch" rows={hbar(s?.by_branch ?? [], 'var(--cyan)')} empty="No dues" />
      </div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="search" /><input placeholder="Search student / enrolment" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
        <FilterMulti label="Ageing" icon="clock" value={fBucket as any} options={asOpts([['not_due', 'Not due'], ['b_0_30', '0–30 days'], ['b_31_60', '31–60 days'], ['b_61_90', '61–90 days'], ['b_90_plus', '90+ days']]) as any} onChange={setFBucket as any} />
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
        <FilterMulti label="Course" icon="book" value={fCourses} options={(ref.courses ?? []) as any} onChange={setFCourses} />
        <FilterMulti label="Trainer" icon="users" value={fTrainers} options={trainerOpts as any} onChange={setFTrainers} />
        <EnumMulti label="Status" icon="flag" value={fStatus} options={statusOpts} onChange={setFStatus} />
        <FilterMulti label="Owner" icon="users" value={fOwners} options={owners as any} onChange={setFOwners} />
      </div>
      <TableCard fill title="Fee Management" icon="clock"
        more={<ListActions onExport={() => downloadObjectsCsv('fee-management.csv', rows.map((r) => ({
          roll_number: r.roll_no || '', enrolment: r.enrolment_no, branch: r.branch_name, vertical: r.vertical_name,
          course: r.course_name || '', level: r.level_summary || '',
          total_fee: (Number(r.total_fee_minor ?? r.amount_minor) / 100).toFixed(2),
          net_fee: (Number(r.net_fee_minor ?? r.amount_minor) / 100).toFixed(2),
          fee_plan: FEE_PLAN_LABEL[r.fee_plan] ?? r.fee_plan ?? '',
          due_fee: (Number(r.outstanding_minor) / 100).toFixed(2),
          status: r.course_status_label || r.course_status || '',
          ageing: (BUCKET_BADGE[r.bucket]?.[0]) ?? r.bucket, days_overdue: r.overdue_days,
          student: r.student_name, trainer: r.trainer_name || '', owner: r.owner_name || '', source: r.source,
        })))} onRefresh={after} />}
        cols={['Student', 'Roll Number', 'Enrolment', 'Branch', 'Vertical', 'Course', 'Level', 'Total Fee', 'Net Fee', 'Fee Plan', 'Due Fee', 'Status', 'Ageing', 'Days overdue', 'Trainer', 'Owner', 'Actions']}
        empty="No outstanding dues — every active enrolment is paid up."
        rows={rows.map((r): Cell[] => [
          { node: <div><b className="nm">{r.student_name}</b>{r.source === 'unplanned' ? <div className="sub">No plan</div> : <div className="sub">Installment {r.seq_no}</div>}</div> },
          { mono: r.roll_no || '—' },
          { mono: r.enrolment_no },
          r.branch_name || '—',
          r.vertical_name || '—',
          r.course_name || '—',
          { node: r.level_summary ? <b>{r.level_summary}</b> : <span className="sub">—</span> },
          { mono: fmtINR(Number(r.total_fee_minor ?? r.amount_minor)) },
          { mono: fmtINR(Number(r.net_fee_minor ?? r.amount_minor)) },
          FEE_PLAN_LABEL[r.fee_plan] ?? r.fee_plan ?? '—',
          { mono: fmtINR(r.outstanding_minor) },
          { node: <span className="bdg b-gray">{r.course_status_label || r.course_status || '—'}</span> },
          { b: BUCKET_BADGE[r.bucket] ?? [r.bucket, 'b-gray'] },
          Number(r.overdue_days) > 0 ? String(r.overdue_days) : '—',
          r.trainer_name || '—',
          r.owner_name || '—',
          {
            node: <RowBtns items={[
              ...(can('payment_plan.create') ? [['cfg', 'Fee setup (payment plan)', () => setPlanFor(Number(r.enrolment_id))] as [string, string, () => void]] : []),
              ...(r.plan_id ? [['pencil', 'Edit plan / schedule', () => setPlanEditFor(Number(r.plan_id))] as [string, string, () => void]] : []),
              ['bell', 'Send fee reminder', () => void remind(r)],
              ...(can('fee.collect') ? [['rupee', 'Collect fee', () => setCollectFor(Number(r.enrolment_id))] as [string, string, () => void]] : []),
              ['doc', 'Download latest receipt', () => void downloadReceipt(r)],
            ]} />,
          },
        ])} />
      {cfg && <ReminderConfigModal onClose={() => setCfg(false)} />}
      {planFor != null && <EnrolmentFeeSetupModal enrolmentId={planFor} onClose={() => setPlanFor(null)} onSaved={() => { setPlanFor(null); after(); }} />}
      {planEditFor != null && <PlanDetailModal id={planEditFor} onClose={() => setPlanEditFor(null)} onChanged={after} />}
      {collectFor != null && <CollectModal enrolmentId={collectFor} onClose={() => setCollectFor(null)} onSaved={() => { setCollectFor(null); after(); }} />}
    </>
  );
}

/* ==================================================================== */
/*  AUTO-REMINDER CONFIG                                                 */
/* ==================================================================== */

export function ReminderConfigModal({ onClose }: { onClose: () => void }) {
  const { data } = useFetch<any>('/fee-reminders/config');
  const [enabled, setEnabled] = useState(true);
  const [channels, setChannels] = useState<string[]>(['whatsapp', 'sms', 'email']);
  const [dueSoon, setDueSoon] = useState('3');
  const [onDue, setOnDue] = useState(true);
  const [overdue, setOverdue] = useState('3, 7');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (data && !loaded) {
    setEnabled(data.enabled !== false);
    setChannels(Array.isArray(data.channels) ? data.channels : ['whatsapp', 'sms', 'email']);
    setDueSoon((Array.isArray(data.due_soon_days) ? data.due_soon_days : []).join(', '));
    setOnDue(data.remind_on_due !== false);
    setOverdue((Array.isArray(data.overdue_days) ? data.overdue_days : []).join(', '));
    setLoaded(true);
  }

  const toggleCh = (c: string) => setChannels((cs) => cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]);
  const parseDays = (v: string) => [...new Set(v.split(',').map((x) => Math.trunc(Number(x.trim()))).filter((n) => Number.isFinite(n) && n > 0))];

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/fee-reminders/config', {
        enabled, channels, due_soon_days: parseDays(dueSoon), remind_on_due: onDue, overdue_days: parseDays(overdue),
      });
      toast('Reminder settings saved');
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah"><h3><Ic k="bell" />Auto fee-reminder settings</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <label className="chk" style={{ marginBottom: 10 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable automatic fee reminders</label>
          <div className="fld"><label>Channels</label>
            <div style={{ display: 'flex', gap: 12 }}>
              {['whatsapp', 'sms', 'email'].map((c) => (
                <label key={c} className="chk"><input type="checkbox" checked={channels.includes(c)} onChange={() => toggleCh(c)} /> {c.toUpperCase()}</label>
              ))}
            </div>
            <div className="fhint">A channel with no credentials degrades cleanly (a skipped/failed row in the send log — no error).</div>
          </div>
          <div className="form-grid">
            <div className="fld"><label htmlFor="rc-ds">Remind days BEFORE due</label><input id="rc-ds" className="ainp" value={dueSoon} onChange={(e) => setDueSoon(e.target.value)} placeholder="3" /><div className="fhint">Comma-separated, e.g. 3, 1</div></div>
            <div className="fld"><label htmlFor="rc-od">Remind days AFTER due (overdue)</label><input id="rc-od" className="ainp" value={overdue} onChange={(e) => setOverdue(e.target.value)} placeholder="3, 7" /></div>
          </div>
          <label className="chk"><input type="checkbox" checked={onDue} onChange={(e) => setOnDue(e.target.checked)} /> Also remind ON the due date</label>
          <div className="notice" style={{ marginTop: 10 }}><Ic k="bell" /><div>Each reminder fires at most once per installment per stage (idempotent). These stages map to the "Installment Due Soon / Due Today / Payment Overdue" automation events.</div></div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
