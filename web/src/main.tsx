import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { ErrorBoundary, installErrorMonitor } from './errormon';
import './styles.css';

document.documentElement.dataset.theme = localStorage.getItem('tl_theme') ?? 'dark';

// dev/121 — capture the mobile-app flag at boot, BEFORE React Router mounts and its
// catch-all redirect (`/?app=mobile` -> `/m/dash/overview`) strips the query string.
// Persisted to sessionStorage so isMobileApp() (specs.tsx) returns true for the whole
// tab session and the nav hard-scopes to the operational Leads CRM. The native
// Capacitor wrapper is also detected via window.Capacitor.isNativePlatform().
try {
  if (new URLSearchParams(window.location.search).get('app') === 'mobile') {
    sessionStorage.setItem('tl_mobile_app', '1');
  }
} catch { /* sessionStorage unavailable — Capacitor signal still applies */ }

installErrorMonitor(); // window.onerror + unhandledrejection -> POST /api/errors

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
