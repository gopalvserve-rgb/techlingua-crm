/**
 * Lead Capture Channels (Marketing & Lead Management › Lead Capture).
 *
 * This is the screen the client actually uses to wire Meta up: connect a channel,
 * copy the webhook URL + verify token into Meta / Google / their website, see the
 * connection status, the last lead received, and every inbound event with the
 * reason it succeeded or failed.
 *
 * All four channels feed the SAME ingestion pipeline as the CSV import, so
 * duplicates, distribution, idempotency and audit behave identically — the screen
 * says so, because that is the question the client asks first.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';

export interface FieldSpec {
  key: string; label: string; type: 'text' | 'password' | 'textarea' | 'number' | 'bool' | 'list';
  hint?: string; placeholder?: string; required?: boolean; generated?: boolean;
}
export interface ProviderSpec {
  key: string; label: string; blurb: string; kind: 'webhook' | 'poll';
  endpoint: 'meta' | 'google' | 'form' | 'push' | null;
  config: FieldSpec[]; secrets: FieldSpec[]; setup: string[];
}
export interface Channel {
  id: number; provider: string; provider_label: string; kind: 'webhook' | 'poll'; name: string;
  branch_id: number; vertical_id: number; pipeline_id: number; campaign_id: number; source_id: number;
  branch_name?: string; vertical_name?: string; pipeline_name?: string;
  campaign_name?: string; source_name?: string;
  public_key: string; webhook_path: string | null;
  config: Record<string, unknown>; secrets_masked: Record<string, string>;
  is_active: boolean; status: 'connected' | 'not_configured' | 'inactive'; missing: string[];
  cursor?: { last_row?: number }; next_poll_at?: string | null;
  last_event_at?: string | null; last_lead_at?: string | null;
  last_lead_id?: number | null; last_lead_name?: string | null; last_error?: string | null;
  events_24h?: number; failures_24h?: number; leads_30d?: number;
}
export interface ChannelEvent {
  id: number; provider: string; status: string; reason?: string | null;
  external_key?: string | null; lead_id?: number | null; lead_name?: string | null;
  channel_id: number; channel_name?: string; ip?: string | null; origin?: string | null;
  signature_ok?: boolean | null; created_at: string;
}

const STATUS_BADGE: Record<string, [string, string]> = {
  connected: ['Connected', 'b-green'],
  not_configured: ['Not configured', 'b-amber'],
  inactive: ['Paused', 'b-gray'],
};
const EVENT_BADGE: Record<string, [string, string]> = {
  ingested: ['Lead created', 'b-green'],
  duplicate: ['Duplicate', 'b-cyan'],
  verified: ['Verified', 'b-indigo'],
  skipped: ['Skipped', 'b-gray'],
  rejected: ['Rejected', 'b-rose'],
  failed: ['Failed', 'b-rose'],
};
const PROVIDER_IC: Record<string, string> = {
  meta: 'bolt', google_ads: 'target', website: 'link', google_sheet: 'grid',
  google_form: 'grid', indiamart: 'target', justdial: 'target', tradeindia: 'target',
  housing: 'target', '99acres': 'target', custom: 'cfg', webhook: 'link',
};

/** NeoDove-style grouping of the Available Tools grid. */
const TOOL_GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Ad platforms', keys: ['meta', 'google_ads'] },
  { title: 'Google', keys: ['google_sheet', 'google_form'] },
  { title: 'Marketplaces', keys: ['indiamart', 'justdial', 'tradeindia', 'housing', '99acres'] },
  { title: 'Website, custom & webhook', keys: ['website', 'custom', 'webhook'] },
];
/** PUSH = they post to us (webhook) · PULL = we fetch on a schedule (poll). */
const typeBadge = (kind: string): [string, string] =>
  kind === 'poll' ? ['PULL', 'b-indigo'] : ['PUSH', 'b-cyan'];

const fmt = (s?: string | null) =>
  !s ? '—' : new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const origin = () => (typeof location !== 'undefined' ? location.origin : '');

