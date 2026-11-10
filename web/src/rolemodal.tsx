/**
 * Role modal — UAT item 5: create a custom role, rename/describe it, and edit its full permission
 * matrix (module × action × record-scope) prefilled from the API.
 *
 * Client 10 Nov 2026 (points 6 & 7): EVERY role is now editable — the system roles (Branch Manager,
 * Counsellor, Accountant, Trainer…) included — except the full-access admin roles the API keeps
 * locked (Super Admin, Organization Admin). Each module gets a one-click Full / Partial / No access
 * switch; Partial opens the module's individual actions, each with its own record scope.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast } from './refdata';
import { isModuleHidden, LEARNING_PERMISSION_MODULES } from './specs';

export interface CatalogModule { module: string; label: string; actions: string[] }
interface Grant { permission_key: string; record_scope: string }

export const SCOPES = ['own', 'team', 'branch', 'vertical', 'pipeline', 'campaign', 'all'] as const;
export const SCOPE_LABEL: Record<string, string> = {
  own: 'Own', team: 'Team', branch: 'Branch', vertical: 'Vertical',
  pipeline: 'Pipeline', campaign: 'Campaign', all: 'All',
};
/** Roles whose matrix the API refuses to change (fallback when the catalog call omits the list). */
export const DEFAULT_LOCKED_ROLES = ['Super Admin', 'Organization Admin'];

export type ModuleLevel = 'full' | 'partial' | 'none';

/** Full = every action at "All" records; none = no action; anything else is partial. */
export function moduleLevel(m: CatalogModule, entries: Record<string, string>): ModuleLevel {
  const set = m.actions.filter((a) => entries[`${m.module}.${a}`]);
  if (!set.length) return 'none';
  return set.length === m.actions.length && set.every((a) => entries[`${m.module}.${a}`] === 'all') ? 'full' : 'partial';
}

/** Apply a module level to a copy of the entries map. Partial keeps what is there, or starts at read · Own. */
export function applyLevel(m: CatalogModule, entries: Record<string, string>, level: ModuleLevel): Record<string, string> {
  const next = { ...entries };
  if (level === 'full') m.actions.forEach((a) => { next[`${m.module}.${a}`] = 'all'; });
  if (level === 'none') m.actions.forEach((a) => { delete next[`${m.module}.${a}`]; });
  if (level === 'partial' && !m.actions.some((a) => next[`${m.module}.${a}`])) {
    const first = m.actions.includes('read') ? 'read' : m.actions[0];
    if (first) next[`${m.module}.${first}`] = 'own';
  }
  return next;
}

export function LevelSwitch({ level, onPick, disabled, testid }: {
  level: ModuleLevel; onPick: (l: ModuleLevel) => void; disabled?: boolean; testid?: string;
}) {
  const opts: Array<[ModuleLevel, string, string]> = [['full', 'Full', 'lv-full'], ['partial', 'Partial', 'lv-part'], ['none', 'No access', 'lv-none']];
  return (
    <span className="lvsw" role="radiogroup" data-testid={testid}>
      {opts.map(([v, label, cls]) => (
        <button key={v} type="button" role="radio" aria-checked={level === v} disabled={disabled}
          className={`${cls}${level === v ? ' on' : ''}`} onClick={() => onPick(v)}>{label}</button>
      ))}
    </span>
  );
}

