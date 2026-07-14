/**
 * START CALLING — the on-demand hand-out working queue
 * (Marketing & Lead Management › Start Calling · PROJECT_DOCUMENTATION §4.1).
 *
 * An On Demand campaign parks its leads in a pool, unassigned. The agent clicks
 * **Start Calling**, the server atomically hands them the next 10 (the campaign's
 * `batch_size`) and assigns them. This screen is that batch as a WORK QUEUE: one
 * lead at a time, disposition + next follow-up, progress "3 of 10", then the next
 * batch — with the pool size always visible.
 *
 * TELEPHONY IS OUT OF SCOPE: there is no dialler here. "Call" is the same `tel:`
 * link the lead sheet already offers; the agent dials on their own phone.
 *
 * Managers/admins additionally see the POOL STATUS: how many leads wait in each
 * on-demand campaign, and who pulled what and when.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard, TempBadge } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';

export interface PullCampaign {
  id: number; name: string;
  branch_name?: string; vertical_name?: string; pipeline_name?: string;
  batch_size: number; waiting: number;
}
export interface QueueLead {
  id: number; position: number; actioned_at: string | null;
  disposition_id: number | null; disposition_name: string | null;
  full_name: string; phone: string; email: string | null;
  priority: string; temperature: string | null; score: number | null;
  stage_id: number | null; stage_name: string | null; status_id: number | null;
  course_name: string | null; city_name: string | null; source_name: string | null;
  next_follow_up_at: string | null; created_at: string;
}
export interface Handout {
  id: number; campaign_id: number; campaign_name: string;
  branch_name?: string; vertical_name?: string;
  size: number; requested_size: number; actioned_count: number;
  status: 'open' | 'completed' | 'closed'; created_at: string; completed_at: string | null;
}
export interface Batch {
  handout: Handout | null; leads: QueueLead[];
  stages: Array<{ id: number; name: string; stage_type: string; sort_order: number }>;
  waiting: number;
}
export interface PoolCampaign {
  id: number; name: string; branch_name?: string; vertical_name?: string;
  batch_size: number; agents: number; waiting: number; oldest_waiting_at: string | null;
  handouts_today: number; leads_handed_today: number; open_batches: number;
}
export interface PoolHandout {
  id: number; campaign_id: number; campaign_name: string; user_id: number; user_name: string;
  size: number; actioned_count: number; status: string; created_at: string; completed_at: string | null;
}
export interface PoolStatus {
  campaigns: PoolCampaign[]; handouts: PoolHandout[];
  guard: { enabled: boolean; min_actioned_pct: number };
}

const fmt = (s?: string | null) =>
  !s ? '—' : new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const ago = (s?: string | null) => {
  if (!s) return '—';
  const mins = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
};

/** Progress rail — "3 of 10". */
function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="hbar" style={{ minWidth: 220 }}>
      <div className="top">
        <span>Batch progress</span>
        <b data-testid="progress">{done} of {total}</b>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${pct}%`, background: 'var(--primary)' }} />
      </div>
    </div>
  );
}

export default function StartCalling() {
  const { can, me } = useAuth();
  const ref = useRef_();
  const canPull = can('lead.pull');
  const isManager = can('lead.assign');

  const { data: campaigns, reload: reloadCampaigns } =
    useFetch<PullCampaign[]>(canPull ? '/leads/handout/campaigns' : null);
  const { data: pool, reload: reloadPool } = useFetch<PoolStatus>(isManager ? '/leads/handout/pool' : null);

  const [batch, setBatch] = useState<Batch | null>(null);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  // the agent's live queue (if they left one open)
  useEffect(() => {
    if (!canPull) return;
    api.get<Batch>('/leads/handout/current')
      .then((b) => {
        setBatch(b);
        if (b.handout) {
          setCampaignId(b.handout.campaign_id);
          const next = b.leads.findIndex((l) => !l.actioned_at);
          setIdx(next < 0 ? Math.max(b.leads.length - 1, 0) : next);
        }
      })
      .catch(() => undefined);
  }, [canPull]);

  const list = campaigns ?? [];
  const selected = useMemo<PullCampaign | null>(
    () => list.find((c) => Number(c.id) === Number(campaignId)) ?? list[0] ?? null,
    [list, campaignId],
  );
  const waiting = batch?.handout && selected && batch.handout.campaign_id === selected.id
    ? batch.waiting : selected?.waiting ?? 0;

  const leads = batch?.leads ?? [];
  const done = batch?.handout?.actioned_count ?? 0;
  const total = batch?.handout?.size ?? 0;
  const lead: QueueLead | undefined = leads[idx];
  const finished = !!batch?.handout && done >= total;

  const startCalling = async () => {
    const camp = selected;
    if (!camp) return toast('Pick a campaign to call from', true);
    setBusy(true);
    try {
      const out = await api.post<Batch & { status: 'ok' | 'empty'; message?: string }>(
        '/leads/handout', { campaign_id: camp.id },
      );
      if (out.status === 'empty' || !out.handout) {
        toast(out.message ?? 'No leads are waiting in this pool right now.');
        setBatch({ handout: null, leads: [], stages: [], waiting: 0 });
      } else {
        setBatch(out);
        setIdx(0);
        setForm({});
        toast(`${out.leads.length} lead${out.leads.length === 1 ? '' : 's'} assigned to you — happy calling`);
      }
      reloadCampaigns();
      if (isManager) reloadPool();
    } catch (e: any) {
      toast(e.message, true);
    } finally { setBusy(false); }
  };

  const saveAndNext = async () => {
    if (!batch?.handout || !lead) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { lead_id: lead.id };
      if (form.disposition_id) body.disposition_id = Number(form.disposition_id);
      if (form.stage_id) body.stage_id = Number(form.stage_id);
      if (form.temperature) body.temperature = form.temperature;
      if (form.priority) body.priority = form.priority;
      if (form.note?.trim()) body.note = form.note.trim();
      if (form.next_follow_up_at) body.next_follow_up_at = new Date(form.next_follow_up_at).toISOString();

      const out = await api.post<Batch>(`/leads/handout/${batch.handout.id}/action`, body);
      setBatch(out);
      setForm({});
      const next = out.leads.findIndex((l) => !l.actioned_at);
      setIdx(next < 0 ? out.leads.length - 1 : next);
      if (isManager) reloadPool();
    } catch (e: any) {
      toast(e.message, true);
    } finally { setBusy(false); }
  };

  if (!canPull) {
    return (
      <div className="card">
        <div className="empty-note">
          Start Calling is for the agents in a campaign&apos;s calling pool. Ask an admin for the
          “Pull leads” permission (lead.pull) if you should be calling.
        </div>
      </div>
    );
  }

  const dispositions = ref.dispositions ?? [];

  return (
    <>
      <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="card kpi">
          <div className="ic indigo"><Ic k="leads" /></div>
          <div className="lab">Leads waiting in the pool</div>
          <div className="val" data-testid="waiting">{waiting}</div>
        </div>
        <div className="card kpi">
          <div className="ic cyan"><Ic k="calls" /></div>
          <div className="lab">My batch</div>
          <div className="val">{batch?.handout ? `${done} / ${total}` : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="ic amber"><Ic k="bolt" /></div>
          <div className="lab">Leads per hand-out</div>
          <div className="val">{selected?.batch_size ?? 10}</div>
        </div>
        <div className="card kpi">
          <div className="ic green"><Ic k="check" /></div>
          <div className="lab">Done in this batch</div>
          <div className="val">{done}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3><Ic k="calls" />Call queue</h3>
          <span className="more">On Demand · leads are handed out {selected?.batch_size ?? 10} at a time</span>
        </div>
        <div className="card-pad">
          <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr', padding: 0 }}>
            <div className="fld">
              <label>Campaign <span className="fhint">on-demand campaigns you are in the pool of</span></label>
              <select className="ainp" aria-label="Campaign" value={selected?.id ?? ''}
                disabled={!!batch?.handout && !finished}
                onChange={(e) => { setCampaignId(Number(e.target.value)); }}>
                {list.length === 0 && <option value="">No on-demand campaign available</option>}
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.waiting} waiting
                  </option>
                ))}
              </select>
            </div>
            <div className="fld" style={{ justifyContent: 'flex-end' }}>
              <label>&nbsp;</label>
              <button className="btn primary" disabled={busy || !selected || (!!batch?.handout && !finished)}
                onClick={startCalling}>
                <Ic k="calls" />{batch?.handout ? `Get next ${selected?.batch_size ?? 10}` : 'Start Calling'}
              </button>
            </div>
          </div>

          {!batch?.handout && (
            <div className="empty-note" style={{ marginTop: 10 }} data-testid="idle">
              {list.length === 0
                ? 'You are not in the agent pool of any On Demand campaign yet — ask an admin to add you to the campaign.'
                : waiting === 0
                  ? `No leads waiting in the “${selected?.name}” pool right now. New leads land here the moment they arrive.`
                  : `${waiting} lead${waiting === 1 ? '' : 's'} waiting. Click Start Calling and the next ${Math.min(selected?.batch_size ?? 10, waiting)} will be assigned to you.`}
            </div>
          )}
        </div>
      </div>

      {batch?.handout && (
        <div className="row2" style={{ gridTemplateColumns: '1fr 1.6fr' }}>
          {/* the batch as a queue */}
          <div className="card">
            <div className="card-head">
              <h3><Ic k="list" />My batch</h3>
              <span className="more">{batch.handout.campaign_name}</span>
            </div>
            <div className="card-pad"><Progress done={done} total={total} /></div>
            {leads.map((l, i) => (
              <div className="lrow" key={l.id} style={{ cursor: 'pointer', background: i === idx ? 'var(--surface-3)' : undefined }}
                onClick={() => { setIdx(i); setForm({}); }}>
                <div className={`ic-t ${l.actioned_at ? 'b-green' : i === idx ? 'b-indigo' : 'b-gray'}`}>
                  {l.actioned_at ? <Ic k="check" /> : <Ic k="calls" />}
                </div>
                <div className="gr">
                  <div className="t1">{l.position}. {l.full_name}</div>
                  <div className="t2"><span className="mono">{l.phone}</span>{l.course_name ? ` · ${l.course_name}` : ''}</div>
                </div>
                <span className="rt">
                  {l.actioned_at
                    ? <span className="bdg b-green">{l.disposition_name || 'Done'}</span>
                    : <span className="bdg b-gray">Pending</span>}
                </span>
              </div>
            ))}
            {finished && (
              <div className="card-pad">
                <div className="notice" data-testid="batch-done">
                  <Ic k="check" />
                  <div>
                    <b>Batch complete — {done} of {total} worked.</b>{' '}
                    {waiting > 0
                      ? `${waiting} more lead${waiting === 1 ? '' : 's'} waiting in the pool — pull the next ${Math.min(selected?.batch_size ?? 10, waiting)}.`
                      : 'The pool is empty — nothing else is waiting right now.'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* the lead being worked */}
          <div className="card">
            <div className="card-head">
              <h3><Ic k="leads" />{lead ? `Lead ${idx + 1} of ${total}` : 'Lead'}</h3>
              <span className="more">{lead?.actioned_at ? 'Already worked — you can update it' : 'Log the outcome to move on'}</span>
            </div>
            {!lead ? <div className="card-pad"><div className="empty-note">Nothing left in this batch.</div></div> : (
              <>
                <div className="card-pad">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 17, fontWeight: 700 }}>{lead.full_name}</div>
                    <TempBadge temperature={lead.temperature} score={lead.score} />
                    {lead.priority === 'high' && <span className="bdg b-rose">High priority</span>}
                    {lead.stage_name && <span className="bdg b-indigo">{lead.stage_name}</span>}
                  </div>
                  <div className="sheet-act" style={{ marginTop: 10 }}>
                    <a className="qa call" href={`tel:${lead.phone}`}><Ic k="calls" />Call {lead.phone}</a>
                    <a className="qa wa" href={`https://wa.me/${String(lead.phone).replace(/[^\d]/g, '')}`}
                      target="_blank" rel="noreferrer"><Ic k="wa" />WhatsApp</a>
                    <a className="qa" href={lead.email ? `mailto:${lead.email}` : undefined}
                      onClick={(e) => { if (!lead.email) { e.preventDefault(); toast('No email on this lead', true); } }}>
                      <Ic k="mail" />Email
                    </a>
                  </div>
                  <div className="kv" style={{ marginTop: 12 }}>
                    <div className="f"><label>Course</label><div className="iv"><span>{lead.course_name || '—'}</span></div></div>
                    <div className="f"><label>City</label><div className="iv"><span>{lead.city_name || '—'}</span></div></div>
                    <div className="f"><label>Source</label><div className="iv"><span>{lead.source_name || '—'}</span></div></div>
                    <div className="f"><label>In the pool since</label><div className="iv"><span>{fmt(lead.created_at)}</span></div></div>
                  </div>
                </div>

                <div className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="form-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)', padding: 0 }}>
                    <div className="fld">
                      <label>Disposition</label>
                      <select className="ainp" aria-label="Disposition" value={form.disposition_id ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, disposition_id: e.target.value }))}>
                        <option value="">Select…</option>
                        {dispositions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </div>
                    <div className="fld">
                      <label>Move to stage</label>
                      <select className="ainp" aria-label="Move to stage" value={form.stage_id ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, stage_id: e.target.value }))}>
                        <option value="">Keep {lead.stage_name || 'current stage'}</option>
                        {(batch.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div className="fld">
                      <label>Next follow-up</label>
                      <input className="ainp" type="datetime-local" aria-label="Next follow-up"
                        value={form.next_follow_up_at ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, next_follow_up_at: e.target.value }))} />
                    </div>
                    <div className="fld">
                      <label>Temperature</label>
                      <select className="ainp" aria-label="Temperature" value={form.temperature ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, temperature: e.target.value }))}>
                        <option value="">Unchanged</option>
                        <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
                      </select>
                    </div>
                    <div className="fld span2">
                      <label>Call note</label>
                      <input className="ainp" aria-label="Call note" placeholder="What did they say?"
                        value={form.note ?? ''} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
                    </div>
                  </div>
                </div>
                <div className="sheet-foot">
                  <button className="btn" disabled={busy || idx >= leads.length - 1}
                    onClick={() => { setIdx((i) => Math.min(i + 1, leads.length - 1)); setForm({}); }}>
                    Skip for now
                  </button>
                  <button className="btn primary" disabled={busy} onClick={saveAndNext}>
                    <Ic k="check" />Save &amp; next
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isManager && pool && <PoolStatusCards pool={pool} me={Number(me?.user.id)} />}
    </>
  );
}

