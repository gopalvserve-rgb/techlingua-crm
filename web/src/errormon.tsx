/**
 * Client-side error monitor — reports browser crashes to POST /api/errors so
 * they surface in Administration › Error Logs (source=web).
 *
 * Fail-safe by design: the reporter never throws, never reports when logged out,
 * throttles to MAX_PER_WINDOW posts/min and dedupes identical messages per
 * session so an error loop can't flood the API.
 */
import { Component, ReactNode } from 'react';
import { getToken } from './api';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
let stamps: number[] = [];
const seen = new Set<string>();

export function reportClientError(message: unknown, stack?: string | null, meta?: Record<string, unknown>) {
  try {
    const token = getToken();
    if (!token) return; // /api/errors is authenticated — skip when logged out
    const msg = String(message ?? '').trim().slice(0, 500);
    if (!msg) return;
    if (seen.has(msg)) return; // dedupe same message within this session
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < WINDOW_MS);
    if (stamps.length >= MAX_PER_WINDOW) return; // client-side throttle
    stamps.push(now);
    seen.add(msg);
    void fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: msg,
        stack: stack ? String(stack).slice(0, 4000) : undefined,
        path: location.pathname,
        meta,
      }),
    }).catch(() => undefined);
  } catch {
    /* the reporter must never break the app */
  }
}

let installed = false;
export function installErrorMonitor() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    reportClientError(e.message || e.error?.message, e.error?.stack, {
      kind: 'onerror', src: e.filename || undefined, line: e.lineno || undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = e.reason;
    reportClientError(r?.message ?? r, r?.stack, { kind: 'unhandledrejection' });
  });
}

/** Reports React render crashes and shows a friendly recovery card. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(err: any, info: any) {
    reportClientError(err?.message ?? err, err?.stack, {
      kind: 'react_boundary',
      componentStack: String(info?.componentStack ?? '').slice(0, 1000) || undefined,
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="card" style={{ maxWidth: 440, padding: '26px 28px', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, marginBottom: 8 }}>
            Something went wrong
          </div>
          <div className="empty-note" style={{ marginBottom: 16 }}>
            The error was reported to your administrators automatically. Reloading usually fixes it.
          </div>
          <button className="btn primary" style={{ justifyContent: 'center' }} onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
