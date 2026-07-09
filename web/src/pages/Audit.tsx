import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHead } from '../components/Shell';
import { useToast } from '../components/ui';

interface AuditRow {
  id: number; actor_name: string | null; entity_type: string; entity_id: number | null;
  action: string; occurred_at: string; ip: string | null;
}

export function AuditPage() {
  const toast = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.get<AuditRow[]>(`/audit-logs?limit=200${filter ? `&entity_type=${encodeURIComponent(filter)}` : ''}`)
      .then(setRows)
      .catch((e) => toast(e.message, true));
  }, [filter]);

  return (
    <>
      <PageHead crumb={['Administration', 'Audit Logs']} title="Audit Logs"
        sub="Append-only trail of every mutation: logins, CRUD, permission changes."
        actions={
          <input className="input" style={{ width: 220 }} placeholder="Filter by entity (e.g. users)"
            value={filter} onChange={(e) => setFilter(e.target.value)} />
        } />
      <div className="card">
        <table className="table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th><th>IP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 11.5 }}>{new Date(r.occurred_at).toLocaleString()}</td>
                <td>{r.actor_name ?? '—'}</td>
                <td><span className={`chip ${r.action === 'delete' ? 'off' : r.action === 'login' ? 'warn' : 'info'}`}>{r.action}</span></td>
                <td className="mono" style={{ fontSize: 12 }}>{r.entity_type}</td>
                <td>{r.entity_id ?? '—'}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{r.ip ?? '—'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="empty">No audit entries.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
