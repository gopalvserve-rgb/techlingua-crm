/**
 * FRANCHISE & ROYALTY (Phase 4 Batch 1) — Franchise › {Franchises · Royalty Plans ·
 * Franchise Dashboard · Royalty Statement}. Reuses the existing blocks (TableCard,
 * add-modal, form-grid, Kpis, DateRange) — no new visual language. A franchise maps
 * to one or more Branches; its data = everything under those branches, so the rollup
 * and statement reconcile with Finance.
 *
 * DEFERRED to the next Phase-4 batch: franchise-owner login/RBAC + partner portal,
 * royalty invoicing/payment tracking, franchise-level targets.
 */
import { useState, useEffect } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { DateRange, DateRangeValue } from './daterange';
import { fmtINR, minorToInput } from './money';
import { downloadMatrixCsv } from './listtools';

type Named = { id: number | string; name: string };

const STATUS: Array<[string, string]> = [
  ['prospect', 'Prospect'], ['onboarding', 'Onboarding'], ['active', 'Active'],
  ['suspended', 'Suspended'], ['terminated', 'Terminated'],
];
const MODELS: Array<[string, string]> = [
  ['percent_collected', '% of collected revenue'], ['percent_net', '% of net revenue (after refunds)'],
  ['fixed', 'Fixed monthly fee'], ['tiered', 'Tiered (% varies by revenue band)'],
];
const statusLabel = (s: string) => STATUS.find(([k]) => k === s)?.[1] ?? s;
const modelLabel = (m: string) => MODELS.find(([k]) => k === m)?.[1] ?? m;
const statusBadge = (s: string): [string, string] =>
  s === 'active' ? [statusLabel(s), 'b-green'] : s === 'terminated' || s === 'suspended' ? [statusLabel(s), 'b-rose']
    : s === 'onboarding' ? [statusLabel(s), 'b-indigo'] : [statusLabel(s), 'b-gray'];
const ymd = (v?: string | null) => (v ? String(v).slice(0, 10) : '—');

