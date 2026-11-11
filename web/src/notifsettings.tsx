/**
 * ADMINISTRATION › NOTIFICATION SETTINGS — client 11 Nov 2026 ("Development Requirements — 11 Nov", §2–4).
 *
 * Staff notifications (the bell + pop-up), one rule per business event:
 *   · master switches — per module and per channel (pop-up / sound / desktop / email / WhatsApp)
 *   · per event — on/off, bell, pop-up, sound, desktop, email, WhatsApp, priority,
 *     WHEN it goes (immediately / after N min · N min before · at the time · N min after),
 *     WHO gets it (the assigned user and/or chosen roles in that branch) and HIERARCHY
 *     escalation (not actioned in N min → their Reports-To manager, then the next level …).
 * The customer-facing SMS / email / WhatsApp templates stay on Engagement › Notification Events.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast, useFetch } from './refdata';
import { desktopNotify, playChime } from './notifications';

export interface StaffRule {
  event_key: string; module: string; name: string; message: string;
  timing_kind: 'instant' | 'before' | 'at' | 'after'; sort_order: number;
  enabled: boolean; in_app: boolean; toast: boolean; sound: boolean; desktop: boolean;
  email: boolean; whatsapp: boolean; priority: 'low' | 'medium' | 'high' | 'critical';
  delay_minutes: number; notify_owner: boolean; role_ids: number[];
  escalate: boolean; escalate_after_minutes: number; escalate_levels: number;
}
interface StaffGlobal { modules: Record<string, boolean>; toast: boolean; sound: boolean; desktop: boolean; email: boolean; whatsapp: boolean }

const MODULES = ['CRM', 'Admissions', 'Students', 'Finance', 'Academics', 'Attendance'];
const CHANNELS: Array<[keyof StaffRule & keyof StaffGlobal | 'in_app', string]> = [
  ['in_app', 'Bell'], ['toast', 'Pop-up'], ['sound', 'Sound'], ['desktop', 'Desktop'], ['email', 'Email'], ['whatsapp', 'WhatsApp'],
];
const PRIOS = ['low', 'medium', 'high', 'critical'] as const;
const OWNER_LABEL: Record<string, string> = {
  CRM: 'the lead’s counsellor', Admissions: 'the assigned user', Students: 'the counsellor',
  Finance: 'the enrolment’s counsellor', Academics: 'the batch trainer', Attendance: 'the batch trainer',
};

/** "15 min" · "2 h" · "1 day" */
export function fmtMinutes(m: number): string {
  if (m % 1440 === 0 && m >= 1440) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0 && m >= 60) return `${m / 60} h`;
  return `${m} min`;
}

/** Plain-language timing for a rule. */
export function timingText(r: Pick<StaffRule, 'timing_kind' | 'delay_minutes'>): string {
  if (r.timing_kind === 'before') return `${fmtMinutes(r.delay_minutes)} before the follow-up`;
  if (r.timing_kind === 'at') return 'At the scheduled time';
  if (r.timing_kind === 'after') return `${fmtMinutes(r.delay_minutes)} after it is due`;
  return r.delay_minutes > 0 ? `After ${fmtMinutes(r.delay_minutes)}` : 'Immediately';
}