export function RoleModal({ roleId, readOnly, focusModules, onClose, onSaved }: {
  roleId?: number; readOnly?: boolean;
  /** open with these permission modules expanded and scrolled into view (Roles matrix › Partial) */
  focusModules?: string[];
  onClose: () => void; onSaved?: () => void;
}) {
  const { can } = useAuth();
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  const [lockedRoles, setLockedRoles] = useState<string[]>(DEFAULT_LOCKED_ROLES);
  const [role, setRole] = useState<any>(roleId ? null : {});
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [entries, setEntries] = useState<Record<string, string>>({}); // permission_key -> record_scope
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusModules ?? []));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ catalog: CatalogModule[]; locked_roles?: string[] }>('/roles/permissions')
      // a hidden module's permission rows are not shown (its existing grants are kept on save)
      .then((r) => {
        setCatalog((r.catalog ?? []).filter((m) => !(isModuleHidden('learning') && LEARNING_PERMISSION_MODULES.has(m.module))));
        if (Array.isArray(r.locked_roles)) setLockedRoles(r.locked_roles);
      })
      .catch(() => setCatalog([]));
  }, []);
  useEffect(() => {
    if (!roleId) return;
    api.get<any>(`/roles/${roleId}`).then((r) => {
      setRole(r); setName(r.name ?? ''); setDesc(r.description ?? '');
      const e: Record<string, string> = {};
      (r.grants as Grant[] ?? []).forEach((g) => { e[g.permission_key] = g.record_scope; });
      setEntries(e);
    }).catch((e) => { toast(e.message, true); onClose(); });
  }, [roleId, onClose]);
  // Roles matrix › Partial: scroll the first focused module into view once everything has loaded.
  useEffect(() => {
    if (!focusModules?.length || !catalog.length || !role) return;
    const el = bodyRef.current?.querySelector(`[data-mod="${focusModules[0]}"]`);
    (el as HTMLElement | null)?.scrollIntoView({ block: 'start' });
  }, [catalog.length, role, focusModules]);

  const isSystem = !!role?.is_system;
  const fullAccessRole = isSystem && lockedRoles.includes(String(role?.name ?? ''));
  const locked = !!readOnly || fullAccessRole || !can(roleId ? 'role.update' : 'role.create');
  const granted = useMemo(() => Object.keys(entries).filter((k) => entries[k]).length, [entries]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? catalog.filter((m) => m.label.toLowerCase().includes(t) || m.module.toLowerCase().includes(t)) : catalog;
  }, [catalog, q]);

  const toggleOpen = (mod: string) => setOpen((o) => { const n = new Set(o); n.has(mod) ? n.delete(mod) : n.add(mod); return n; });
  const pickLevel = (m: CatalogModule, level: ModuleLevel) => {
    setEntries((x) => applyLevel(m, x, level));
    setOpen((o) => { const n = new Set(o); level === 'partial' ? n.add(m.module) : n.delete(m.module); return n; });
  };

  const save = async () => {
    if (!name.trim()) return toast('Role name is required', true);
    setBusy(true);
    try {
      let id = roleId;
      if (id) {
        // a system role keeps its name (the API refuses a rename); its description can change
        await api.patch(`/roles/${id}`, isSystem ? { description: desc.trim() || null } : { name: name.trim(), description: desc.trim() || null });
      } else {
        const created = await api.post<any>('/roles', { name: name.trim(), description: desc.trim() || undefined });
        id = Number(created.id);
      }
      await api.put(`/roles/${id}/permissions`, {
        entries: Object.entries(entries)
          .filter(([, scope]) => scope)
          .map(([permission_key, record_scope]) => ({ permission_key, record_scope })),
      });
      toast(roleId ? `Role "${name.trim()}" updated` : `Role "${name.trim()}" created`);
      onSaved?.(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const title = !roleId ? 'New Role' : locked ? `Role — ${role?.name ?? ''}` : `Edit Role — ${role?.name ?? ''}`;

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 780 }}>
        <div className="ah">
          <h3><Ic k={locked ? 'shield' : roleId ? 'pencil' : 'plus'} />{title}
            {fullAccessRole ? <span className="bdg b-indigo" style={{ marginLeft: 8 }}>Full access · locked</span>
              : isSystem ? <span className="bdg b-cyan" style={{ marginLeft: 8 }}>System role · editable</span> : null}
          </h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody" ref={bodyRef}>
          {!roleId || role ? (
            <>
              <div className="form-grid">
                <div className="fld">
                  <label>Role Name {locked || isSystem ? null : <span className="star">*</span>}</label>
                  {locked || isSystem
                    ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{name || '—'}</div>
                    : <input className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior Counsellor" />}
                </div>
                <div className="fld">
                  <label>Description<span className="fhint">what this role is for</span></label>
                  {locked
                    ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{desc || '—'}</div>
                    : <input className="ainp" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional description" />}
                </div>
              </div>
              {fullAccessRole && (
                <div className="empty-note" style={{ textAlign: 'left', margin: '10px 0 0' }}>
                  {role?.name} always has every permission, so it cannot be edited — otherwise nobody could manage roles any more.
                </div>
              )}
              <div className="sechead" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>Permission matrix<span className="fhint" style={{ marginLeft: 8 }}>{granted} grants · Full = every action on all records · Partial = pick actions &amp; record scope</span></span>
                <input className="ainp" style={{ marginLeft: 'auto', width: 200, padding: '6px 10px' }} placeholder="Filter modules…"
                  value={q} onChange={(e) => setQ(e.target.value)} data-testid="role-mod-filter" />
              </div>
              <div className="scroll-x">
                <table className="matrixed rolemx">
                  <thead><tr><th>Module</th><th>Access</th><th>Actions</th></tr></thead>
                  <tbody>
                    {shown.map((m) => {
                      const level = moduleLevel(m, entries);
                      const isOpen = open.has(m.module);
                      const count = m.actions.filter((a) => entries[`${m.module}.${a}`]).length;
                      return [
                        <tr key={m.module} className="mod-row" data-mod={m.module}>
                          <td style={{ fontWeight: 600 }}>
                            <button type="button" className="modexp" aria-expanded={isOpen} onClick={() => toggleOpen(m.module)}>
                              <span style={{ display: 'inline-flex', transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}><Ic k="chev" /></span>
                              {m.label}
                            </button>
                          </td>
                          <td>
                            {locked
                              ? <span className={`bdg ${level === 'full' ? 'b-green' : level === 'partial' ? 'b-amber' : 'b-gray'}`}>{level === 'full' ? 'Full' : level === 'partial' ? 'Partial' : 'No access'}</span>
                              : <LevelSwitch level={level} onPick={(l) => pickLevel(m, l)} testid={`lvl-${m.module}`} />}
                          </td>
                          <td className="sub">{count} / {m.actions.length}</td>
                        </tr>,
                        ...(isOpen ? m.actions.map((a) => {
                          const key = `${m.module}.${a}`;
                          const cur = entries[key] ?? '';
                          return (
                            <tr key={key} className="act-row">
                              <td className="mono" style={{ fontSize: 11.5, paddingLeft: 34 }}>{a}</td>
                              <td colSpan={2}>
                                {locked
                                  ? (cur ? <span className={`bdg ${cur === 'all' ? 'b-green' : 'b-cyan'}`}>{SCOPE_LABEL[cur] ?? cur}</span> : <span className="bdg b-gray">—</span>)
                                  : (
                                    <select value={cur} aria-label={`${m.label} ${a} record scope`} data-testid={`scope-${key}`}
                                      onChange={(e) => setEntries((x) => {
                                        const n = { ...x };
                                        if (e.target.value) n[key] = e.target.value; else delete n[key];
                                        return n;
                                      })}>
                                      <option value="">— No access</option>
                                      {SCOPES.map((sc) => <option key={sc} value={sc}>{SCOPE_LABEL[sc]}</option>)}
                                    </select>
                                  )}
                              </td>
                            </tr>
                          );
                        }) : []),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : <div className="empty-note">Loading role…</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
          {!locked && <button className="btn primary" onClick={save} disabled={busy} data-testid="role-save"><Ic k="check" />{roleId ? 'Save changes' : 'Create role'}</button>}
        </div>
      </div>
    </div>
  );
}