/* ==================================================================== */
/*  FRANCHISES — list + add/edit/view                                   */
/* ==================================================================== */
export function FranchisesScreen() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/franchises', []);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [view, setView] = useState<any>(null);
  const rows = data ?? [];

  const del = async (f: any) => {
    if (!confirm(`Delete the franchise "${f.name}"?`)) return;
    try { await api.del(`/franchises/${f.id}`); toast('Franchise deleted'); reload(); }
    catch (e) { toast((e as Error).message); }
  };

  return (
    <>
      <div className="page-actions">
        {can('franchise.create') && <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New franchise</button>}
      </div>
      <TableCard
        title="Franchises" icon="fran"
        cols={['Name', 'Code', 'Owner', 'City', 'Branches', 'Status', 'Agreement', '']}
        empty="No franchises yet — add one and map it to the branches it operates."
        rows={rows.map((f): Cell[] => [
          { node: <b>{f.name}</b> },
          f.code,
          f.owner_name || '—',
          f.city || '—',
          String(f.branch_count ?? 0),
          { b: statusBadge(f.status) },
          f.agreement_end ? `till ${ymd(f.agreement_end)}` : '—',
          {
            node: (
              <div className="rowacts">
                <button className="icon-btn sm" title="View" onClick={(e) => { e.stopPropagation(); setView(f); }}><Ic k="eye" /></button>
                {can('franchise.update') && <button className="icon-btn sm" title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(f); }}><Ic k="pencil" /></button>}
                {can('franchise.delete') && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(f); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {(modal || edit) && <FranchiseModal initial={edit} onClose={() => { setModal(false); setEdit(null); }} onSaved={reload} />}
      {view && <FranchiseView id={view.id} onClose={() => setView(null)} />}
    </>
  );
}

function FranchiseView({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useFetch<any>(`/franchises/${id}`, [id]);
  // The franchise scope resolver — the branch_ids that define this franchise's data.
  const scope = useFetch<any>(`/franchises/${id}/scope`, [id]);
  const f = data;
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah"><h3><Ic k="fran" />{f?.name ?? 'Franchise'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          {!f ? <div className="sub">Loading…</div> : (
            <div className="form-grid">
              <Read k="Code" v={f.code} /><Read k="Status" v={statusLabel(f.status)} />
              <Read k="Owner" v={f.owner_name} /><Read k="Phone" v={f.owner_phone} />
              <Read k="Email" v={f.owner_email} /><Read k="GST No" v={f.gst_no} />
              <Read k="City" v={f.city} /><Read k="Agreement" v={`${ymd(f.agreement_start)} → ${ymd(f.agreement_end)}`} />
              <div className="fld span2"><label>Address</label><div>{f.address || '—'}</div></div>
              <div className="fld span2"><label>Mapped branches</label>
                <div>{f.branches?.length ? f.branches.map((b: any) => b.name).join(', ') : '— none —'}</div></div>
              <div className="fld span2"><label>Data scope (branch IDs)</label>
                <div>{scope.data ? (scope.data.branch_ids?.length ? scope.data.branch_ids.join(', ') : 'no branches mapped') : '…'}</div>
                <div className="fhint">This franchise’s revenue, dues & royalty roll up from exactly these branch IDs.</div></div>
              {f.note ? <div className="fld span2"><label>Note</label><div>{f.note}</div></div> : null}
            </div>
          )}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
const Read = ({ k, v }: { k: string; v?: string | null }) => (
  <div className="fld"><label>{k}</label><div>{v || '—'}</div></div>
);

function FranchiseModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved?: () => void }) {
  const ref = useRef_();
  const full = useFetch<any>(initial?.id ? `/franchises/${initial.id}` : null, [initial?.id]);
  const cur = full.data ?? initial;
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [code, setCode] = useState<string>(initial?.code ?? '');
  const [ownerName, setOwnerName] = useState<string>(initial?.owner_name ?? '');
  const [ownerEmail, setOwnerEmail] = useState<string>(initial?.owner_email ?? '');
  const [ownerPhone, setOwnerPhone] = useState<string>(initial?.owner_phone ?? '');
  const [address, setAddress] = useState<string>(initial?.address ?? '');
  const [city, setCity] = useState<string>(initial?.city ?? '');
  const [gst, setGst] = useState<string>(initial?.gst_no ?? '');
  const [status, setStatus] = useState<string>(initial?.status ?? 'prospect');
  const [aStart, setAStart] = useState<string>(initial?.agreement_start ? String(initial.agreement_start).slice(0, 10) : '');
  const [aEnd, setAEnd] = useState<string>(initial?.agreement_end ? String(initial.agreement_end).slice(0, 10) : '');
  const [note, setNote] = useState<string>(initial?.note ?? '');
  const [branchIds, setBranchIds] = useState<number[]>(initial?.branch_ids ?? []);
  const [seeded, setSeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // When editing, hydrate the branch mapping + full fields once the record loads.
  if (initial?.id && full.data && !seeded) {
    setSeeded(true);
    setName(full.data.name ?? ''); setCode(full.data.code ?? '');
    setOwnerName(full.data.owner_name ?? ''); setOwnerEmail(full.data.owner_email ?? '');
    setOwnerPhone(full.data.owner_phone ?? ''); setAddress(full.data.address ?? '');
    setCity(full.data.city ?? ''); setGst(full.data.gst_no ?? ''); setStatus(full.data.status ?? 'prospect');
    setAStart(full.data.agreement_start ? String(full.data.agreement_start).slice(0, 10) : '');
    setAEnd(full.data.agreement_end ? String(full.data.agreement_end).slice(0, 10) : '');
    setNote(full.data.note ?? ''); setBranchIds(full.data.branch_ids ?? []);
  }
  const toggle = (id: number) => setBranchIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/franchises', {
        id: initial?.id, name, code, owner_name: ownerName, owner_email: ownerEmail, owner_phone: ownerPhone,
        address, city, gst_no: gst, status, agreement_start: aStart || null, agreement_end: aEnd || null,
        note, branch_ids: branchIds,
      });
      toast('Franchise saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const branches: Named[] = (ref.branches ?? []) as any;

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 720 }}>
        <div className="ah"><h3><Ic k="fran" />{initial ? 'Edit franchise' : 'New franchise'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2"><label htmlFor="fr-name">Franchise name <span className="star">*</span></label><input id="fr-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tech Lingua Pune" /></div>
            <div className="fld"><label htmlFor="fr-code">Code <span className="star">*</span></label><input id="fr-code" className="ainp" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="PUN" /></div>
            <div className="fld"><label htmlFor="fr-status">Status</label>
              <select id="fr-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="fld"><label htmlFor="fr-owner">Owner name</label><input id="fr-owner" className="ainp" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-phone">Owner phone</label><input id="fr-phone" className="ainp" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-email">Owner email</label><input id="fr-email" className="ainp" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-gst">GST No</label><input id="fr-gst" className="ainp" value={gst} onChange={(e) => setGst(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-city">City</label><input id="fr-city" className="ainp" value={city} onChange={(e) => setCity(e.target.value)} /></div>
            <div className="fld span2"><label htmlFor="fr-addr">Address</label><textarea id="fr-addr" className="ainp" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-astart">Agreement start</label><input id="fr-astart" className="ainp" type="date" value={aStart} onChange={(e) => setAStart(e.target.value)} /></div>
            <div className="fld"><label htmlFor="fr-aend">Agreement end</label><input id="fr-aend" className="ainp" type="date" value={aEnd} onChange={(e) => setAEnd(e.target.value)} /></div>
            <div className="fld span2">
              <label>Operated branches <span className="star">*</span></label>
              <div className="fhint">A franchise operates one or more branches. Its revenue, dues & royalty roll up from these.</div>
              <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginTop: 6 }}>
                {branches.length === 0 ? <div className="sub">No branches available.</div> : branches.map((b) => (
                  <label key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 2px' }}>
                    <input type="checkbox" checked={branchIds.includes(Number(b.id))} onChange={() => toggle(Number(b.id))} />
                    <span>{b.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="fld span2"><label htmlFor="fr-note">Note</label><textarea id="fr-note" className="ainp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save franchise'}</button></div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  ROYALTY PLANS — list + add/edit                                     */
/* ==================================================================== */
export function RoyaltyPlansScreen() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/royalty-plans', []);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const rows = data ?? [];

  const del = async (p: any) => {
    if (!confirm(`Delete the royalty plan "${p.name}"?`)) return;
    try { await api.del(`/royalty-plans/${p.id}`); toast('Plan deleted'); reload(); }
    catch (e) { toast((e as Error).message); }
  };
  const rate = (p: any) => p.model === 'fixed' ? `${fmtINR(p.fixed_amount_minor)}/mo`
    : p.model === 'tiered' ? `${p.slabs?.length ?? 0} bands (${p.tier_basis})`
      : `${p.percent}%`;

  return (
    <>
      <div className="page-actions">
        {can('royalty.manage') && <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New royalty plan</button>}
      </div>
      <TableCard
        title="Royalty plans" icon="rupee"
        cols={['Plan', 'Franchise', 'Model', 'Rate / Fee', 'Effective', 'Status', '']}
        empty="No royalty plans yet — create one and link it to a franchise."
        rows={rows.map((p): Cell[] => [
          { node: <b>{p.name}</b> },
          p.franchise_name || 'Template (reusable)',
          modelLabel(p.model),
          rate(p),
          `${ymd(p.effective_from)} → ${p.effective_to ? ymd(p.effective_to) : 'open'}`,
          { b: p.status === 'active' ? ['Active', 'b-green'] : ['Inactive', 'b-gray'] },
          {
            node: (
              <div className="rowacts">
                {can('royalty.manage') && <button className="icon-btn sm" title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(p); }}><Ic k="pencil" /></button>}
                {can('royalty.manage') && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(p); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {(modal || edit) && <RoyaltyPlanModal initial={edit} onClose={() => { setModal(false); setEdit(null); }} onSaved={reload} />}
    </>
  );
}

function RoyaltyPlanModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved?: () => void }) {
  const franchises = useFetch<any[]>('/franchises', []);
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [franchiseId, setFranchiseId] = useState<string>(String(initial?.franchise_id ?? ''));
  const [model, setModel] = useState<string>(initial?.model ?? 'percent_collected');
  const [percent, setPercent] = useState<string>(String(initial?.percent ?? ''));
  const [fixed, setFixed] = useState<string>(minorToInput(initial?.fixed_amount_minor));
  const [minGuar, setMinGuar] = useState<string>(minorToInput(initial?.min_guarantee_minor));
  const [tierBasis, setTierBasis] = useState<string>(initial?.tier_basis ?? 'collected');
  const [slabs, setSlabs] = useState<any[]>(initial?.slabs?.length
    ? initial.slabs.map((s: any) => ({ min_amount: minorToInput(s.min_amount_minor), max_amount: minorToInput(s.max_amount_minor), percent: String(s.percent), label: s.label }))
    : [{ min_amount: '0', max_amount: '', percent: '5', label: 'Tier 1' }]);
  const [from, setFrom] = useState<string>(initial?.effective_from ? String(initial.effective_from).slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState<string>(initial?.effective_to ? String(initial.effective_to).slice(0, 10) : '');
  const [status, setStatus] = useState<string>(initial?.status ?? 'active');
  const [note, setNote] = useState<string>(initial?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [pvGross, setPvGross] = useState('100000');
  const [pvRefunds, setPvRefunds] = useState('0');
  const [pvMonths, setPvMonths] = useState('1');
  const [preview, setPreview] = useState<any>(null);
  const runPreview = async () => {
    if (!initial?.id) { toast('Save the plan first, then preview a royalty.'); return; }
    const g = Math.round((Number(pvGross) || 0) * 100); const r = Math.round((Number(pvRefunds) || 0) * 100);
    try { setPreview(await api.get<any>(`/royalty-plans/${initial.id}/compute?gross_minor=${g}&refunds_minor=${r}&months=${Number(pvMonths) || 1}`)); }
    catch (e) { toast((e as Error).message); }
  };

  const updSlab = (i: number, k: string, v: any) => setSlabs((arr) => arr.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSlab = () => setSlabs((arr) => [...arr, { min_amount: '', max_amount: '', percent: '0', label: `Tier ${arr.length + 1}` }]);
  const rmSlab = (i: number) => setSlabs((arr) => arr.filter((_, j) => j !== i));

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/royalty-plans', {
        id: initial?.id, name, franchise_id: franchiseId ? Number(franchiseId) : null, model,
        percent: Number(percent || 0), fixed_amount: fixed || '0', min_guarantee: minGuar || '0',
        tier_basis: tierBasis, effective_from: from, effective_to: to || null, status, note,
        slabs: model === 'tiered' ? slabs.map((s) => ({ min_amount: s.min_amount || '0', max_amount: s.max_amount || '', percent: Number(s.percent || 0), label: s.label })) : [],
      });
      toast('Royalty plan saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 860 }}>
        <div className="ah"><h3><Ic k="rupee" />{initial ? 'Edit royalty plan' : 'New royalty plan'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2"><label htmlFor="rp-name">Plan name <span className="star">*</span></label><input id="rp-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="fld"><label htmlFor="rp-fr">Franchise</label>
              <select id="rp-fr" className="ainp" value={franchiseId} onChange={(e) => setFranchiseId(e.target.value)}>
                <option value="">— reusable template —</option>
                {(franchises.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="fld"><label htmlFor="rp-model">Royalty model</label>
              <select id="rp-model" className="ainp" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {(model === 'percent_collected' || model === 'percent_net') && (
              <div className="fld"><label htmlFor="rp-pct">Royalty % <span className="star">*</span></label><input id="rp-pct" className="ainp" type="number" min={0} max={100} step="0.01" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 10" /></div>
            )}
            {model === 'fixed' && (
              <div className="fld"><label htmlFor="rp-fixed">Fixed monthly fee (₹) <span className="star">*</span></label><input id="rp-fixed" className="ainp" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="0.00" /></div>
            )}
            {model === 'tiered' && (
              <div className="fld"><label htmlFor="rp-basis">Band base</label>
                <select id="rp-basis" className="ainp" value={tierBasis} onChange={(e) => setTierBasis(e.target.value)}>
                  <option value="collected">Gross collected</option><option value="net">Net collected (after refunds)</option>
                </select>
              </div>
            )}
            <div className="fld"><label htmlFor="rp-min">Minimum guarantee (₹/mo)</label><input id="rp-min" className="ainp" value={minGuar} onChange={(e) => setMinGuar(e.target.value)} placeholder="0.00" /></div>
            <div className="fld"><label htmlFor="rp-from">Effective from <span className="star">*</span></label><input id="rp-from" className="ainp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="fld"><label htmlFor="rp-to">Effective to</label><input id="rp-to" className="ainp" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <div className="fld"><label htmlFor="rp-status">Status</label>
              <select id="rp-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          {model === 'tiered' && (
            <>
              <div className="sub" style={{ marginTop: 14, marginBottom: 6 }}><b>Revenue bands</b> — the royalty % is the band the period’s {tierBasis === 'net' ? 'net' : 'gross'} collected revenue falls in (from ₹ inclusive).</div>
              <table className="tbl" style={{ width: '100%' }}>
                <thead><tr><th>From (₹)</th><th>To (₹)</th><th>Label</th><th>Royalty %</th><th></th></tr></thead>
                <tbody>
                  {slabs.map((s, i) => (
                    <tr key={i}>
                      <td><input className="ainp" style={{ width: 120 }} value={s.min_amount} onChange={(e) => updSlab(i, 'min_amount', e.target.value)} /></td>
                      <td><input className="ainp" style={{ width: 120 }} value={s.max_amount} placeholder="∞" onChange={(e) => updSlab(i, 'max_amount', e.target.value)} /></td>
                      <td><input className="ainp" value={s.label} onChange={(e) => updSlab(i, 'label', e.target.value)} /></td>
                      <td><input className="ainp" style={{ width: 84 }} type="number" step="0.01" value={s.percent} onChange={(e) => updSlab(i, 'percent', e.target.value)} /></td>
                      <td><button className="icon-btn sm" title="Remove" onClick={() => rmSlab(i)}><Ic k="trash" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn" style={{ marginTop: 8 }} onClick={addSlab}><Ic k="plus" />Add band</button>
            </>
          )}
          <div className="sub" style={{ marginTop: 14 }}>
            <b>Preview royalty</b> — apply the plan to a hypothetical collected / refunds over N months.
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <input className="ainp" style={{ width: 130 }} value={pvGross} onChange={(e) => setPvGross(e.target.value)} placeholder="Gross ₹" aria-label="Gross collected ₹" />
              <input className="ainp" style={{ width: 110 }} value={pvRefunds} onChange={(e) => setPvRefunds(e.target.value)} placeholder="Refunds ₹" aria-label="Refunds ₹" />
              <input className="ainp" style={{ width: 80 }} type="number" min={1} value={pvMonths} onChange={(e) => setPvMonths(e.target.value)} placeholder="Months" aria-label="Months" />
              <button className="btn" onClick={runPreview}><Ic k="rupee" />Compute</button>
              {preview && (
                <span style={{ fontWeight: 600 }}>{fmtINR(preview.royalty_minor)}
                  <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
                    on {fmtINR(preview.base_minor)} {preview.rate_pct != null ? `@ ${preview.rate_pct}%` : '(fixed)'}{preview.floor_applied ? ' · floor applied' : ''}
                  </span>
                </span>
              )}
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save plan'}</button></div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  FRANCHISE DASHBOARD — franchise selector + DateRange + KPI cards     */
/* ==================================================================== */
export function FranchiseDashboardScreen() {
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const [range, setRange] = useState<DateRangeValue>({});
  const chosen = fid || (list[0] ? String(list[0].id) : '');

  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const dash = useFetch<any>(chosen ? `/franchises/${chosen}/dashboard?${qs.toString()}` : null, [chosen, qs.toString()]);
  const k = dash.data?.kpis;

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="fran" />
          <select value={chosen} onChange={(e) => setFid(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
            {list.length === 0 ? <option value="">No franchises</option> : list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <DateRange value={range} onChange={setRange} idPrefix="frd-dr" />
      </div>
      {!chosen ? <div className="notice"><Ic k="bolt" /><div>Add a franchise first, then its live KPIs appear here.</div></div> : (
        <>
          <Kpis items={[
            { lab: 'Active branches', val: k ? `${k.active_branches}/${k.total_branches}` : '—', ic: 'branch' },
            { lab: 'Students', val: k ? String(k.students) : '—', ic: 'users' },
            { lab: 'Enrolments', val: k ? String(k.enrolments) : '—', ic: 'list' },
            { lab: 'Revenue collected', val: k ? fmtINR(k.revenue_collected_minor) : '—', ic: 'rupee' },
            { lab: 'Net revenue', val: k ? fmtINR(k.net_revenue_minor) : '—', ic: 'check' },
            { lab: 'Outstanding dues', val: k ? fmtINR(k.outstanding_minor) : '—', ic: 'bolt' },
            { lab: 'Royalty payable', val: k ? fmtINR(k.royalty_payable_minor) : '—', ic: 'rupee' },
            { lab: 'Booked (net fee)', val: k ? fmtINR(k.net_booked_minor) : '—', ic: 'doc' },
          ]} />
          {dash.data?.royalty && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-pad">
                <div className="sub" style={{ marginTop: 0 }}>
                  <b>Royalty — {k?.royalty_plan_name}</b>
                  <div style={{ marginTop: 6 }}>
                    {dash.data.royalty.base_label}: <b>{fmtINR(dash.data.royalty.base_minor)}</b>
                    {dash.data.royalty.rate_pct != null ? ` @ ${dash.data.royalty.rate_pct}%` : ' (fixed monthly fee)'}
                    {' → '}<b>{fmtINR(dash.data.royalty.royalty_minor)}</b>
                    {dash.data.royalty.floor_applied ? ' (minimum guarantee applied)' : ''}
                  </div>
                </div>
              </div>
            </div>
          )}
          {chosen && !k?.royalty_plan_name && (
            <div className="notice" style={{ marginTop: 12 }}><Ic k="bolt" /><div>No active royalty plan for this franchise in the selected period — royalty payable shows ₹0. Add one under Royalty Plans.</div></div>
          )}
        </>
      )}
    </>
  );
}

/* ==================================================================== */
/*  ROYALTY STATEMENT — franchise + period → payable                    */
/* ==================================================================== */
export function RoyaltyStatementScreen() {
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const [range, setRange] = useState<DateRangeValue>({});
  const [adj, setAdj] = useState<string>('0');
  const [stmt, setStmt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const chosen = fid || (list[0] ? String(list[0].id) : '');

  const run = async () => {
    if (!chosen) return;
    setBusy(true);
    const qs = new URLSearchParams();
    if (range.from) qs.set('from', range.from);
    if (range.to) qs.set('to', range.to);
    const cents = Math.round((Number(adj) || 0) * 100);
    if (cents) qs.set('adjustments_minor', String(cents));
    try { setStmt(await api.get<any>(`/franchises/${chosen}/royalty/statement?${qs.toString()}`)); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  const rev = stmt?.revenue; const comp = stmt?.computation;
  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="fran" />
          <select value={chosen} onChange={(e) => setFid(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
            {list.length === 0 ? <option value="">No franchises</option> : list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <DateRange value={range} onChange={setRange} idPrefix="rst-dr" />
        <label className="fchip"><Ic k="rupee" />
          <input value={adj} onChange={(e) => setAdj(e.target.value)} placeholder="Adjustments ₹" aria-label="Adjustments ₹"
            style={{ width: 110, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} />
        </label>
        <button className="btn primary" disabled={busy || !chosen} onClick={run}><Ic k="doc" />{busy ? 'Computing…' : 'Generate statement'}</button>
      </div>
      {!stmt ? <div className="notice"><Ic k="bolt" /><div>Pick a franchise + period and generate the royalty statement.</div></div> : (
        <TableCard title={`Royalty statement — ${stmt.franchise.name} (${stmt.period.from ?? 'all'} → ${stmt.period.to ?? 'all'}, ${stmt.period.months} mo)`} icon="rupee"
          cols={['Line', 'Amount']}
          rows={([
            ['Gross collected', fmtINR(rev.gross_collected_minor)],
            ['Refunds (approved)', `- ${fmtINR(rev.refunds_minor)}`],
            ['Net collected', fmtINR(rev.net_collected_minor)],
            ['Royalty plan', stmt.plan ? `${stmt.plan.name} (${modelLabel(stmt.plan.model)})` : 'No active plan'],
            ['Royalty base', comp ? `${comp.base_label}: ${fmtINR(comp.base_minor)}` : '—'],
            ['Royalty rate', comp ? (comp.rate_pct != null ? `${comp.rate_pct}%` : 'fixed monthly fee') : '—'],
            ['Royalty amount', comp ? fmtINR(comp.royalty_minor) + (comp.floor_applied ? ' (floor)' : '') : fmtINR(0)],
            ['Adjustments', fmtINR(stmt.adjustments_minor)],
            ['Payable', fmtINR(stmt.payable_minor)],
          ] as Array<[string, string]>).map(([lab, val], i): Cell[] => [
            i >= 7 ? { node: <b>{lab}</b> } : lab,
            i >= 7 ? { node: <b>{val}</b> } : { mono: val },
          ])}
        />
      )}
    </>
  );
}

/* ==================================================================== */
/*  PHASE 4 BATCH 2 — royalty ops & lifecycle                           */
/* ==================================================================== */

const INV_STATUS: Record<string, [string, string]> = {
  draft: ['Draft', 'b-gray'], issued: ['Issued', 'b-indigo'], paid: ['Paid', 'b-green'], cancelled: ['Cancelled', 'b-rose'],
};
const invBadge = (s: string): [string, string] => INV_STATUS[s] ?? [s, 'b-gray'];
const MODE_LABEL: Array<[string, string]> = [
  ['bank_transfer', 'Bank transfer'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['card', 'Card'], ['adjustment', 'Adjustment'], ['other', 'Other'],
];

/** A franchise picker chip reused by the ops screens. */
function FranchisePick({ list, value, onChange, allowAll }: { list: any[]; value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  return (
    <label className="fchip"><Ic k="fran" />
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
        {allowAll && <option value="">All franchises</option>}
        {list.length === 0 && !allowAll ? <option value="">No franchises</option>
          : list.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </label>
  );
}

/* -------------------------------------------------------- Record payment -- */
function RoyaltyPaymentModal({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved?: () => void }) {
  const [amount, setAmount] = useState<string>(minorToInput(invoice.outstanding_minor));
  const [paidOn, setPaidOn] = useState<string>(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<string>('bank_transfer');
  const [reference, setReference] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr(''); setBusy(true);
    const cents = Math.round((Number(amount) || 0) * 100);
    try {
      await api.post(`/royalty-invoices/${invoice.id}/payments`, { amount_minor: cents, paid_on: paidOn, mode, reference, note });
      toast('Payment recorded'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 520 }}>
        <div className="ah"><h3><Ic k="rupee" />Record royalty payment — {invoice.invoice_no}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="sub" style={{ marginTop: 0 }}>Outstanding <b>{fmtINR(invoice.outstanding_minor)}</b> of {fmtINR(invoice.amount_minor)}.</div>
          <div className="form-grid">
            <div className="fld"><label htmlFor="rpay-amt">Amount (₹) <span className="star">*</span></label><input id="rpay-amt" className="ainp" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div className="fld"><label htmlFor="rpay-date">Paid on</label><input id="rpay-date" className="ainp" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></div>
            <div className="fld"><label htmlFor="rpay-mode">Mode</label>
              <select id="rpay-mode" className="ainp" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODE_LABEL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="fld"><label htmlFor="rpay-ref">Reference</label><input id="rpay-ref" className="ainp" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no" /></div>
            <div className="fld span2"><label htmlFor="rpay-note">Note</label><input id="rpay-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Record payment'}</button></div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Invoice view --- */
function RoyaltyInvoiceView({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { data, reload } = useFetch<any>(`/royalty-invoices/${id}`, [id]);
  const [pay, setPay] = useState(false);
  const inv = data;
  const delPayment = async (pid: number) => {
    if (!confirm('Delete this payment?')) return;
    try { await api.del(`/royalty-invoices/${id}/payments/${pid}`); toast('Payment deleted'); reload(); onChanged?.(); }
    catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah"><h3><Ic k="rupee" />Royalty invoice {inv?.invoice_no ?? ''}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody" id="roy-invoice-print">
          {!inv ? <div className="notice"><Ic k="bolt" /><div>Loading…</div></div> : (
            <>
              <div className="sub" style={{ marginTop: 0 }}>
                <b>{inv.franchise_name}</b> ({inv.franchise_code}) · {invBadge(inv.status)[0]}<br />
                Period {ymd(inv.period_from)} → {ymd(inv.period_to)} ({inv.months} mo) · Issued {ymd(inv.issue_date)}
              </div>
              <table className="tbl" style={{ width: '100%', marginTop: 8 }}>
                <tbody>
                  <tr><td>Gross collected</td><td style={{ textAlign: 'right' }}>{fmtINR(inv.gross_collected_minor)}</td></tr>
                  <tr><td>Refunds</td><td style={{ textAlign: 'right' }}>- {fmtINR(inv.refunds_minor)}</td></tr>
                  <tr><td>Net collected</td><td style={{ textAlign: 'right' }}>{fmtINR(inv.net_collected_minor)}</td></tr>
                  <tr><td>Royalty plan</td><td style={{ textAlign: 'right' }}>{inv.plan_name || 'No plan'}{inv.rate_pct != null ? ` @ ${inv.rate_pct}%` : ''}</td></tr>
                  <tr><td>Royalty amount</td><td style={{ textAlign: 'right' }}>{fmtINR(inv.royalty_minor)}</td></tr>
                  <tr><td>Adjustments</td><td style={{ textAlign: 'right' }}>{fmtINR(inv.adjustments_minor)}</td></tr>
                  <tr><td><b>Amount payable</b></td><td style={{ textAlign: 'right' }}><b>{fmtINR(inv.amount_minor)}</b></td></tr>
                  <tr><td>Collected</td><td style={{ textAlign: 'right' }}>{fmtINR(inv.paid_minor)}</td></tr>
                  <tr><td><b>Outstanding</b></td><td style={{ textAlign: 'right' }}><b>{fmtINR(inv.outstanding_minor)}</b></td></tr>
                </tbody>
              </table>
              {inv.payments?.length ? (
                <>
                  <div className="sub" style={{ marginTop: 12, marginBottom: 4 }}><b>Payments</b></div>
                  <table className="tbl" style={{ width: '100%' }}>
                    <thead><tr><th>Date</th><th>Amount</th><th>Mode</th><th>Reference</th><th>By</th><th></th></tr></thead>
                    <tbody>
                      {inv.payments.map((p: any) => (
                        <tr key={p.id}>
                          <td>{ymd(p.paid_on)}</td><td>{fmtINR(p.amount_minor)}</td><td>{p.mode}</td><td>{p.reference || '—'}</td><td>{p.by_name || '—'}</td>
                          <td><button className="icon-btn sm" title="Delete payment" onClick={() => void delPayment(p.id)}><Ic k="trash" /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={() => window.print()}><Ic k="doc" />Print / PDF</button>
          {inv && inv.status === 'issued' && inv.outstanding_minor > 0 && <button className="btn primary" onClick={() => setPay(true)}><Ic k="rupee" />Record payment</button>}
        </div>
      </div>
      {pay && inv && <RoyaltyPaymentModal invoice={inv} onClose={() => setPay(false)} onSaved={() => { reload(); onChanged?.(); }} />}
    </div>
  );
}

/* ---------------------------------------------- Generate invoice modal --- */
function GenerateInvoiceModal({ franchises, onClose, onSaved }: { franchises: any[]; onClose: () => void; onSaved?: () => void }) {
  const [fid, setFid] = useState<string>(franchises[0] ? String(franchises[0].id) : '');
  const [range, setRange] = useState<DateRangeValue>({});
  const [adj, setAdj] = useState<string>('0');
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<any>(null);

  const loadPreview = async () => {
    if (!fid) return;
    const qs = new URLSearchParams();
    if (range.from) qs.set('from', range.from);
    if (range.to) qs.set('to', range.to);
    const cents = Math.round((Number(adj) || 0) * 100);
    if (cents) qs.set('adjustments_minor', String(cents));
    try { setPreview(await api.get<any>(`/franchises/${fid}/royalty/statement?${qs.toString()}`)); }
    catch (e) { toast((e as Error).message); }
  };
  useEffect(() => { setPreview(null); }, [fid, range.from, range.to, adj]);

  const save = async () => {
    setErr(''); setBusy(true);
    const cents = Math.round((Number(adj) || 0) * 100);
    try {
      const r = await api.post<{ invoice_no: string }>('/royalty-invoices/from-statement', {
        franchise_id: Number(fid), from: range.from || null, to: range.to || null, adjustments_minor: cents, note, issue: true,
      });
      toast(`Invoice ${r.invoice_no} generated`); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 620 }}>
        <div className="ah"><h3><Ic k="rupee" />Generate royalty invoice</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld"><label htmlFor="gi-fr">Franchise <span className="star">*</span></label>
              <select id="gi-fr" className="ainp" value={fid} onChange={(e) => setFid(e.target.value)}>
                {franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="fld"><label htmlFor="gi-adj">Adjustments (₹)</label><input id="gi-adj" className="ainp" value={adj} onChange={(e) => setAdj(e.target.value)} placeholder="0.00" /></div>
          </div>
          <div className="filters" style={{ marginTop: 6 }}>
            <DateRange value={range} onChange={setRange} idPrefix="gi-dr" />
            <button className="btn" onClick={loadPreview}><Ic k="doc" />Preview statement</button>
          </div>
          {preview && (
            <div className="sub" style={{ marginTop: 8 }}>
              Net collected <b>{fmtINR(preview.revenue.net_collected_minor)}</b> · Royalty <b>{fmtINR(preview.royalty_minor)}</b>
              {' '}· Adjustments {fmtINR(preview.adjustments_minor)} · <b>Payable {fmtINR(preview.payable_minor)}</b>
              {!preview.plan ? <div style={{ color: 'var(--muted)' }}>No active royalty plan for this franchise in the period — the invoice will bill only the adjustments.</div> : null}
            </div>
          )}
          <div className="fld" style={{ marginTop: 8 }}><label htmlFor="gi-note">Note</label><input id="gi-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !fid} onClick={save}><Ic k="check" />{busy ? 'Generating…' : 'Generate & issue'}</button></div>
      </div>
    </div>
  );
}

export function RoyaltyInvoicesScreen() {
  const { can } = useAuth();
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const qs = new URLSearchParams();
  if (fid) qs.set('franchise_id', fid);
  if (status) qs.set('status', status);
  const { data, reload } = useFetch<any[]>(`/royalty-invoices?${qs.toString()}`, [fid, status]);
  const rows = data ?? [];
  const [gen, setGen] = useState(false);
  const [view, setView] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);

  const issue = async (r: any) => { try { await api.post(`/royalty-invoices/${r.id}/status`, { status: 'issued' }); toast('Invoice issued'); reload(); } catch (e) { toast((e as Error).message); } };
  const cancel = async (r: any) => { if (!confirm(`Cancel invoice ${r.invoice_no}?`)) return; try { await api.post(`/royalty-invoices/${r.id}/status`, { status: 'cancelled' }); toast('Invoice cancelled'); reload(); } catch (e) { toast((e as Error).message); } };
  const del = async (r: any) => { if (!confirm(`Delete invoice ${r.invoice_no}?`)) return; try { await api.del(`/royalty-invoices/${r.id}`); toast('Invoice deleted'); reload(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <FranchisePick list={list} value={fid} onChange={setFid} allowAll />
        <label className="fchip"><Ic k="list" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
            <option value="">All statuses</option><option value="draft">Draft</option><option value="issued">Issued</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option>
          </select>
        </label>
        <div style={{ marginLeft: 'auto' }}>
          {can('royalty.manage') && <button className="btn primary" onClick={() => setGen(true)}><Ic k="plus" />Generate invoice</button>}
        </div>
      </div>
      <TableCard
        title="Royalty invoices" icon="rupee"
        cols={['Invoice #', 'Franchise', 'Period', 'Amount', 'Collected', 'Outstanding', 'Status', '']}
        empty="No royalty invoices yet — generate one from a franchise's royalty statement."
        rows={rows.map((r): Cell[] => [
          { node: <a href="#" onClick={(e) => { e.preventDefault(); setView(r); }}><b>{r.invoice_no}</b></a> },
          r.franchise_name,
          `${ymd(r.period_from)} → ${ymd(r.period_to)}`,
          { mono: fmtINR(r.amount_minor) },
          { mono: fmtINR(r.paid_minor) },
          { mono: fmtINR(r.outstanding_minor) },
          { b: invBadge(r.status) },
          {
            node: (
              <div className="rowacts">
                <button className="icon-btn sm" title="View / print" onClick={(e) => { e.stopPropagation(); setView(r); }}><Ic k="eye" /></button>
                {can('royalty.manage') && r.status === 'draft' && <button className="icon-btn sm" title="Issue" onClick={(e) => { e.stopPropagation(); void issue(r); }}><Ic k="check" /></button>}
                {can('royalty.manage') && r.status === 'issued' && r.outstanding_minor > 0 && <button className="icon-btn sm" title="Record payment" onClick={(e) => { e.stopPropagation(); setPay(r); }}><Ic k="rupee" /></button>}
                {can('royalty.manage') && (r.status === 'issued' || r.status === 'draft') && <button className="icon-btn sm" title="Cancel" onClick={(e) => { e.stopPropagation(); void cancel(r); }}><Ic k="x" /></button>}
                {can('royalty.manage') && r.paid_minor === 0 && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(r); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {gen && <GenerateInvoiceModal franchises={list} onClose={() => setGen(false)} onSaved={reload} />}
      {view && <RoyaltyInvoiceView id={view.id} onClose={() => setView(null)} onChanged={reload} />}
      {pay && <RoyaltyPaymentModal invoice={pay} onClose={() => setPay(null)} onSaved={reload} />}
    </>
  );
}

/* --------------------------------------------------- Outstanding royalties */
export function OutstandingRoyaltiesScreen() {
  const { can } = useAuth();
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const qs = new URLSearchParams();
  if (fid) qs.set('franchise_id', fid);
  const { data, reload } = useFetch<any>(`/royalty-invoices/outstanding?${qs.toString()}`, [fid]);
  const [pay, setPay] = useState<any>(null);
  const b = data?.buckets;
  const items = data?.items ?? [];

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <FranchisePick list={list} value={fid} onChange={setFid} allowAll />
      </div>
      <Kpis items={[
        { lab: 'Current (0–30)', val: b ? fmtINR(b.current_minor) : '—', ic: 'check' },
        { lab: '31–60 days', val: b ? fmtINR(b.d30_minor) : '—', ic: 'clock' },
        { lab: '61–90 days', val: b ? fmtINR(b.d60_minor) : '—', ic: 'clock' },
        { lab: '90+ days', val: b ? fmtINR(b.d90_minor) : '—', ic: 'bolt' },
      ]} />
      <div style={{ marginTop: 12 }}>
        <TableCard
          title={`Outstanding royalties${b ? ` — ${fmtINR(b.total_minor)}` : ''}`} icon="rupee"
          cols={['Invoice #', 'Franchise', 'Issued', 'Age', 'Bucket', 'Amount', 'Outstanding', '']}
          empty="No outstanding royalty invoices — everything issued is fully collected."
          rows={items.map((r: any): Cell[] => [
            r.invoice_no, r.franchise_name, ymd(r.issue_date), `${r.age_days}d`,
            { b: r.bucket === 'current' ? ['Current', 'b-green'] : r.bucket === '90+' ? ['90+', 'b-rose'] : [r.bucket, 'b-amber'] },
            { mono: fmtINR(r.amount_minor) },
            { mono: fmtINR(r.outstanding_minor) },
            { node: can('royalty.manage') ? <button className="icon-btn sm" title="Record payment" onClick={() => setPay(r)}><Ic k="rupee" /></button> : <span>—</span> },
          ])}
        />
      </div>
      {pay && <RoyaltyPaymentModal invoice={pay} onClose={() => setPay(null)} onSaved={reload} />}
    </>
  );
}

/* -------------------------------------------------- Agreements & Renewals */
const AGR_STATUS: Record<string, [string, string]> = {
  active: ['Active', 'b-green'], expiring: ['Expiring', 'b-amber'], expired: ['Expired', 'b-rose'], renewed: ['Renewed', 'b-indigo'],
};
function AgreementModal({ initial, franchises, onClose, onSaved }: { initial?: any; franchises: any[]; onClose: () => void; onSaved?: () => void }) {
  const [fid, setFid] = useState<string>(String(initial?.franchise_id ?? (franchises[0]?.id ?? '')));
  const [no, setNo] = useState<string>(initial?.agreement_no ?? '');
  const [sign, setSign] = useState<string>(initial?.sign_date ? String(initial.sign_date).slice(0, 10) : '');
  const [start, setStart] = useState<string>(initial?.start_date ? String(initial.start_date).slice(0, 10) : '');
  const [end, setEnd] = useState<string>(initial?.end_date ? String(initial.end_date).slice(0, 10) : '');
  const [renew, setRenew] = useState<string>(initial?.renewal_date ? String(initial.renewal_date).slice(0, 10) : '');
  const [status, setStatus] = useState<string>(initial?.status ?? 'active');
  const [note, setNote] = useState<string>(initial?.note ?? '');
  const [fileKey, setFileKey] = useState<string>('');
  const [fileName, setFileName] = useState<string>(initial?.has_document ? 'Attached document' : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const { url, r2_key } = await api.post<{ url: string; r2_key: string }>('/franchise-agreements/upload-url', { file_name: file.name, content_type: file.type || 'application/octet-stream' });
      const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      if (!res.ok) throw new Error('Upload failed');
      setFileKey(r2_key); setFileName(file.name); toast('Document uploaded');
    } catch (e) { toast((e as Error).message, true); }
  };
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/franchise-agreements', {
        id: initial?.id, franchise_id: Number(fid), agreement_no: no, sign_date: sign || null,
        start_date: start || null, end_date: end || null, renewal_date: renew || null, status, note,
        document_r2_key: fileKey || null,
      });
      toast('Agreement saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah"><h3><Ic k="doc" />{initial ? 'Edit agreement' : 'New agreement'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld"><label htmlFor="ag-fr">Franchise <span className="star">*</span></label>
              <select id="ag-fr" className="ainp" value={fid} onChange={(e) => setFid(e.target.value)}>
                {franchises.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div className="fld"><label htmlFor="ag-no">Agreement no</label><input id="ag-no" className="ainp" value={no} onChange={(e) => setNo(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ag-sign">Sign date</label><input id="ag-sign" className="ainp" type="date" value={sign} onChange={(e) => setSign(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ag-start">Start</label><input id="ag-start" className="ainp" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ag-end">End</label><input id="ag-end" className="ainp" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ag-renew">Renewal date</label><input id="ag-renew" className="ainp" type="date" value={renew} onChange={(e) => setRenew(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ag-status">Status</label>
              <select id="ag-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option><option value="renewed">Renewed</option><option value="expiring">Expiring</option><option value="expired">Expired</option>
              </select>
            </div>
            <div className="fld"><label htmlFor="ag-doc">Signed document</label>
              <input id="ag-doc" type="file" onChange={(e) => onFile(e.target.files?.[0])} />
              {fileName ? <span className="sub" style={{ marginTop: 4 }}>{fileName}</span> : null}
            </div>
            <div className="fld span2"><label htmlFor="ag-note">Note</label><input id="ag-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !fid} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save agreement'}</button></div>
      </div>
    </div>
  );
}

export function AgreementsScreen() {
  const { can } = useAuth();
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const qs = new URLSearchParams();
  if (fid) qs.set('franchise_id', fid);
  const { data, reload } = useFetch<any[]>(`/franchise-agreements?${qs.toString()}`, [fid]);
  const expiring = useFetch<any[]>('/franchise-agreements/expiring?days=60', []);
  const rows = data ?? [];
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);

  const del = async (a: any) => { if (!confirm('Delete this agreement?')) return; try { await api.del(`/franchise-agreements/${a.id}`); toast('Agreement deleted'); reload(); } catch (e) { toast((e as Error).message); } };
  const openDoc = async (a: any) => { try { const d = await api.get<any>(`/franchise-agreements/${a.id}`); if (d.document_url) window.open(d.document_url, '_blank', 'noopener'); else toast('No document attached', true); } catch (e) { toast((e as Error).message, true); } };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <FranchisePick list={list} value={fid} onChange={setFid} allowAll />
        <div style={{ marginLeft: 'auto' }}>
          {can('franchise.update') && <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New agreement</button>}
        </div>
      </div>
      {(expiring.data ?? []).length > 0 && (
        <div className="notice" style={{ marginBottom: 12 }}><Ic k="clock" />
          <div><b>Renewal reminder</b> — {(expiring.data ?? []).length} agreement(s) expire within 60 days: {(expiring.data ?? []).map((a: any) => `${a.franchise_name} (${ymd(a.end_date)})`).join(', ')}.</div>
        </div>
      )}
      <TableCard
        title="Franchise agreements" icon="doc"
        cols={['Franchise', 'Agreement #', 'Start', 'End', 'Renewal', 'Status', 'Document', '']}
        empty="No agreements yet — add one and attach the signed document."
        rows={rows.map((a): Cell[] => [
          { node: <b>{a.franchise_name}</b> },
          a.agreement_no || '—',
          ymd(a.start_date), ymd(a.end_date), ymd(a.renewal_date),
          { b: AGR_STATUS[a.derived_status] ?? ['—', 'b-gray'] },
          { node: a.has_document ? <a href="#" onClick={(e) => { e.preventDefault(); void openDoc(a); }}>Open</a> : <span>—</span> },
          {
            node: (
              <div className="rowacts">
                {can('franchise.update') && <button className="icon-btn sm" title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(a); }}><Ic k="pencil" /></button>}
                {can('franchise.update') && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(a); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {(modal || edit) && <AgreementModal initial={edit} franchises={list} onClose={() => { setModal(false); setEdit(null); }} onSaved={() => { reload(); expiring.reload(); }} />}
    </>
  );
}

/* -------------------------------------------------------------- Onboarding */
export function FranchiseOnboardingScreen() {
  const { can } = useAuth();
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const chosen = fid || (list[0] ? String(list[0].id) : '');
  const { data, reload } = useFetch<any>(chosen ? `/franchises/${chosen}/onboarding` : null, [chosen]);
  const [newStep, setNewStep] = useState('');
  const steps = data?.steps ?? [];

  const toggle = async (s: any) => { try { await api.post(`/franchises/${chosen}/onboarding/${s.id}/toggle`, { done: !s.done }); reload(); } catch (e) { toast((e as Error).message); } };
  const addStep = async () => { const t = newStep.trim(); if (!t) return; try { await api.post(`/franchises/${chosen}/onboarding/steps`, { title: t }); setNewStep(''); reload(); } catch (e) { toast((e as Error).message); } };
  const rmStep = async (s: any) => { if (!confirm('Remove this step?')) return; try { await api.del(`/franchises/${chosen}/onboarding/steps/${s.id}`); reload(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <FranchisePick list={list} value={chosen} onChange={setFid} />
      </div>
      {!chosen ? <div className="notice"><Ic k="bolt" /><div>Add a franchise first, then its onboarding checklist appears here.</div></div> : (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-pad">
              <div className="sub" style={{ marginTop: 0 }}><b>Onboarding progress — {data ? `${data.done}/${data.total} (${data.progress_pct}%)` : '—'}</b></div>
              <div style={{ background: 'var(--line)', borderRadius: 6, height: 10, marginTop: 6, overflow: 'hidden' }}>
                <div style={{ width: `${data?.progress_pct ?? 0}%`, height: '100%', background: 'var(--green, #16a34a)' }} />
              </div>
            </div>
          </div>
          <TableCard
            title="Onboarding steps" icon="check"
            cols={['#', 'Step', 'Done', 'Completed by', 'When', '']}
            empty="No steps — the default template will seed on first load."
            rows={steps.map((s: any, i: number): Cell[] => [
              String(i + 1),
              { node: s.done ? <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{s.title}</span> : <b>{s.title}</b> },
              { node: <input type="checkbox" checked={!!s.done} disabled={!can('franchise.update')} onChange={() => void toggle(s)} /> },
              s.completed_by_name || '—',
              s.completed_at ? ymd(s.completed_at) : '—',
              { node: can('franchise.update') ? <button className="icon-btn sm" title="Remove step" onClick={() => void rmStep(s)}><Ic k="trash" /></button> : <span>—</span> },
            ])}
          />
          {can('franchise.update') && (
            <div className="filters" style={{ marginTop: 10 }}>
              <input className="ainp" style={{ maxWidth: 320 }} value={newStep} onChange={(e) => setNewStep(e.target.value)} placeholder="Add a custom onboarding step…" />
              <button className="btn" onClick={addStep}><Ic k="plus" />Add step</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------- Territory */
export function TerritoryScreen() {
  const { can } = useAuth();
  const franchises = useFetch<any[]>('/franchises', []);
  const list = franchises.data ?? [];
  const [fid, setFid] = useState<string>('');
  const chosen = fid || (list[0] ? String(list[0].id) : '');
  const { data, reload } = useFetch<any[]>(chosen ? `/franchises/${chosen}/territory` : null, [chosen]);
  const rows = data ?? [];
  const [kind, setKind] = useState('city');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  const add = async () => { const v = value.trim(); if (!v) return; try { await api.post(`/franchises/${chosen}/territory`, { kind, value: v, note }); setValue(''); setNote(''); reload(); } catch (e) { toast((e as Error).message); } };
  const del = async (t: any) => { if (!confirm('Remove this territory?')) return; try { await api.del(`/franchises/${chosen}/territory/${t.id}`); reload(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <FranchisePick list={list} value={chosen} onChange={setFid} />
      </div>
      {!chosen ? <div className="notice"><Ic k="bolt" /><div>Add a franchise first, then map its operating territory here.</div></div> : (
        <>
          <TableCard
            title="Territory — allowed operating area(s)" icon="branch"
            cols={['Type', 'Value', 'Note', 'Overlap', '']}
            empty="No territory mapped — add the cities / regions / pincodes this franchise operates in."
            rows={rows.map((t): Cell[] => [
              t.kind,
              { node: <b>{t.value}</b> },
              t.note || '—',
              { node: t.overlaps_with ? <span className="b b-amber" title={`Also mapped to ${t.overlaps_with}`}>Shared: {t.overlaps_with}</span> : <span>—</span> },
              { node: can('franchise.update') ? <button className="icon-btn sm" title="Remove" onClick={() => void del(t)}><Ic k="trash" /></button> : <span>—</span> },
            ])}
          />
          {can('franchise.update') && (
            <div className="filters" style={{ marginTop: 10 }}>
              <select className="ainp" style={{ maxWidth: 140 }} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="city">City</option><option value="region">Region</option><option value="pincode">Pincode</option><option value="area">Area</option>
              </select>
              <input className="ainp" style={{ maxWidth: 240 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Pune / 411001 / West Zone" />
              <input className="ainp" style={{ maxWidth: 240 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
              <button className="btn" onClick={add}><Ic k="plus" />Add territory</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------- Franchise Reports */
export function FranchiseReportsScreen() {
  const [range, setRange] = useState<DateRangeValue>({});
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const { data, reload } = useFetch<any>(`/franchise-reports?${qs.toString()}`, [range.from, range.to]);
  const rows = data?.rows ?? [];
  const t = data?.totals;

  const exportCsv = () => {
    const headers = ['Franchise', 'Code', 'Status', 'Branches', 'Active branches', 'Students', 'Enrolments',
      'Revenue collected', 'Net revenue', 'Outstanding dues', 'Royalty billed', 'Royalty paid', 'Royalty outstanding'];
    const body = rows.map((r: any) => [
      r.franchise_name, r.code, r.status, r.branches, r.active_branches, r.students, r.enrolments,
      (r.revenue_collected_minor / 100).toFixed(2), (r.net_revenue_minor / 100).toFixed(2), (r.outstanding_dues_minor / 100).toFixed(2),
      (r.royalty_billed_minor / 100).toFixed(2), (r.royalty_paid_minor / 100).toFixed(2), (r.royalty_outstanding_minor / 100).toFixed(2),
    ]);
    downloadMatrixCsv('franchise-report.csv', headers, body);
  };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <DateRange value={range} onChange={setRange} idPrefix="frep-dr" />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={reload}><Ic k="refresh" />Refresh</button>
          <button className="btn" onClick={exportCsv}><Ic k="export" />Export CSV</button>
        </div>
      </div>
      <TableCard
        title="Franchise reports — per-franchise rollup" icon="rupee"
        cols={['Franchise', 'Branches', 'Students', 'Enrolments', 'Revenue collected', 'Net revenue', 'Outstanding dues', 'Royalty billed', 'Royalty paid', 'Royalty outstanding']}
        empty="No franchises to report on yet."
        rows={[
          ...rows.map((r: any): Cell[] => [
            { node: <b>{r.franchise_name}</b> },
            `${r.active_branches}/${r.branches}`,
            String(r.students), String(r.enrolments),
            { mono: fmtINR(r.revenue_collected_minor) },
            { mono: fmtINR(r.net_revenue_minor) },
            { mono: fmtINR(r.outstanding_dues_minor) },
            { mono: fmtINR(r.royalty_billed_minor) },
            { mono: fmtINR(r.royalty_paid_minor) },
            { mono: fmtINR(r.royalty_outstanding_minor) },
          ]),
          ...(t ? [[
            { node: <b>Total</b> } as Cell,
            '—', { node: <b>{t.students}</b> } as Cell, { node: <b>{t.enrolments}</b> } as Cell,
            { node: <b>{fmtINR(t.revenue_collected_minor)}</b> } as Cell,
            { node: <b>{fmtINR(t.net_revenue_minor)}</b> } as Cell,
            { node: <b>{fmtINR(t.outstanding_dues_minor)}</b> } as Cell,
            { node: <b>{fmtINR(t.royalty_billed_minor)}</b> } as Cell,
            { node: <b>{fmtINR(t.royalty_paid_minor)}</b> } as Cell,
            { node: <b>{fmtINR(t.royalty_outstanding_minor)}</b> } as Cell,
          ] as Cell[]] : []),
        ]}
      />
    </>
  );
}
