import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { Shell } from './Shell';
import { LoginPage } from './Login';
import { ResetPasswordPage } from './resetpassword';
import { RefDataProvider } from './refdata';
import { GlobalScopeProvider } from './scope';
import { ParentReportView } from './learning';

/** Public, login-free parent report-card view (tokenised share link). */
function ParentReportRoute() {
  const { token } = useParams();
  return <ParentReportView token={token ?? ''} />;
}

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <div className="empty-note" style={{ paddingTop: '30vh' }}>Loading…</div>;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/parent/report/:token" element={<ParentReportRoute />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <RefDataProvider>
      <GlobalScopeProvider>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/parent/report/:token" element={<ParentReportRoute />} />
          <Route path="/m/:mod/:sub" element={<Shell />} />
          <Route path="*" element={<Navigate to="/m/dash/overview" replace />} />
        </Routes>
      </GlobalScopeProvider>
    </RefDataProvider>
  );
}