function copy(text: string, what: string) {
  const done = () => toast(`${what} copied`);
  const nav = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } });
  if (nav.clipboard?.writeText) { void nav.clipboard.writeText(text).then(done, () => toast('Copy failed', true)); return; }
  done();
}

/** A read-only value with a Copy button — the whole point of this screen. */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="fld span2">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="ainp mono" readOnly value={value} aria-label={label} style={{ flex: 1 }}
          onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" type="button" onClick={() => copy(value, label)}><Ic k="doc" />Copy</button>
      </div>
      {hint && <span className="fhint">{hint}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ modal --- */

function ConfigureModal({ spec, channel, onClose, onSaved }: {
  spec: ProviderSpec; channel: Channel | null; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef_();
  const editing = !!channel;
  const [name, setName] = useState(channel?.name ?? spec.label);
  const [target, setTarget] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number; source?: number }>(
    channel
      ? { branch: channel.branch_id, vertical: channel.vertical_id, pipeline: channel.pipeline_id, campaign: channel.campaign_id, source: channel.source_id }
      : {},
  );
  const [config, setConfig] = useState<Record<string, unknown>>({ ...(channel?.config ?? {}) });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<{ verify_token?: string; google_key?: string }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // the two read-back credentials live behind their own channel.manage endpoint
  useEffect(() => {
    if (!channel) return;
    api.get<{ verify_token?: string; google_key?: string }>(`/channels/${channel.id}/credentials`)
      .then(setCreds).catch(() => undefined);
  }, [channel]);

  const verticals = ref.verticals.filter((v) => !target.branch || Number(v.branch_id) === target.branch);
  const pipelines = ref.pipelines.filter((p) => !target.vertical || Number(p.vertical_id) === target.vertical);
  const campaigns = ref.campaigns.filter((c) => !target.pipeline || Number(c.pipeline_id) === target.pipeline);
  const sources = ref.sources.filter((s) => !target.campaign || Number(s.campaign_id) === target.campaign);

  const url = channel?.webhook_path ? `${origin()}${channel.webhook_path}` : '';

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (editing) {
        await api.patch(`/channels/${channel!.id}`, { name, config, secrets });
      } else {
        await api.post('/channels', {
          provider: spec.key, name, campaign_id: target.campaign, source_id: target.source, config, secrets,
        });
      }
      toast(editing ? 'Channel updated' : 'Channel connected');
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const field = (f: FieldSpec, secret: boolean) => {
    const val = secret ? (secrets[f.key] ?? '') : String(config[f.key] ?? '');
    const set = (v: unknown) => secret
      ? setSecrets((s) => ({ ...s, [f.key]: String(v) }))
      : setConfig((c) => ({ ...c, [f.key]: v }));
    const placeholder = secret && channel?.secrets_masked?.[f.key]
      ? `${channel.secrets_masked[f.key]} — leave blank to keep`
      : f.placeholder ?? '';

    return (
      <div className={`fld ${f.type === 'textarea' || f.type === 'list' ? 'span2' : ''}`} key={f.key}>
        <label>{f.label} {f.required && <span className="star">*</span>}</label>
        {f.type === 'bool' ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', textTransform: 'none' }}>
            <input type="checkbox" aria-label={f.label} checked={!!config[f.key]}
              onChange={(e) => set(e.target.checked)} />
            <span className="fhint">{f.hint}</span>
          </label>
        ) : f.type === 'textarea' ? (
          <textarea className="ainp" aria-label={f.label} rows={f.key === 'service_account_json' ? 5 : 3}
            placeholder={placeholder} value={val} onChange={(e) => set(e.target.value)} />
        ) : (
          <input className="ainp" aria-label={f.label}
            type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
            placeholder={placeholder} value={val} onChange={(e) => set(e.target.value)} />
        )}
        {f.type !== 'bool' && f.hint && <span className="fhint">{f.hint}</span>}
      </div>
    );
  };

  const sel = (label: string, value: number | undefined, list: Array<{ id: number; name: string }>,
    set: (v?: number) => void, disabled?: boolean) => (
    <div className="fld" key={label}>
      <label>{label} <span className="star">*</span></label>
      <select className="ainp" aria-label={label} value={value ?? ''} disabled={disabled || editing}
        onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">Select {label}…</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  const ready = editing || (!!target.campaign && !!target.source && !!name.trim());

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 720 }}>
        <div className="ah">
          <h3><Ic k={PROVIDER_IC[spec.key] ?? 'link'} />{editing ? `Configure ${channel!.name}` : `Connect ${spec.label}`}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="notice">
            <Ic k="bolt" />
            <div>
              {spec.blurb} Leads land in the campaign you choose below and follow <b>that campaign's own</b>
              {' '}duplicate rule and assignment rule — exactly like a CSV import. A repeated delivery never creates a second lead.
            </div>
          </div>

          {err && <div className="form-err" role="alert">{err}</div>}

          <div className="form-grid">
            <div className="fld span2">
              <label>Channel name <span className="star">*</span></label>
              <input className="ainp" aria-label="Channel name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {/* where the leads land */}
            {sel('Branch', target.branch, ref.branches, (v) => setTarget({ branch: v }))}
            {sel('Vertical', target.vertical, verticals, (v) => setTarget((t) => ({ ...t, vertical: v, pipeline: undefined, campaign: undefined, source: undefined })), !target.branch)}
            {sel('Pipeline', target.pipeline, pipelines, (v) => setTarget((t) => ({ ...t, pipeline: v, campaign: undefined, source: undefined })), !target.vertical)}
            {sel('Campaign', target.campaign, campaigns, (v) => setTarget((t) => ({ ...t, campaign: v, source: undefined })), !target.pipeline)}
            {sel('Source', target.source, sources, (v) => setTarget((t) => ({ ...t, source: v })), !target.campaign)}
            {editing && (
              <div className="fld">
                <label>Target</label>
                <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>
                  {channel!.branch_name} › {channel!.vertical_name} › {channel!.campaign_name}
                </div>
              </div>
            )}

            {/* what to paste into Meta / Google / the website — only exists once saved */}
            {editing && url && (
              <CopyRow label="Webhook URL" value={url}
                hint={spec.key === 'website'
                  ? 'Your website posts its form JSON here.'
                  : `Paste this into ${spec.key === 'meta' ? 'Meta as the Callback URL' : 'Google Ads as the Webhook URL'}.`} />
            )}
            {editing && spec.key === 'meta' && creds.verify_token && (
              <CopyRow label="Verify token" value={creds.verify_token}
                hint="Paste this into Meta as the Verify Token, next to the Callback URL." />
            )}
            {editing && spec.key === 'google_ads' && creds.google_key && (
              <CopyRow label="Webhook key" value={creds.google_key}
                hint='Paste this into Google Ads as the "Key". Google echoes it back and we reject any payload whose key does not match.' />
            )}

            {spec.config.map((f) => field(f, false))}
            {/* `generated` secrets (Meta verify token, Google webhook key) are minted
                server-side and shown above as a copy-row — never as an editable input. */}
            {spec.secrets.filter((f) => !f.generated).map((f) => field(f, true))}
          </div>

          {/* the copy-pasteable website snippet */}
          {editing && spec.key === 'website' && <Snippet channel={channel!} />}

          <div className="card-pad">
            <h4 style={{ fontSize: 12.5, marginBottom: 8 }}>Setup steps</h4>
            <ol style={{ paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.75 }}>
              {spec.setup.map((s) => <li key={s}>{s}</li>)}
            </ol>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready} onClick={save}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Connect channel'}<Ic k="check" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The copy-pasteable HTML/JS the client drops into their website. */
