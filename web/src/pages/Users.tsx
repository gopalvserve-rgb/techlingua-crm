import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { Field, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

interface UserRow { id: number; name: string; email: string; phone: string | null; status: string }
interface Assignment {
  id?: number; role_id: number | ''; branch_id?: number | null; vertical_id?: number | null;
  pipeline_id?: number | null; campaign_id?: number | null; team_id?: number | null;
}
interface Option { id: number; name: string }

export function UsersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Option[]>([]);
  const [branches, setBranches] = useState<Option[]>([]);
  const [verticals, setVerticals] = useState<Array<Option & { branch_id: number }>>([]);
  const [pipelines, setPipelines] = useState<Array<Option & { vertical_id: number }>>([]);
  const [campaigns, setCampaigns] = useState<Array<Option & { pipeline_id: number }>>([]);
  const [teams, setTeams] = useState<Option[]>([]);
  const [editing, setEditing] = useState<(Partial<UserRow> & { password?: string; assignments?: Assignment[] }) | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState('name,email,phone,password\n');

  const load = () => api.get<UserRow[]>('/users').then(setRows).catch((e) => toast(e.message, true));

  useEffect(() => {
    load();
    if (can('role.read')) api.get<Option[]>('/roles').then(setRoles);
    if (can('branch.read')) api.get<any[]>('/branches').then(setBranches);
    if (can('vertical.read')) api.get<any[]>('/verticals').then(setVerticals);
    if (can('pipeline.read')) api.get<any[]>('/pipelines').then(setPipelines);
    if (can('campaign.read')) api.get<any[]>('/campaigns').then(setCampaigns);
    if (can('team.read')) api.get<any[]>('/teams').then(setTeams);
  }, []);

  const openEdit = async (row?: UserRow) => {
    if (!row) return setEditing({ assignments: [] });
    const full = await api.get<any>(`/users/${row.id}`);
    setEditing({ ...row, assignments: full.assignments.map((a: any) => ({
      id: a.id, role_id: Number(a.role_id), branch_id: a.branch_id ? Number(a.branch_id) : null,
      vertical_id: a.vertical_id ? Number(a.vertical_id) : null, pipeline_id: a.pipeline_id ? Number(a.pipeline_id) : null,
      campaign_id: a.campaign_id ? Number(a.campaign_id) : null, team_id: a.team_id ? Number(a.team_id) : null,
    })) });
  };

  const save = async () => {
    if (!editing) return;
    try {
      const assignments = (editing.assignments ?? []).filter((a) => a.role_id !== '');
      if (editing.id) {
        await api.patch(`/users/${editing.id}`, { name: editing.name, phone: editing.phone, password: editing.password || undefined });
        // reconcile assignments: naive replace (delete all existing, re-add) via assignments API
        const existing = await api.get<any[]>(`/assignments?user_id=${editing.id}`);
        for (const a of existing) await api.del(`/assignments/${a.id}`);
        for (const a of assignments) await api.post('/assignments', { ...a, user_id: editing.id });
      } else {
        await api.post('/users', { name: editing.name, email: editing.email, phone: editing.phone,
          password: editing.password || undefined, assignments });
      }
      toast('Saved');
      setEditing(null);
      load();
    } catch (e: any) { toast(e.message, true); }
  };

  const toggle = async (row: UserRow) => {
    try {
      if (row.status === 'active') await api.patch(`/users/${row.id}/deactivate`);
      else await api.patch(`/users/${row.id}`, { status: 'active' });
      load();
    } catch (e: any) { toast(e.message, true); }
  };

  const runImport = async () => {
    try {
      const res = await api.post<any>('/users/import', { csv });
      toast(`Imported ${res.imported}/${res.total} (${res.failed} failed)`);
      setImportOpen(false);
      load();
    } catch (e: any) { toast(e.message, true); }
  };

  const setAsg = (idx: number, patch: Partial<Assignment>) => {
    const list = [...(editing?.assignments ?? [])];
    list[idx] = { ...list[idx], ...patch };
    setEditing({ ...editing!, assignments: list });
  };

  return (
    <>
      <PageHead crumb={['Administration', 'Users']} title="Users"
        sub="Create users and grant multi-unit access: each assignment binds a role to a branch/vertical/pipeline/campaign/team."
        actions={<div style={{ display: 'flex', gap: 8 }}>
          {can('user.import') && <button className="btn" onClick={() => setImportOpen(true)}>Bulk CSV import</button>}
          {can('user.create') && <button className="btn primary" onClick={() => openEdit()}>+ New user</button>}
        </div>} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td>
                <td>{r.email}</td>
                <td>{r.phone ?? '—'}</td>
                <td><span className={`chip ${r.status === 'active' ? 'ok' : 'off'}`}>{r.status}</span></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {can('user.update') && <button className="btn sm" onClick={() => openEdit(r)}>Edit</button>}{' '}
                  {can('user.deactivate') && (
                    <button className={`btn sm${r.status === 'active' ? ' danger' : ''}`} onClick={() => toggle(r)}>
                      {r.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="empty">No users visible in your scope.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal wide title={editing.id ? `Edit user — ${editing.name}` : 'New user'} onClose={() => setEditing(null)}
          footer={<>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Name"><input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Email">
              <input className="input" value={editing.email ?? ''} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Phone"><input className="input" value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></Field>
            <Field label={editing.id ? 'Reset password (blank = keep)' : 'Password'}>
              <input className="input" type="password" value={editing.password ?? ''} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </Field>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 8px' }}>
            <b style={{ fontSize: 13 }}>Assignments (role × unit)</b>
            <button className="btn sm" onClick={() => setEditing({ ...editing, assignments: [...(editing.assignments ?? []), { role_id: '' }] })}>+ Add</button>
          </div>
          {(editing.assignments ?? []).map((a, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr) 30px', gap: 6, marginBottom: 6 }}>
              <select className="input" value={a.role_id} onChange={(e) => setAsg(i, { role_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Role…</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select className="input" value={a.branch_id ?? ''} onChange={(e) => setAsg(i, { branch_id: e.target.value ? Number(e.target.value) : null, vertical_id: null, pipeline_id: null, campaign_id: null })}>
                <option value="">All branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select className="input" value={a.vertical_id ?? ''} onChange={(e) => setAsg(i, { vertical_id: e.target.value ? Number(e.target.value) : null, pipeline_id: null, campaign_id: null })}>
                <option value="">All verticals</option>
                {verticals.filter((v) => !a.branch_id || Number(v.branch_id) === a.branch_id).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <select className="input" value={a.pipeline_id ?? ''} onChange={(e) => setAsg(i, { pipeline_id: e.target.value ? Number(e.target.value) : null, campaign_id: null })}>
                <option value="">All pipelines</option>
                {pipelines.filter((p) => !a.vertical_id || Number(p.vertical_id) === a.vertical_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select className="input" value={a.campaign_id ?? ''} onChange={(e) => setAsg(i, { campaign_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">All campaigns</option>
                {campaigns.filter((c) => !a.pipeline_id || Number(c.pipeline_id) === a.pipeline_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className="input" value={a.team_id ?? ''} onChange={(e) => setAsg(i, { team_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">No team</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn sm danger" onClick={() => setEditing({ ...editing, assignments: (editing.assignments ?? []).filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          {!(editing.assignments ?? []).length && <p className="empty" style={{ padding: 12 }}>No assignments — the user will have no access.</p>}
        </Modal>
      )}

      {importOpen && (
        <Modal wide title="Bulk CSV import" onClose={() => setImportOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setImportOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={runImport}>Import</button>
          </>}>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>
            Header row required: <span className="mono">name,email,phone,password</span> (phone/password optional).
            Existing emails are skipped. Imported users get no assignments — grant roles afterwards.
          </p>
          <textarea className="input" rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
        </Modal>
      )}
    </>
  );
}
