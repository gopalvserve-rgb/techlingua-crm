import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { ErrorBoundary, installErrorMonitor } from './errormon';
import './styles.css';

document.documentElement.dataset.theme = localStorage.getItem('tl_theme') ?? 'dark';
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
