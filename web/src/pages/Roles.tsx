import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { Field, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

const SCOPES = ['own', 'team', 'branch', 'vertical', 'pipeline', 'campaign', 'all'] as const;

interface Role { id: number; name: string; is_system: boolean; is_custom: boolean; description: string | null; permission_count: number; user_count: number; is_active: boolean }
interface CatalogModule { module: string; label: string; actions: string[] }
interface Grant { permission_key: string; record_scope: string }

export function RolesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [grants, setGrants] = useState<Map<string, string>>(new Map()); // permission_key -> record_scope
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState<{ name: string; description: string } | null>(null);

  const loadRoles = () => api.get<Role[]>('/roles').then(setRoles).catch((e) => toast(e.message, true));

  useEffect(() => {
    loadRoles();
    api.get<{ catalog: CatalogModule[] }>('/roles/permissions').then((r) => setCatalog(r.catalog));
  }, []);

  const select = async (role: Role) => {
    setSelected(role);
    setDirty(false);
    const full = await api.get<{ grants: Grant[] }>(`/roles/${role.id}`);
    setGrants(new Map(full.grants.map((g) => [g.permission_key, g.record_scope])));
  };

  const toggleGrant = (key: string) => {
    const next = new Map(grants);
    if (next.has(key)) next.delete(key);
    else next.set(key, 'own');
    setGrants(next);
    setDirty(true);
  };

  const setScope = (key: string, scope: string) => {
    const next = new Map(grants);
    next.set(key, scope);
    setGrants(next);
    setDirty(true);
  };

  const saveMatrix = async () => {
    if (!selected) return;
    try {
      await api.put(`/roles/${selected.id}/permissions`, {
        entries: [...grants.entries()].map(([permission_key, record_scope]) => ({ permission_key, record_scope })),
      });
      toast('Permissions saved');
      setDirty(false);
      loadRoles();
    } catch (e: any) { toast(e.message, true); }
  };

  const createRole = async () => {
    if (!creating?.name) return;
    try {
      const role = await api.post<Role>('/roles', creating);
      toast('Custom role created');
      setCreating(null);
      await loadRoles();
      select(role);
    } catch (e: any) { toast(e.message, true); }
  };

  const grantCount = useMemo(() => grants.size, [grants]);

  return (
    <>
      <PageHead crumb={['Administration', 'Roles & Permissions']} title="Roles & Permissions"
        sub="Compose roles from module-level permissions and pick a record scope for each: own, team, branch, vertical, pipeline, campaign, or all."
        actions={can('role.create') ? <button className="btn primary" onClick={() => setCreating({ name: '', description: '' })}>+ Custom role</button> : undefined} />
      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 14, alignItems: 'start' }}>
        <div className="card" style={{ padding: 8 }}>
          {roles.map((r) => (
            <button key={r.id} className={`hier-item${selected?.id === r.id ? ' active' : ''}`} onClick={() => select(r)}>
              <span>
                {r.name}
                <span className="sub">{r.permission_count} perms · {r.user_count} users{r.is_system ? ' · system' : ''}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="card">
          <div className="card-head">
            <h3>{selected ? `Matrix — ${selected.name}` : 'Select a role'}</h3>
            {selected && can('role.update') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="chip info">{grantCount} granted</span>
                <button className="btn sm primary" disabled={!dirty} onClick={saveMatrix}>Save changes</button>
              </div>
            )}
          </div>
          {selected ? (
            <table className="table matrix">
              <thead><tr><th style={{ width: '40%' }}>Permission</th><th>Granted</th><th>Record scope</th></tr></thead>
              <tbody>
                {catalog.map((mod) => (
                  <FragmentRows key={mod.module} mod={mod} grants={grants}
                    editable={can('role.update')} onToggle={toggleGrant} onScope={setScope} />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">Pick a role on the left to view or edit its permission matrix.</div>
          )}
        </div>
      </div>

      {creating && (
        <Modal title="New custom role" onClose={() => setCreating(null)}
          footer={<>
            <button className="btn" onClick={() => setCreating(null)}>Cancel</button>
            <button className="btn primary" onClick={createRole}>Create</button>
          </>}>
          <Field label="Role name"><input className="input" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} /></Field>
          <Field label="Description"><input className="input" value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}

function FragmentRows(props: {
  mod: CatalogModule; grants: Map<string, string>; editable: boolean;
  onToggle: (key: string) => void; onScope: (key: string, scope: string) => void;
}) {
  const { mod, grants, editable, onToggle, onScope } = props;
  return (
    <>
      <tr className="module-row"><td colSpan={3}>{mod.label}</td></tr>
      {mod.actions.map((action) => {
        const key = `${mod.module}.${action}`;
        const granted = grants.has(key);
        return (
          <tr key={key}>
            <td className="mono" style={{ fontSize: 12 }}>{key}</td>
            <td>
              <input type="checkbox" checked={granted} disabled={!editable} onChange={() => onToggle(key)} />
            </td>
            <td>
              {granted ? (
                <select className="scope-sel" value={grants.get(key)} disabled={!editable}
                  onChange={(e) => onScope(key, e.target.value)}>
                  {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <span style={{ color: 'var(--text-dim)', fontSize: 11.5 }}>—</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}
