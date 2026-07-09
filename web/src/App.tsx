import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Shell } from './Shell';
import { LoginPage } from './Login';
import { RefDataProvider } from './refdata';

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <div className="empty-note" style={{ paddingTop: '30vh' }}>Loading…</div>;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <RefDataProvider>
      <Routes>
        <Route path="/m/:mod/:sub" element={<Shell />} />
        <Route path="*" element={<Navigate to="/m/dash/overview" replace />} />
      </Routes>
    </RefDataProvider>
  );
}
