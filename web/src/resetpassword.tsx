import { FormEvent, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from './api';

/**
 * Reset password page — reached from the link in the reset email
 * (`<app>/reset-password?token=…`). Sets a new password against a valid,
 * unexpired, single-use token, then sends the user to sign in.
 *
 * Public route (no session needed): wired into App.tsx before the auth gate.
 */
const MIN = 8;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // basic strength rule: length + at least one letter and one number
  const weak = useMemo(() => {
    if (pw.length < MIN) return `Use at least ${MIN} characters.`;
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
    return '';
  }, [pw]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (weak) { setError(weak); return; }
    if (pw !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, new_password: pw });
      setDone(true);
      setTimeout(() => nav('/login', { replace: true }), 1800);
    } catch (err: any) {
      if (err instanceof ApiError) setError(err.message || 'Could not reset the password.');
      else setError(err?.message ?? 'Could not reset the password.');
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="logo">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M4 7l8-4 8 4-8 4-8-4z" fill="#fff" opacity=".95" />
              <path d="M4 7v6l8 4 8-4V7" stroke="#fff" strokeWidth="1.6" opacity=".7" fill="none" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="login-title">Tech Lingua</div>
            <div className="login-sub">Set a new password</div>
          </div>
        </div>

        {!token && (
          <div className="login-err">This reset link is missing its token. Please use the link from your email, or request a new one.</div>
        )}
        {error && <div className="login-err">{error}</div>}
        {done ? (
          <div className="login-err" style={{ background: 'rgba(46,230,201,.08)', borderColor: 'var(--success, #2ee6c9)', color: 'var(--success, #2ee6c9)' }}>
            Password reset. Redirecting you to sign in…
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="fld">
              <label>New password</label>
              <input className="ainp" type="password" value={pw} autoFocus required disabled={!token}
                onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" />
            </div>
            <div className="fld">
              <label>Confirm new password</label>
              <input className="ainp" type="password" value={confirm} required disabled={!token}
                onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter the password" />
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
              disabled={busy || !token}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
            <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              disabled={busy} onClick={() => nav('/login', { replace: true })}>Back to sign in</button>
          </form>
        )}
      </div>
    </div>
  );
}