/** Manager/admin view: what is waiting where, and who pulled what and when. */
function PoolStatusCards({ pool, me }: { pool: PoolStatus; me: number }) {
  const campRows: Cell[][] = pool.campaigns.map((c) => [
    c.name,
    `${c.branch_name ?? '—'} › ${c.vertical_name ?? '—'}`,
    { b: [String(c.waiting), c.waiting > 0 ? 'b-amber' : 'b-gray'] },
    c.oldest_waiting_at ? `${ago(c.oldest_waiting_at)} old` : '—',
    String(c.batch_size),
    String(c.agents || 'anyone in scope'),
    String(c.open_batches),
    String(c.leads_handed_today),
  ]);
  const hoRows: Cell[][] = pool.handouts.map((h) => [
    { b: [h.user_name + (h.user_id === me ? ' (me)' : ''), 'b-indigo'] },
    h.campaign_name,
    `${h.actioned_count} of ${h.size}`,
    { b: [h.status === 'open' ? 'Working' : h.status === 'completed' ? 'Completed' : 'Superseded',
      h.status === 'completed' ? 'b-green' : h.status === 'open' ? 'b-cyan' : 'b-gray'] },
    fmt(h.created_at),
  ]);
  return (
    <>
      <TableCard
        title="Pool status — On Demand campaigns" icon="target"
        cols={['Campaign', 'Path', 'Leads waiting', 'Oldest', 'Per hand-out', 'Agents', 'Open batches', 'Handed out today']}
        rows={campRows}
        empty="No On Demand campaigns in your scope yet."
        more={pool.guard.enabled
          ? `Guardrail ON — an agent must action ${pool.guard.min_actioned_pct}% of a batch before pulling again`
          : 'Guardrail OFF — agents may pull a fresh batch at any time'}
      />
      <TableCard
        title="Recent hand-outs — who pulled what, and when" icon="clock"
        cols={['Agent', 'Campaign', 'Progress', 'Status', 'Pulled at']}
        rows={hoRows}
        empty="Nobody has pulled a batch yet."
      />
    </>
  );
}
