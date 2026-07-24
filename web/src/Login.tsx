import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from './api';
import { useAuth } from './auth';
import { PhoneInput } from './phonefield';

/**
 * Mobile-first sign-in (client update #1): Password | OTP toggle.
 * Password mode accepts identifier = mobile number OR email; OTP mode sends a
 * 6-digit code to a registered mobile (503 surfaces verbatim while no SMS
 * gateway is configured in Settings).
 */
export function LoginPage() {
  const { login, loginWithToken } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const done = () => nav('/m/dash/overview', { replace: true });

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try { await login(identifier.trim(), password); done(); }
    catch (err: any) { setError(err.message ?? 'Login failed'); }
    finally { setBusy(false); }
  };

  const requestOtp = async () => {
    setError(''); setInfo(''); setBusy(true);
    try {
      await api.post('/auth/otp/request', { mobile });
      setOtpSent(true);
      setInfo('OTP sent — valid for 5 minutes.');
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 503) {
        setError(err.message || 'SMS gateway not configured — add SMS API in Settings');
      } else setError(err.message ?? 'Could not send OTP');
    } finally { setBusy(false); }
  };

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setInfo(''); setBusy(true);
    try {
      // ALWAYS a generic success — the API never reveals whether the email exists.
      const res = await api.post<{ message: string }>('/auth/forgot-password', { email: forgotEmail.trim() });
      setForgotSent(true);
      setInfo(res?.message || 'If an account exists for that address, a reset link has been sent.');
    } catch (err: any) {
      setError(err?.message ?? 'Could not send the reset link.');
    } finally { setBusy(false); }
  };

  const submitOtp = async (e: FormEvent) => {
    e.preventDefault();
    if (!otpSent) { await requestOtp(); return; }
    setError(''); setBusy(true);
    try {
      const res = await api.post<{ token: string }>('/auth/otp/verify', { mobile, code: code.trim() });
      await loginWithToken(res.token);
      done();
    } catch (err: any) { setError(err.message ?? 'OTP verification failed'); }
    finally { setBusy(false); }
  };

  const tabStyle = (on: boolean): React.CSSProperties => ({
    flex: 1, padding: '8px 0', textAlign: 'center', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
    borderRadius: 8, border: '1px solid', userSelect: 'none',
    borderColor: on ? 'var(--primary)' : 'var(--border)',
    background: on ? 'var(--primary-soft, rgba(90,98,240,.12))' : 'transparent',
    color: on ? 'var(--primary)' : 'var(--text-muted)',
  });

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
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <div style={tabStyle(mode === 'password')} onClick={() => { setMode('password'); setError(''); setInfo(''); }}>Password</div>
          <div style={tabStyle(mode === 'otp')} onClick={() => { setMode('otp'); setError(''); setInfo(''); }}>OTP</div>
        </div>
        {error && <div className="login-err">{error}</div>}
        {info && !error && <div className="login-err" style={{ background: 'rgba(46,230,201,.08)', borderColor: 'var(--success, #2ee6c9)', color: 'var(--success, #2ee6c9)' }}>{info}</div>}
        {forgot ? (
          forgotSent ? (
            <div>
              <button type="button" className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
                onClick={() => { setForgot(false); setForgotSent(false); setInfo(''); }}>Back to sign in</button>
            </div>
          ) : (
            <form onSubmit={submitForgot}>
              <div className="fld">
                <label>Your account email</label>
                <input className="ainp" type="email" value={forgotEmail} autoFocus required
                  onChange={(e) => setForgotEmail(e.target.value)} placeholder="you@techlingua.in" />
              </div>
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy || !forgotEmail.trim()}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                disabled={busy} onClick={() => { setForgot(false); setError(''); setInfo(''); }}>Back to sign in</button>
            </form>
          )
        ) : mode === 'password' ? (
          <form onSubmit={submitPassword}>
            <div className="fld">
              <label>Mobile number or email</label>
              <input className="ainp" type="text" value={identifier} autoFocus required
                onChange={(e) => setIdentifier(e.target.value)} placeholder="98111 00001 or you@techlingua.in" />
            </div>
            <div className="fld">
              <label>Password</label>
              <input className="ainp" type="password" value={password} required
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <a role="button" tabIndex={0} onClick={() => { setForgot(true); setError(''); setInfo(''); }}
                style={{ fontSize: 12.5, color: 'var(--primary)', cursor: 'pointer' }}>Forgot password?</a>
            </div>
          </form>
        ) : (
          <form onSubmit={submitOtp}>
            <div className="fld">
              <label>Mobile number</label>
              <PhoneInput value={mobile} onChange={setMobile} placeholder="Registered mobile" />
            </div>
            {otpSent && (
              <div className="fld">
                <label>One-time code</label>
                <input className="ainp" type="text" inputMode="numeric" maxLength={6} value={code} autoFocus required
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="6-digit code" />
              </div>
            )}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy || !mobile}>
              {busy ? 'Please wait…' : otpSent ? 'Verify & sign in' : 'Send OTP'}
            </button>
            {otpSent && (
              <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                disabled={busy} onClick={requestOtp}>Resend OTP</button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
