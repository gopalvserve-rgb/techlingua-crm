import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { ActiveChip, Field, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

interface MasterType { type: string; label: string; parent: string | null }
interface MasterRow {
  id: number; name: string; code: string | null; sort_order: number;
  is_active: boolean; parent_id: number | null; parent_name?: string | null;
}

export function MastersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [types, setTypes] = useState<MasterType[]>([]);
  const [type, setType] = useState<MasterType | null>(null);
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [parents, setParents] = useState<MasterRow[]>([]);
  const [editing, setEditing] = useState<Partial<MasterRow> | null>(null);

  useEffect(() => {
    api.get<MasterType[]>('/masters').then((t) => { setTypes(t); setType(t[0] ?? null); });
  }, []);

  const load = (t: MasterType) => {
    api.get<MasterRow[]>(`/masters/${t.type}?all=1`).then(setRows).catch((e) => toast(e.message, true));
    if (t.parent) api.get<MasterRow[]>(`/masters/${t.parent}`).then(setParents);
    else setParents([]);
  };

  useEffect(() => { if (type) load(type); }, [type]);

  const save = async () => {
    if (!type || !editing) return;
    try {
      const body = { name: editing.name, code: editing.code, sort_order: editing.sort_order, parent_id: editing.parent_id ?? null };
      if (editing.id) await api.patch(`/masters/${type.type}/${editing.id}`, body);
      else await api.post(`/masters/${type.type}`, body);
      toast('Saved');
      setEditing(null);
      load(type);
    } catch (e: any) { toast(e.message, true); }
  };

  const toggleActive = async (row: MasterRow) => {
    if (!type) return;
    try {
      if (row.is_active) await api.patch(`/masters/${type.type}/${row.id}/deactivate`);
      else await api.patch(`/masters/${type.type}/${row.id}`, { is_active: true });
      load(type);
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      <PageHead crumb={['Administration', 'Masters']} title="Masters"
        sub="Admin-editable dropdown data used across the CRM. Deactivation hides a value from pickers without breaking existing records."
        actions={can('master.create') ? (
          <button className="btn primary" onClick={() => setEditing({})}>+ New {type?.label.replace(/s$/, '')}</button>
        ) : undefined}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14, alignItems: 'start' }}>
        <div className="card" style={{ padding: 8 }}>
          {types.map((t) => (
            <button key={t.type} className={`hier-item${type?.type === t.type ? ' active' : ''}`} onClick={() => setType(t)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="card">
          <div className="card-head"><h3>{type?.label ?? ''}</h3><span className="chip info">{rows.length}</span></div>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Code</th>{type?.parent && <th style={{ textTransform: 'capitalize' }}>{type.parent}</th>}
                <th>Sort</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.code ?? '—'}</td>
                  {type?.parent && <td>{r.parent_name ?? '—'}</td>}
                  <td>{r.sort_order}</td>
                  <td><ActiveChip on={r.is_active} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {can('master.update') && <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>}{' '}
                    {can('master.deactivate') && (
                      <button className={`btn sm${r.is_active ? ' danger' : ''}`} onClick={() => toggleActive(r)}>
                        {r.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="empty">No entries yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && type && (
        <Modal title={`${editing.id ? 'Edit' : 'New'} — ${type.label}`} onClose={() => setEditing(null)}
          footer={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </>}>
          <Field label="Name">
            <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="Code (optional)">
            <input className="input" value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
          </Field>
          {type.parent && (
            <Field label={type.parent}>
              <select className="input" value={editing.parent_id ?? ''}
                onChange={(e) => setEditing({ ...editing, parent_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Sort order">
            <input className="input" type="number" value={editing.sort_order ?? 0}
              onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} />
          </Field>
        </Modal>
      )}
    </>
  );
}