export function Snippet({ channel }: { channel: Channel }) {
  const url = `${origin()}${channel.webhook_path ?? ''}`;
  const hp = String(channel.config?.honeypot_field ?? 'company_website');
  const code = `<form id="tl-lead-form">
  <input name="name"   placeholder="Your name"     required />
  <input name="phone"  placeholder="Mobile number" required />
  <input name="email"  placeholder="Email" type="email" />
  <input name="course" placeholder="Course you're interested in" />
  <textarea name="message" placeholder="Message"></textarea>
  <!-- honeypot: keep it hidden and empty. Bots fill it; humans never see it. -->
  <input name="${hp}" style="display:none" tabindex="-1" autocomplete="off" />
  <button type="submit">Submit</button>
</form>
<script>
document.getElementById('tl-lead-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var data = Object.fromEntries(new FormData(e.target).entries());
  var res = await fetch('${url}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) { e.target.reset(); alert('Thank you! We will call you shortly.'); }
  else { alert('Sorry, something went wrong. Please call us.'); }
});
</script>`;

  return (
    <div className="card-pad">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ fontSize: 12.5 }}>Paste this into your website</h4>
        <button className="btn" type="button" onClick={() => copy(code, 'Snippet')}><Ic k="doc" />Copy snippet</button>
      </div>
      <pre className="mono" data-testid="form-snippet"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 9,
          padding: 12, fontSize: 11.5, overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre' }}>{code}</pre>
    </div>
  );
}

