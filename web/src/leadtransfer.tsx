import { useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast, useRef_ } from './refdata';
import { UserPicker } from './userpicker';
import { ConfirmModal } from './rowactions';

/* ==========================================================================
 * LEAD TRANSFER + BULK ACTIONS (client request, Jul 2026)
 * A lead can be TRANSFERRED to another Branch › Vertical › (Pipeline) › Campaign
 * (strict cascade); its denormalised path is re-parented server-side. Owner behaviour
 * is a choice: keep the owner, or hand to the target campaign's distribution.
 * The Leads list can multi-select and apply a bulk Transfer / Reassign / Pause / Resume.
 * ======================================================================== */

/** Branch › Vertical › (Pipeline) › Campaign strict cascade + owner behaviour, shared by
 *  the single and bulk transfer dialogs. Emits campaign_id + owner_mode. */
function TransferTargetPicker({ value, onChange }: {
  value: { campaign?: number; owner_mode: 'keep' | 'distribute' };
  onChange: (v: { branch?: number; vertical?: number; pipeline?: number; campaign?: number; owner_mode: 'keep' | 'distribute' }) => void;
}) {
  const ref = useRef_();
  const [t, setT] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number }>({});
  const push = (next: typeof t) => { setT(next); onChange({ ...next, owner_mode: value.owner_mode }); };
  const sel = (label: string, icon: string, cur: number | undefined, list: Array<{ id: number; name: string }>, on: (v?: number) => void, disabled?: boolean) => (
    <div className="fld"><label>{label}</label>
      <select value={cur ?? ''} disabled={disabled} onChange={(e) => on(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">{disabled ? 'Pick the parent first…' : 'Select…'}</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
  return (
    <>
      {sel('Branch', 'branch', t.branch, ref.branches, (v) => push({ branch: v }))}
      {sel('Vertical', 'grid', t.vertical, ref.verticals.filter((v) => !t.branch || Number(v.branch_id) === t.branch), (v) => push({ branch: t.branch, vertical: v }), !t.branch)}
      {sel('Pipeline', 'list', t.pipeline, ref.pipelines.filter((p) => !t.vertical || Number(p.vertical_id) === t.vertical), (v) => push({ branch: t.branch, vertical: t.vertical, pipeline: v }), !t.vertical)}
      {sel('Campaign', 'bolt', t.campaign, ref.campaigns.filter((c) => !t.pipeline || Number(c.pipeline_id) === t.pipeline), (v) => push({ ...t, campaign: v }), !t.pipeline)}
      <div className="fld"><label>Owner after transfer</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="qc-src"><input type="radio" name="owner_mode" checked={value.owner_mode === 'keep'}
            onChange={() => onChange({ ...t, owner_mode: 'keep' })} /> Keep the current owner</label>
          <label className="qc-src"><input type="radio" name="owner_mode" checked={value.owner_mode === 'distribute'}
            onChange={() => onChange({ ...t, owner_mode: 'distribute' })} /> Assign via the target campaign's distribution (round-robin)</label>
        </div>
      </div>
    </>
  );
}

/** Single-lead transfer modal. */
export function LeadTransferModal({ leadId, leadName, onDone, onClose }: { leadId: number; leadName?: string; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number; owner_mode: 'keep' | 'distribute' }>({ owner_mode: 'keep' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!v.campaign) return;
    setBusy(true);
    try {
      await api.post(`/leads/${leadId}/transfer`, { campaign_id: v.campaign, owner_mode: v.owner_mode });
      toast(`Lead transferred${v.owner_mode === 'distribute' ? ' and reassigned' : ''}`);
      onDone(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 480 }}>
        <div className="ah"><h3><Ic k="swap" />Transfer lead{leadName ? ` — ${leadName}` : ''}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="empty-note" style={{ fontSize: 12, padding: '2px 2px 10px', textAlign: 'left' }}>
            Move this lead to another Branch / Vertical / Campaign. Its full path is re-parented and the change is recorded on the lead's timeline.
          </div>
          <TransferTargetPicker value={v} onChange={setV} />
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !v.campaign} onClick={go}><Ic k="check" />Transfer</button>
        </div>
      </div>
    </div>
  );
}

/** Bulk transfer modal (N selected leads). */
export function BulkTransferModal({ ids, onDone, onClose }: { ids: number[]; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number; owner_mode: 'keep' | 'distribute' }>({ owner_mode: 'keep' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!v.campaign) return;
    setBusy(true);
    try {
      const r = await api.post<{ transferred: number; skipped: number }>(`/leads/bulk/transfer`, { lead_ids: ids, campaign_id: v.campaign, owner_mode: v.owner_mode });
      toast(`${r.transferred} lead${r.transferred === 1 ? '' : 's'} transferred${r.skipped ? ` · ${r.skipped} skipped (out of scope)` : ''}`);
      onDone(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 480 }}>
        <div className="ah"><h3><Ic k="swap" />Transfer {ids.length} lead{ids.length === 1 ? '' : 's'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="empty-note" style={{ fontSize: 12, padding: '2px 2px 10px', textAlign: 'left' }}>
            Transfer the <b>{ids.length}</b> selected lead{ids.length === 1 ? '' : 's'} to one Branch / Vertical / Campaign. Leads outside your scope are skipped.
          </div>
          <TransferTargetPicker value={v} onChange={setV} />
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !v.campaign} onClick={go}><Ic k="check" />Transfer all</button>
        </div>
      </div>
    </div>
  );
}

/** Bulk reassign modal (N selected leads → one active, in-scope user). */
export function BulkReassignModal({ ids, onDone, onClose }: { ids: number[]; onDone: () => void; onClose: () => void }) {
  const [to, setTo] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const target = to[0];
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api.post<{ reassigned: number; skipped: number; already: number }>(`/leads/bulk/reassign`, { lead_ids: ids, to_user_id: Number(target) });
      toast(`${r.reassigned} lead${r.reassigned === 1 ? '' : 's'} reassigned${r.already ? ` · ${r.already} already owned` : ''}${r.skipped ? ` · ${r.skipped} skipped` : ''}`);
      onDone(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 460 }}>
        <div className="ah"><h3><Ic k="users" />Reassign {ids.length} lead{ids.length === 1 ? '' : 's'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="empty-note" style={{ fontSize: 12, padding: '2px 2px 10px', textAlign: 'left' }}>
            Reassign the <b>{ids.length}</b> selected lead{ids.length === 1 ? '' : 's'} to one user. Only active, in-scope users are offered; out-of-scope leads are skipped.
          </div>
          <div className="fld"><label>Reassign to</label>
            <UserPicker value={to} onChange={setTo} multiple={false} placeholder="Search a user…" />
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !target} onClick={go}><Ic k="check" />Reassign all</button>
        </div>
      </div>
    </div>
  );
}

