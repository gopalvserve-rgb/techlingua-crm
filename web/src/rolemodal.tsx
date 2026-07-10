/**
 * Role modal — UAT item 5: create a custom role, rename/describe it, and edit
 * its full permission matrix (module × action × record-scope) prefilled from
 * the API. System roles open read-only (the API locks renames; we lock the
 * matrix too — system grants are seed-managed).
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast } from './refdata';

interface CatalogModule { module: string; label: string; actions: string[] }
interface Grant { permission_key: string; record_scope: string }

const SCOPES = ['own', 'team', 'branch', 'vertical', 'pipeline', 'campaign', 'all'] as const;
const SCOPE_LABEL: Record<string, string> = {
  own: 'Own', team: 'Team', branch: 'Branch', vertical: 'Vertical',
  pipeline: 'Pipeline', campaign: 'Campaign', all: 'All',
};

export function RoleModal({ roleId, readOnly, onClose, onSaved }: {
  roleId?: number; readOnly?: boolean; onClose: () => void; onSaved?: () => void;
}) {
  const { can } = useAuth();
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  const [role, setRole] = useState<any>(roleId ? null : {});
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [entries, setEntries] = useState<Record<string, string>>({}); // permission_key -> record_scope
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ catalog: CatalogModule[] }>('/roles/permissions')
      .then((r) => setCatalog(r.catalog ?? [])).catch(() => setCatalog([]));
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

  const isSystem = !!role?.is_system;
  const locked = readOnly || isSystem || !can(roleId ? 'role.update' : 'role.create');
  const granted = useMemo(() => Object.keys(entries).filter((k) => entries[k]).length, [entries]);

  const save = async () => {
    if (!name.trim()) return toast('Role name is required', true);
    setBusy(true);
    try {
      let id = roleId;
      if (id) {
        await api.patch(`/roles/${id}`, { name: name.trim(), description: desc.trim() || null });
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
      <div className="add-modal" style={{ width: 720 }}>
        <div className="ah">
          <h3><Ic k={locked ? 'shield' : roleId ? 'pencil' : 'plus'} />{title}
            {isSystem ? <span className="bdg b-indigo" style={{ marginLeft: 8 }}>System · locked</span> : null}
          </h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">
          {!roleId || role ? (
            <>
              <div className="form-grid">
                <div className="fld">
                  <label>Role Name {locked ? null : <span className="star">*</span>}</label>
                  {locked
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
              <div className="sechead">Permission matrix<span className="fhint" style={{ marginLeft: 8 }}>{granted} grants · scope controls record visibility</span></div>
              <div className="scroll-x">
                <table className="matrixed">
                  <thead><tr><th>Module</th><th>Action</th><th>Record scope</th></tr></thead>
                  <tbody>
                    {catalog.map((m) => m.actions.map((a, ai) => {
                      const key = `${m.module}.${a}`;
                      const cur = entries[key] ?? '';
                      return (
                        <tr key={key}>
                          {ai === 0 ? <td rowSpan={m.actions.length} style={{ fontWeight: 600 }}>{m.label}</td> : null}
                          <td className="mono" style={{ fontSize: 11.5 }}>{a}</td>
                          <td>
                            {locked
                              ? (cur ? <span className={`bdg ${cur === 'all' ? 'b-green' : 'b-cyan'}`}>{SCOPE_LABEL[cur] ?? cur}</span> : <span className="bdg b-gray">—</span>)
                              : (
                                <select value={cur} onChange={(e) => setEntries((x) => ({ ...x, [key]: e.target.value }))}>
                                  <option value="">— No access</option>
                                  {SCOPES.map((sc) => <option key={sc} value={sc}>{SCOPE_LABEL[sc]}</option>)}
                                </select>
                              )}
                          </td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <div className="empty-note">Loading role…</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
          {!locked && <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />{roleId ? 'Save changes' : 'Create role'}</button>}
        </div>
      </div>
    </div>
  );
}
