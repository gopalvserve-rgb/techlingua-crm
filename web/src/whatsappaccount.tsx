/**
 * ENGAGEMENT › WHATSAPP ACCOUNT — /m/engage/waaccount
 *
 * The management screen for the connected WhatsApp Business Account, modelled on the
 * client's reference product:
 *   1. the CONNECTED NUMBERS table (phone, verified name, an editable label, WABA id,
 *      Meta's status, Set default, Remove) with "Connect another number" and "Sync from Meta";
 *   2. the "WhatsApp connected" card — WABA id + Phone ID, Verify / Register phone / Disconnect;
 *   3. WEBHOOK HEALTH — last inbound + events in the last 24 h, or an honest "nothing yet";
 *   4. the WEBHOOK SETUP CHECKLIST with a copyable Callback URL and Verify Token.
 *
 * Everything is read from ONE call (`GET /settings/whatsapp/account`) that never touches
 * Meta, so the page renders instantly; only Sync / Verify / Register / Disconnect go to
 * the Graph API, server-side. The DEFAULT number is the one the sender uses — "Set default"
 * re-points `config.phone_number_id`, which is exactly what Bulk WhatsApp and Live Chat
 * send through.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast } from './refdata';
import { ConfirmModal } from './rowactions';
import { ensureFbSdk, launchEmbeddedSignup } from './whatsappsignup';

/* ------------------------------------------------------------------ types */

export interface WaNumber {
  phone_number_id: string; display_phone_number: string; verified_name: string; waba_id: string;
  status: string; quality_rating: string; code_verification_status: string; name_status?: string;
  label: string; is_default: boolean; config_id: number;
}
export interface WaAccount {
  config_id: number; vertical_id: number | null; vertical_name: string | null;
  waba_id: string; phone_number_id: string; display_phone_number: string; verify_token: string; is_active: boolean;
}
export interface WaAccountPayload {
  connected: boolean;
  accounts: WaAccount[];
  numbers: WaNumber[];
  webhook: { callback_path: string; last_inbound_at: string | null; events_24h: number; healthy: boolean };
}
interface SignupInfo {
  app_id: string; config_id: string; ready: boolean; missing: string[];
  connected: boolean; connected_via: string; display_phone_number: string;
}
type ActionResult = WaAccountPayload & { warning?: string | null; mode?: string; new_default?: string | null; synced?: number };

/* ---------------------------------------------------------------- helpers */

/** "2m ago" — the reference screen's phrasing for the webhook's last inbound. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Meta's status string -> badge tone + the word the admin reads. */
export function statusBadge(status: string): [string, string] {
  const s = String(status || '').toUpperCase();
  if (!s) return ['Not synced', 'b-gray'];
  if (s === 'CONNECTED' || s === 'ACTIVE' || s === 'VERIFIED') return [s, 'b-green'];
  if (s === 'PENDING' || s === 'MIGRATED' || s === 'UNKNOWN' || s === 'UNVERIFIED') return [s, 'b-amber'];
  if (s === 'FLAGGED' || s === 'RESTRICTED' || s === 'BANNED' || s === 'DISCONNECTED' || s === 'RATE_LIMITED') return [s, 'b-red'];
  return [s, 'b-gray'];
}

const QUALITY: Record<string, string> = { GREEN: 'b-green', YELLOW: 'b-amber', RED: 'b-red' };

function copyText(text: string, what: string) {
  try {
    navigator.clipboard?.writeText(text);
    toast(`${what} copied`);
  } catch { toast(`Could not copy the ${what.toLowerCase()} — select it and press Ctrl+C.`, true); }
}

/* --------------------------------------------------------------- the page */

