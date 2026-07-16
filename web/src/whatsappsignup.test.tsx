import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { launchEmbeddedSignup, ensureFbSdk, __resetSdk } from './whatsappsignup';
import { integrationState, STATE_BADGE, ChannelCfg } from './sprint4';

/* ===================== the four-state badge ===================== */

describe('integrationState — "Configured" and "Verified" are NOT the same word', () => {
  const row = (over: Partial<ChannelCfg>): ChannelCfg => ({
    id: 1, channel: 'payment', provider: 'razorpay', provider_label: 'Razorpay',
    vertical_id: null, vertical_name: null, config: {}, secrets_masked: {},
    is_active: true, status: 'connected', missing: [],
    last_test_at: null, last_test_ok: null, last_test_error: null, ...over,
  });

  it('nothing stored -> Not configured', () => {
    expect(integrationState(null)).toBe('not_configured');
    expect(STATE_BADGE.not_configured[0]).toBe('Not configured');
  });

  it('stored but a required field is short -> Not configured, not Configured', () => {
    expect(integrationState(row({ missing: ['Key Secret'] }))).toBe('not_configured');
  });

  it('complete but NEVER TESTED -> Configured (never "Verified")', () => {
    // The whole point: saving a Razorpay key proves nothing. Nobody has asked Razorpay.
    expect(integrationState(row({}))).toBe('configured');
    expect(STATE_BADGE.configured[0]).toMatch(/not yet tested/);
  });

  it('a passing test -> Verified', () => {
    expect(integrationState(row({ last_test_ok: true, last_test_at: 'x' }))).toBe('verified');
  });

  it('a failing test -> Failed (and the reason is carried on the row)', () => {
    const r = row({ last_test_ok: false, last_test_error: 'Invalid API Token' });
    expect(integrationState(r)).toBe('failed');
    expect(r.last_test_error).toBe('Invalid API Token');
  });

  it('deactivated -> Paused, and that beats any stale test result', () => {
    expect(integrationState(row({ is_active: false, last_test_ok: true }))).toBe('inactive');
  });
});

/* ===================== the Embedded Signup launcher ===================== */

describe('Embedded Signup launcher (Meta SDK faked)', () => {
  let listeners: Array<(e: any) => void> = [];
  const origAdd = window.addEventListener;
  const origRemove = window.removeEventListener;

  beforeEach(() => {
    __resetSdk();
    listeners = [];
    window.addEventListener = ((t: string, f: any) => {
      if (t === 'message') listeners.push(f); else origAdd.call(window, t, f);
    }) as any;
    window.removeEventListener = ((t: string, f: any) => {
      if (t === 'message') listeners = listeners.filter((l) => l !== f); else origRemove.call(window, t, f);
    }) as any;
  });
  afterEach(() => {
    window.addEventListener = origAdd;
    window.removeEventListener = origRemove;
    delete (window as any).FB;
  });

  /** Drives the fake dialog: emits Meta's postMessage, then fires the login callback. */
  const fakeFB = (opts: { message?: unknown; code?: string | null; origin?: string }) => {
    (window as any).FB = {
      login: (cb: (r: any) => void, params: any) => {
        (window as any).__params = params;
        if (opts.message !== undefined) {
          for (const l of [...listeners]) l({ origin: opts.origin ?? 'https://www.facebook.com', data: opts.message });
        }
        cb(opts.code === null ? {} : { authResponse: { code: opts.code ?? 'CODE-1' } });
      },
    };
  };

  it('THE HAPPY PATH: returns the code plus the ids Meta sent on the postMessage', async () => {
    fakeFB({ message: { type: 'WA_EMBEDDED_SIGNUP', data: { phone_number_id: '555', waba_id: '777' } } });
    await expect(launchEmbeddedSignup('cfg-1')).resolves.toEqual({
      code: 'CODE-1', phone_number_id: '555', waba_id: '777',
    });
  });

  it('asks Meta for a CODE — not a token. The exchange is server-side, with the app secret', async () => {
    fakeFB({ message: { type: 'WA_EMBEDDED_SIGNUP', data: { phone_number_id: '5', waba_id: '7' } } });
    await launchEmbeddedSignup('cfg-99');
    const p = (window as any).__params;
    expect(p.config_id).toBe('cfg-99');
    expect(p.response_type).toBe('code');
    expect(p.override_default_response_type).toBe(true);
  });

  it('accepts the OTHER payload shapes Meta has shipped (session_info / business_id)', async () => {
    fakeFB({ message: { type: 'WA_EMBEDDED_SIGNUP', session_info: { phone_id: '888', business_id: '999' } } });
    await expect(launchEmbeddedSignup('c')).resolves.toMatchObject({ phone_number_id: '888', waba_id: '999' });
  });

  it('a message from a NON-Facebook origin is ignored — no id spoofing', async () => {
    fakeFB({
      origin: 'https://evil.example.com',
      message: { type: 'WA_EMBEDDED_SIGNUP', data: { phone_number_id: 'HACKED', waba_id: 'HACKED' } },
    });
    const out = await launchEmbeddedSignup('c');
    expect(out.phone_number_id).toBe('');
    expect(out.waba_id).toBe('');
  });

  it('a cancelled login (after Meta spoke) says CANCELLED', async () => {
    fakeFB({ message: { type: 'WA_EMBEDDED_SIGNUP', data: {} }, code: null });
    await expect(launchEmbeddedSignup('c')).rejects.toThrow(/cancelled/i);
  });

  it('a popup that closes with NO message names the real cause: the redirect URI', async () => {
    // This is the failure the SaaS hit repeatedly. "Nothing happened" is the most
    // expensive thing this screen could say, so it says exactly what to go and fix.
    fakeFB({ code: null });
    await expect(launchEmbeddedSignup('c')).rejects.toThrow(/Valid OAuth Redirect URIs/);
  });

  it('the message listener is REMOVED afterwards — no leak across attempts', async () => {
    fakeFB({ message: { type: 'WA_EMBEDDED_SIGNUP', data: { phone_number_id: '1', waba_id: '2' } } });
    await launchEmbeddedSignup('c');
    expect(listeners).toHaveLength(0);
  });

  it('without the SDK loaded it refuses cleanly instead of throwing a ReferenceError', async () => {
    await expect(launchEmbeddedSignup('c')).rejects.toThrow(/still loading/i);
  });

  it('ensureFbSdk refuses without an App ID rather than injecting a broken script', async () => {
    await expect(ensureFbSdk('')).rejects.toThrow(/Meta App ID/);
  });
});
