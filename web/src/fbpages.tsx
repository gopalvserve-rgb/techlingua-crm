/**
 * Facebook Page Monitor + Form Mapping — the two drawers a Meta Lead Ads channel row opens.
 *
 *  · Pages        every Facebook Page the admin granted on "Connect Page", each with a
 *                 Monitored switch (= our app subscribed to its leadgen field), the last
 *                 status Facebook reported, leads received, and Refresh / Re-authorise /
 *                 Disconnect Facebook.
 *  · Form Mapping per monitored Page, its Lead Ad forms; per form, every question with a
 *                 CRM-field dropdown, an Auto-map, an Enabled switch, Save.
 *
 * Both are read-only for a channel.read user (no write controls), same rule as channels.tsx.
 * No Page token is ever part of any payload these screens receive.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';
import type { Channel } from './channels';

export interface FbPage {
  page_id: string; page_name: string; monitored: boolean; subscribed: boolean | null;
  subscribed_at: string | null; checked_at: string | null; last_error: string | null;
  has_token: boolean; is_primary: boolean; leads: number; last_lead_at: string | null;
}
export interface FbPagesResp { connected: boolean; pages: FbPage[]; warning?: string | null }
export interface FbFormRow {
  form_id: string; form_name: string; status: string; locale: string;
  total_fields: number; mapped_fields: number; has_custom_mapping: boolean; is_enabled: boolean;
}
export interface FbFormsResp { page_id: string; page_name: string; truncated: boolean; forms: FbFormRow[] }
export interface FbMappingResp {
  form: { form_id: string; form_name: string; page_id: string };
  questions: Array<{ key: string; label: string; type: string }>;
  field_map: Record<string, string>;
  saved: boolean; is_enabled: boolean;
  crm_fields: Array<{ key: string; label: string }>;
  suggested: Record<string, string>;
  channel_field_map: Record<string, string>;
}

/** "3 min ago" / "2 d ago" — the Page table's last-lead column. */
export function ago(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 60) return `${d} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const fmt = (s?: string | null) =>
  !s ? '—' : new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function statusBadge(p: FbPage): [string, string, string] {
  if (p.last_error) return ['Error', 'b-red', p.last_error];
  if (p.subscribed === true) return ['Subscribed', 'b-green', `Facebook confirmed the leadgen subscription${p.checked_at ? ` (checked ${fmt(p.checked_at)})` : ''}`];
  if (p.subscribed === false) return ['Not subscribed', 'b-gray', 'Our app is not subscribed to this Page\'s leadgen field on Facebook'];
  return ['Unknown', 'b-gray', 'Not checked yet — press Refresh status'];
}

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return (
    <label className="switch" title={on ? 'On' : 'Off'}>
      <input type="checkbox" role="switch" aria-label={label} checked={on} disabled={disabled} onChange={onChange} />
      <span className="slider" />
    </label>
  );
}

/* ================================================================ Page Monitor === */

export function FbPagesModal({ channel, canManage, onClose, onConnect, onChanged }: {
  channel: Channel; canManage: boolean; onClose: () => void;
  /** the existing "Connect Page" OAuth flow (re-authorise / connect another) */
  onConnect: () => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<FbPagesResp | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);   // page id, 'refresh' or 'disconnect'

  const load = () => {
    setErr('');
    api.get<FbPagesResp>(`/channels/${channel.id}/fb/pages`).then(setData).catch((e) => setErr((e as Error).message));
  };
  useEffect(load, [channel.id]);          // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<FbPagesResp | unknown>, ok: string) => {
    setBusy(key); setErr('');
    try {
      const r = await fn();
      if (r && typeof r === 'object' && Array.isArray((r as FbPagesResp).pages)) setData(r as FbPagesResp);
      else load();
      const warn = (r as FbPagesResp | null)?.warning;
      toast(warn ? `${ok} — but Facebook said: ${warn}` : ok, !!warn);
      onChanged?.();
    } catch (e) { toast((e as Error).message, true); load(); } finally { setBusy(null); }
  };

  const toggle = (p: FbPage) => run(p.page_id,
    () => api.post<FbPagesResp>(`/channels/${channel.id}/fb/pages/${p.page_id}/${p.monitored ? 'unsubscribe' : 'subscribe'}`, {}),
    p.monitored ? `Stopped monitoring "${p.page_name}"` : `Now monitoring "${p.page_name}"`);
  const refresh = () => run('refresh', () => api.post<FbPagesResp>(`/channels/${channel.id}/fb/pages/refresh`, {}), 'Status refreshed from Facebook');
  const disconnect = () => {
    if (!confirm(`Disconnect Facebook from “${channel.name}”?\n\nEvery Page is unsubscribed and every Page token is deleted — no more Meta leads arrive on this channel until you Connect Page again. Your form mappings are kept.`)) return;
    void run('disconnect', () => api.post(`/channels/${channel.id}/fb/disconnect`, {}), 'Facebook disconnected');
  };

  const pages = data?.pages ?? [];

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 860 }} data-testid="fb-pages-modal">
        <div className="ah">
          <h3><Ic k="bolt" />Facebook Pages — {channel.name}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="notice">
            <Ic k="shield" />
            <div>
              <b>Monitored</b> = our app is subscribed to that Page's <b>leadgen</b> field and holds its Page token, so its
              Lead Ads land in <b>{channel.campaign_name} › {channel.source_name}</b>. A Page that is switched off is still
              connected — its deliveries are logged as <i>skipped</i> and create no lead.
              <div style={{ marginTop: 6 }}>
                Only the Pages you <b>ticked in Facebook's permission window</b> appear here — not everything in your
                Business Settings. To add more, press <b>Connect Page</b> again and choose <i>Edit settings</i> /
                <i> Opt in to current Pages only</i>, then tick the extra Pages.
              </div>
            </div>
          </div>
          {err && <div className="form-err" role="alert">{err}</div>}

          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <h3><Ic k="list" />Pages</h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {canManage && (
                  <button className="btn" disabled={busy !== null || !pages.length} onClick={refresh} title="Ask Facebook whether each Page is still subscribed">
                    <Ic k="refresh" />{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
                  </button>
                )}
                {canManage && (
                  <button className="btn primary" onClick={onConnect} title="Log in with Facebook again — adds newly granted Pages and refreshes tokens">
                    <Ic k="link" />{pages.length ? 'Connect another / Re-authorise' : 'Connect Page'}
                  </button>
                )}
                {canManage && pages.length > 0 && (
                  <button className="btn" style={{ color: 'var(--danger)' }} disabled={busy !== null} onClick={disconnect}
                    title="Unsubscribe every Page and delete every Page token">
                    <Ic k="ban" />{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Facebook'}
                  </button>
                )}
              </div>
            </div>
            {!data && !err ? (
              <div className="empty-note">Loading…</div>
            ) : !pages.length ? (
              <div className="empty-note" data-testid="fb-pages-empty">
                No Facebook Page is connected to this channel yet.
                {canManage ? ' Press Connect Page, log in with Facebook and grant the Pages whose Lead Ads should flow here — every Page you grant appears in this list.' : ' An admin must press Connect Page first.'}
              </div>
            ) : (
              <table className="tbl" data-testid="fb-pages-table">
                <thead>
                  <tr><th>Page</th><th>Page id</th><th>Monitored</th><th>Status</th><th>Leads received</th><th>Last lead</th></tr>
                </thead>
                <tbody>
                  {pages.map((p) => {
                    const [label, tone, tip] = statusBadge(p);
                    return (
                      <tr key={p.page_id}>
                        <td>
                          <span className="nm">{p.page_name || p.page_id}</span>
                          {p.is_primary && <span className="bdg b-indigo" style={{ marginLeft: 6 }} title="The Page this channel was first connected with">Primary</span>}
                          {!p.has_token && <div className="sub" style={{ fontSize: 11, color: 'var(--danger)' }}>No token — re-authorise</div>}
                        </td>
                        <td><span className="mono sub">{p.page_id}</span></td>
                        <td>
                          {canManage ? (
                            <Switch on={p.monitored} disabled={busy !== null || !p.has_token}
                              label={`Monitor ${p.page_name || p.page_id}`} onChange={() => toggle(p)} />
                          ) : (
                            <span className={`bdg ${p.monitored ? 'b-green' : 'b-gray'}`}>{p.monitored ? 'ON' : 'OFF'}</span>
                          )}
                        </td>
                        <td><span className={`bdg ${tone}`} title={tip}>{label}</span></td>
                        <td><span className="mono">{p.leads}</span></td>
                        <td><span title={p.last_lead_at ? fmt(p.last_lead_at) : undefined}>{ago(p.last_lead_at)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="af">
          <span className="fhint" style={{ marginRight: 'auto' }}>Leads received = deliveries that reached the pipeline (created or merged as a duplicate), from the inbound event log.</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ Form Mapping === */

export function FbFormMappingModal({ channel, canManage, onClose }: {
  channel: Channel; canManage: boolean; onClose: () => void;
}) {
  const [pages, setPages] = useState<FbPage[] | null>(null);
  const [pageId, setPageId] = useState('');
  const [forms, setForms] = useState<FbFormsResp | null>(null);
  const [formsErr, setFormsErr] = useState('');
  const [loadingForms, setLoadingForms] = useState(false);
  const [formId, setFormId] = useState('');
  const [mapping, setMapping] = useState<FbMappingResp | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<FbPagesResp>(`/channels/${channel.id}/fb/pages`)
      .then((r) => {
        setPages(r.pages);
        const first = r.pages.find((p) => p.monitored) ?? r.pages[0];
        if (first) setPageId(first.page_id);
      })
      .catch((e) => { setPages([]); setFormsErr((e as Error).message); });
  }, [channel.id]);

  const loadForms = (pid: string) => {
    if (!pid) { setForms(null); return; }
    setLoadingForms(true); setFormsErr('');
    api.get<FbFormsResp>(`/channels/${channel.id}/fb/pages/${pid}/forms`)
      .then(setForms)
      .catch((e) => { setForms(null); setFormsErr((e as Error).message); })
      .finally(() => setLoadingForms(false));
  };
  useEffect(() => { setFormId(''); setMapping(null); loadForms(pageId); }, [pageId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const openForm = (fid: string) => {
    if (dirty && !confirm('You have unsaved mapping changes. Discard them?')) return;
    setFormId(fid); setMapping(null); setDirty(false);
    if (!fid) return;
    api.get<FbMappingResp>(`/channels/${channel.id}/fb/forms/${fid}/mapping?page_id=${encodeURIComponent(pageId)}`)
      .then((m) => {
        setMapping(m);
        setDraft(m.saved ? { ...m.field_map } : { ...m.suggested });
        setEnabled(m.is_enabled);
      })
      .catch((e) => toast((e as Error).message, true));
  };

  const close = () => {
    if (dirty && !confirm('You have unsaved mapping changes. Close anyway?')) return;
    onClose();
  };

  const autoMap = () => {
    if (!mapping) return;
    setDraft({ ...mapping.suggested });
    setDirty(true);
  };

  const save = async () => {
    if (!mapping) return;
    setBusy(true);
    try {
      const body = { field_map: draft, is_enabled: enabled, page_id: pageId, form_name: mapping.form.form_name };
      const m = await api.put<FbMappingResp>(`/channels/${channel.id}/fb/forms/${mapping.form.form_id}/mapping`, body);
      setMapping(m); setDraft({ ...m.field_map }); setEnabled(m.is_enabled); setDirty(false);
      toast('Form mapping saved');
      loadForms(pageId);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  /** the Enabled switch in the forms table saves straight away (no field changes involved) */
  const toggleEnabled = async (f: FbFormRow) => {
    setBusy(true);
    try {
      await api.put(`/channels/${channel.id}/fb/forms/${f.form_id}/mapping`, { is_enabled: !f.is_enabled, page_id: pageId, form_name: f.form_name });
      toast(f.is_enabled ? `"${f.form_name}" disabled — its leads are now skipped` : `"${f.form_name}" enabled`);
      if (mapping?.form.form_id === f.form_id) setEnabled(!f.is_enabled);
      loadForms(pageId);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const mappedNow = useMemo(() => (mapping ? mapping.questions.filter((q) => draft[q.key]).length : 0), [mapping, draft]);
  const selPage = pages?.find((p) => p.page_id === pageId);

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 960 }} data-testid="fb-mapping-modal">
        <div className="ah">
          <h3><Ic k="grid" />Facebook Form Mapping — {channel.name}</h3>
          <button className="ax" onClick={close} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="notice">
            <Ic k="bolt" />
            <div>
              Pick a Page, then a Lead Ad form, and choose which CRM field each question fills. A form's map is laid
              <b> on top of</b> the channel-level mapping (Edit › Extra field mapping) — the form wins. Standard questions
              (full name, phone, email, city…) map automatically; choose <i>— ignore —</i> to drop one.
            </div>
          </div>

          <div className="form-grid">
            <div className="fld">
              <label>Facebook Page</label>
              <select className="ainp" aria-label="Facebook Page" value={pageId} onChange={(e) => setPageId(e.target.value)}
                disabled={!pages?.length}>
                {!pages?.length && <option value="">{pages === null ? 'Loading…' : 'No Page connected — press Connect Page first'}</option>}
                {(pages ?? []).map((p) => (
                  <option key={p.page_id} value={p.page_id}>{p.page_name || p.page_id}{p.monitored ? '' : ' (not monitored)'}</option>
                ))}
              </select>
              {selPage && !selPage.monitored && <span className="fhint">This Page is not monitored — you can prepare its mapping, but its leads are skipped until it is switched on under Pages.</span>}
            </div>
          </div>

          {formsErr && <div className="form-err" role="alert">{formsErr}</div>}

          {/* ------------------------------ forms ------------------------------ */}
          <div className="card" style={{ margin: 0 }}>
            <div className="card-head">
              <h3><Ic k="list" />Lead Ad forms{forms ? ` — ${forms.forms.length}` : ''}</h3>
              <span className="more">{forms?.truncated ? 'Showing the first 200 forms' : 'read live from Facebook'}</span>
            </div>
            {loadingForms ? <div className="empty-note">Reading forms from Facebook…</div>
              : !forms || !forms.forms.length ? <div className="empty-note">{pageId ? 'This Page has no Lead Ad forms yet.' : 'Choose a Page.'}</div>
              : (
                <table className="tbl" data-testid="fb-forms-table">
                  <thead><tr><th>Form</th><th>Status</th><th>Mapped fields</th><th>Enabled</th><th></th></tr></thead>
                  <tbody>
                    {forms.forms.map((f) => (
                      <tr key={f.form_id} className={f.form_id === formId ? 'on' : undefined}>
                        <td>
                          <span className="nm">{f.form_name}</span>
                          <div className="sub mono" style={{ fontSize: 11 }}>{f.form_id}{f.has_custom_mapping ? ' · custom map' : ''}</div>
                        </td>
                        <td><span className={`bdg ${f.status === 'ACTIVE' ? 'b-green' : 'b-gray'}`}>{f.status}</span></td>
                        <td><span className="mono">{f.mapped_fields}/{f.total_fields}</span></td>
                        <td>
                          {canManage
                            ? <Switch on={f.is_enabled} disabled={busy} label={`Enable ${f.form_name}`} onChange={() => toggleEnabled(f)} />
                            : <span className={`bdg ${f.is_enabled ? 'b-green' : 'b-gray'}`}>{f.is_enabled ? 'ON' : 'OFF'}</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button className={`btn${f.form_id === formId ? ' primary' : ''}`} onClick={() => openForm(f.form_id)}>
                            <Ic k="pencil" />{canManage ? 'Map fields' : 'View mapping'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          {/* ---------------------------- questions ---------------------------- */}
          {formId && (
            <div className="card" style={{ margin: 0 }} data-testid="fb-question-map">
              <div className="card-head">
                <h3><Ic k="grid" />{mapping ? `Questions — ${mapping.form.form_name}` : 'Loading questions…'}</h3>
                {mapping && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="sub">{mappedNow}/{mapping.questions.length} mapped{mapping.saved ? '' : ' · suggested (not saved yet)'}</span>
                    {canManage && (
                      <>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <Switch on={enabled} disabled={busy} label="Form enabled" onChange={() => { setEnabled(!enabled); setDirty(true); }} />
                          Enabled
                        </label>
                        <button className="btn" onClick={autoMap} title="Apply the suggested mapping"><Ic k="bolt" />Auto-map</button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {mapping && !mapping.questions.length && (
                <div className="empty-note">Facebook returned no questions for this form.</div>
              )}
              {mapping && mapping.questions.length > 0 && (
                <table className="tbl">
                  <thead><tr><th>Question</th><th>Key</th><th>Type</th><th>CRM field</th></tr></thead>
                  <tbody>
                    {mapping.questions.map((q) => (
                      <tr key={q.key}>
                        <td><span className="nm">{q.label}</span></td>
                        <td><span className="mono sub">{q.key}</span></td>
                        <td><span className="bdg b-gray">{q.type}</span></td>
                        <td>
                          <select className="ainp" aria-label={`Map ${q.label}`} value={draft[q.key] ?? ''} disabled={!canManage}
                            onChange={(e) => { setDraft((d) => ({ ...d, [q.key]: e.target.value })); setDirty(true); }}>
                            <option value="">— ignore —</option>
                            {mapping.crm_fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className="af">
          {dirty && <span className="fhint" style={{ marginRight: 'auto', color: 'var(--amber, #d97706)' }}>Unsaved changes</span>}
          <button className="btn" onClick={close}>Close</button>
          {canManage && formId && (
            <button className="btn primary" disabled={busy || !mapping || !dirty} onClick={save}>
              {busy ? 'Saving…' : 'Save mapping'}<Ic k="check" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
