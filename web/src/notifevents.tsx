/**
 * NOTIFICATION EVENTS (Engagement & Workflow) — the curated, user-friendly layer over the
 * templates / channels / notifier stack. A fixed CATALOG of 37 standard business events,
 * each with a per-channel (SMS / Email / WhatsApp) ENABLE toggle and a TEMPLATE picker per
 * channel. Admin flips a channel + maps the template it should send; firing happens server
 * side over the existing send path (opt-out / business-hours / degrade-cleanly all reused).
 *
 * FULL LIST TREATMENT: multi-select filters (Category / Channel / Enabled) + Export +
 * Column chooser (TableCard fill+listKey) + Refresh. Bulk-delete is N/A — this is a FIXED
 * catalog of 37 events, not a user-created list — so the list-audit declares the NO_BULK
 * profile for it (documented in listaudit.test.tsx).
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch } from './refdata';
import { EnumMulti } from './dyn';
import { ListActions, downloadObjectsCsv } from './listtools';

interface Ev {
  event_key: string; name: string; trigger_desc: string; category: string;
  recipient: string; trigger_status: string;
  sms_enabled: boolean; email_enabled: boolean; whatsapp_enabled: boolean;
  sms_template_id: number | null; email_template_id: number | null; whatsapp_template_id: number | null;
  sms_template_name: string | null; email_template_name: string | null; whatsapp_template_name: string | null;
}

const CATS = ['Leads', 'Academics', 'Fees', 'Certificates', 'Calls'];
const CHANNELS: Array<{ k: 'sms' | 'email' | 'whatsapp'; label: string; icon: string }> = [
  { k: 'sms', label: 'SMS', icon: 'phone' },
  { k: 'email', label: 'Email', icon: 'mail' },
  { k: 'whatsapp', label: 'WhatsApp', icon: 'wa' },
];

export function NotificationEvents() {
  const { can } = useAuth();
  const editable = can('notification_event.update');
  const [tick, setTick] = useState(0);
  const [fCats, setFCats] = useState<string[]>([]);
  const [fChans, setFChans] = useState<string[]>([]);
  const [fEnabled, setFEnabled] = useState<string[]>([]);

  const events = useFetch<Ev[]>('/notification-events', [tick]);
  const templates = useFetch<any[]>('/templates', []);
  const all = events.data ?? [];
  const tpls = templates.data ?? [];
  const after = () => setTick((t) => t + 1);

  const rows = useMemo(() => all.filter((r) =>
    (!fCats.length || fCats.includes(r.category)) &&
    (!fChans.length || fChans.some((c) => (r as any)[`${c}_enabled`])) &&
    (!fEnabled.length || (fEnabled.includes('on')
      ? (r.sms_enabled || r.email_enabled || r.whatsapp_enabled)
      : !(r.sms_enabled || r.email_enabled || r.whatsapp_enabled)))
  ), [all, fCats, fChans, fEnabled]);

  const byChannel = (c: string) => tpls.filter((t) => t.channel === c);

  async function save(key: string, patch: Record<string, unknown>) {
    try { await api.patch(`/notification-events/${key}`, patch); after(); }
    catch (e) { toast((e as Error).message || 'Could not save', true); }
  }

  const chanCell = (r: Ev, c: 'sms' | 'email' | 'whatsapp'): Cell => {
    const on = !!(r as any)[`${c}_enabled`];
    const tid = (r as any)[`${c}_template_id`] as number | null;
    return {
      node: (
        <div className="ne-chan" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label className="switch" title={on ? 'Enabled' : 'Disabled'}>
            <input type="checkbox" checked={on} disabled={!editable}
              onChange={() => save(r.event_key, { [`${c}_enabled`]: !on })} />
            <span className="slider" />
          </label>
          <select className="ne-tpl" value={tid ?? ''} disabled={!editable}
            data-testid={`ne-${r.event_key}-${c}-tpl`}
            onChange={(e) => save(r.event_key, { [`${c}_template_id`]: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— template —</option>
            {byChannel(c).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      ),
    };
  };

  return (
    <>
      <div className="page-head">
        <h2><Ic k="bell" /> Notification Events</h2>
        <p className="sub">A catalog of standard events. For each, turn SMS / Email / WhatsApp on or off and
          choose the template it should send. Messages fire over the existing channels — opt-out and business
          hours are respected, and a channel with no credentials yet degrades to a logged, not-sent attempt.</p>
      </div>

      <div className="filters" style={{ marginBottom: 12 }}>
        <EnumMulti label="Category" icon="grid" value={fCats}
          options={CATS.map((c) => ({ id: c, name: c }))} onChange={setFCats} testid="ne-f-category" />
        <EnumMulti label="Channel" icon="send" value={fChans}
          options={CHANNELS.map((c) => ({ id: c.k, name: c.label }))} onChange={setFChans} testid="ne-f-channel" />
        <EnumMulti label="Enabled" icon="shield" value={fEnabled}
          options={[{ id: 'on', name: 'Any channel on' }, { id: 'off', name: 'All off' }]} onChange={setFEnabled} testid="ne-f-enabled" />
      </div>

      <TableCard fill title="Notification Events" icon="bell" listKey="notification-events"
        more={<ListActions onRefresh={after} onExport={() => downloadObjectsCsv('notification-events.csv', rows.map((r) => ({
          event: r.name, category: r.category, trigger: r.trigger_desc, recipient: r.recipient, wiring: r.trigger_status,
          sms: r.sms_enabled ? 'on' : 'off', sms_template: r.sms_template_name || '',
          email: r.email_enabled ? 'on' : 'off', email_template: r.email_template_name || '',
          whatsapp: r.whatsapp_enabled ? 'on' : 'off', whatsapp_template: r.whatsapp_template_name || '',
        })))} />}
        cols={['Event', 'Category', 'Trigger', 'Recipient', 'SMS', 'Email', 'WhatsApp', 'Wiring']}
        empty={events.loading ? 'Loading…' : 'No events match these filters.'}
        rows={rows.map((r): Cell[] => [
          { node: <b className="nm">{r.name}</b> },
          { b: [r.category, 'b-cyan'] },
          { node: <span className="sub">{r.trigger_desc}</span> },
          r.recipient,
          chanCell(r, 'sms'),
          chanCell(r, 'email'),
          chanCell(r, 'whatsapp'),
          r.trigger_status === 'wired'
            ? { b: ['Live', 'b-green'] }
            : { b: ['Catalogued', 'b-amber'] },
        ])}
      />
    </>
  );
}

export default NotificationEvents;
