/**
 * SPRINT 4 — Engagement & automation, on the prototype's own shell.
 *
 *   · Message Templates   (Engagement › Message Templates) — CRUD + LIVE PREVIEW
 *   · Automation Journeys (Engagement › Automation Journeys) — trigger/condition/action builder
 *   · Bulk WhatsApp / Bulk SMS / Email Campaigns — channel status + the DURABLE SEND LOG + a blast composer
 *   · Administration › Settings — the settings framework, incl. the encrypted credential store
 *
 * Every screen reuses the prototype's existing blocks (card, tbl, add-modal, form-grid,
 * bdg, builder) — no new visual language, no new nav items.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { ApprovalPolicyCard, NumberingCard } from './sprint5';
import { ensureFbSdk, launchEmbeddedSignup } from './whatsappsignup';

/* ============================== types =============================== */

export interface Template {
  id: number; channel: 'whatsapp' | 'sms' | 'email'; name: string; code: string | null;
  vertical_id: number | null; vertical_name?: string | null;
  subject: string | null; body: string;
  wa_template_name: string | null; wa_language: string; wa_params: string[];
  sms_sender_id: string | null; sms_dlt_template_id: string | null;
  variables: string[]; is_active: boolean; used_count?: number;
}
export interface Journey {
  id: number; name: string; description: string | null;
  trigger_type: string; trigger_config: Record<string, unknown>;
  conditions: Record<string, unknown>; actions: JourneyAction[];
  status: 'draft' | 'active' | 'paused';
  branch_id: number | null; vertical_id: number | null;
  runs?: number; failures?: number; last_run_at?: string | null;
}
export interface JourneyAction {
  kind: string; channel?: string; template_id?: number; title?: string; due_in_days?: number;
  priority?: string; assign_to?: string | number; stage_id?: number; body?: string;
  days?: number; hours?: number;
}
export interface Trigger { key: string; label: string; blurb: string; config: string[] }
export interface Message {
  id: number; channel: string; provider: string | null; status: string;
  to_addr: string; subject: string | null; body: string; error: string | null;
  not_configured: boolean; attempts: number; created_at: string; sent_at: string | null;
  lead_id: number | null; lead_name: string | null; template_name: string | null;
  journey_name: string | null; user_name: string | null; vertical_name: string | null;
}
export interface ChannelCfg {
  id: number; channel: string; provider: string; provider_label: string;
  vertical_id: number | null; vertical_name: string | null;
  config: Record<string, unknown>; secrets_masked: Record<string, string>;
  verify_token?: string; is_active: boolean;
  status: 'connected' | 'not_configured' | 'inactive'; missing: string[];
  last_test_at: string | null; last_test_ok: boolean | null; last_test_error: string | null;
}
export interface ProviderSpec {
  key: string; channel: string; label: string; blurb: string; perVertical: boolean;
  config: FieldSpec[]; secrets: FieldSpec[]; setup: string[];
  /** 'send' delivers a real message; 'probe' calls the provider read-only; 'none' cannot be checked */
  test?: 'send' | 'probe' | 'none';
  /** rendered next to a GREEN result — what the pass actually proves, and what it does not */
  testCaveat?: string;
  /** rendered always — what is stored vs. what is actually live (e.g. Cloudflare R2) */
  storedOnly?: string;
}
export interface TestOutcome {
  mode?: string; ok?: boolean; message?: string; caveat?: string; storedOnly?: string;
  detail?: string; status?: string; reason?: string;
}
export interface SignupInfo {
  app_id: string; config_id: string; ready: boolean; missing: string[];
  connected: boolean; connected_via: string; display_phone_number: string;
}
export interface FieldSpec {
  key: string; label: string; type: string; hint?: string; placeholder?: string;
  required?: boolean; opts?: string[]; generated?: boolean;
}
export interface SettingGroup {
  key: string; label: string; blurb: string; icon?: string;
  fields?: Array<{ key: string; label: string; type: string; hint?: string; opts?: string[] }>;
  editor?: string; readonly?: boolean; managedOn?: string;
}

/* ============================= helpers ============================== */

const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const CHANNEL_IC: Record<string, string> = { whatsapp: 'wa', sms: 'chat', email: 'mail' };

const STATUS_BADGE: Record<string, [string, string]> = {
  queued: ['Queued', 'b-cyan'],
  sending: ['Sending', 'b-indigo'],
  sent: ['Sent', 'b-green'],
  delivered: ['Delivered', 'b-green'],
  read: ['Read', 'b-green'],
  failed: ['Failed', 'b-rose'],
  skipped: ['Skipped', 'b-gray'],
};
const CFG_BADGE: Record<string, [string, string]> = {
  connected: ['Connected', 'b-green'],
  not_configured: ['Not configured', 'b-amber'],
  inactive: ['Paused', 'b-gray'],
};

export type IntegrationState = 'not_configured' | 'configured' | 'verified' | 'failed' | 'inactive';

/**
 * THE FOUR-STATE BADGE the client reads at a glance.
 *
 * "Configured" and "Verified" are deliberately DIFFERENT words. Credentials that are
 * merely saved have never been proven; credentials that passed a Test connection have.
 * Collapsing the two would tell him a Razorpay key works when nobody has ever asked
 * Razorpay — which is exactly the class of mistake this whole screen exists to prevent.
 */
export function integrationState(cfg: ChannelCfg | null | undefined): IntegrationState {
  if (!cfg) return 'not_configured';
  if (!cfg.is_active) return 'inactive';
  if (cfg.missing?.length) return 'not_configured';
  if (cfg.last_test_ok === true) return 'verified';
  if (cfg.last_test_ok === false) return 'failed';
  return 'configured';
}

/** Worst-first, so a provider with one broken vertical never reads as Verified. */
export const STATE_RANK: Record<IntegrationState, number> = {
  failed: 0, not_configured: 1, inactive: 2, configured: 3, verified: 4,
};

export const STATE_BADGE: Record<IntegrationState, [string, string]> = {
  not_configured: ['Not configured', 'b-amber'],
  configured: ['Configured — not yet tested', 'b-cyan'],
  verified: ['Verified', 'b-green'],
  failed: ['Test failed', 'b-red'],
  inactive: ['Paused', 'b-gray'],
};
const JOURNEY_BADGE: Record<string, [string, string]> = {
  active: ['Active', 'b-green'], paused: ['Paused', 'b-amber'], draft: ['Draft', 'b-gray'],
};

const fmt = (s?: string | null) =>
  !s ? '—' : new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const bdg = (map: Record<string, [string, string]>, k: string): Cell => {
  const [label, cls] = map[k] ?? [k, 'b-gray'];
  return { b: [label, cls] };
};

/** A row of buttons on a table row. */
function RowBtns({ items }: { items: Array<[string, string, () => void]> }) {
  return (
    <div className="rowacts">
      {items.map(([icon, title, fn]) => (
        <button className="icon-btn sm" key={title} title={title}
          onClick={(e) => { e.stopPropagation(); fn(); }}>
          <Ic k={icon} />
        </button>
      ))}
    </div>
  );
}

/* ==================================================================== */
/*  MESSAGE TEMPLATES                                                   */
/* ==================================================================== */

/**
 * The template editor. The PREVIEW panel calls the same `renderTemplate()` the real send
 * uses (POST /templates/preview), so what the client sees here is exactly what the lead
 * gets — including which variables will come out BLANK, listed in amber.
 */
