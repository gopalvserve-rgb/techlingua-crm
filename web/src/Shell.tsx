/** App shell — brand, topbar (scope chips, shortcuts, user menu), sidebar nav tree,
 *  and the per-screen page renderer. Ported 1:1 from the prototype shell. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { Ic } from './icons';
import { scopedApp, isMobileApp, isRouteAllowed, findScreen } from './specs';
import { Blocks } from './renderer';
import { DYN, ScreenCtx } from './dyn';
import { AddModal, CampaignModal, SPEC_FORMS, headerActions, resolveAdd, addLike } from './forms';
import { LeadSheet } from './leadsheet';
import { RoleModal } from './rolemodal';
import { toast, useRef_, Toaster } from './refdata';
import { NotificationBell } from './notifications';
import { ScopeSelector, useScope } from './scope';
import { isoDay } from './daterange';


function Logo() {
  return (
    <div className="logo">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M4 7l8-4 8 4-8 4-8-4z" fill="#fff" opacity=".95" />
        <path d="M4 7v6l8 4 8-4V7" stroke="#fff" strokeWidth="1.6" opacity=".7" fill="none" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function Shell() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const params = useParams<{ mod: string; sub: string }>();
  const mod = params.mod || 'dash';
  const sub = params.sub || 'overview';

  const [theme, setTheme] = useState<string>(() => localStorage.getItem('tl_theme') || 'dark');
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState('');
  const [openMods, setOpenMods] = useState<Record<string, boolean>>({ [mod]: true });
  const { params: scopeParams, key: scopeKey } = useScope();

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('tl_theme', theme); }, [theme]);
  useEffect(() => { setOpenMods((x) => ({ ...x, [mod]: true })); }, [mod]);

  // Mobile-app scope (dev/121): inside the Android/Capacitor app (or ?app=mobile) the
  // shell renders ONLY the operational Leads CRM. A hidden config/admin deep-link is
  // not reachable — bounce it to the leads dashboard so config isn't opened by URL.
  const mobileApp = isMobileApp();
  useEffect(() => {
    if (!isRouteAllowed(mod, sub)) nav('/m/dash/overview', { replace: true });
  }, [mod, sub, nav]);

  // Aug 2026 — an optional 3rd arg carries list filter params so a KPI card opens its list
  // pre-filtered (e.g. go('leads','all',{ owner_id, temperature:'hot' })). Undefined/empty
  // values are dropped; with no params the URL is exactly as before.
  const go = (m: string, s: string, filter?: Record<string, string | number | undefined>) => {
    setDrawer(false);
    const qs = new URLSearchParams();
    // GLOBAL SCOPE as the BASELINE: fold the top-bar Branch/Vertical/Pipeline/Campaign into every
    // navigation so the target screen seeds pre-scoped. An explicit filter param from the caller
    // (e.g. a KPI card link) still WINS, so a card can narrow further inside the global scope.
    for (const [key, val] of Object.entries(scopeParams)) qs.set(key, val);
    if (filter) for (const [key, val] of Object.entries(filter)) {
      if (val !== undefined && val !== '') qs.set(key, String(val)); else qs.delete(key);
    }
    const suffix = qs.toString();
    nav(`/m/${m}/${s}${suffix ? `?${suffix}` : ''}`);
  };

  const q = filter.toLowerCase().trim();
  const visible = useMemo(() => scopedApp().map((m) => {
    const subs = m.subs.filter((s) => !q || s.label.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    return { m, subs, show: subs.length > 0 };
  }), [q]);

  const roleName = (me?.assignments?.[0] as any)?.role_name ?? '';

  // Table-only scroll (client, Aug 2026): on the big list screens the OUTER page must not scroll —
  // the app header, the filter/toolbar and the table's column header stay fixed, and ONLY the
  // table body scrolls inside a viewport-bounded container. We opt these screens into the
  // `.main--list` layout (their results card carries `.tbl-fill`). Non-list screens (dashboards,
  // forms, reports) keep the normal page scroll.
  // NOTE (client, Aug 2026): Leads (`leadsAll`) is intentionally NOT in this set. It must scroll
  // EXACTLY like Student Management (`studentsList`), which is also absent here: a sticky column
  // header with ONLY the table body scrolling (its `.tbl-fill` card falls back to `.tbl-scroll`
  // `max-height:62vh; overflow:auto`) and horizontal overflow for wide tables. The full-height
  // `.main--list` flex mode used for the masters made the tall Leads toolbar (band chips + the
  // `.toolbar-surface` filter rows + view switcher + bulk bar) crowd the body and behave unlike
  // Students, so Leads mirrors the Students container instead.
  // NOTE 'roles' is deliberately NOT here (client UAT, Aug 2026): the Roles screen renders a
  // tall permission MATRIX + a "Permission depth" block ABOVE/BELOW the roles TableCard, so the
  // `.main--list` full-height flex (overflow:hidden) squeezed the table body to zero and the ⋯
  // row menu to a clipped sliver — custom roles were invisible/unmanageable. Dropping it (exactly
  // like `leadsAll` earlier) lets `main` scroll normally and the roles `.tbl-fill` card falls
  // back to `.tbl-scroll{max-height:62vh; overflow:auto}` with its sticky header — matrix, rows
  // and the full ⋯ Edit/Delete menu all visible. Mirrors the known-good Students container.
  // dev/126 (client, Aug 2026): the Leads-area MASTER screens (Branch, Vertical, Pipeline,
  // Campaign, Lead Source) render extra content ABOVE the results table — Branch shows a tall
  // "Hierarchy" tree, and all of them carry a filter/bulk band. In `.main--list` full-height flex
  // (overflow:hidden) that tall header squeezed the table body to a ~26px sliver on Branch (and
  // the client reported Pipeline not scrolling either), so the list was cut off and unreachable.
  // Exactly the Roles/Leads class of bug — the fix is the SAME: drop these from LIST_SCROLL so
  // `main` scrolls normally and each `.tbl-fill` card falls back to `.tbl-scroll{max-height:62vh;
  // overflow:auto}` with its sticky header. Mirrors the known-good Students/Roles container; every
  // Leads master now scrolls consistently and reaches the last row.
  const LIST_SCROLL = new Set(['users', 'audit', 'errorLogs', 'walkIns', 'courses', 'followups']);
  const curDyn = (findScreen(mod, sub)?.sub.spec as any)?.dyn as string | undefined;
  const listScroll = !!curDyn && LIST_SCROLL.has(curDyn);

  return (
    <div className="app">
      <div className="brand">
        <Logo />
        <div className="brand-name">Tech Lingua<span>Education CRM · ERP</span></div>
      </div>
      <div className="topbar">
        <button className="icon-btn hamb" onClick={() => setDrawer((d) => !d)} aria-label="Open menu"><Ic k="menu" /></button>
        <div className="mbrand"><div className="logo" style={{ fontSize: 11, color: '#fff' }}>TL</div><span>Tech Lingua</span></div>
        <ScopeSelector />
        <div className="tb-actions">
          {/* Quick-access shortcuts (client #4). Each is a real, keyboard-accessible destination
              via go(mod,sub,params) reusing the card-link / follow-up filter params:
              New Leads = leads created today (IST); Due Today / Upcoming = the Today's Follow-ups
              screen pre-set to today / next-7-days via the #3 followup filter; Features = the
              in-app What's New / Features panel. */}
          {/* Icon buttons (client, Aug 2026): the four shortcuts are compact ICON buttons with a
              hover tooltip + accessible name, not full-text buttons — saves top-bar space and
              stays clean at ~1280px. Same navigation/filters as before; keyboard-focusable. */}
          <div className="tb-shortcuts" role="group" aria-label="Quick shortcuts">
            <button className="icon-btn tb-shortcut" type="button" title="New Leads — created today"
              aria-label="New Leads — leads created today"
              onClick={() => go('leads', 'all', { created_from: isoDay(), created_to: isoDay() })}>
              <Ic k="leads" />
            </button>
            <button className="icon-btn tb-shortcut" type="button" title="Due Today — follow-ups due today"
              aria-label="Due Today — follow-ups due today"
              onClick={() => go('dash', 'todayfollowups', { followup: 'today' })}>
              <Ic k="clock" />
            </button>
            <button className="icon-btn tb-shortcut" type="button" title="Upcoming — follow-ups in the next 7 days"
              aria-label="Upcoming — follow-ups in the next 7 days"
              onClick={() => go('dash', 'todayfollowups', { followup: 'next7' })}>
              <Ic k="cal" />
            </button>
{!mobileApp && (
            <button className="icon-btn tb-shortcut" type="button" title="What's New / Features"
              aria-label="What's New / Features"
              onClick={() => go('help', 'features')}>
              <Ic k="bolt" />
            </button>)}
          </div>
          {!mobileApp && <button className="icon-btn" title="Site Map" onClick={() => go('map', 'all')}><Ic k="grid" /></button>}
          {/* Sprint 3 — the real notification centre. Reminders, overdue escalations,
              SLA breaches and assignments all land here; Sprint 4's WhatsApp/SMS/Email
              channels fan out from the same server-side message. */}
          <NotificationBell onOpenLead={(id) => nav(`/m/leads/all?lead=${id}`)} />
          {/* User (Super Admin) menu — the account dropdown. The light/dark theme
              toggle now lives HERE (client, Aug 2026), not as a standalone top-bar
              control; switching + localStorage persistence is unchanged. */}
          <UserMenu me={me} roleName={roleName} theme={theme} setTheme={setTheme} logout={logout} />
        </div>
      </div>
      <nav className={`sidebar ${drawer ? 'open' : ''}`}>
        <div className="sb-search">
          <Ic k="search" />
          <input placeholder="Filter menu…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div>
          {visible.map(({ m, subs, show }) => show && (
            <div className="mod" key={m.id}>
              <button className={`mod-btn ${openMods[m.id] || q ? 'open' : ''}`}
                onClick={() => setOpenMods((x) => ({ ...x, [m.id]: !x[m.id] }))}>
                <Ic k={m.icon} className="mi" /> <span className="ml">{m.label}</span>
                {m.phase ? <span className="ph">{m.phase}</span> : null}
                <Ic k="chev" className="chev" />
              </button>
              <div className={`submenu ${openMods[m.id] || q ? 'open' : ''}`}>
                {subs.map((s) => (
                  <a className={`subitem ${mod === m.id && sub === s.id ? 'active' : ''}`} key={s.id}
                    onClick={() => go(m.id, s.id)}>
                    <span className="pt" />{s.label}
                    {s.spec.tag === 'p2' ? <span className="ph">P2</span> : null}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
      <div className={`scrim ${drawer ? 'open' : ''}`} onClick={() => setDrawer(false)} />
      <main className={`main${listScroll ? ' main--list' : ''}`} id="main">
        <Screen key={`${mod}.${sub}.${scopeKey}`} mod={mod} sub={sub} go={go} />
      </main>
      <Toaster />
    </div>
  );
}

function Screen({ mod, sub, go }: { mod: string; sub: string; go: (m: string, s: string, filter?: Record<string, string | number | undefined>) => void }) {
  const screen = findScreen(mod, sub) ?? findScreen('dash', 'overview')!;
  const spec = screen.sub.spec;
  const ref = useRef_();
  // dev/84 item 1 — carry the launch mode (view=read-only default, edit=editable).
  const [leadOpen, setLeadOpen] = useState<{ id: number; mode: 'view' | 'edit' } | null>(null);
  const [addKey, setAddKey] = useState<string | null>(null);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const key = `${screen.mod.id}.${screen.sub.id}`;
  const openAdd = (formKey: string) => {
    if (formKey === 'leads.campaigns') { setCampaignOpen(true); return; }
    if (formKey === 'admin.roles') { setRoleOpen(true); return; }
    if (SPEC_FORMS[formKey]) setAddKey(formKey);
    // Every caller passes a wired formKey (dyn components + resolveAdd); no placeholder dead-end.
  };

  // Header buttons come from the single source of truth in forms.tsx: explicit
  // spec actions + MULTI_ADD + the ADD_INJECT allowlist. Read-only dashboards,
  // analytics and summary screens no longer get a phantom "Add" that dead-ends.
  const acts = headerActions(screen.mod.id, screen.sub.id);

  const onAction = (label: string) => {
    if (addLike(label)) {
      const t = resolveAdd(key, label);
      if (t.kind === 'campaign') return setCampaignOpen(true);
      if (t.kind === 'roles') return setRoleOpen(true);
      if (t.kind === 'form') return openAdd(t.formKey);
      return;
    }
    if (/filter/i.test(label)) return toast('Filter with the chips shown above the table.');
    if (/export/i.test(label)) return toast('Export any report from Analytics & Reports (Excel · PDF · CSV).');
  };

  const Dyn = spec.dyn ? DYN[spec.dyn] : null;
  // DEF-05 — the live query string. URL-driven filter screens (Today's Follow-ups, Leads) re-seed
  // from it when a top-bar shortcut / card link re-navigates here while the screen is already open.
  const loc = useLocation();

  return (
    <ScreenCtx.Provider value={{
      go, openLead: (id, mode) => setLeadOpen({ id, mode: mode ?? 'view' }), openAdd, refreshTick: tick, bump: () => setTick((t) => t + 1),
      search: loc.search,
    }}>
      <div className="view">
        <div className="crumb">
          <Ic k={screen.mod.icon} /><span>{screen.mod.label}</span><Ic k="chev" /><b>{screen.sub.label}</b>
        </div>
        <div className="page-head">
          <div>
            <div className="page-title">
              {screen.sub.label}
              {spec.tag === 'p2' ? <span className="tag p2">Phase 2</span> : null}
            </div>
            <div className="page-sub">{spec.sub || ''}</div>
          </div>
          <div className="head-actions">
            {acts.map(([icon, label, style], i) => (
              <button className={`btn ${style || ''}`} key={i} onClick={() => onAction(label)}>
                <Ic k={icon} />{label}
              </button>
            ))}
          </div>
        </div>
        {spec.sprintNote && (
          <div className="notice"><Ic k="bolt" /><div>{spec.sprintNote}</div></div>
        )}
        <div className="stack">
          {Dyn ? <Dyn /> : spec.blocks ? <Blocks blocks={spec.blocks} /> : null}
        </div>
      </div>
      {leadOpen && <LeadSheet leadId={leadOpen.id} mode={leadOpen.mode} onClose={() => setLeadOpen(null)} onChanged={() => setTick((t) => t + 1)} />}
      {addKey && <AddModal formKey={addKey} onClose={() => setAddKey(null)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
      {campaignOpen && <CampaignModal onClose={() => setCampaignOpen(false)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
      {roleOpen && <RoleModal onClose={() => setRoleOpen(false)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
    </ScreenCtx.Provider>
  );
}


/** The Super Admin (user) account dropdown in the top bar. Holds the account
 *  header, the light/dark THEME toggle (relocated here from the top bar — the
 *  toggle behaviour and `tl_theme` persistence live in the Shell and are passed
 *  in unchanged) and Sign out. Closes on an outside click like the bell. */
function UserMenu({ me, roleName, theme, setTheme, logout }: {
  me: ReturnType<typeof useAuth>['me']; roleName: string;
  theme: string; setTheme: (t: string) => void; logout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const initials = (me?.user.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button className="user-pill" title="Account" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <div className="av">{initials}</div>
        <div><div className="nm">{me?.user.name}</div><div className="rl">{roleName || me?.user.email}</div></div>
        <Ic k="chev" />
      </button>
      {open && (
        <div className="user-menu" role="menu" aria-label="Account menu">
          <div className="um-head">
            <div className="av">{initials}</div>
            <div><div className="nm">{me?.user.name}</div><div className="rl">{roleName || me?.user.email}</div></div>
          </div>
          <div className="um-sec">
            <div className="um-label">Theme</div>
            <div className="theme-toggle" role="group" aria-label="Theme">
              <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')} title="Light">
                <Ic k="sun" />Light
              </button>
              <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')} title="Dark">
                <Ic k="moon" />Dark
              </button>
            </div>
          </div>
          {/* Android app download (docs/dev/120) — public APK streamed from R2 via the API's
             /downloads route. Hidden when already running inside the Capacitor WebView app. */}
          {typeof window !== 'undefined' && !(window as unknown as { Capacitor?: unknown }).Capacitor && (
            <a className="um-item" role="menuitem" href="/downloads/techlingua-crm.apk" download
              style={{ textDecoration: 'none' }} onClick={() => setOpen(false)}>
              <Ic k="download" /> Download Android App
            </a>
          )}
          <button className="um-item danger" role="menuitem"
            onClick={() => { if (confirm('Sign out?')) logout(); }}>
            <Ic k="logout" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
