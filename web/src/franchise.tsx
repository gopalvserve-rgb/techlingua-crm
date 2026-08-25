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
import { useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { DateRange, DateRangeValue } from './daterange';
import { fmtINR, minorToInput } from './money';

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