export function NotificationSettings() {
  const { can } = useAuth();
  const editable = can('notification_event.manage');
  const [tick, setTick] = useState(0);
  const data = useFetch<{ global: StaffGlobal; rules: StaffRule[] }>('/notification-settings', [tick]);
  const roles = useFetch<any[]>('/roles', []);
  const roleName = useMemo(() => new Map((roles.data ?? []).map((r: any) => [Number(r.id), String(r.name)])), [roles.data]);
  const [edit, setEdit] = useState<StaffRule | null>(null);
  const [perm, setPerm] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const g = data.data?.global;
  const rules = data.data?.rules ?? [];

  const saveGlobal = async (patch: Partial<StaffGlobal>) => {
    try { await api.put('/notification-settings/global', patch); setTick((t) => t + 1); toast('Saved'); }
    catch (e) { toast((e as Error).message, true); }
  };
  const saveRule = async (key: string, patch: Partial<StaffRule>) => {
    try { await api.patch(`/notification-settings/${key}`, patch); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };
  const askDesktop = async () => {
    if (typeof Notification === 'undefined') { toast('This browser does not support desktop notifications', true); return; }
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === 'granted') desktopNotify({ id: 0, title: 'Desktop notifications are on', body: 'CRM alerts will appear here too.' });
  };
  const rolesText = (r: StaffRule) => {
    const parts: string[] = [];
    if (r.notify_owner) parts.push('Assigned user');
    for (const id of r.role_ids) parts.push(roleName.get(Number(id)) ?? `Role #${id}`);
    return parts.length ? parts.join(', ') : 'Nobody';
  };

  return (
    <>
      <div className="card" data-testid="nset-global">
        <div className="card-head"><h3><Ic k="bell" />Notification settings</h3></div>
        <div className="card-pad">
          <p className="sub" style={{ marginTop: 0 }}>
            Staff alerts — the bell, pop-ups, sound, desktop, email and WhatsApp to your team — for each event below.
            Messages to students and leads are set up separately on <b>Engagement › Notification Events</b>.
          </p>
          {!g ? <div className="sub">Loading…</div> : (
            <>
              <div className="fhint" style={{ fontWeight: 700, marginTop: 6 }}>Modules</div>
              <div className="nset-switches">
                {MODULES.map((m) => (
                  <label key={m}><input type="checkbox" disabled={!editable} checked={g.modules[m] !== false}
                    data-testid={`nset-mod-${m}`} onChange={(e) => void saveGlobal({ modules: { ...g.modules, [m]: e.target.checked } })} />{m}</label>
                ))}
              </div>
              <div className="fhint" style={{ fontWeight: 700, marginTop: 10 }}>Channels (master switch for every event)</div>
              <div className="nset-switches">
                {(['toast', 'sound', 'desktop', 'email', 'whatsapp'] as const).map((k) => (
                  <label key={k}><input type="checkbox" disabled={!editable} checked={!!g[k]} data-testid={`nset-ch-${k}`}
                    onChange={(e) => void saveGlobal({ [k]: e.target.checked })} />
                    {k === 'toast' ? 'Toast pop-ups' : k === 'sound' ? 'Sound alerts' : k === 'desktop' ? 'Desktop / browser' : k === 'email' ? 'Email' : 'WhatsApp'}</label>
                ))}
              </div>
              <div className="min-row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => playChime('high')}><Ic k="bell" />Test sound</button>
                <button className="btn sm" onClick={() => void askDesktop()} data-testid="nset-desktop-perm">
                  <Ic k="check" />{perm === 'granted' ? 'Desktop alerts allowed on this browser' : 'Allow desktop alerts on this browser'}
                </button>
                <span className="fhint">Each user allows desktop alerts once on their own browser. Email and WhatsApp go to the address / mobile on the user’s profile.</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3><Ic k="list" />Events</h3></div>
        <div className="scroll-x">
          <table className="tbl nset-tbl" data-testid="nset-rules">
            <thead><tr>
              <th>Event</th><th>On</th>{CHANNELS.map(([k, l]) => <th key={k}>{l}</th>)}
              <th>Priority</th><th>When</th><th>Who</th><th>Hierarchy</th><th />
            </tr></thead>
            <tbody>
              {MODULES.map((m) => {
                const rs = rules.filter((r) => r.module === m);
                if (!rs.length) return null;
                const off = g?.modules[m] === false;
                return [
                  <tr key={`h-${m}`}><td className="nset-mod" colSpan={CHANNELS.length + 7}>{m}{off ? ' — switched off' : ''}</td></tr>,
                  ...rs.map((r) => (
                    <tr key={r.event_key} data-testid={`nset-row-${r.event_key}`} style={{ opacity: off || !r.enabled ? 0.55 : 1 }}>
                      <td><b>{r.name}</b><div className="sub">{r.message}</div></td>
                      <td><input type="checkbox" aria-label={`${r.name} on`} disabled={!editable} checked={r.enabled}
                        onChange={(e) => void saveRule(r.event_key, { enabled: e.target.checked })} /></td>
                      {CHANNELS.map(([k, l]) => (
                        <td key={k}><input type="checkbox" aria-label={`${r.name} ${l}`} disabled={!editable}
                          checked={!!(r as any)[k]} data-testid={`nset-${r.event_key}-${k}`}
                          onChange={(e) => void saveRule(r.event_key, { [k]: e.target.checked } as any)} /></td>
                      ))}
                      <td>
                        <select className="ainp" style={{ width: 104 }} disabled={!editable} value={r.priority} aria-label={`${r.name} priority`}
                          onChange={(e) => void saveRule(r.event_key, { priority: e.target.value as StaffRule['priority'] })}>
                          {PRIOS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                        </select>
                      </td>
                      <td>{timingText(r)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{rolesText(r)}</td>
                      <td>{r.escalate ? `After ${fmtMinutes(r.escalate_after_minutes)} → ${r.escalate_levels} level${r.escalate_levels === 1 ? '' : 's'} up` : '—'}</td>
                      <td>{editable && <button className="btn sm" onClick={() => setEdit(r)} data-testid={`nset-edit-${r.event_key}`}><Ic k="pencil" />Edit</button>}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <RuleModal rule={edit} roles={roles.data ?? []} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); setTick((t) => t + 1); toast('Notification rule saved'); }} />}
    </>
  );
}

function RuleModal({ rule, roles, onClose, onSaved }: { rule: StaffRule; roles: any[]; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<StaffRule>({ ...rule, role_ids: [...rule.role_ids] });
  const [unit, setUnit] = useState<number>(rule.delay_minutes && rule.delay_minutes % 1440 === 0 ? 1440 : rule.delay_minutes && rule.delay_minutes % 60 === 0 ? 60 : 1);
  const [eUnit, setEUnit] = useState<number>(rule.escalate_after_minutes % 1440 === 0 ? 1440 : rule.escalate_after_minutes % 60 === 0 ? 60 : 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setErr(''); }, [r]);
  const set = (p: Partial<StaffRule>) => setR((x) => ({ ...x, ...p }));
  const toggleRole = (id: number) => set({ role_ids: r.role_ids.includes(id) ? r.role_ids.filter((x) => x !== id) : [...r.role_ids, id] });
  const timingLabel = r.timing_kind === 'before' ? 'How long BEFORE the follow-up' : r.timing_kind === 'after' ? 'How long AFTER it is due'
    : r.timing_kind === 'at' ? '' : 'Send after (0 = immediately)';

  const save = async () => {
    if (!r.notify_owner && !r.role_ids.length) { setErr('Choose who receives it — the assigned user and/or at least one role.'); return; }
    setBusy(true);
    try {
      await api.patch(`/notification-settings/${r.event_key}`, {
        enabled: r.enabled, in_app: r.in_app, toast: r.toast, sound: r.sound, desktop: r.desktop, email: r.email, whatsapp: r.whatsapp,
        priority: r.priority, delay_minutes: r.delay_minutes, notify_owner: r.notify_owner, role_ids: r.role_ids,
        escalate: r.escalate, escalate_after_minutes: r.escalate_after_minutes, escalate_levels: r.escalate_levels,
      });
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ maxWidth: 680 }} data-testid="nset-modal">
        <div className="ah">
          <h3><Ic k="bell" />{r.module} · {r.name} — {r.message}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label>Channels</label>
              <div className="nset-switches">
                <label><input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
                {CHANNELS.map(([k, l]) => (
                  <label key={k}><input type="checkbox" checked={!!(r as any)[k]} onChange={(e) => set({ [k]: e.target.checked } as any)} />{l}</label>
                ))}
              </div>
            </div>
            <div className="fld">
              <label htmlFor="ns-prio">Priority</label>
              <select id="ns-prio" className="ainp" value={r.priority} onChange={(e) => set({ priority: e.target.value as StaffRule['priority'] })}>
                {PRIOS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
              </select>
              <div className="fhint">High and Critical pop-ups stay longer (Critical until dismissed) and are coloured.</div>
            </div>
            <div className="fld">
              <label htmlFor="ns-delay">When it goes</label>
              {r.timing_kind === 'at'
                ? <input id="ns-delay" className="ainp" value="At the scheduled time" readOnly disabled />
                : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input id="ns-delay" className="ainp" type="number" min={0} aria-label={timingLabel} data-testid="nset-delay"
                      value={Math.round(r.delay_minutes / unit)} onChange={(e) => set({ delay_minutes: Math.max(0, Math.round(Number(e.target.value || 0) * unit)) })} />
                    <select className="ainp" style={{ width: 96 }} value={unit} aria-label="unit" onChange={(e) => setUnit(Number(e.target.value))}>
                      <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
                    </select>
                  </div>
                )}
              <div className="fhint">{timingLabel ? `${timingLabel}. ` : ''}Now: <b>{timingText(r)}</b></div>
            </div>
            <div className="fld span2">
              <label>Who receives it</label>
              <div className="nset-switches">
                <label><input type="checkbox" checked={r.notify_owner} onChange={(e) => set({ notify_owner: e.target.checked })} data-testid="nset-owner" />
                  Assigned user ({OWNER_LABEL[r.module] ?? 'owner'})</label>
              </div>
              <div className="nset-switches" data-testid="nset-roles">
                {roles.map((ro: any) => (
                  <label key={ro.id}><input type="checkbox" checked={r.role_ids.includes(Number(ro.id))} onChange={() => toggleRole(Number(ro.id))} />{ro.name}</label>
                ))}
              </div>
              <div className="fhint">Everyone holding a ticked role in that record’s branch also gets it. The person who did the action is never notified about their own action.</div>
            </div>
            <div className="fld span2">
              <label>Hierarchy escalation</label>
              <div className="nset-switches">
                <label><input type="checkbox" checked={r.escalate} onChange={(e) => set({ escalate: e.target.checked })} data-testid="nset-escalate" />
                  If it is not actioned, send it up the hierarchy</label>
              </div>
              {r.escalate && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                  <span>after</span>
                  <input className="ainp" type="number" min={1} style={{ width: 80 }} aria-label="escalate after" data-testid="nset-esc-after"
                    value={Math.round(r.escalate_after_minutes / eUnit)} onChange={(e) => set({ escalate_after_minutes: Math.max(1, Math.round(Number(e.target.value || 1) * eUnit)) })} />
                  <select className="ainp" style={{ width: 96 }} value={eUnit} aria-label="escalation unit" onChange={(e) => setEUnit(Number(e.target.value))}>
                    <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
                  </select>
                  <span>, up to</span>
                  <select className="ainp" style={{ width: 120 }} value={r.escalate_levels} aria-label="levels" data-testid="nset-esc-levels"
                    onChange={(e) => set({ escalate_levels: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} level{n === 1 ? '' : 's'}</option>)}
                  </select>
                </div>
              )}
              <div className="fhint">
                Level 1 = the person’s <b>Reports To</b> manager (Administration › Users); level 2 = that manager’s manager, and so on — each
                level waits the same time again. Without a Reports-To it goes to the team leader / vertical or branch manager / organization admin.
                Follow-up and fee alerts stop escalating as soon as the follow-up is done or the instalment is paid; other alerts once the notification is opened.
              </div>
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()} data-testid="nset-save"><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