export default function WhatsAppAccount() {
  const { can } = useAuth();
  const nav = useNavigate();
  const canRead = can('settings.read');
  const canWrite = can('settings.update');

  const [data, setData] = useState<WaAccountPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [signup, setSignup] = useState<SignupInfo | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [busy, setBusy] = useState<string>('');              // which action is running
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: 'number' | 'all'; number: WaNumber | null } | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [verifyOut, setVerifyOut] = useState<{ ok: boolean; detail: string; caveat?: string | null } | null>(null);

  const account = data?.accounts[0] ?? null;
  const numbers = data?.numbers ?? [];
  const defaultNo = numbers.find((n) => n.is_default) ?? null;

  const apply = useCallback((p: WaAccountPayload) => {
    setData(p);
    const l: Record<string, string> = {};
    for (const n of p.numbers) l[n.phone_number_id] = n.label ?? '';
    setLabels(l);
  }, []);

  const load = useCallback(async () => {
    if (!canRead) { setLoading(false); return; }
    setLoading(true); setLoadErr('');
    try {
      const [p, s] = await Promise.all([
        api.get<WaAccountPayload>('/settings/whatsapp/account'),
        api.get<SignupInfo>('/settings/whatsapp/embedded-signup').catch(() => null),
      ]);
      apply(p);
      setSignup(s);
    } catch (e) { setLoadErr((e as Error).message); } finally { setLoading(false); }
  }, [canRead, apply]);

  useEffect(() => { void load(); }, [load]);

  // Preload the SDK the moment the page is on screen — loading it inside the click means
  // Chrome has already expired the user gesture by the time FB.login runs (see whatsappsignup.tsx).
  useEffect(() => {
    if (!signup?.app_id || !canWrite) return;
    let dead = false;
    ensureFbSdk(signup.app_id).then(() => !dead && setSdkReady(true)).catch(() => undefined);
    return () => { dead = true; };
  }, [signup?.app_id, canWrite]);

  /** Every write returns the refreshed payload — apply it and surface the warning, if any. */
  const run = async (key: string, fn: () => Promise<ActionResult>, okMsg?: string) => {
    setErr(''); setNote(''); setBusy(key);
    try {
      const out = await fn();
      apply(out);
      if (out.warning) setNote(out.warning);
      if (okMsg) toast(okMsg);
      return out;
    } catch (e) { setErr((e as Error).message); toast((e as Error).message, true); return null; } finally { setBusy(''); }
  };

  const sync = (configId = account?.config_id) => {
    if (!configId) return Promise.resolve(null);
    return run('sync', () => api.post<ActionResult>('/settings/whatsapp/account/sync', { config_id: configId }), 'Numbers synced from Meta');
  };

  const setDefault = (n: WaNumber) => run(`default:${n.phone_number_id}`, () =>
    api.post<ActionResult>('/settings/whatsapp/account/number', { config_id: n.config_id, phone_number_id: n.phone_number_id, is_default: true }),
  `${n.display_phone_number || n.phone_number_id} is now the default sending number`);

  const saveLabel = async (n: WaNumber) => {
    const label = (labels[n.phone_number_id] ?? '').trim();
    if (label === (n.label ?? '')) return;
    await run(`label:${n.phone_number_id}`, () =>
      api.post<ActionResult>('/settings/whatsapp/account/number', { config_id: n.config_id, phone_number_id: n.phone_number_id, label }),
    'Label saved');
  };

  const verify = async () => {
    if (!account) return;
    setErr(''); setVerifyOut(null); setBusy('verify');
    try {
      const out = await api.post<{ ok: boolean; detail: string; caveat?: string | null }>('/settings/whatsapp/account/verify', { config_id: account.config_id });
      setVerifyOut(out);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  const register = async () => {
    if (!account || !pinFor) return;
    if (!/^\d{6}$/.test(pin)) { setErr('The PIN must be exactly 6 digits.'); return; }
    setErr(''); setBusy('register');
    try {
      const out = await api.post<{ ok: boolean; message: string }>('/settings/whatsapp/account/register', { config_id: account.config_id, phone_number_id: pinFor, pin });
      toast(out.message || 'Registered');
      setPinFor(null); setPin('');
      await sync(account.config_id);
    } catch (e) { setErr((e as Error).message); toast((e as Error).message, true); } finally { setBusy(''); }
  };

  const doDisconnect = async () => {
    if (!confirm || !account) return;
    const c = confirm;
    setConfirm(null);
    const body: Record<string, unknown> = { config_id: account.config_id };
    if (c.kind === 'number' && c.number) body.remove_number = c.number.phone_number_id;
    const out = await run('disconnect', () => api.post<ActionResult>('/settings/whatsapp/account/disconnect', body));
    if (!out) return;
    if (out.mode === 'disconnected') toast('WhatsApp disconnected');
    else toast(`${c.number?.display_phone_number || 'Number'} removed${out.new_default ? ' — default moved to another number' : ''}`);
    // the Connect button's readiness may have changed (token gone, app kept)
    api.get<SignupInfo>('/settings/whatsapp/embedded-signup').then(setSignup).catch(() => undefined);
  };

  /** "Connect another number" — the SAME Embedded Signup flow as Settings, then a sync. */
  const connect = async () => {
    setErr(''); setNote('');
    if (!signup?.ready) {
      setErr(`Save your Meta App ID, Configuration ID and App secret in Administration › Settings first — still missing: ${(signup?.missing ?? []).join(', ') || 'Meta app'}.`);
      return;
    }
    if (!sdkReady) { setErr('The Facebook SDK is still loading — press Connect another number again in a moment.'); return; }
    const prevDefault = defaultNo?.phone_number_id ?? '';
    const prevWaba = account?.waba_id ?? '';
    setBusy('connect');
    try {
      // MUST be called synchronously from this click, or Chrome blocks the popup.
      const payload = await launchEmbeddedSignup(signup.config_id);
      const r = await api.post<{ display_phone_number: string; waba_id: string; phone_number_id: string; subscribed: boolean; subscribe_error: string | null; warning: string | null }>(
        '/settings/whatsapp/embedded-signup', payload,
      );
      let m = `Connected ${r.display_phone_number || 'the number'} (WABA ${r.waba_id}).`;
      if (!r.subscribed) m += ` Subscribing the webhook failed: ${r.subscribe_error}.`;
      if (r.warning) m += ` ${r.warning}`;
      // the exchange re-points the sender at the new number; pull the list, then keep the
      // admin's previous default when it is still part of the same account
      const fresh = await api.get<WaAccountPayload>('/settings/whatsapp/account');
      apply(fresh);
      const cfgId = fresh.accounts[0]?.config_id;
      let after: ActionResult | null = cfgId
        ? await api.post<ActionResult>('/settings/whatsapp/account/sync', { config_id: cfgId }).catch(() => null)
        : null;
      if (after && prevDefault && prevDefault !== r.phone_number_id && r.waba_id === prevWaba
        && after.numbers.some((n) => n.phone_number_id === prevDefault)) {
        after = await api.post<ActionResult>('/settings/whatsapp/account/number', { config_id: cfgId, phone_number_id: prevDefault, is_default: true }).catch(() => after);
        m += ' Your previous default is still the sending number — press Set default to switch.';
      } else if (after) {
        m += ' It is now the default sending number.';
      }
      if (after) apply(after);
      setNote(m);
      toast('WhatsApp number connected');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  /* ------------------------------------------------------------- render */

  if (!canRead) {
    return <div className="card"><div className="empty-note">You do not have permission to view the WhatsApp account. Ask an Organization Admin.</div></div>;
  }
  if (loading && !data) return <div className="card"><div className="empty-note">Loading…</div></div>;
  if (loadErr && !data) {
    return (
      <div className="card"><div className="card-pad">
        <div className="notice err"><Ic k="bolt" /><div>{loadErr}</div></div>
        <button className="btn" onClick={() => void load()}><Ic k="refresh" />Retry</button>
      </div></div>
    );
  }

  const callbackUrl = typeof location !== 'undefined' && data ? `${location.origin}${data.webhook.callback_path}` : '';
  const wh = data?.webhook;
  const connectBtn = canWrite ? (
    <button className="btn primary" disabled={busy === 'connect' || !signup?.ready} onClick={() => void connect()}
      title={signup && !signup.ready ? `Missing: ${signup.missing.join(', ')}` : undefined}>
      <Ic k="wa" />{account ? 'Connect another number' : 'Connect WhatsApp'}
    </button>
  ) : null;

  /* ---- not connected: a clean empty state, with the way in ---- */
  if (!account) {
    return (
      <>
        <div className="page-actions">{connectBtn}</div>
        <div className="card" data-testid="wa-not-connected">
          <div className="card-head"><h3><Ic k="wa" />WhatsApp is not connected</h3></div>
          <div className="card-pad">
            {signup && !signup.ready ? (
              <div className="notice warn"><Ic k="bolt" /><div>
                <b>Save your Meta app in Settings first.</b> The Connect button needs the Meta App ID,
                the Embedded Signup Configuration ID and the App secret — still missing:{' '}
                <b>{signup.missing.join(', ')}</b>.{' '}
                <a onClick={() => nav('/m/admin/settings')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Open Administration › Settings</a>
              </div></div>
            ) : (
              <p className="sub" style={{ marginTop: 0 }}>
                Press <b>Connect WhatsApp</b>, log in to Meta and pick your WhatsApp Business Account and
                phone number. We store a <b>permanent</b> token and subscribe the webhook for you — nothing to paste.
              </p>
            )}
            {err ? <div className="notice err"><Ic k="bolt" /><div>{err}</div></div> : null}
            {note ? <div className="notice ok"><Ic k="check" /><div>{note}</div></div> : null}
          </div>
        </div>
      </>
    );
  }

  const rows: Cell[][] = numbers.map((n): Cell[] => {
    const [st, tone] = statusBadge(n.status);
    const isBusy = busy.endsWith(n.phone_number_id);
    return [
      { node: (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className="mono">{n.display_phone_number || n.phone_number_id}</span>
          {n.is_default ? <span className="bdg b-indigo" data-testid="default-badge">Default</span> : null}
        </span>
      ) },
      n.verified_name || '—',
      { node: canWrite ? (
        <input className="ainp" style={{ minWidth: 140 }} placeholder="e.g. Sales line" aria-label={`Label for ${n.display_phone_number || n.phone_number_id}`}
          value={labels[n.phone_number_id] ?? ''} disabled={isBusy}
          onChange={(e) => setLabels({ ...labels, [n.phone_number_id]: e.target.value })}
          onBlur={() => void saveLabel(n)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} />
      ) : <span>{n.label || '—'}</span> },
      { mono: n.waba_id || '—', dim: true },
      { node: (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`bdg ${tone}`}>{st}</span>
          {n.quality_rating ? <span className={`bdg ${QUALITY[n.quality_rating.toUpperCase()] ?? 'b-gray'}`} title="Quality rating">Q: {n.quality_rating}</span> : null}
        </span>
      ) },
      { node: canWrite ? (
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {n.is_default
            ? <span className="sub">Used for sending</span>
            : <button className="btn sm" disabled={!!busy} onClick={() => void setDefault(n)}><Ic k="check" />Set default</button>}
          <button className="btn sm" disabled={!!busy} title={numbers.length > 1 ? 'Remove this number from the CRM' : 'Disconnect WhatsApp'}
            style={{ color: 'var(--danger)' }} onClick={() => setConfirm({ kind: 'number', number: n })}>
            <Ic k="trash" />Remove
          </button>
        </span>
      ) : <span /> },
    ];
  });

  return (
    <>
      <div className="page-actions">
        {canWrite ? (
          <button className="btn" disabled={!!busy} onClick={() => void sync()}>
            <Ic k="refresh" />{busy === 'sync' ? 'Syncing…' : 'Sync from Meta'}
          </button>
        ) : null}
        {connectBtn}
      </div>

      {!data?.connected ? (
        <div className="notice warn"><Ic k="bolt" /><div>
          <b>This connection cannot send yet.</b> It is inactive or missing its access token — press{' '}
          <b>Connect another number</b> to log in to Meta again, or complete it in Administration › Settings.
        </div></div>
      ) : null}
      {err ? <div className="notice err"><Ic k="bolt" /><div>{err}</div></div> : null}
      {note ? <div className="notice ok"><Ic k="check" /><div>{note}</div></div> : null}

      {/* ------------------------------------------------ 1. connected numbers */}
      <TableCard
        title="Connected numbers" icon="wa"
        cols={['Phone', 'Verified name', 'Label', 'WABA id', 'Status', '']}
        rows={rows}
        empty="No numbers stored yet — press Sync from Meta."
        more={<span className="sub">The <b>default</b> number is used for sending unless an agent picks another in Live Chat.</span>}
      />

      {/* --------------------------------------------- 2. WhatsApp connected */}
      <div className="card" style={{ marginTop: 16 }} data-testid="wa-connected-card">
        <div className="card-head">
          <h3><Ic k="check" />WhatsApp connected</h3>
          <span className="more"><span className={`bdg ${data?.connected ? 'b-green' : 'b-amber'}`}>{data?.connected ? 'CONNECTED' : 'INCOMPLETE'}</span></span>
        </div>
        <div className="card-pad">
          <div className="kv">
            <div className="f">
              <label>WABA id</label>
              <div className="iv"><span className="mono">{account.waba_id || '—'}</span>
                {account.waba_id ? <button className="icon-btn sm" title="Copy WABA id" onClick={() => copyText(account.waba_id, 'WABA id')}><Ic k="copy" /></button> : null}
              </div>
            </div>
            <div className="f">
              <label>Phone ID (default)</label>
              <div className="iv"><span className="mono">{account.phone_number_id || '—'}</span>
                {account.phone_number_id ? <button className="icon-btn sm" title="Copy Phone ID" onClick={() => copyText(account.phone_number_id, 'Phone ID')}><Ic k="copy" /></button> : null}
              </div>
            </div>
          </div>
          <div className="fhint" style={{ marginTop: 6 }}>
            Sending from <b>{account.display_phone_number || defaultNo?.display_phone_number || account.phone_number_id || '—'}</b>
            {account.vertical_name ? <> · {account.vertical_name}</> : ' · organisation-wide'}
          </div>

          {canWrite ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <button className="btn" disabled={!!busy} onClick={() => void verify()}><Ic k="shield" />{busy === 'verify' ? 'Verifying…' : 'Verify'}</button>
              <button className="btn" disabled={!!busy || !numbers.length} onClick={() => { setPinFor(pinFor ? null : (defaultNo?.phone_number_id ?? numbers[0]?.phone_number_id ?? null)); setPin(''); }}>
                <Ic k="phone" />Register phone
              </button>
              <button className="btn" disabled={!!busy} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                onClick={() => setConfirm({ kind: 'all', number: null })}>
                <Ic k="power" />Disconnect
              </button>
            </div>
          ) : null}

          {verifyOut ? (
            <div className={`notice ${verifyOut.ok ? 'ok' : 'err'}`} style={{ marginTop: 12, marginBottom: 0 }} data-testid="verify-result">
              <Ic k={verifyOut.ok ? 'check' : 'bolt'} />
              <div>{verifyOut.detail}{verifyOut.ok && verifyOut.caveat ? <div className="fhint">{verifyOut.caveat}</div> : null}</div>
            </div>
          ) : null}

          {pinFor !== null ? (
            <div className="card" style={{ marginTop: 12 }} data-testid="register-form">
              <div className="card-pad">
                <div className="form-grid">
                  <div className="fld">
                    <label htmlFor="wa-reg-no">Number to register</label>
                    <select id="wa-reg-no" className="ainp" value={pinFor} onChange={(e) => setPinFor(e.target.value)}>
                      {numbers.map((n) => <option key={n.phone_number_id} value={n.phone_number_id}>{n.display_phone_number || n.phone_number_id}{n.label ? ` · ${n.label}` : ''}</option>)}
                    </select>
                  </div>
                  <div className="fld">
                    <label htmlFor="wa-reg-pin">6-digit PIN</label>
                    <input id="wa-reg-pin" className="ainp mono" inputMode="numeric" maxLength={6} placeholder="000000"
                      value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                    <div className="fhint">Your two-step verification PIN. If you never set one, Meta accepts <b>000000</b>. Registration is only needed for a number that shows PENDING / not registered.</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn primary" disabled={busy === 'register' || pin.length !== 6} onClick={() => void register()}><Ic k="check" />{busy === 'register' ? 'Registering…' : 'Register'}</button>
                  <button className="btn" onClick={() => { setPinFor(null); setPin(''); }}>Cancel</button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* -------------------------------------------------- 3. webhook health */}
      <div className="card" style={{ marginTop: 16 }} data-testid="webhook-health">
        <div className="card-head">
          <h3><Ic k="bolt" />Webhook health</h3>
          <span className="more"><span className={`bdg ${wh?.healthy ? 'b-green' : wh?.last_inbound_at ? 'b-amber' : 'b-gray'}`}>
            {wh?.healthy ? 'RECEIVING' : wh?.last_inbound_at ? 'QUIET' : 'NO EVENTS YET'}
          </span></span>
        </div>
        <div className="card-pad">
          {wh?.last_inbound_at ? (
            <div className={`notice ${wh.healthy ? 'ok' : 'warn'}`} style={{ marginBottom: 0 }}>
              <Ic k={wh.healthy ? 'check' : 'bolt'} />
              <div>
                {wh.healthy ? 'Webhook is receiving events from Meta.' : 'Meta has not called the webhook recently.'}{' '}
                Last inbound: <b title={new Date(wh.last_inbound_at).toLocaleString()}>{ago(wh.last_inbound_at)}</b> · <b>{wh.events_24h}</b> events in last 24 h.
              </div>
            </div>
          ) : (
            <div className="notice" style={{ marginBottom: 0 }}>
              <Ic k="bolt" />
              <div>
                <b>No events received yet.</b> Meta has never called <span className="mono">{callbackUrl}</span>. Finish the
                checklist below, then send a WhatsApp message to your number — the first inbound event shows up here.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------- 4. webhook setup checklist */}
      <div className="card" style={{ marginTop: 16 }} data-testid="webhook-checklist">
        <div className="card-head"><h3><Ic k="link" />Webhook setup checklist</h3></div>
        <div className="card-pad">
          <p className="sub" style={{ marginTop: 0 }}>
            Connect WhatsApp subscribes your account automatically. Do this only if webhook health stays
            empty, or you are wiring the app by hand.
          </p>
          <ol className="steps">
            <li>Open the <b>Meta App Dashboard</b> › <b>WhatsApp</b> › <b>Configuration</b> › <b>Edit</b> webhook.</li>
            <li>
              Paste the <b>Callback URL</b>:
              <div className="form-grid" style={{ marginTop: 6 }}>
                <div className="fld span2" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input className="ainp mono" readOnly value={callbackUrl} aria-label="Callback URL" onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn sm" type="button" onClick={() => copyText(callbackUrl, 'Callback URL')}><Ic k="copy" />Copy</button>
                </div>
              </div>
            </li>
            <li>
              Paste the <b>Verify Token</b>:
              <div className="form-grid" style={{ marginTop: 6 }}>
                <div className="fld span2" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input className="ainp mono" readOnly value={account.verify_token || ''} aria-label="Verify Token" onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn sm" type="button" disabled={!account.verify_token} onClick={() => copyText(account.verify_token, 'Verify Token')}><Ic k="copy" />Copy</button>
                </div>
              </div>
              {!account.verify_token ? <div className="fhint">No verify token stored yet — save the WhatsApp channel once in Administration › Settings to generate one.</div> : null}
            </li>
            <li>Click <b>Verify and save</b>. Meta calls the URL with your token; the CRM answers the challenge.</li>
            <li>
              Under <b>Webhook fields</b>, subscribe to <span className="mono">messages</span> (required — inbound messages
              <i> and </i> delivery / read receipts) and <span className="mono">message_template_status_update</span>.
            </li>
          </ol>
        </div>
      </div>

      {confirm ? (
        <ConfirmModal
          title={confirm.kind === 'all' || numbers.length <= 1 ? 'Disconnect WhatsApp?' : 'Remove this number?'}
          danger busy={busy === 'disconnect'}
          confirmLabel={confirm.kind === 'all' || numbers.length <= 1 ? 'Disconnect' : 'Remove'}
          onConfirm={() => void doDisconnect()} onClose={() => setConfirm(null)}
          body={confirm.kind === 'number' && confirm.number && numbers.length > 1 ? (
            <>
              Remove <b>{confirm.number.display_phone_number || confirm.number.phone_number_id}</b>
              {confirm.number.label ? <> ({confirm.number.label})</> : null} from the CRM?
              {confirm.number.is_default ? <> It is the <b>default sending number</b> — sending will move to another connected number.</> : null}
              {' '}The number stays in your Meta account; <b>Sync from Meta</b> would list it again.
            </>
          ) : (
            <>
              Disconnect WhatsApp{confirm.number ? <> (<b>{confirm.number.display_phone_number || confirm.number.phone_number_id}</b> is the only number)</> : null}?
              Bulk WhatsApp and Live Chat stop sending immediately, the stored access token is removed and the webhook is
              unsubscribed at Meta. Your Meta App ID / secret and verify token are kept so you can reconnect.
              {defaultNo && !confirm.number ? <> Current number: <b>{defaultNo.display_phone_number || defaultNo.phone_number_id}</b>.</> : null}
            </>
          )}
        />
      ) : null}
    </>
  );
}
