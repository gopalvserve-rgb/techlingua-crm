import { ReactNode, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';

/** Phase-1 side-nav per design/00-foundations-IA.md. Sprint-1 ships Administration;
    other groups render as placeholders tagged with their sprint. */
const NAV: Array<{ group: string; items: Array<{ label: string; to?: string; perm?: string; ph?: string }> }> = [
  { group: 'Dashboard', items: [{ label: 'Overview', to: '/', perm: 'dashboard.read' }] },
  { group: 'Marketing & Lead Management', items: [
    { label: 'Leads', ph: 'S2' }, { label: 'Campaigns', to: '/hierarchy', perm: 'campaign.read' },
    { label: 'Sources & Capture', ph: 'S2' }, { label: 'Bulk Import', ph: 'S2' },
  ]},
  { group: 'Performance & Conversion', items: [{ label: 'Enrolments', ph: 'S5' }, { label: 'Quotations', ph: 'S5' }] },
  { group: 'Engagement & Workflow', items: [{ label: 'Templates', ph: 'S4' }, { label: 'Automation', ph: 'S4' }] },
  { group: 'Reports & Analytics', items: [{ label: 'Report Builder', ph: 'S6' }] },
  { group: 'Workspace', items: [{ label: 'Tasks & Notes', ph: 'S6' }] },
  { group: 'Administration', items: [
    { label: 'Hierarchy', to: '/hierarchy', perm: 'branch.read' },
    { label: 'Masters', to: '/masters', perm: 'master.read' },
    { label: 'Users', to: '/users', perm: 'user.read' },
    { label: 'Teams', to: '/teams', perm: 'team.read' },
    { label: 'Roles & Permissions', to: '/roles', perm: 'role.read' },
    { label: 'Audit Logs', to: '/audit', perm: 'audit.read' },
  ]},
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, logout, can } = useAuth();
  const [theme, setTheme] = useState(localStorage.getItem('tl_theme') ?? 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('tl_theme', theme);
  }, [theme]);

  const initials = me?.user.name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase() ?? '?';
  const roleNames = [...new Set((me?.assignments ?? []).map((a) => a.role_name))].join(', ');

  return (
    <div className="app">
      <div className="brand">
        <div className="logo">TL</div>
        <div className="brand-name">Tech Lingua<span>Education CRM</span></div>
      </div>
      <div className="topbar">
        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Organisation: <b style={{ color: 'var(--text)' }}>Tech Lingua LLP</b>
        </span>
        <div className="user-pill">
          <div className="avatar">{initials}</div>
          <div>
            <b>{me?.user.name}</b>
            <span className="rl">{roleNames || 'No role'}</span>
          </div>
        </div>
        <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="icon-btn" title="Sign out" onClick={logout}>⎋</button>
      </div>
      <nav className="sidebar">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(i.perm) || i.ph);
          if (!items.length) return null;
          return (
            <div key={g.group} style={{ marginBottom: 6 }}>
              <div className="mod-btn open" style={{ pointerEvents: 'none', fontWeight: 600 }}>{g.group}</div>
              <div className="submenu">
                {items.map((i) =>
                  i.to && (!i.perm || can(i.perm)) ? (
                    <NavLink key={i.label} to={i.to} end={i.to === '/'}
                      className={({ isActive }) => `subitem${isActive ? ' active' : ''}`}>
                      <span className="pt" />{i.label}
                    </NavLink>
                  ) : (
                    <span key={i.label} className="subitem" style={{ opacity: .55, cursor: 'default' }}>
                      <span className="pt" />{i.label}
                      {i.ph && <span className="chip warn" style={{ marginLeft: 'auto', fontSize: 8.5 }}>{i.ph}</span>}
                    </span>
                  ),
                )}
              </div>
            </div>
          );
        })}
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

export function PageHead(props: { crumb: string[]; title: string; sub?: string; actions?: ReactNode }) {
  return (
    <>
      <div className="crumb">
        {props.crumb.map((c, i) => (
          <span key={i}>{i > 0 && ' › '}{i === props.crumb.length - 1 ? <b>{c}</b> : c}</span>
        ))}
      </div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{props.title}</h1>
          {props.sub && <p className="page-sub">{props.sub}</p>}
        </div>
        {props.actions}
      </div>
    </>
  );
}
