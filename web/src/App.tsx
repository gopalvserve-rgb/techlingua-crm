import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { MastersPage } from './pages/Masters';
import { UsersPage } from './pages/Users';
import { TeamsPage } from './pages/Teams';
import { RolesPage } from './pages/Roles';
import { HierarchyPage } from './pages/Hierarchy';
import { AuditPage } from './pages/Audit';

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <div className="empty" style={{ paddingTop: '30vh' }}>Loading…</div>;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/masters" element={<MastersPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/hierarchy" element={<HierarchyPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
