import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { ActiveChip, Field, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

/** Cascading-columns manager: Branches › Verticals › Pipelines (+stages) › Campaigns › Sources. */

interface Row { id: number; name: string; code?: string; is_active: boolean; [k: string]: unknown }
type Level = 'branch' | 'vertical' | 'pipeline' | 'campaign' | 'source' | 'stage';

const CHANNELS = ['meta', 'google', 'justdial', 'indiamart', 'form', 'sheet', 'webhook', 'walkin', 'referral', 'manual'];

export function HierarchyPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [branches, setBranches] = useState<Row[]>([]);
  const [verticals, setVerticals] = useState<Row[]>([]);
  const [pipelines, setPipelines] = useState<Row[]>([]);
  const [campaigns, setCampaigns] = useState<Row[]>([]);
  const [sources, setSources] = useState<Row[]>([]);
  const [stages, setStages] = useState<Row[]>([]);
  const [sel, setSel] = useState<{ branch?: Row; vertical?: Row; pipeline?: Row; campaign?: Row }>({});
  const [modal, setModal] = useState<{ level: Level; row?: Row } | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});

  const loadBranches = () => api.get<Row[]>('/branches').then(setBranches).catch((e) => toast(e.message, true));
  useEffect(() => { loadBranches(); }, []);

  useEffect(() => {
    setVerticals([]); setPipelines([]); setCampaigns([]); setSources([]); setStages([]);
    if (sel.branch) api.get<Row[]>(`/verticals?branch_id=${sel.branch.id}`).then(setVerticals);
  }, [sel.branch]);

  useEffect(() => {
    setPipelines([]); setCampaigns([]); setSources([]); setStages([]);
    if (sel.vertical) api.get<Row[]>(`/pipelines?vertical_id=${sel.vertical.id}`).then(setPipelines);
  }, [sel.vertical]);

  useEffect(() => {
    setCampaigns([]); setSources([]); setStages([]);
    if (sel.pipeline) {
      api.get<Row[]>(`/campaigns?pipeline_id=${sel.pipeline.id}`).then(setCampaigns);
      api.get<Row[]>(`/pipelines/${sel.pipeline.id}/stages`).then(setStages);
    }
  }, [sel.pipeline]);

  useEffect(() => {
    setSources([]);
    if (sel.campaign) api.get<Row[]>(`/sources?campaign_id=${sel.campaign.id}`).then(setSources);
  }, [sel.campaign]);

  const open = (level: Level, row?: Row) => {
    setForm(row ? { ...row } : {});
    setModal({ level, row });
  };

  const refresh = (level: Level) => {
    if (level === 'branch') loadBranches();
    if (level === 'vertical' && sel.branch) api.get<Row[]>(`/verticals?branch_id=${sel.branch.id}`).then(setVerticals);
    if (level === 'pipeline' && sel.vertical) api.get<Row[]>(`/pipelines?vertical_id=${sel.vertical.id}`).then(setPipelines);
    if ((level === 'campaign') && sel.pipeline) api.get<Row[]>(`/campaigns?pipeline_id=${sel.pipeline.id}`).then(setCampaigns);
    if (level === 'stage' && sel.pipeline) api.get<Row[]>(`/pipelines/${sel.pipeline.id}/stages`).then(setStages);
    if (level === 'source' && sel.campaign) api.get<Row[]>(`/sources?campaign_id=${sel.campaign.id}`).then(setSources);
  };

  const save = async () => {
    if (!modal) return;
    const { level, row } = modal;
    try {
      const urls: Record<Level, string> = {
        branch: '/branches', vertical: '/verticals', pipeline: '/pipelines',
        campaign: '/campaigns', source: '/sources', stage: `/pipelines/${sel.pipeline?.id}/stages`,
      };
      const body: Record<string, any> = { name: form.name, code: form.code };
      if (level === 'vertical') body.branch_id = sel.branch?.id;
      if (level === 'pipeline') body.vertical_id = sel.vertical?.id;
      if (level === 'campaign') {
        Object.assign(body, {
          pipeline_id: sel.pipeline?.id, cost: Number(form.cost ?? 0), priority: form.priority ?? 'med',
          distribution_config: {
            mode: form.dist_mode ?? 'on_demand',
            batch_size: Number(form.dist_batch ?? 10),
            agent_user_ids: [], round_robin_scope: form.dist_rr_scope ?? 'campaign', conditions: [],
          },
          duplicacy_config: {
            check_scope: form.dup_scope ?? 'this_campaign', match_key: 'phone',
            on_duplicate: form.dup_action ?? 'ignore', open_reassign_same_user: true,
          },
        });
        delete body.code;
      }
      if (level === 'source') {
        Object.assign(body, { campaign_id: sel.campaign?.id, channel: form.channel ?? 'manual' });
        delete body.code;
      }
      if (level === 'stage') {
        Object.assign(body, { stage_type: form.stage_type ?? 'open', sort_order: form.sort_order != null ? Number(form.sort_order) : undefined });
        delete body.code;
      }
      if (row) await api.patch(`${level === 'stage' ? '/stages' : urls[level]}/${row.id}`.replace('//', '/'), body);
      else await api.post(urls[level], body);
      toast('Saved');
      setModal(null);
      refresh(level);
    } catch (e: any) { toast(e.message, true); }
  };

  const toggleActive = async (level: Level, row: Row) => {
    const urls: Record<Level, string> = {
      branch: '/branches', vertical: '/verticals', pipeline: '/pipelines',
      campaign: '/campaigns', source: '/sources', stage: '/stages',
    };
    try {
      await api.patch(`${urls[level]}/${row.id}`, { is_active: !row.is_active });
      refresh(level);
    } catch (e: any) { toast(e.message, true); }
  };

  const col = (
    title: string, level: Level, rows: Row[], selected: Row | undefined,
    onSelect: ((r: Row) => void) | null, canCreate: boolean, enabled: boolean, sub?: (r: Row) => string,
  ) => (
    <div className="hier-col card" style={{ padding: 10, opacity: enabled ? 1 : .45 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="col-title">{title}</div>
        {canCreate && enabled && <button className="btn sm" onClick={() => open(level)}>+</button>}
      </div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button className={`hier-item${selected?.id === r.id ? ' active' : ''}`}
            onClick={() => onSelect?.(r)} style={{ flex: 1 }}>
            <span>
              {r.name} {!r.is_active && <span className="chip off" style={{ fontSize: 9 }}>off</span>}
              {sub && <span className="sub">{sub(r)}</span>}
            </span>
          </button>
          <button className="btn sm" title="Edit" onClick={() => open(level, r)}>✎</button>
        </div>
      ))}
      {!rows.length && enabled && <div className="empty" style={{ padding: 14 }}>None yet</div>}
    </div>
  );

  return (
    <>
      <PageHead crumb={['Administration', 'Hierarchy']} title="Hierarchy"
        sub="Org › Branch › Vertical › Pipeline › Campaign › Source. Select left-to-right; every child inherits its full ancestor path automatically." />
      <div className="hier-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(230px, 1fr))' }}>
        {col('Branches', 'branch', branches, sel.branch, (r) => setSel({ branch: r }), can('branch.create'), true,
          (r) => `${r.city_name ?? ''} ${r.code ?? ''}`.trim())}
        {col('Verticals', 'vertical', verticals, sel.vertical, (r) => setSel({ ...sel, vertical: r, pipeline: undefined, campaign: undefined }),
          can('vertical.create'), !!sel.branch)}
        {col('Pipelines', 'pipeline', pipelines, sel.pipeline, (r) => setSel({ ...sel, pipeline: r, campaign: undefined }),
          can('pipeline.create'), !!sel.vertical)}
        {col('Campaigns', 'campaign', campaigns, sel.campaign, (r) => setSel({ ...sel, campaign: r }),
          can('campaign.create'), !!sel.pipeline, (r) => `${(r as any).priority} priority`)}
      </div>

      {sel.pipeline && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
          <div className="card">
            <div className="card-head">
              <h3>Stages — {sel.pipeline.name}</h3>
              {can('pipeline.update') && <button className="btn sm" onClick={() => open('stage')}>+ Stage</button>}
            </div>
            <table className="table">
              <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Default</th><th /></tr></thead>
              <tbody>
                {stages.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.sort_order}</td>
                    <td><b>{s.name}</b></td>
                    <td><span className={`chip ${s.stage_type === 'won' ? 'ok' : s.stage_type === 'lost' ? 'off' : 'info'}`}>{s.stage_type}</span></td>
                    <td>{s.is_default ? '✓' : ''}</td>
                    <td style={{ textAlign: 'right' }}>
                      {can('pipeline.update') && <button className="btn sm" onClick={() => open('stage', s)}>Edit</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Sources — {sel.campaign ? sel.campaign.name : 'select a campaign'}</h3>
              {sel.campaign && can('source.create') && <button className="btn sm" onClick={() => open('source')}>+ Source</button>}
            </div>
            <table className="table">
              <thead><tr><th>Name</th><th>Channel</th><th>Webhook token</th><th>Status</th><th /></tr></thead>
              <tbody>
                {sources.map((s: any) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td><span className="chip info">{s.channel}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{s.webhook_token ?? '—'}</td>
                    <td><ActiveChip on={s.is_active} /></td>
                    <td style={{ textAlign: 'right' }}>
                      {can('source.update') && <button className="btn sm" onClick={() => toggleActive('source', s)}>{s.is_active ? 'Deactivate' : 'Reactivate'}</button>}
                    </td>
                  </tr>
                ))}
                {sel.campaign && !sources.length && <tr><td colSpan={5} className="empty">No sources yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal wide={modal.level === 'campaign'} title={`${modal.row ? 'Edit' : 'New'} ${modal.level}`} onClose={() => setModal(null)}
          footer={<>
            {modal.row && (
              <button className="btn danger" onClick={() => { toggleActive(modal.level, modal.row!); setModal(null); }}>
                {modal.row.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            )}
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </>}>
          <Field label="Name"><input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          {['branch', 'vertical', 'pipeline'].includes(modal.level) && (
            <Field label="Code"><input className="input" value={form.code ?? ''} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          )}
          {modal.level === 'stage' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Type">
                <select className="input" value={form.stage_type ?? 'open'} onChange={(e) => setForm({ ...form, stage_type: e.target.value })}>
                  <option value="open">open</option><option value="won">won</option><option value="lost">lost</option>
                </select>
              </Field>
              <Field label="Sort order">
                <input className="input" type="number" value={form.sort_order ?? ''} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} />
              </Field>
            </div>
          )}
          {modal.level === 'source' && (
            <Field label="Channel">
              <select className="input" value={form.channel ?? 'manual'} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          )}
          {modal.level === 'campaign' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Cost (INR)"><input className="input" type="number" value={form.cost ?? 0} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
                <Field label="Priority">
                  <select className="input" value={form.priority ?? 'med'} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                    <option value="low">Low</option><option value="med">Medium</option><option value="high">High</option>
                  </select>
                </Field>
              </div>
              <b style={{ fontSize: 12.5 }}>Lead Distribution (NeoDove)</b>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, margin: '8px 0 12px' }}>
                <Field label="Mode">
                  <select className="input" value={form.dist_mode ?? 'on_demand'} onChange={(e) => setForm({ ...form, dist_mode: e.target.value })}>
                    <option value="on_demand">On Demand</option><option value="equal">Equal</option><option value="conditional">Conditional</option>
                  </select>
                </Field>
                <Field label="Batch size (On Demand)">
                  <input className="input" type="number" value={form.dist_batch ?? 10} onChange={(e) => setForm({ ...form, dist_batch: e.target.value })} />
                </Field>
                <Field label="Round-robin scope">
                  <select className="input" value={form.dist_rr_scope ?? 'campaign'} onChange={(e) => setForm({ ...form, dist_rr_scope: e.target.value })}>
                    <option value="branch">branch</option><option value="vertical">vertical</option>
                    <option value="pipeline">pipeline</option><option value="campaign">campaign</option>
                  </select>
                </Field>
              </div>
              <b style={{ fontSize: 12.5 }}>Lead Duplicacy (NeoDove)</b>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                <Field label="Check for duplicates">
                  <select className="input" value={form.dup_scope ?? 'this_campaign'} onChange={(e) => setForm({ ...form, dup_scope: e.target.value })}>
                    <option value="this_campaign">Within This Campaign</option>
                    <option value="this_pipeline">Within This Pipeline</option>
                    <option value="global">All Campaigns (Global)</option>
                  </select>
                </Field>
                <Field label="If duplicate found">
                  <select className="input" value={form.dup_action ?? 'ignore'} onChange={(e) => setForm({ ...form, dup_action: e.target.value })}>
                    <option value="ignore">Ignore Duplicate</option>
                    <option value="merge">Merge Duplicate</option>
                    <option value="create">Create Duplicate Leads</option>
                    <option value="merge_and_reopen">Merge & Reopen Closed Leads</option>
                  </select>
                </Field>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