/* ----------------------------------------------------------------- screen --- */

export default function Channels() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<{ spec: ProviderSpec; channel: Channel | null } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const canRead = can('channel.read');
  const canManage = can('channel.manage');

  const providers = useFetch<ProviderSpec[]>(canRead ? '/channels/providers' : null, []);
  const channels = useFetch<Channel[]>(canRead ? '/channels' : null, [tick]);
  const events = useFetch<ChannelEvent[]>(canRead ? '/channels/events?limit=50' : null, [tick]);

  const list = channels.data ?? [];
  const specs = providers.data ?? [];
  const bump = () => setTick((t) => t + 1);

  const kpis = useMemo(() => {
    const connected = list.filter((c) => c.status === 'connected').length;
    const leads = list.reduce((n, c) => n + (c.leads_30d ?? 0), 0);
    const ev = list.reduce((n, c) => n + (c.events_24h ?? 0), 0);
    const fails = list.reduce((n, c) => n + (c.failures_24h ?? 0), 0);
    return [
      ['Channels connected', `${connected}/${list.length}`, 'link', 'green'],
      ['Leads captured (30d)', String(leads), 'leads', 'indigo'],
      ['Inbound events (24h)', String(ev), 'bolt', 'cyan'],
      ['Rejected / failed (24h)', String(fails), 'shield', fails ? 'rose' : 'green'],
    ] as Array<[string, string, string, string]>;
  }, [list]);

  const pull = async (c: Channel) => {
    setBusyId(c.id);
    try {
      const r = await api.post<{ status: string; created: number; read: number; reason: string }>(`/channels/${c.id}/poll`, {});
      toast(r.status === 'ingested' ? `Pulled ${r.read} row(s) — ${r.created} lead(s) created` : r.reason);
    } catch (e) {
      toast((e as Error).message, true);      // "Not configured — still needed: …" comes through verbatim
    } finally { setBusyId(null); bump(); }
  };

  const toggle = async (c: Channel) => {
    setBusyId(c.id);
    try {
      await api.patch(`/channels/${c.id}`, { is_active: !c.is_active });
      toast(c.is_active ? 'Channel paused' : 'Channel resumed');
    } catch (e) { toast((e as Error).message, true); } finally { setBusyId(null); bump(); }
  };

  // ⋮ Re-Connect — rotate the public URL + generated key (re-auth / refresh).
  const reconnect = async (c: Channel) => {
    if (!confirm(`Re-Connect “${c.name}”?\n\nThis rotates its webhook URL and key. Update the source (Meta / marketplace / your site) with the NEW URL — the old one stops working.`)) return;
    setBusyId(c.id);
    try { await api.post(`/channels/${c.id}/regenerate`, {}); toast('Re-connected — URL & key rotated'); }
    catch (e) { toast((e as Error).message, true); } finally { setBusyId(null); bump(); }
  };

  // ⋮ Delete — soft-delete the connection (event history is kept for audit).
  const del = async (c: Channel) => {
    if (!confirm(`Delete “${c.name}”?\n\nIt stops receiving leads immediately. Its inbound event history is kept for audit.`)) return;
    setBusyId(c.id);
    try { await api.del(`/channels/${c.id}`); toast('Integration deleted'); }
    catch (e) { toast((e as Error).message, true); } finally { setBusyId(null); bump(); }
  };

  // ⋮ Edit / Edit Field Mapping — open the Configure drawer (name, target path,
  // tool config AND the field mapping live there together).
  const openCfg = (c: Channel) => {
    const spec = specs.find((sp) => sp.key === c.provider);
    if (spec) setOpen({ spec, channel: c });
  };

  if (!canRead) {
    return <div className="card"><div className="empty-note">You do not have permission to view lead capture channels.</div></div>;
  }

  return (
    <>
      <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        {kpis.map(([lab, val, ic, tone]) => (
          <div className="card kpi" key={lab}>
            <div className={`ic ${tone}`}><Ic k={ic} /></div>
            <div className="lab">{lab}</div>
            <div className="val">{val}</div>
          </div>
        ))}
      </div>

      <div className="notice">
        <Ic k="bolt" />
        <div>
          Every channel feeds the <b>same ingestion pipeline</b> as the CSV import: phones are normalised,
          the campaign's duplicate rule and assignment rule are applied, and <b>a repeated delivery can never
          create a second lead</b>. Every inbound request is logged below — including the ones we reject — so a
          missing lead can always be traced.
        </div>
      </div>

      {/* ------------------------- Available Tools ----------------------- */}
      {canManage && (() => {
        const grouped = new Set<string>();
        const groups = TOOL_GROUPS
          .map((g) => ({ title: g.title, items: g.keys.map((k) => specs.find((s) => s.key === k)).filter(Boolean) as ProviderSpec[] }))
          .filter((g) => g.items.length);
        groups.forEach((g) => g.items.forEach((s) => grouped.add(s.key)));
        const other = specs.filter((s) => !grouped.has(s.key));
        if (other.length) groups.push({ title: 'Other', items: other });

        const Tool = (s: ProviderSpec) => {
          const [t, tone] = typeBadge(s.kind);
          return (
            <div className="fld" key={s.key}>
              <button className="btn" style={{ justifyContent: 'flex-start', width: '100%' }}
                onClick={() => setOpen({ spec: s, channel: null })}>
                <Ic k={PROVIDER_IC[s.key] ?? 'link'} />{s.label}
                <span className={`bdg ${tone}`} style={{ marginLeft: 'auto' }}>{t}</span>
              </button>
              <span className="fhint">{s.blurb}</span>
            </div>
          );
        };

        return (
          <div className="card" data-testid="available-tools">
            <div className="card-head"><h3><Ic k="plus" />Available Tools</h3>
              <span className="more">Pick a tool, choose Branch › Vertical › Campaign, then map its fields</span></div>
            {groups.map((g) => (
              <div key={g.title} style={{ marginTop: 4 }}>
                <div className="sub" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', margin: '10px 2px 4px', color: 'var(--text-dim)' }}>{g.title}</div>
                <div className="form-grid">{g.items.map(Tool)}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* ---------------------------- channels --------------------------- */}
      <TableCard title="Lead capture channels" icon="link"
        more={`${list.length} configured`}
        cols={['Channel', 'Leads land in', 'Status', 'Last lead received', 'Last event', 'Leads (30d)', '']}
        empty={canManage ? 'No channels yet — connect one above' : 'No channels configured yet'}
        rows={list.map((c): Cell[] => [
          { node: (
            <div>
              <span className="nm">{c.name}</span>
              <div className="sub" style={{ fontSize: 11 }}>{c.provider_label}</div>
            </div>
          ) },
          { node: (
            <span className="sub" style={{ fontSize: 11.5 }}>
              {c.branch_name} › {c.vertical_name} › {c.campaign_name} › {c.source_name}
            </span>
          ) },
          { node: (
            <div>
              <span className={`bdg ${STATUS_BADGE[c.status][1]}`}>{STATUS_BADGE[c.status][0]}</span>
              {c.status === 'not_configured' && !!c.missing.length && (
                <div className="sub" style={{ fontSize: 11, marginTop: 3 }}>Needs: {c.missing.join(', ')}</div>
              )}
              {c.last_error && c.status !== 'not_configured' && (
                <div className="sub" style={{ fontSize: 11, marginTop: 3, color: 'var(--danger)' }}>{c.last_error}</div>
              )}
            </div>
          ) },
          { node: c.last_lead_id
            ? <span>{c.last_lead_name ?? `Lead #${c.last_lead_id}`}<div className="sub" style={{ fontSize: 11 }}>{fmt(c.last_lead_at)}</div></span>
            : <span className="sub">No leads yet</span> },
          fmt(c.last_event_at),
          { mono: String(c.leads_30d ?? 0) },
          { node: (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {c.webhook_path && (
                <button className="btn" title="Copy the webhook URL"
                  onClick={() => copy(`${origin()}${c.webhook_path}`, 'Webhook URL')}><Ic k="doc" />URL</button>
              )}
              {canManage && c.kind === 'poll' && (
                <button className="btn" title="Sync — pull the latest now" disabled={busyId === c.id} onClick={() => pull(c)}>
                  <Ic k="refresh" />{busyId === c.id ? 'Pulling…' : 'Pull now'}
                </button>
              )}
              {canManage && (
                <button className="btn" disabled={busyId === c.id} onClick={() => toggle(c)}>
                  {c.is_active ? 'Pause' : 'Resume'}
                </button>
              )}
              {canManage && (
                <button className="btn" title="Edit field mapping" onClick={() => openCfg(c)}><Ic k="link" />Mapping</button>
              )}
              {canManage && (
                <button className="btn" title="Re-Connect — rotate the URL & key" disabled={busyId === c.id} onClick={() => reconnect(c)}>
                  <Ic k="refresh" />Re-Connect</button>
              )}
              {canManage && (
                <button className="btn primary" title="Edit" onClick={() => openCfg(c)}><Ic k="cfg" />Edit</button>
              )}
              {canManage && (
                <button className="btn" title="Delete integration" disabled={busyId === c.id} onClick={() => del(c)}
                  style={{ color: 'var(--danger)' }}><Ic k="trash" /></button>
              )}
            </div>
          ) },
        ])} />

      {/* -------------------------- inbound events ------------------------ */}
      <TableCard title="Recent inbound events" icon="clock"
        more="every request we received — accepted or rejected"
        cols={['When', 'Channel', 'Result', 'Lead', 'Reference', 'Detail']}
        empty="Nothing received yet — the first Meta / Google / form submission will appear here within seconds"
        rows={(events.data ?? []).map((e): Cell[] => [
          fmt(e.created_at),
          e.channel_name ?? e.provider,
          { b: EVENT_BADGE[e.status] ?? [e.status, 'b-gray'] },
          e.lead_id ? (e.lead_name ?? `#${e.lead_id}`) : '—',
          { mono: e.external_key || '—', dim: true },
          { node: <span className="sub" style={{ fontSize: 11.5 }}>{e.reason || '—'}</span> },
        ])} />

      {open && (
        <ConfigureModal spec={open.spec} channel={open.channel}
          onClose={() => setOpen(null)} onSaved={bump} />
      )}
    </>
  );
}
