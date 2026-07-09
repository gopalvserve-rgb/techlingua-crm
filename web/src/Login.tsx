import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth';

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      nav('/m/dash/overview', { replace: true });
    } catch (err: any) {
      setError(err.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
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
            <div className="login-sub">Education CRM · ERP — sign in</div>
          </div>
        </div>
        {error && <div className="login-err">{error}</div>}
        <form onSubmit={submit}>
          <div className="fld">
            <label>Email</label>
            <input className="ainp" type="email" value={email} autoFocus required
              onChange={(e) => setEmail(e.target.value)} placeholder="you@techlingua.in" />
          </div>
          <div className="fld">
            <label>Password</label>
            <input className="ainp" type="password" value={password} required
              onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
