import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { ActiveChip, Field, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

interface TeamRow {
  id: number; name: string; branch_id: number | null; branch_name: string | null;
  vertical_id: number | null; vertical_name: string | null; leader_id: number | null;
  leader_name: string | null; member_count: number; is_active: boolean;
}
interface Option { id: number; name: string; [k: string]: unknown }

export function TeamsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [branches, setBranches] = useState<Option[]>([]);
  const [verticals, setVerticals] = useState<Option[]>([]);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);

  const load = () => api.get<TeamRow[]>('/teams').then(setRows).catch((e) => toast(e.message, true));

  useEffect(() => {
    load();
    if (can('user.read')) api.get<Option[]>('/users').then(setUsers);
    if (can('branch.read')) api.get<Option[]>('/branches').then(setBranches);
    if (can('vertical.read')) api.get<Option[]>('/verticals').then(setVerticals);
  }, []);

  const openEdit = async (row?: TeamRow) => {
    if (!row) return setEditing({ member_ids: [] });
    const full = await api.get<any>(`/teams/${row.id}`);
    setEditing({ ...row, member_ids: full.members.map((m: any) => Number(m.id)) });
  };

  const save = async () => {
    if (!editing) return;
    try {
      const body = {
        name: editing.name, branch_id: editing.branch_id || null, vertical_id: editing.vertical_id || null,
        leader_id: editing.leader_id || null, member_ids: editing.member_ids,
      };
      if (editing.id) await api.patch(`/teams/${editing.id}`, body);
      else await api.post('/teams', body);
      toast('Saved');
      setEditing(null);
      load();
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      <PageHead crumb={['Administration', 'Teams']} title="Teams"
        sub="Teams group agents under a leader inside a branch/vertical — team-scoped permissions resolve through these."
        actions={can('team.create') ? <button className="btn primary" onClick={() => openEdit()}>+ New team</button> : undefined} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Branch</th><th>Vertical</th><th>Leader</th><th>Members</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td>
                <td>{r.branch_name ?? '—'}</td>
                <td>{r.vertical_name ?? '—'}</td>
                <td>{r.leader_name ?? '—'}</td>
                <td>{r.member_count}</td>
                <td><ActiveChip on={r.is_active} /></td>
                <td style={{ textAlign: 'right' }}>
                  {can('team.update') && <button className="btn sm" onClick={() => openEdit(r)}>Edit</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="empty">No teams in your scope.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={editing.id ? `Edit team — ${editing.name}` : 'New team'} onClose={() => setEditing(null)}
          footer={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </>}>
          <Field label="Name"><input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Branch">
              <select className="input" value={editing.branch_id ?? ''} onChange={(e) => setEditing({ ...editing, branch_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Vertical">
              <select className="input" value={editing.vertical_id ?? ''} onChange={(e) => setEditing({ ...editing, vertical_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>
                {verticals.filter((v: any) => !editing.branch_id || Number(v.branch_id) === Number(editing.branch_id))
                  .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Leader">
            <select className="input" value={editing.leader_id ?? ''} onChange={(e) => setEditing({ ...editing, leader_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="Members">
            <select className="input" multiple size={6} value={(editing.member_ids ?? []).map(String)}
              onChange={(e) => setEditing({ ...editing, member_ids: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        </Modal>
      )}
    </>
  );
}
