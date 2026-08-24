/**
 * THE NOTIFICATION CENTRE (the bell).
 *
 * This is the SEAM Sprint 4's WhatsApp / SMS / Email channels plug into: reminders,
 * overdue escalations, SLA breaches and assignments all land here first (the server's
 * channel-agnostic notifier writes an in-app row for every one of them), and the extra
 * channels fan out from the same message.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';

export interface Notif {
  id: number;
  type: 'reminder' | 'escalation' | 'assignment' | 'sla_breach' | 'handout' | 'system';
  severity: 'info' | 'warn' | 'error';
  title: string;
  body?: string | null;
  link_type?: string | null;
  link_id?: number | null;
  read_at?: string | null;
  created_at: string;
}

const ICON: Record<string, string> = {
  reminder: 'clock', escalation: 'bolt', assignment: 'users',
  sla_breach: 'clock', handout: 'calls', system: 'cfg',
};
const TONE: Record<string, string> = { info: 'b-indigo', warn: 'b-amber', error: 'b-rose' };

export const ago = (iso: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** The bell in the topbar: unread badge + the dropdown panel. */
export function NotificationBell({ onOpenLead }: { onOpenLead?: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // dev/132 ITEM C — ids we've already surfaced as a popup toast. `null` until the first poll,
  // which SEEDS the set silently (so logging in never floods the screen with old unread rows).
  const seenRef = useRef<Set<number> | null>(null);

  const poll = useCallback(async () => {
    try {
      // one lightweight poll: the unread rows (for popups) + the authoritative badge count.
      const list = await api.get<Notif[]>('/notifications?unread=1&limit=20');
      try { setUnread((await api.get<{ unread: number }>('/notifications/count')).unread); }
      catch { setUnread(list.length); }
      // ITEM C — real-time popup/toast for lead created/assigned, follow-up missed, SLA breach,
      // reminder due, task assigned/due, red flag. Only NEW (unseen) events toast — never a re-toast.
      if (seenRef.current === null) {
        seenRef.current = new Set(list.map((n) => n.id));   // first run: seed, don't toast
      } else {
        // oldest-first so a burst pops in chronological order
        for (const n of [...list].reverse()) {
          if (!seenRef.current.has(n.id)) {
            seenRef.current.add(n.id);
            toast(`${n.title}${n.body ? ` — ${n.body}` : ''}`, n.severity === 'error');
          }
        }
      }
    } catch { /* the bell must never break the shell */ }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try { setRows(await api.get<Notif[]>('/notifications?limit=20')); }
    catch { setRows([]); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => { void poll(); }, 45_000);   // ITEM C — poll unread every 45s for popups
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  // close on an outside click (the bell is a dropdown, not a modal — modals never do this)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const openOne = async (n: Notif) => {
    if (!n.read_at) {
      try { await api.patch(`/notifications/${n.id}/read`); } catch { /* non-fatal */ }
      setRows((r) => r.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.link_type === 'lead' && n.link_id && onOpenLead) { onOpenLead(Number(n.link_id)); setOpen(false); }
  };

  const readAll = async () => {
    try {
      const r = await api.post<{ marked: number }>('/notifications/read-all');
      setRows((rs) => rs.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
      setUnread(0);
      toast(r.marked ? `${r.marked} notification${r.marked === 1 ? '' : 's'} marked read` : 'Nothing unread');
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button className="icon-btn" title="Notifications" aria-label="Notifications"
        data-unread={unread} onClick={() => setOpen((o) => !o)}>
        <Ic k="bell" />
        {unread > 0 && (
          <span className="notif-dot" aria-label={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <h4>Notifications</h4>
            <a onClick={readAll} style={{ cursor: 'pointer', color: 'var(--primary)', fontSize: 12 }}>Mark all read</a>
          </div>
          <div className="notif-list">
            {busy && rows.length === 0 ? <div className="lrow empty">Loading…</div>
              : rows.length === 0 ? (
                <div className="lrow empty">
                  You&rsquo;re all caught up. Reminders, escalations and SLA breaches land here.
                </div>
              ) : rows.map((n) => (
                <div className={`notif-row${n.read_at ? '' : ' unread'}`} key={n.id}
                  onClick={() => void openOne(n)} style={{ cursor: n.link_id ? 'pointer' : 'default' }}>
                  <div className={`ic-t ${TONE[n.severity] || 'b-indigo'}`}><Ic k={ICON[n.type] || 'bolt'} /></div>
                  <div className="gr">
                    <div className="t1">{n.title}</div>
                    <div className="t2">{n.body || ''}</div>
                  </div>
                  <span className="rt">{ago(n.created_at)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
