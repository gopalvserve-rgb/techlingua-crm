import { useAuth } from '../auth';
import { PageHead } from '../components/Shell';

/** Sprint-1 placeholder — role-based KPI dashboard lands in Sprint 3. */
export function DashboardPage() {
  const { me } = useAuth();
  return (
    <>
      <PageHead crumb={['Home', 'Dashboard']} title={`Welcome, ${me?.user.name}`}
        sub="Sprint 1 delivers the administration foundation: hierarchy, masters, users, teams, roles & permissions. Lead capture arrives in Sprint 2; KPI dashboards in Sprint 3." />
      <div className="card">
        <div className="card-head"><h3>Your access</h3></div>
        <div className="card-body">
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 10 }}>
            Assignments (role × unit) that shape what you can see:
          </p>
          <table className="table">
            <thead><tr><th>Role</th><th>Branch</th><th>Vertical</th><th>Pipeline</th><th>Campaign</th><th>Team</th></tr></thead>
            <tbody>
              {(me?.assignments ?? []).map((a: any) => (
                <tr key={a.id}>
                  <td><span className="chip info">{a.role_name}</span></td>
                  <td>{a.branch_name ?? <span style={{ color: 'var(--text-dim)' }}>All</span>}</td>
                  <td>{a.vertical_name ?? <span style={{ color: 'var(--text-dim)' }}>All</span>}</td>
                  <td>{a.pipeline_name ?? <span style={{ color: 'var(--text-dim)' }}>All</span>}</td>
                  <td>{a.campaign_name ?? <span style={{ color: 'var(--text-dim)' }}>All</span>}</td>
                  <td>{a.team_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