/** Bulk pause / resume confirm (N selected leads). */
export function BulkPauseModal({ ids, action, onDone, onClose }: { ids: number[]; action: 'pause' | 'resume'; onDone: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<Record<string, number>>(`/leads/bulk/${action}`, { lead_ids: ids });
      const n = r[action === 'pause' ? 'paused' : 'resumed'] ?? 0;
      toast(`${n} lead${n === 1 ? '' : 's'} ${action === 'pause' ? 'paused' : 'resumed'}${r.already ? ` · ${r.already} already ${action === 'pause' ? 'paused' : 'active'}` : ''}${r.skipped ? ` · ${r.skipped} skipped` : ''}`);
      onDone(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <ConfirmModal
      title={`${action === 'pause' ? 'Pause' : 'Resume'} ${ids.length} lead${ids.length === 1 ? '' : 's'}`}
      body={action === 'pause'
        ? <>Paused leads are <b>parked</b>: they are excluded from lead hand-out / distribution and from the SLA &amp; escalation sweeps until resumed. They are not deleted or deactivated.</>
        : <>Resume the selected leads — they return to distribution and the SLA / escalation sweeps.</>}
      confirmLabel={action === 'pause' ? 'Pause leads' : 'Resume leads'}
      busy={busy} onConfirm={go} onClose={onClose} />
  );
}

