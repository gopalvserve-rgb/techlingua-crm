/** App shell — brand, topbar (scope chips, search, theme, user), sidebar nav tree,
 *  and the per-screen page renderer. Ported 1:1 from the prototype shell. */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { Ic } from './icons';
import { APP, findScreen } from './specs';
import { Blocks } from './renderer';
import { DYN, ScreenCtx } from './dyn';
import { AddModal, CampaignModal, SPEC_FORMS, headerActions, resolveAdd, addLike } from './forms';
import { LeadSheet } from './leadsheet';
import { RoleModal } from './rolemodal';
import { toast, useRef_, Toaster } from './refdata';
import { NotificationBell } from './notifications';


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
  const ref = useRef_();
  const nav = useNavigate();
  const params = useParams<{ mod: string; sub: string }>();
  const mod = params.mod || 'dash';
  const sub = params.sub || 'overview';

  const [theme, setTheme] = useState<string>(() => localStorage.getItem('tl_theme') || 'dark');
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState('');
  const [openMods, setOpenMods] = useState<Record<string, boolean>>({ [mod]: true });
  const [globalQ, setGlobalQ] = useState('');

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('tl_theme', theme); }, [theme]);
  useEffect(() => { setOpenMods((x) => ({ ...x, [mod]: true })); }, [mod]);

  const go = (m: string, s: string) => { setDrawer(false); nav(`/m/${m}/${s}`); };

  const q = filter.toLowerCase().trim();
  const visible = useMemo(() => APP.map((m) => {
    const subs = m.subs.filter((s) => !q || s.label.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    return { m, subs, show: subs.length > 0 };
  }), [q]);

  const roleName = (me?.assignments?.[0] as any)?.role_name ?? '';
  const firstBranch = ref.branches[0]?.name;
  const firstVertical = ref.verticals[0]?.name;
  const firstPipeline = ref.pipelines[0]?.name;

  return (
    <div className="app">
      <div className="brand">
        <Logo />
        <div className="brand-name">Tech Lingua<span>Education CRM · ERP</span></div>
      </div>
      <div className="topbar">
        <button className="icon-btn hamb" onClick={() => setDrawer((d) => !d)} aria-label="Open menu"><Ic k="menu" /></button>
        <div className="mbrand"><div className="logo" style={{ fontSize: 11, color: '#fff' }}>TL</div><span>Tech Lingua</span></div>
        <div className="scope">
          <button className="scope-chip org"><span className="lv">Org</span><span className="vl">Tech Lingua LLP</span></button>
          <span className="scope-sep"><Ic k="chev" /></span>
          <button className="scope-chip"><span className="lv">Branch</span><span className="vl">{firstBranch ? (ref.branches.length > 1 ? `All (${ref.branches.length})` : firstBranch) : 'All'} <Ic k="chevd" /></span></button>
          <span className="scope-sep"><Ic k="chev" /></span>
          <button className="scope-chip"><span className="lv">Vertical</span><span className="vl">{firstVertical ? (ref.verticals.length > 1 ? `All (${ref.verticals.length})` : firstVertical) : 'All'} <Ic k="chevd" /></span></button>
          <span className="scope-sep"><Ic k="chev" /></span>
          <button className="scope-chip"><span className="lv">Pipeline</span><span className="vl">{firstPipeline ? (ref.pipelines.length > 1 ? `All (${ref.pipelines.length})` : firstPipeline) : 'All'} <Ic k="chevd" /></span></button>
        </div>
        <div className="tb-actions">
          <div className="searchbox">
            <Ic k="search" />
            <input placeholder="Search anything…" value={globalQ} onChange={(e) => setGlobalQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { go('leads', 'all'); } }} />
            <kbd>⌘K</kbd>
          </div>
          <button className="icon-btn" title="Site Map" onClick={() => go('map', 'all')}><Ic k="grid" /></button>
          <div className="theme-toggle">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')} title="Light"><Ic k="sun" /></button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')} title="Dark"><Ic k="moon" /></button>
          </div>
          {/* Sprint 3 — the real notification centre. Reminders, overdue escalations,
              SLA breaches and assignments all land here; Sprint 4's WhatsApp/SMS/Email
              channels fan out from the same server-side message. */}
          <NotificationBell onOpenLead={(id) => nav(`/m/leads/all?lead=${id}`)} />
          <button className="user-pill" title="Sign out" onClick={() => { if (confirm('Sign out?')) logout(); }}>
            <div className="av">{(me?.user.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</div>
            <div><div className="nm">{me?.user.name}</div><div className="rl">{roleName || me?.user.email}</div></div>
            <Ic k="logout" />
          </button>
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
      <main className="main" id="main">
        <Screen key={`${mod}.${sub}`} mod={mod} sub={sub} go={go} />
      </main>
      <Toaster />
    </div>
  );
}

function Screen({ mod, sub, go }: { mod: string; sub: string; go: (m: string, s: string) => void }) {
  const screen = findScreen(mod, sub) ?? findScreen('dash', 'overview')!;
  const spec = screen.sub.spec;
  const ref = useRef_();
  const [leadId, setLeadId] = useState<number | null>(null);
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

  return (
    <ScreenCtx.Provider value={{
      go, openLead: (id) => setLeadId(id), openAdd, refreshTick: tick, bump: () => setTick((t) => t + 1),
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
      {leadId != null && <LeadSheet leadId={leadId} onClose={() => setLeadId(null)} onChanged={() => setTick((t) => t + 1)} />}
      {addKey && <AddModal formKey={addKey} onClose={() => setAddKey(null)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
      {campaignOpen && <CampaignModal onClose={() => setCampaignOpen(false)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
      {roleOpen && <RoleModal onClose={() => setRoleOpen(false)} onSaved={() => { setTick((t) => t + 1); ref.reload(); }} />}
    </ScreenCtx.Provider>
  );
}