export function TemplateModal({ initial, onClose, onSaved }: {
  initial?: Template | null; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef_();
  const [channel, setChannel] = useState<string>(initial?.channel ?? 'whatsapp');
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [verticalId, setVerticalId] = useState<string>(initial?.vertical_id ? String(initial.vertical_id) : '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [waName, setWaName] = useState(initial?.wa_template_name ?? '');
  const [waLang, setWaLang] = useState(initial?.wa_language ?? 'en');
  const [waParams, setWaParams] = useState((initial?.wa_params ?? []).join(', '));
  const [senderId, setSenderId] = useState(initial?.sms_sender_id ?? '');
  const [dlt, setDlt] = useState(initial?.sms_dlt_template_id ?? '');
  const [active, setActive] = useState(initial?.is_active !== false);
  const [preview, setPreview] = useState<{ subject: string | null; body: string; wa_params: string[]; missing: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const catalog = useFetch<{ variables: Array<{ key: string; label: string }> }>('/templates/catalog');

  const payload = () => ({
    channel, name, code: code || null, vertical_id: verticalId ? Number(verticalId) : null,
    subject: subject || null, body,
    wa_template_name: waName || null, wa_language: waLang,
    wa_params: waParams.split(',').map((s) => s.trim()).filter(Boolean),
    sms_sender_id: senderId || null, sms_dlt_template_id: dlt || null,
    is_active: active,
  });

  // LIVE preview — debounced, against the sample lead
  useEffect(() => {
    if (!body && !subject) { setPreview(null); return; }
    const t = setTimeout(() => {
      api.post<typeof preview>('/templates/preview', payload()).then(setPreview).catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, subject, body, waParams]);

  const insert = (v: string) => setBody((b) => `${b}{{${v}}}`);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (initial) await api.patch(`/templates/${initial.id}`, payload());
      else await api.post('/templates', payload());
      toast(initial ? 'Template updated' : 'Template created');
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 900 }}>
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit template — ${initial.name}` : 'Add message template'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="t-channel">Channel <span className="star">*</span></label>
              <select id="t-channel" className="ainp" value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="t-name">Template Name <span className="star">*</span></label>
              <input id="t-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Welcome — new lead" />
            </div>
            <div className="fld">
              <label htmlFor="t-code">Code</label>
              <input id="t-code" className="ainp" value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="welcome_wa" />
              <div className="fhint">A stable key journeys refer to. Optional.</div>
            </div>
            <div className="fld">
              <label htmlFor="t-vertical">Vertical</label>
              <select id="t-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">All verticals</option>
                {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <div className="fhint">Scope this template to one vertical, or leave it org-wide.</div>
            </div>

            {channel === 'email' && (
              <div className="fld span2">
                <label htmlFor="t-subject">Subject <span className="star">*</span></label>
                <input id="t-subject" className="ainp" value={subject} onChange={(e) => setSubject(e.target.value)}
                  placeholder="Your {{course}} details from {{org}}" />
              </div>
            )}

            {channel === 'whatsapp' && (
              <>
                <div className="fld">
                  <label htmlFor="t-waname">Meta template name <span className="star">*</span></label>
                  <input id="t-waname" className="ainp" value={waName} onChange={(e) => setWaName(e.target.value)}
                    placeholder="lead_welcome" />
                  <div className="fhint">The name of the template APPROVED in Meta. Meta will not deliver an unapproved one.</div>
                </div>
                <div className="fld">
                  <label htmlFor="t-walang">Language</label>
                  <input id="t-walang" className="ainp" value={waLang} onChange={(e) => setWaLang(e.target.value)} placeholder="en" />
                </div>
                <div className="fld span2">
                  <label htmlFor="t-waparams">Body parameters</label>
                  <input id="t-waparams" className="ainp" value={waParams} onChange={(e) => setWaParams(e.target.value)}
                    placeholder="{{lead.name}}, {{course}}" />
                  <div className="fhint">Comma-separated, in order. These fill Meta's {'{{1}}'}, {'{{2}}'} … placeholders.</div>
                </div>
              </>
            )}

            {channel === 'sms' && (
              <>
                <div className="fld">
                  <label htmlFor="t-sender">DLT Sender ID</label>
                  <input id="t-sender" className="ainp" value={senderId} onChange={(e) => setSenderId(e.target.value)}
                    placeholder="TCHLNG" />
                </div>
                <div className="fld">
                  <label htmlFor="t-dlt">DLT Template ID</label>
                  <input id="t-dlt" className="ainp" value={dlt} onChange={(e) => setDlt(e.target.value)}
                    placeholder="1207161234567890" />
                  <div className="fhint">Required by Indian law (TRAI DLT). Get it from your gateway's DLT portal.</div>
                </div>
              </>
            )}

            <div className="fld span2">
              <label htmlFor="t-body">Message Body <span className="star">*</span></label>
              <textarea id="t-body" className="ainp" rows={channel === 'email' ? 7 : 4} value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={channel === 'email' ? '<p>Hi {{lead.name}}…</p>' : 'Hi {{lead.name}}, about your {{course}} enquiry…'} />
              <div className="fhint">
                {channel === 'whatsapp'
                  ? 'Used for the preview and for free-form session replies (inside the 24-hour window).'
                  : 'Click a variable below to insert it.'}
              </div>
            </div>

            <div className="fld span2">
              <label>Variables</label>
              <div className="chips">
                {(catalog.data?.variables ?? []).map((v) => (
                  <button type="button" className="chip" key={v.key} onClick={() => insert(v.key)} title={v.label}>
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="fld">
              <label htmlFor="t-status">Status</label>
              <select id="t-status" className="ainp" value={active ? 'Active' : 'Inactive'}
                onChange={(e) => setActive(e.target.value === 'Active')}>
                <option>Active</option><option>Inactive</option>
              </select>
            </div>
          </div>

          {/* THE LIVE PREVIEW — the same renderer the real send uses */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head"><h3><Ic k="doc" />Preview — sample lead (Priya Sharma · IELTS · Vikaspuri)</h3></div>
            <div className="card-pad">
              {!preview ? <div className="empty-note">Type a message to see it rendered against a sample lead.</div> : (
                <>
                  {preview.subject ? <div style={{ fontWeight: 600, marginBottom: 6 }}>{preview.subject}</div> : null}
                  <div className="prev-body" data-testid="preview-body"
                    style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{preview.body}</div>
                  {preview.wa_params?.length ? (
                    <div className="fhint" style={{ marginTop: 8 }}>
                      Meta params: {preview.wa_params.map((p, i) => `{{${i + 1}}} = ${p || '(blank)'}`).join(' · ')}
                    </div>
                  ) : null}
                  {preview.missing?.length ? (
                    <div className="notice" style={{ marginTop: 10 }} data-testid="preview-missing">
                      <Ic k="bolt" />
                      <div>
                        <b>These will be blank</b> for a lead that has no value:{' '}
                        {preview.missing.map((m) => `{{${m}}}`).join(', ')}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            <Ic k="check" />{busy ? 'Saving…' : initial ? 'Save changes' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Templates() {
  const { data, reload } = useFetch<Template[]>('/templates');
  const [modal, setModal] = useState<{ open: boolean; row?: Template | null }>({ open: false });
  const rows = data ?? [];

  const del = async (t: Template) => {
    if (!confirm(`Delete the template "${t.name}"?`)) return;
    await api.del(`/templates/${t.id}`);
    toast('Template deleted'); reload();
  };

  return (
    <>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setModal({ open: true, row: null })}>
          <Ic k="plus" />New template
        </button>
      </div>
      <TableCard
        title="Message templates" icon="doc"
        cols={['Name', 'Channel', 'Vertical', 'Variables', 'Used', 'Status', '']}
        empty="No templates yet — create one to use it in a journey or a blast."
        rows={rows.map((t): Cell[] => [
          { node: <div><b>{t.name}</b>{t.code ? <div className="sub mono">{t.code}</div> : null}</div> },
          { b: [CHANNEL_LABEL[t.channel] ?? t.channel, 'b-indigo'] },
          t.vertical_name ?? 'All',
          { node: <span className="mono sub">{(t.variables ?? []).map((v) => `{{${v}}}`).join(' ') || '—'}</span> },
          String(t.used_count ?? 0),
          t.is_active ? { b: ['Active', 'b-green'] } : { b: ['Inactive', 'b-gray'] },
          {
            node: <RowBtns items={[
              ['pencil', 'Edit', () => setModal({ open: true, row: t })],
              ['trash', 'Delete', () => void del(t)],
            ]} />,
          },
        ])}
      />
      {modal.open && (
        <TemplateModal initial={modal.row} onClose={() => setModal({ open: false })}
          onSaved={reload} />
      )}
    </>
  );
}

/* ==================================================================== */
/*  AUTOMATION JOURNEYS                                                 */
/* ==================================================================== */

const ACTION_KINDS: Array<{ kind: string; label: string }> = [
  { kind: 'send_message', label: 'Send a message' },
  { kind: 'create_task', label: 'Create a follow-up task' },
  { kind: 'change_stage', label: 'Change the lead stage' },
  { kind: 'notify_user', label: 'Notify a user' },
  { kind: 'wait', label: 'Wait' },
];

/** The builder. Trigger -> conditions -> ordered actions, exactly as the prototype draws it. */
export function JourneyModal({ initial, onClose, onSaved }: {
  initial?: Journey | null; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef_();
  const triggers = useFetch<Trigger[]>('/journeys/triggers');
  const templates = useFetch<Template[]>('/templates');
  const [name, setName] = useState(initial?.name ?? '');
  const [desc, setDesc] = useState(initial?.description ?? '');
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? 'lead_created');
  const [tcfg, setTcfg] = useState<Record<string, unknown>>(initial?.trigger_config ?? {});
  const [cond, setCond] = useState<Record<string, unknown>>(initial?.conditions ?? {});
  const [actions, setActions] = useState<JourneyAction[]>(initial?.actions ?? [{ kind: 'send_message' }]);
  const [status, setStatus] = useState(initial?.status ?? 'draft');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const spec = (triggers.data ?? []).find((t) => t.key === trigger);
  const ids = (v: unknown): string => (Array.isArray(v) ? v.join(',') : String(v ?? ''));
  const toIds = (s: string): number[] => s.split(',').map((x) => Number(x.trim())).filter(Boolean);

  const setAction = (i: number, patch: Partial<JourneyAction>) =>
    setActions((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addAction = () => setActions((a) => [...a, { kind: 'create_task' }]);
  const delAction = (i: number) => setActions((a) => a.filter((_, j) => j !== i));

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = {
        name, description: desc || null, trigger_type: trigger, trigger_config: tcfg,
        conditions: cond, actions, status,
      };
      if (initial) await api.patch(`/journeys/${initial.id}`, body);
      else await api.post('/journeys', body);
      toast(initial ? 'Journey updated' : 'Journey created');
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 880 }}>
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit journey — ${initial.name}` : 'New journey'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="j-name">Journey Name <span className="star">*</span></label>
              <input id="j-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Welcome every new Meta lead" />
            </div>
            <div className="fld span2">
              <label htmlFor="j-desc">Description</label>
              <input id="j-desc" className="ainp" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>

            {/* ---- TRIGGER ---- */}
            <div className="fld">
              <label htmlFor="j-trigger">Trigger <span className="star">*</span></label>
              <select id="j-trigger" className="ainp" value={trigger}
                onChange={(e) => { setTrigger(e.target.value); setTcfg({}); }}>
                {(triggers.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              {spec ? <div className="fhint">{spec.blurb}</div> : null}
            </div>
            <div className="fld">
              <label htmlFor="j-status">Status</label>
              <select id="j-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value as Journey['status'])}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
              <div className="fhint">Only an ACTIVE journey fires. Pausing one stops it for everybody, immediately.</div>
            </div>

            {trigger === 'stage_changed' && (
              <div className="fld span2">
                <label htmlFor="j-stages">Fire when the lead enters these stages</label>
                <input id="j-stages" className="ainp" value={ids(tcfg.stage_ids)}
                  onChange={(e) => setTcfg({ ...tcfg, stage_ids: toIds(e.target.value) })}
                  placeholder="Stage IDs, comma-separated. Blank = any stage." />
              </div>
            )}
            {trigger === 'no_response' && (
              <div className="fld">
                <label htmlFor="j-days">No response for (days) <span className="star">*</span></label>
                <input id="j-days" className="ainp" type="number" value={String(tcfg.days ?? 3)}
                  onChange={(e) => setTcfg({ ...tcfg, days: Number(e.target.value) })} />
              </div>
            )}
            {(trigger === 'fee_due' || trigger === 'birthday') && (
              <div className="fld">
                <label htmlFor="j-before">Days before</label>
                <input id="j-before" className="ainp" type="number" value={String(tcfg.days_before ?? 0)}
                  onChange={(e) => setTcfg({ ...tcfg, days_before: Number(e.target.value) })} />
              </div>
            )}

            {/* ---- CONDITIONS ---- */}
            <div className="fld span2"><label>Conditions — leave a box empty to mean "any"</label></div>
            <div className="fld">
              <label htmlFor="j-campaigns">Campaign</label>
              <select id="j-campaigns" className="ainp" value={ids(cond.campaign_ids)}
                onChange={(e) => setCond({ ...cond, campaign_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">Any campaign</option>
                {ref.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="j-sources">Lead Source</label>
              <select id="j-sources" className="ainp" value={ids(cond.source_ids)}
                onChange={(e) => setCond({ ...cond, source_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">Any source</option>
                {ref.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="j-band">Score band</label>
              <select id="j-band" className="ainp" value={ids(cond.bands)}
                onChange={(e) => setCond({ ...cond, bands: e.target.value ? [e.target.value] : [] })}>
                <option value="">Any band</option>
                <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="j-branch">Branch</label>
              <select id="j-branch" className="ainp" value={ids(cond.branch_ids)}
                onChange={(e) => setCond({ ...cond, branch_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">Any branch</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="j-vertical">Vertical</label>
              <select id="j-vertical" className="ainp" value={ids(cond.vertical_ids)}
                onChange={(e) => setCond({ ...cond, vertical_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">Any vertical</option>
                {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          </div>

          {/* ---- ACTIONS ---- */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head">
              <h3><Ic k="bolt" />Then do this, in order</h3>
              <span className="more"><button className="btn sm" onClick={addAction}><Ic k="plus" />Add step</button></span>
            </div>
            <div className="card-pad">
              {actions.map((a, i) => (
                <div className="form-grid" key={i} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
                  <div className="fld">
                    <label htmlFor={`a-kind-${i}`}>Step {i + 1}</label>
                    <select id={`a-kind-${i}`} className="ainp" value={a.kind}
                      onChange={(e) => setAction(i, { kind: e.target.value })}>
                      {ACTION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                    </select>
                  </div>

                  {a.kind === 'send_message' && (
                    <div className="fld">
                      <label htmlFor={`a-tpl-${i}`}>Template <span className="star">*</span></label>
                      <select id={`a-tpl-${i}`} className="ainp" value={String(a.template_id ?? '')}
                        onChange={(e) => setAction(i, { template_id: Number(e.target.value) })}>
                        <option value="">Choose a template…</option>
                        {(templates.data ?? []).map((t) => (
                          <option key={t.id} value={t.id}>{CHANNEL_LABEL[t.channel]} — {t.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {a.kind === 'create_task' && (
                    <>
                      <div className="fld">
                        <label htmlFor={`a-title-${i}`}>Task title</label>
                        <input id={`a-title-${i}`} className="ainp" value={a.title ?? ''}
                          onChange={(e) => setAction(i, { title: e.target.value })} placeholder="Call the new lead" />
                      </div>
                      <div className="fld">
                        <label htmlFor={`a-due-${i}`}>Due in (days)</label>
                        <input id={`a-due-${i}`} className="ainp" type="number" value={String(a.due_in_days ?? 1)}
                          onChange={(e) => setAction(i, { due_in_days: Number(e.target.value) })} />
                      </div>
                      <div className="fld">
                        <label htmlFor={`a-assign-${i}`}>Assign to</label>
                        <select id={`a-assign-${i}`} className="ainp" value={String(a.assign_to ?? 'owner')}
                          onChange={(e) => setAction(i, { assign_to: e.target.value })}>
                          <option value="owner">The Lead Counsellor</option>
                          <option value="manager">Their manager</option>
                        </select>
                      </div>
                    </>
                  )}

                  {a.kind === 'change_stage' && (
                    <div className="fld">
                      <label htmlFor={`a-stage-${i}`}>Move to stage (ID) <span className="star">*</span></label>
                      <input id={`a-stage-${i}`} className="ainp" type="number" value={String(a.stage_id ?? '')}
                        onChange={(e) => setAction(i, { stage_id: Number(e.target.value) })} />
                    </div>
                  )}

                  {a.kind === 'notify_user' && (
                    <>
                      <div className="fld">
                        <label htmlFor={`a-who-${i}`}>Notify</label>
                        <select id={`a-who-${i}`} className="ainp" value={String(a.assign_to ?? 'owner')}
                          onChange={(e) => setAction(i, { assign_to: e.target.value })}>
                          <option value="owner">The Lead Counsellor</option>
                          <option value="manager">Their manager</option>
                        </select>
                      </div>
                      <div className="fld">
                        <label htmlFor={`a-ntitle-${i}`}>Message</label>
                        <input id={`a-ntitle-${i}`} className="ainp" value={a.title ?? ''}
                          onChange={(e) => setAction(i, { title: e.target.value })} />
                      </div>
                    </>
                  )}

                  {a.kind === 'wait' && (
                    <div className="fld">
                      <label htmlFor={`a-wait-${i}`}>Wait (days)</label>
                      <input id={`a-wait-${i}`} className="ainp" type="number" value={String(a.days ?? 1)}
                        onChange={(e) => setAction(i, { days: Number(e.target.value) })} />
                    </div>
                  )}

                  <div className="fld">
                    <label>&nbsp;</label>
                    <button className="btn" onClick={() => delAction(i)} disabled={actions.length === 1}>
                      <Ic k="trash" />Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="notice" style={{ marginTop: 10 }}>
            <Ic k="bolt" />
            <div>
              Every journey obeys the <b>guardrails</b> in Settings: business hours, the daily
              message cap per lead, and opt-out. A lead <b>never receives the same step twice</b>.
            </div>
          </div>

          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            <Ic k="check" />{busy ? 'Saving…' : initial ? 'Save changes' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Journeys() {
  const { data, reload } = useFetch<Journey[]>('/journeys');
  const runs = useFetch<Array<Record<string, any>>>('/journeys/runs?limit=25');
  const [modal, setModal] = useState<{ open: boolean; row?: Journey | null }>({ open: false });
  const rows = data ?? [];

  const setStatus = async (j: Journey, status: string) => {
    await api.patch(`/journeys/${j.id}/status`, { status });
    toast(status === 'active' ? 'Journey activated' : 'Journey paused');
    reload();
  };
  const del = async (j: Journey) => {
    if (!confirm(`Delete the journey "${j.name}"?`)) return;
    await api.del(`/journeys/${j.id}`);
    toast('Journey deleted'); reload();
  };

  return (
    <>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setModal({ open: true, row: null })}>
          <Ic k="plus" />New journey
        </button>
      </div>
      <TableCard
        title="Automation journeys" icon="bolt"
        cols={['Journey', 'Trigger', 'Steps', 'Runs', 'Failures', 'Status', '']}
        empty="No journeys yet — build one to greet new leads, chase quiet ones, or wish a happy birthday."
        rows={rows.map((j): Cell[] => [
          { node: <div><b>{j.name}</b>{j.description ? <div className="sub">{j.description}</div> : null}</div> },
          { b: [String(j.trigger_type).replace(/_/g, ' '), 'b-indigo'] },
          String((j.actions ?? []).length),
          String(j.runs ?? 0),
          (j.failures ?? 0) > 0 ? { b: [String(j.failures), 'b-rose'] } : '0',
          bdg(JOURNEY_BADGE, j.status),
          {
            node: <RowBtns items={[
              j.status === 'active'
                ? ['clock', 'Pause', () => void setStatus(j, 'paused')]
                : ['bolt', 'Activate', () => void setStatus(j, 'active')],
              ['pencil', 'Edit', () => setModal({ open: true, row: j })],
              ['trash', 'Delete', () => void del(j)],
            ]} />,
          },
        ])}
      />

      <TableCard
        title="Recent journey runs" icon="list"
        cols={['When', 'Journey', 'Lead', 'Trigger key', 'Steps', 'Status']}
        empty="Journey runs appear here — and on each lead's own timeline."
        rows={(runs.data ?? []).map((r): Cell[] => [
          fmt(r.created_at), r.journey_name, r.lead_name,
          { mono: r.trigger_key, dim: true },
          { node: <span className="sub">{(r.steps ?? []).map((s: any) => `${s.kind}:${s.status}`).join(', ') || '—'}</span> },
          bdg({ done: ['Done', 'b-green'], failed: ['Failed', 'b-rose'], pending: ['Waiting', 'b-cyan'], running: ['Running', 'b-indigo'], skipped: ['Skipped', 'b-gray'] }, r.status),
        ])}
      />

      {modal.open && <JourneyModal initial={modal.row} onClose={() => setModal({ open: false })} onSaved={reload} />}
    </>
  );
}

/* ==================================================================== */
/*  THE ENGAGEMENT CHANNEL SCREENS (Bulk WhatsApp / Bulk SMS / Email)   */
/* ==================================================================== */

/** Compose a blast: pick a template, pick an audience, send. Guard-railed like any automation. */
export function BlastModal({ channel, onClose, onSent }: { channel: string; onClose: () => void; onSent: () => void }) {
  const ref = useRef_();
  const templates = useFetch<Template[]>(`/templates?channel=${channel}`);
  const [templateId, setTemplateId] = useState('');
  const [campaign, setCampaign] = useState('');
  const [band, setBand] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ audience: number; queued: number; skipped: number; failed: number } | null>(null);

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      const out = await api.post<typeof result>('/messages/bulk', {
        template_id: Number(templateId),
        campaign_ids: campaign ? [Number(campaign)] : undefined,
        temperature: band || undefined,
      });
      setResult(out);
      toast(`${out!.queued} queued · ${out!.skipped} skipped`);
      onSent();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 600 }}>
        <div className="ah">
          <h3><Ic k={CHANNEL_IC[channel]} />New {CHANNEL_LABEL[channel]} blast</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="b-template">Template <span className="star">*</span></label>
              <select id="b-template" className="ainp" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Choose a template…</option>
                {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-campaign">Campaign</label>
              <select id="b-campaign" className="ainp" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">All campaigns</option>
                {ref.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-band">Score band</label>
              <select id="b-band" className="ainp" value={band} onChange={(e) => setBand(e.target.value)}>
                <option value="">All bands</option>
                <option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
              </select>
            </div>
          </div>
          <div className="notice" style={{ marginTop: 10 }}>
            <Ic k="bolt" />
            <div>
              The audience is resolved through <b>your own scope</b> — you can only message leads you can see.
              Opted-out contacts and leads already at their daily cap are skipped, and every send is logged below.
            </div>
          </div>
          {result ? (
            <div className="notice" style={{ marginTop: 10 }} data-testid="blast-result">
              <Ic k="check" />
              <div>
                <b>{result.audience}</b> leads matched · <b>{result.queued}</b> queued ·{' '}
                <b>{result.skipped}</b> skipped (opt-out / cap) · <b>{result.failed}</b> with no {channel === 'email' ? 'email address' : 'mobile number'}.
              </div>
            </div>
          ) : null}
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || !templateId} onClick={send}>
            <Ic k="check" />{busy ? 'Queueing…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One screen, three channels. The DURABLE SEND LOG is the point of it. */
export function ChannelScreen({ channel }: { channel: 'whatsapp' | 'sms' | 'email' }) {
  const log = useFetch<Message[]>(`/messages?channel=${channel}&limit=100`);
  const summary = useFetch<{ channels: Array<{ channel: string; configured: boolean; missing: string[]; vertical_id: number | null }> }>('/messages/summary');
  const [blast, setBlast] = useState(false);

  const cfgs = (summary.data?.channels ?? []).filter((c) => c.channel === channel);
  const configured = cfgs.some((c) => c.configured);
  const rows = log.data ?? [];

  const retry = async (m: Message) => {
    await api.post(`/messages/${m.id}/retry`, {});
    toast('Re-queued'); log.reload();
  };

  return (
    <>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setBlast(true)}>
          <Ic k="plus" />New {CHANNEL_LABEL[channel]} blast
        </button>
      </div>

      {!configured && (
        <div className="notice" data-testid="not-configured">
          <Ic k="bolt" />
          <div>
            <b>{CHANNEL_LABEL[channel]} is not configured yet.</b> Everything on this screen is
            built and live — the moment the credentials are pasted into{' '}
            <b>Administration › Settings › Channels</b>, sending starts. No deploy.
            {cfgs[0]?.missing?.length ? <> Missing: {cfgs[0].missing.join(', ')}.</> : null}
          </div>
        </div>
      )}

      <TableCard
        title={`${CHANNEL_LABEL[channel]} send log`} icon={CHANNEL_IC[channel]}
        cols={['When', 'To', 'Lead / User', 'Template', 'Journey', 'Status', 'Detail', '']}
        empty={`No ${CHANNEL_LABEL[channel]} messages sent yet.`}
        rows={rows.map((m): Cell[] => [
          fmt(m.created_at),
          { mono: m.to_addr },
          m.lead_name ?? m.user_name ?? '—',
          m.template_name ?? '—',
          m.journey_name ?? '—',
          bdg(STATUS_BADGE, m.status),
          {
            node: m.error
              ? <span className={m.not_configured ? 'sub' : 'err-text'} title={m.error}>
                {m.not_configured ? 'Not configured' : m.error.slice(0, 60)}
              </span>
              : <span className="sub mono">{m.provider ?? '—'}</span>,
          },
          {
            node: m.status === 'failed' || m.status === 'skipped'
              ? <RowBtns items={[['refresh', 'Retry', () => void retry(m)]]} />
              : <span />,
          },
        ])}
      />

      {blast && <BlastModal channel={channel} onClose={() => setBlast(false)} onSent={() => log.reload()} />}
    </>
  );
}

export const BulkWhatsApp = () => <ChannelScreen channel="whatsapp" />;
// Bulk SMS / Email Campaigns wrappers removed (Aug 2026) — those nav entries were retired
// (client: keep Bulk WhatsApp only). ChannelScreen stays; it still backs the WhatsApp screen
// and the durable SMS/Email SEND LOG surfaced elsewhere (Message Log / notifications).

/* ==================================================================== */
/*  ADMINISTRATION › SETTINGS                                           */
/* ==================================================================== */

/** The credential form for one provider — GENERATED from the provider spec. */
export function ChannelConfigModal({ spec, existing, onClose, onSaved }: {
  spec: ProviderSpec; existing: ChannelCfg | null; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef_();
  const [verticalId, setVerticalId] = useState(existing?.vertical_id ? String(existing.vertical_id) : '');
  const [config, setConfig] = useState<Record<string, unknown>>({ ...(existing?.config ?? {}) });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [signup, setSignup] = useState<SignupInfo | null>(null);
  const [sdkReady, setSdkReady] = useState(false);

  const setC = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  // 'send' providers need somewhere to send TO; 'probe' providers need nothing.
  const mode = spec.test ?? 'send';
  const sendable = mode === 'send';
  const testable = mode !== 'none';
  const isWhatsApp = spec.channel === 'whatsapp';
  const webhookUrl = typeof location !== 'undefined' ? `${location.origin}/api/webhooks/whatsapp` : '';

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/settings/channels/save', {
        provider: spec.key, channel: spec.channel,
        vertical_id: spec.perVertical && verticalId ? Number(verticalId) : null,
        config, secrets, is_active: true,
      });
      toast(`${spec.label} saved`);
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const test = async () => {
    setErr(''); setMsg(''); setOutcome(null); setBusy(true);
    try {
      const out = await api.post<TestOutcome>('/settings/channels/test', {
        channel: spec.channel, to: testTo,
        // DEF-S5-04: DeepSeek and Gemini share channel 'ai' and are INDEPENDENT rows.
        // Say which card was pressed, or the API probes an arbitrary one and reports the
        // other provider's verdict.
        provider: spec.key,
        vertical_id: spec.perVertical && verticalId ? Number(verticalId) : null,
      });
      setOutcome(out);
      if (!out.ok) setErr(out.message || out.reason || 'The test did not pass.');
      onSaved();      // pull the fresh Verified / Test failed badge back into the list
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /* ---------------------- WHATSAPP EMBEDDED SIGNUP ---------------------- */

  // Preload the SDK the moment the card is on screen. Loading it inside the click
  // handler means Chrome has already expired the user gesture by the time FB.login
  // runs, and blocks the popup — the SaaS learned this the hard way.
  useEffect(() => {
    if (spec.channel !== 'whatsapp') return;
    let dead = false;
    api.get<SignupInfo>('/settings/whatsapp/embedded-signup')
      .then((i) => {
        if (dead) return;
        setSignup(i);
        if (i.app_id) ensureFbSdk(i.app_id).then(() => !dead && setSdkReady(true)).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => { dead = true; };
  }, [spec.channel]);

  const connectWhatsApp = async () => {
    setErr(''); setMsg(''); setOutcome(null);
    if (!signup?.ready) {
      setErr(`Save your Meta App ID, Configuration ID and App secret first — still missing: ${(signup?.missing ?? []).join(', ')}.`);
      return;
    }
    if (!sdkReady) { setErr('The Facebook SDK is still loading — press Connect WhatsApp again in a moment.'); return; }
    setBusy(true);
    try {
      // MUST be called synchronously from this click, or Chrome blocks the popup.
      const payload = await launchEmbeddedSignup(signup.config_id);
      const r = await api.post<{ display_phone_number: string; waba_id: string; subscribed: boolean; subscribe_error: string | null; warning: string | null }>(
        '/settings/whatsapp/embedded-signup', payload,
      );
      let m = `Connected ${r.display_phone_number || 'your WhatsApp number'} (WABA ${r.waba_id}). A permanent token is stored — you never have to paste one.`;
      if (r.subscribed) m += ' The webhook is subscribed automatically.';
      if (r.warning) m += ` ${r.warning}`;
      setMsg(m);
      if (!r.subscribed) setErr(`Connected, but subscribing the webhook failed: ${r.subscribe_error}. Delivery receipts will not arrive until this is fixed.`);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const field = (f: FieldSpec, secret: boolean) => (
    <div className={`fld ${f.type === 'textarea' ? 'span2' : ''}`} key={f.key}>
      <label htmlFor={`cf-${f.key}`}>{f.label}{f.required ? <> <span className="star">*</span></> : null}</label>
      {f.type === 'textarea' ? (
        <textarea id={`cf-${f.key}`} className="ainp" rows={3}
          value={secret ? (secrets[f.key] ?? '') : String(config[f.key] ?? '')}
          placeholder={f.placeholder}
          onChange={(e) => (secret ? setSecrets({ ...secrets, [f.key]: e.target.value }) : setC(f.key, e.target.value))} />
      ) : f.type === 'bool' ? (
        <select id={`cf-${f.key}`} className="ainp" value={config[f.key] ? 'Yes' : 'No'}
          onChange={(e) => setC(f.key, e.target.value === 'Yes')}>
          <option>No</option><option>Yes</option>
        </select>
      ) : f.type === 'select' ? (
        <select id={`cf-${f.key}`} className="ainp" value={String(config[f.key] ?? '')}
          onChange={(e) => setC(f.key, e.target.value)}>
          <option value="">Select…</option>
          {(f.opts ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={`cf-${f.key}`} className="ainp"
          type={secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
          value={secret ? (secrets[f.key] ?? '') : String(config[f.key] ?? '')}
          placeholder={secret ? (existing?.secrets_masked?.[f.key] || f.placeholder) : f.placeholder}
          onChange={(e) => (secret ? setSecrets({ ...secrets, [f.key]: e.target.value }) : setC(f.key, e.target.value))} />
      )}
      {f.hint ? <div className="fhint">{f.hint}</div> : null}
      {secret && existing?.secrets_masked?.[f.key] ? (
        <div className="fhint">Currently set ({existing.secrets_masked[f.key]}). Leave blank to keep it.</div>
      ) : null}
    </div>
  );

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 760 }}>
        <div className="ah">
          <h3><Ic k="cfg" />{spec.label}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <p className="sub" style={{ marginTop: 0 }}>{spec.blurb}</p>

          {spec.storedOnly ? (
            <div className="notice" style={{ marginTop: 0 }}><Ic k="doc" /><div>{spec.storedOnly}</div></div>
          ) : null}

          {/* ---------- EMBEDDED SIGNUP: the whole point of the WhatsApp card ---------- */}
          {isWhatsApp ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="card-head"><h3><Ic k="wa" />Connect WhatsApp</h3></div>
              <div className="card-pad">
                {signup?.connected && signup.connected_via === 'embedded_signup' ? (
                  <div className="notice ok"><Ic k="check" /><div>
                    Connected{signup.display_phone_number ? <> as <b>{signup.display_phone_number}</b></> : null} via
                    Meta login. A <b>permanent</b> token is stored — there is no 24-hour token to re-paste.
                    Press <b>Connect WhatsApp</b> again to switch to a different number.
                  </div></div>
                ) : (
                  <p className="sub" style={{ marginTop: 0 }}>
                    Press the button, log in to Meta, and pick your WhatsApp Business Account.
                    We store the <b>permanent</b> access token, the WABA and the phone number, and
                    subscribe the webhook for you. <b>You never paste a token.</b>
                  </p>
                )}
                {signup && !signup.ready ? (
                  <div className="notice warn"><Ic k="bolt" /><div>
                    Fill in and <b>Save</b> these first, then press Connect WhatsApp:{' '}
                    <b>{(signup.missing ?? []).join(', ') || 'Meta App ID, Configuration ID, App secret'}</b>.
                  </div></div>
                ) : null}
                <button className="btn primary" disabled={busy || !signup?.ready} onClick={connectWhatsApp}>
                  <Ic k="wa" />Connect WhatsApp
                </button>
                <details style={{ marginTop: 10 }}>
                  <summary className="sub">Advanced — connect by pasting a token instead</summary>
                  <p className="sub">
                    Only needed if Embedded Signup cannot be used (no Login-for-Business
                    configuration, or a number managed outside your Meta app). Paste the
                    Phone number ID and a <b>permanent</b> system-user access token in the
                    fields below and press Save. A 24-hour test token will stop working tomorrow.
                  </p>
                </details>
              </div>
            </div>
          ) : null}

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-head"><h3><Ic k="doc" />What you need to do</h3></div>
            <div className="card-pad">
              <ol className="steps">{spec.setup.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
          </div>

          <div className="form-grid">
            {spec.perVertical && (
              <div className="fld span2">
                <label htmlFor="cf-vertical">Vertical <span className="star">*</span></label>
                <select id="cf-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                  <option value="">Organisation-wide (the fallback)</option>
                  {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <div className="fhint">
                  {spec.channel === 'email'
                    ? 'SMTP is configured PER VERTICAL so each course line sends from its own domain. A vertical with no row of its own falls back to the organisation-wide one.'
                    : 'Configured per vertical.'}
                </div>
              </div>
            )}
            {spec.config.map((f) => field(f, false))}
            {spec.secrets.filter((f) => !f.generated).map((f) => field(f, true))}
          </div>

          {spec.channel === 'whatsapp' && existing && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-head"><h3><Ic k="link" />Paste these INTO Meta</h3></div>
              <div className="card-pad">
                <div className="form-grid">
                  <div className="fld span2">
                    <label>Callback URL</label>
                    <input className="ainp mono" readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} />
                  </div>
                  <div className="fld span2">
                    <label>Verify Token</label>
                    <input className="ainp mono" readOnly value={existing.verify_token ?? ''}
                      onFocus={(e) => e.currentTarget.select()} />
                    <div className="fhint">Meta › WhatsApp › Configuration › Webhook. Subscribe to the "messages" field.</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ---------------------------- TEST CONNECTION ----------------------------
              One button, two honest behaviours. A 'send' provider delivers a real
              message; a 'probe' provider calls the provider's API read-only. Either
              way the RESULT IS SPECIFIC, and a PASS carries the caveat verbatim —
              because "the gateway accepted it" and "the customer got it" are not the
              same sentence, and MSG91 answers `success` to a bogus key. */}
          {testable && existing && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-head">
                <h3><Ic k="bolt" />{sendable ? 'Send a test message' : 'Test connection'}</h3>
              </div>
              <div className="card-pad">
                <div className="form-grid">
                  {sendable ? (
                    <div className="fld">
                      <label htmlFor="cf-testto">{spec.channel === 'email' ? 'Your email' : 'Your mobile'}</label>
                      <input id="cf-testto" className="ainp" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                        placeholder={spec.channel === 'email' ? 'you@techlingua.in' : '+919810000001'} />
                    </div>
                  ) : (
                    <div className="fld span2">
                      <p className="sub" style={{ margin: 0 }}>
                        We call {spec.label} with the stored credentials and tell you exactly what it said.
                        Nothing is created, nothing is charged, no message is sent.
                      </p>
                    </div>
                  )}
                  <div className="fld">
                    <label>&nbsp;</label>
                    <button className="btn" disabled={busy || (sendable && !testTo)} onClick={test}>
                      <Ic k="check" />{sendable ? 'Send test' : 'Test connection'}
                    </button>
                  </div>
                </div>

                {outcome ? (
                  <>
                    <div className={`notice ${outcome.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
                      <Ic k={outcome.ok ? 'check' : 'bolt'} /><div>{outcome.message}</div>
                    </div>
                    {/* THE CAVEAT. Never hidden behind a disclosure — a green tick that
                        overclaims is how a client concludes his SMS gateway works when
                        it does not. */}
                    {outcome.ok && outcome.caveat ? (
                      <div className="notice warn" style={{ marginTop: 8 }}>
                        <Ic k="bolt" /><div><b>What this does and does not prove:</b> {outcome.caveat}</div>
                      </div>
                    ) : null}
                    {outcome.detail ? (
                      <details style={{ marginTop: 8 }}>
                        <summary className="sub">What {spec.label} actually replied</summary>
                        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{outcome.detail}</pre>
                      </details>
                    ) : null}
                  </>
                ) : null}

                {existing?.last_test_at && !outcome ? (
                  <div className="sub" style={{ marginTop: 8 }}>
                    Last tested {fmt(existing.last_test_at)} —{' '}
                    {existing.last_test_ok ? <b>passed</b> : <>failed: {existing.last_test_error}</>}
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {msg ? <div className="notice" style={{ marginTop: 10 }}><Ic k="check" /><div>{msg}</div></div> : null}
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />Save</button>
        </div>
      </div>
    </div>
  );
}

/** A generic settings group editor — fields are GENERATED from the registry. */
function GroupCard({ group, value, onSaved }: {
  group: SettingGroup; value: Record<string, unknown>; onSaved: () => void;
}) {
  const [v, setV] = useState<Record<string, unknown>>({ ...value });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV({ ...value }); }, [value]);

  const save = async () => {
    setBusy(true);
    try { await api.post(`/settings/${group.key}`, v); toast(`${group.label} saved`); onSaved(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k={group.icon ?? 'cfg'} />{group.label}</h3>
        {!group.readonly ? (
          <span className="more">
            <button className="btn sm primary" disabled={busy} onClick={save}><Ic k="check" />Save</button>
          </span>
        ) : <span className="more"><span className="bdg b-gray">Read-only</span></span>}
      </div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>{group.blurb}</p>
        {group.managedOn ? <div className="fhint">Edited on: <b>{group.managedOn}</b></div> : null}
        <div className="form-grid">
          {(group.fields ?? []).map((f) => (
            <div className="fld" key={f.key}>
              <label htmlFor={`s-${group.key}-${f.key}`}>{f.label}</label>
              {f.type === 'bool' ? (
                <select id={`s-${group.key}-${f.key}`} className="ainp" disabled={group.readonly}
                  value={v[f.key] ? 'Yes' : 'No'}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value === 'Yes' })}>
                  <option>No</option><option>Yes</option>
                </select>
              ) : f.type === 'select' ? (
                <select id={`s-${group.key}-${f.key}`} className="ainp" disabled={group.readonly}
                  value={String(v[f.key] ?? '')} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                  {(f.opts ?? []).map((o) => <option key={o} value={o}>{o || 'None'}</option>)}
                </select>
              ) : (
                <input id={`s-${group.key}-${f.key}`} className="ainp" disabled={group.readonly}
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={String(v[f.key] ?? '')}
                  onChange={(e) => setV({ ...v, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />
              )}
              {f.hint ? <div className="fhint">{f.hint}</div> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Business hours — a bespoke editor, because a week is not a flat field list. */
function HoursCard({ value, onSaved }: { value: Record<string, any>; onSaved: () => void }) {
  const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
    ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
  const [days, setDays] = useState<Record<string, string[]>>({ ...(value?.days ?? {}) });
  const [enabled, setEnabled] = useState(value?.enabled !== false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDays({ ...(value?.days ?? {}) }); setEnabled(value?.enabled !== false); }, [value]);

  const setDay = (d: string, i: number, t: string) => {
    const cur = days[d] ?? ['09:00', '19:00'];
    const next = [...cur]; next[i] = t;
    setDays({ ...days, [d]: next });
  };
  const toggle = (d: string) => setDays({ ...days, [d]: (days[d] ?? []).length ? [] : ['09:00', '19:00'] });

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/settings/business_hours', { enabled, timezone: value?.timezone ?? 'Asia/Kolkata', days });
      toast('Business hours saved'); onSaved();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="clock" />Business hours</h3>
        <span className="more"><button className="btn sm primary" disabled={busy} onClick={save}><Ic k="check" />Save</button></span>
      </div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>
          Automation never messages a lead outside these hours — it <b>waits for the next working
          window</b> rather than dropping the message.
        </p>
        <div className="form-grid">
          <div className="fld">
            <label htmlFor="bh-enabled">Respect business hours</label>
            <select id="bh-enabled" className="ainp" value={enabled ? 'Yes' : 'No'}
              onChange={(e) => setEnabled(e.target.value === 'Yes')}>
              <option>No</option><option>Yes</option>
            </select>
          </div>
        </div>
        {DAYS.map(([k, label]) => {
          const win = days[k] ?? [];
          const open = win.length >= 2;
          return (
            <div className="cfg-row" key={k}>
              <div className="ci"><Ic k="clock" /></div>
              <div className="cg"><div className="ct">{label}</div>
                <div className="cs">{open ? `${win[0]} – ${win[1]}` : 'Closed'}</div></div>
              {open ? (
                <span className="cv" style={{ display: 'flex', gap: 6 }}>
                  <input className="ainp" style={{ width: 92 }} aria-label={`${label} open`} value={win[0]}
                    onChange={(e) => setDay(k, 0, e.target.value)} />
                  <input className="ainp" style={{ width: 92 }} aria-label={`${label} close`} value={win[1]}
                    onChange={(e) => setDay(k, 1, e.target.value)} />
                </span>
              ) : null}
              <button className="btn sm" onClick={() => toggle(k)}>{open ? 'Close' : 'Open'}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The notification matrix — which event, on which channel. */
function MatrixCard({ value, onSaved }: { value: Record<string, any>; onSaved: () => void }) {
  const EVENTS = [['reminder', 'Follow-up reminder'], ['escalation', 'Overdue escalation'],
    ['sla_breach', 'SLA breach'], ['assignment', 'Lead assigned'], ['handout', 'Leads handed out'],
    // Sprint 5 — only relevant when enrolment approvals are switched ON, but the row is
    // always shown: a matrix that hides an event until some other screen is configured is
    // how an admin discovers a notification he cannot find the switch for.
    ['approval', 'Enrolment awaiting approval'],
    ['system', 'System / journeys']];
  const CH = ['in_app', 'email', 'sms', 'whatsapp'];
  const [m, setM] = useState<Record<string, Record<string, boolean>>>({ ...(value ?? {}) });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setM({ ...(value ?? {}) }); }, [value]);

  const flip = (ev: string, ch: string) =>
    setM({ ...m, [ev]: { ...(m[ev] ?? {}), [ch]: !(m[ev] ?? {})[ch] } });

  const save = async () => {
    setBusy(true);
    try { await api.post('/settings/notification_matrix', m); toast('Notification matrix saved'); onSaved(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="bell" />Notification matrix</h3>
        <span className="more"><button className="btn sm primary" disabled={busy} onClick={save}><Ic k="check" />Save</button></span>
      </div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>
          Which event notifies people on which channel. <b>In-app is always on</b> — the bell is the
          system of record. A channel switched on before its credentials exist simply does nothing
          (and says so in the send log).
        </p>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th>Event</th>{CH.map((c) => <th key={c}>{c === 'in_app' ? 'In-app' : CHANNEL_LABEL[c]}</th>)}</tr></thead>
            <tbody>
              {EVENTS.map(([ev, label]) => (
                <tr key={ev}>
                  <td>{label}</td>
                  {CH.map((ch) => (
                    <td key={ch}>
                      <input type="checkbox" aria-label={`${label} on ${ch}`}
                        checked={ch === 'in_app' ? true : !!(m[ev] ?? {})[ch]}
                        disabled={ch === 'in_app'}
                        onChange={() => flip(ev, ch)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function Settings() {
  const { data, reload } = useFetch<{
    groups: SettingGroup[]; values: Record<string, Record<string, unknown>>;
    providers: ProviderSpec[]; channels: ChannelCfg[];
  }>('/settings');
  const [modal, setModal] = useState<{ spec: ProviderSpec; existing: ChannelCfg | null } | null>(null);

  const groups = data?.groups ?? [];
  const providers = data?.providers ?? [];
  const channels = data?.channels ?? [];

  const byProvider = useMemo(() => {
    const m: Record<string, ChannelCfg[]> = {};
    for (const c of channels) (m[c.provider] ??= []).push(c);
    return m;
  }, [channels]);

  /** Providers with nothing usable stored yet — the "what do I still owe you" list. */
  const outstanding = useMemo(
    () => providers.filter((p) => {
      const rows = byProvider[p.key] ?? [];
      return !rows.length || rows.every((r) => integrationState(r) === 'not_configured');
    }),
    [providers, byProvider],
  );

  return (
    <>
      {/* CHANNELS & CREDENTIALS — the reason this screen exists */}
      <div className="card">
        <div className="card-head"><h3><Ic k="bolt" />Channels &amp; credentials</h3></div>
        <div className="card-pad">
          <p className="sub" style={{ marginTop: 0 }}>
            WhatsApp, SMS, SMTP <b>per vertical</b>, Google Calendar, Cloudflare, the Razorpay
            gateway <b>per vertical</b>, and the AI keys. Every secret is <b>encrypted at rest</b> and
            <b> masked on read</b> — we can show you that a credential is set, and let you replace it,
            but never show it back to you. Nothing here needs a developer or a deploy.
          </p>

          {/* WHAT IS STILL MISSING, AT A GLANCE. The client should never have to open
              seven cards to find out which one is empty. */}
          {outstanding.length ? (
            <div className="notice warn"><Ic k="bolt" /><div>
              <b>Still to set up ({outstanding.length}):</b> {outstanding.map((p) => p.label).join(' · ')}.
              Everything else in the CRM works meanwhile — an unconfigured channel simply says so.
            </div></div>
          ) : (
            <div className="notice ok"><Ic k="check" /><div>
              Every integration is configured. Press <b>Test connection</b> on any of them to re-check it.
            </div></div>
          )}

          {providers.map((p) => {
            const rows = byProvider[p.key] ?? [];
            const worst = rows.length
              ? rows.map(integrationState).sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0]
              : 'not_configured';
            const [label, cls] = STATE_BADGE[worst];
            return (
              <div className="cfg-row" key={p.key}>
                <div className="ci"><Ic k="cfg" /></div>
                <div className="cg">
                  <div className="ct">{p.label}</div>
                  <div className="cs">
                    {rows.length
                      ? rows.map((r) => `${r.vertical_name ?? 'Org-wide'}: ${STATE_BADGE[integrationState(r)][0]}`).join(' · ')
                      : p.blurb}
                    {rows.length && rows[0].missing?.length
                      ? <> — <b>missing: {rows[0].missing.join(', ')}</b></>
                      : null}
                    {worst === 'failed' && rows[0]?.last_test_error
                      ? <> — <b>{rows[0].last_test_error}</b></>
                      : null}
                  </div>
                </div>
                <span className="cv"><span className={`bdg ${cls}`}>{label}</span></span>
                <button className="btn sm" onClick={() => setModal({ spec: p, existing: rows[0] ?? null })}>
                  <Ic k="cfg" />{rows.length ? 'Edit' : 'Configure'}
                </button>
                {p.perVertical && rows.length ? (
                  <button className="btn sm" onClick={() => setModal({ spec: p, existing: null })}>
                    <Ic k="plus" />Add vertical
                  </button>
                ) : null}
              </div>
            );
          })}

          {/* The Google Sheet credentials live on the Lead Capture screen with the rest of
              that channel's config. Pointing at them beats duplicating them: two places to
              edit one credential is how you end up with two different credentials. */}
          <div className="cfg-row">
            <div className="ci"><Ic k="cfg" /></div>
            <div className="cg">
              <div className="ct">Google Sheet pull (lead capture)</div>
              <div className="cs">
                The service-account JSON / API key and the Spreadsheet ID for the Sheet-pull
                channel are entered with that channel, on <b>Marketing &amp; Lead Management ›
                Lead Capture</b> — one channel, one place.
              </div>
            </div>
            <span className="cv" />
            <a className="btn sm" href="#/marketing/capture"><Ic k="cfg" />Open Lead Capture</a>
          </div>
        </div>
      </div>

      {groups.filter((g) => g.key !== 'channels').map((g) => {
        const value = data?.values?.[g.key] ?? {};
        if (g.editor === 'business_hours') return <HoursCard key={g.key} value={value} onSaved={reload} />;
        if (g.editor === 'matrix') return <MatrixCard key={g.key} value={value} onSaved={reload} />;
        // Sprint 5: numbering is no longer a JSON blob in `app_setting` — it is the
        // `number_series` TABLE that quotations/enrolments/receipts atomically allocate
        // from, per branch and per vertical. It gets a real editor, and it is the ONLY
        // place it is edited (migration 029 deleted the old row).
        if (g.editor === 'numbering') return <NumberingCard key={g.key} />;
        if (g.editor === 'holidays') {
          return (
            <div className="card" key={g.key}>
              <div className="card-head"><h3><Ic k={g.icon ?? 'cfg'} />{g.label}</h3></div>
              <div className="card-pad">
                <p className="sub" style={{ marginTop: 0 }}>{g.blurb}</p>
                <JsonCard groupKey={g.key} value={value} onSaved={reload} />
              </div>
            </div>
          );
        }
        // Sprint 5: the approval policy is a real editor, not a JSON blob — it is the one
        // switch that changes how every sale closes.
        if (g.editor === 'approvals') return <ApprovalPolicyCard key={g.key} />;
        return <GroupCard key={g.key} group={g} value={value} onSaved={reload} />;
      })}

      {modal && (
        <ChannelConfigModal spec={modal.spec} existing={modal.existing}
          onClose={() => setModal(null)} onSaved={reload} />
      )}
    </>
  );
}

/** Holidays + numbering series: structured JSON the client edits directly (and we validate). */
function JsonCard({ groupKey, value, onSaved }: {
  groupKey: string; value: Record<string, unknown>; onSaved: () => void;
}) {
  const [text, setText] = useState(JSON.stringify(value ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setText(JSON.stringify(value ?? {}, null, 2)); }, [value]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const parsed = JSON.parse(text);
      await api.post(`/settings/${groupKey}`, parsed);
      toast('Saved'); onSaved();
    } catch (e) {
      setErr(e instanceof SyntaxError ? 'That is not valid JSON.' : (e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="fld span2">
        <textarea className="ainp mono" rows={7} value={text} aria-label={groupKey}
          onChange={(e) => setText(e.target.value)} />
      </div>
      {err ? <div className="notice err"><Ic k="bolt" /><div>{err}</div></div> : null}
      <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />Save</button>
    </>
  );
}

/* ==================================================================== */
/*  SMS TEMPLATES — DLT-compliant, Branch+Vertical scoped (Nimbus)      */
/* ==================================================================== */

export interface SmsTemplateRow {
  id: number; header: string; name: string; body: string;
  branch_id: number | null; branch_name?: string | null;
  vertical_id: number | null; vertical_name?: string | null;
  dlt_template_id: string | null; entity_id: string | null;
  var_mapping: string[] | string | null; unicode: boolean | null;
  trigger_event: string; is_active: boolean;
}

/**
 * The Add/Edit SMS Template form, exactly the model in the client's screenshot:
 * Header (the DLT sender), Template name, Template body (DLT-approved, {#var#} markers),
 * Branch -> Vertical cascade, DLT Template ID, and an active toggle. Every field reaches
 * the request body (qa10 differential probe).
 */
export function SmsTemplateModal({ initial, onClose, onSaved }: {
  initial?: SmsTemplateRow | null; onClose: () => void; onSaved: () => void;
}) {
  const ref = useRef_();
  const [header, setHeader] = useState(initial?.header ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [branchId, setBranchId] = useState<string>(initial?.branch_id ? String(initial.branch_id) : '');
  const [verticalId, setVerticalId] = useState<string>(initial?.vertical_id ? String(initial.vertical_id) : '');
  const [dlt, setDlt] = useState(initial?.dlt_template_id ?? '');
  const [entityId, setEntityId] = useState(initial?.entity_id ?? '');
  const [mapping, setMapping] = useState(
    Array.isArray(initial?.var_mapping) ? initial!.var_mapping.join(', ')
      : typeof initial?.var_mapping === 'string' ? initial!.var_mapping : 'name, course',
  );
  const [active, setActive] = useState(initial?.is_active !== false);
  const [preview, setPreview] = useState<{ url: string; resolved_text: string; missing: string[]; configured: boolean; note: string; unicode: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Branch -> Vertical cascade: verticals belong to the chosen branch (or all when none).
  const verticals = branchId
    ? ref.verticals.filter((v) => String((v as { branch_id?: number }).branch_id ?? '') === branchId)
    : ref.verticals;

  const markers = (body.match(/\{#var#\}/g) ?? []).length;

  const payload = () => ({
    header, name, body,
    branch_id: branchId ? Number(branchId) : null,
    vertical_id: verticalId ? Number(verticalId) : null,
    dlt_template_id: dlt || null,
    entity_id: entityId || null,
    var_mapping: mapping.split(',').map((s) => s.trim()).filter(Boolean),
    trigger_event: 'lead_created',
    is_active: active,
  });

  // Live URL preview (authkey masked) — proves exactly what the gateway will receive.
  useEffect(() => {
    if (!body) { setPreview(null); return; }
    const t = setTimeout(() => {
      api.post<typeof preview>('/sms-templates/preview', {
        body, header, dlt_template_id: dlt,
        var_mapping: mapping.split(',').map((s) => s.trim()).filter(Boolean),
      }).then(setPreview).catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, header, dlt, mapping]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      if (initial) await api.patch(`/sms-templates/${initial.id}`, payload());
      else await api.post('/sms-templates', payload());
      toast(initial ? 'SMS template updated' : 'SMS template created');
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 860 }}>
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit SMS template — ${initial.name}` : 'Add SMS template'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="s-header">Header (DLT sender) <span className="star">*</span></label>
              <input id="s-header" className="ainp" value={header} onChange={(e) => setHeader(e.target.value)}
                placeholder="BRTISC" maxLength={24} />
              <div className="fhint">The DLT-approved header, e.g. BRTISC / INSTAI. Sent as the SMS `sender`.</div>
            </div>
            <div className="fld">
              <label htmlFor="s-name">Template name <span className="star">*</span></label>
              <input id="s-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. BCL Lead Creation II" />
            </div>
            <div className="fld">
              <label htmlFor="s-branch">Branch</label>
              <select id="s-branch" className="ainp" value={branchId}
                onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); }}>
                <option value="">All branches</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="s-vertical">Vertical</label>
              <select id="s-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">All verticals</option>
                {verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <div className="fhint">Which lead this template applies to — its Branch + Vertical are matched on new-lead auto-send.</div>
            </div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="s-body">Template body (DLT-approved) <span className="star">*</span></label>
              <textarea id="s-body" className="ainp" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
                placeholder="Dear {#var#}, thank you for your interest in {#var#}. - BCL" />
              <div className="fhint">
                Paste the EXACT text approved on the DLT portal. Use {'{#var#}'} for each variable, in order.
                This template has <b>{markers}</b> {'{#var#}'} marker{markers === 1 ? '' : 's'}.
              </div>
            </div>
            <div className="fld">
              <label htmlFor="s-dlt">DLT Template ID <span className="star">*</span></label>
              <input id="s-dlt" className="ainp mono" value={dlt} onChange={(e) => setDlt(e.target.value)}
                placeholder="1707160000000000001" />
              <div className="fhint">The `templateid` registered on DLT for this exact body.</div>
            </div>
            <div className="fld">
              <label htmlFor="s-entity">DLT Entity ID (optional)</label>
              <input id="s-entity" className="ainp mono" value={entityId} onChange={(e) => setEntityId(e.target.value)}
                placeholder="leave blank to use the Nimbus default" />
            </div>
            <div className="fld">
              <label htmlFor="s-map">Variable order</label>
              <input id="s-map" className="ainp" value={mapping} onChange={(e) => setMapping(e.target.value)}
                placeholder="name, course" />
              <div className="fhint">Comma-separated lead fields, in {'{#var#}'} order. Default: name, course.</div>
            </div>
            <div className="fld">
              <label htmlFor="s-active">Status</label>
              <select id="s-active" className="ainp" value={active ? '1' : '0'} onChange={(e) => setActive(e.target.value === '1')}>
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </div>
          </div>

          {preview && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="sub" style={{ marginBottom: 6 }}>
                Sample resolved text (name=Test Lead, course=Sample Course):
              </div>
              <div style={{ marginBottom: 8 }}>{preview.resolved_text || <span className="sub">—</span>}</div>
              {preview.missing?.length ? (
                <div className="bdg b-amber" style={{ marginBottom: 8 }}>
                  Will be blank: {preview.missing.join(', ')}
                </div>
              ) : null}
              <div className="sub" style={{ marginBottom: 4 }}>Gateway URL preview{preview.unicode ? ' (unicode, &type=1)' : ''}:</div>
              <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', opacity: 0.85 }}>{preview.url}</div>
              <div className="sub" style={{ marginTop: 6 }}>{preview.note}</div>
            </div>
          )}
          {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            <Ic k="check" />{initial ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Send a chosen template to a typed number — the client tests to +91 7827878780. */
function SmsTestModal({ row, onClose }: { row: SmsTemplateRow; onClose: () => void }) {
  const [mobile, setMobile] = useState('+917827878780');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; reason?: string; resolved_text?: string } | null>(null);
  const [err, setErr] = useState('');

  const send = async () => {
    setErr(''); setBusy(true); setResult(null);
    try {
      const out = await api.post<{ status: string; reason?: string; resolved_text?: string }>(`/sms-templates/${row.id}/test`, { mobile });
      setResult(out);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah">
          <h3><Ic k="wa" />Send test SMS — {row.name}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="fld">
            <label htmlFor="st-mobile">Mobile number <span className="star">*</span></label>
            <input id="st-mobile" className="ainp mono" value={mobile} onChange={(e) => setMobile(e.target.value)}
              placeholder="+917827878780" />
            <div className="fhint">Sends through Nimbus. Until the gateway credentials are entered in Settings, this returns a clean &quot;not configured&quot; and is logged — no crash.</div>
          </div>
          {result && (
            <div className={`bdg ${result.status === 'sent' ? 'b-green' : result.status === 'skipped' ? 'b-amber' : 'b-rose'}`} style={{ marginTop: 8 }}>
              {result.status}{result.reason ? ` — ${result.reason}` : ''}
            </div>
          )}
          {result?.resolved_text && <div style={{ marginTop: 8 }} className="mono sub">{result.resolved_text}</div>}
          {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy} onClick={() => void send()}><Ic k="wa" />Send test</button>
        </div>
      </div>
    </div>
  );
}

export function SmsTemplates() {
  const { data, reload } = useFetch<SmsTemplateRow[]>('/sms-templates');
  const [modal, setModal] = useState<{ open: boolean; row?: SmsTemplateRow | null }>({ open: false });
  const [test, setTest] = useState<SmsTemplateRow | null>(null);
  const rows = data ?? [];

  const del = async (t: SmsTemplateRow) => {
    if (!confirm(`Delete the SMS template "${t.name}"?`)) return;
    await api.del(`/sms-templates/${t.id}`);
    toast('SMS template deleted'); reload();
  };

  return (
    <>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setModal({ open: true, row: null })}>
          <Ic k="plus" />New SMS template
        </button>
      </div>
      <TableCard
        title="SMS templates (DLT)" icon="doc"
        cols={['Header', 'Template name', 'Branch', 'Vertical', 'DLT Template ID', 'Status', '']}
        empty="No SMS templates yet — add one per Branch+Vertical for the new-lead auto-send."
        rows={rows.map((t): Cell[] => [
          { node: <b className="mono">{t.header}</b> },
          { node: <div><b>{t.name}</b><div className="sub" style={{ maxWidth: 320, whiteSpace: 'normal' }}>{t.body}</div></div> },
          t.branch_name ?? 'All',
          t.vertical_name ?? 'All',
          t.dlt_template_id ? { node: <span className="mono sub">{t.dlt_template_id}</span> } : { b: ['Not set', 'b-amber'] },
          t.is_active ? { b: ['Active', 'b-green'] } : { b: ['Inactive', 'b-gray'] },
          {
            node: <RowBtns items={[
              ['wa', 'Send test', () => setTest(t)],
              ['pencil', 'Edit', () => setModal({ open: true, row: t })],
              ['trash', 'Delete', () => void del(t)],
            ]} />,
          },
        ])}
      />
      {modal.open && (
        <SmsTemplateModal initial={modal.row} onClose={() => setModal({ open: false })} onSaved={reload} />
      )}
      {test && <SmsTestModal row={test} onClose={() => setTest(null)} />}
    </>
  );
}
