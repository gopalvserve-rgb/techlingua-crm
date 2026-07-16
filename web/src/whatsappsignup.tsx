/**
 * WHATSAPP EMBEDDED SIGNUP — the browser half.
 *
 * Ported from the tenant-SaaS (`public/tenant/app.js` → `startEmbeddedSignup` +
 * `ensureFbSdkLoaded`), which is this project's design reference. The hard-won details
 * are carried over deliberately — each one is a bug the SaaS already paid for:
 *
 *   · The SDK is PRELOADED when the card renders. If you load it inside the click
 *     handler, `FB.login` runs after the user gesture has expired and Chrome blocks the
 *     popup: the toast fires and no window ever opens.
 *   · `FB.login` is called SYNCHRONOUSLY inside the click handler for the same reason.
 *   · Meta sends the phone_number_id / waba_id on a `postMessage`, NOT in the login
 *     callback — so we listen for `WA_EMBEDDED_SIGNUP` while the dialog is open, and
 *     accept all THREE payload shapes Meta has shipped over the years.
 *   · The FB SDK rejects an async function as a callback ("Expression is of type
 *     asyncfunction, not function") — hence a plain function wrapping an async IIFE.
 *   · If no message ever arrives from facebook.com, the cause is almost always the
 *     redirect URI not being whitelisted. We say so, because "nothing happened" is the
 *     single most expensive thing this screen could tell the client.
 *
 * What we do NOT port: the SaaS's coexistence/`featureType` variants and its
 * multi-number "add another" branch. Single-tenant, one WhatsApp number, one WABA.
 */

declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void }
}

export interface SignupPayload { code: string; phone_number_id: string; waba_id: string }

let sdkLoading: Promise<void> | null = null;

/** Loads + inits the Facebook JS SDK once. v21.0 is the minimum for Embedded Signup. */
export function ensureFbSdk(appId: string): Promise<void> {
  if (window.FB && typeof window.FB.login === 'function') return Promise.resolve();
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<void>((resolve, reject) => {
    if (!appId) { reject(new Error('Set the Meta App ID first (Settings › Channels › WhatsApp).')); return; }
    window.fbAsyncInit = () => {
      try {
        window.FB.init({ appId, cookie: true, xfbml: false, version: 'v21.0', autoLogAppEvents: true });
        resolve();
      } catch (e) { reject(e as Error); }
    };
    if (document.getElementById('facebook-jssdk')) return;   // already in flight
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Could not load the Facebook SDK — check your connection or an ad-blocker.'));
    document.body.appendChild(s);
  });
  return sdkLoading;
}

/** Test seam: the unit tests reset the module-level SDK promise between cases. */
export const __resetSdk = () => { sdkLoading = null; };

/**
 * Opens Meta's dialog and resolves with what the server needs. Rejects with a message
 * that is safe to show the client verbatim.
 */
export function launchEmbeddedSignup(configId: string): Promise<SignupPayload> {
  return new Promise((resolve, reject) => {
    if (!window.FB || typeof window.FB.login !== 'function') {
      reject(new Error('The Facebook SDK is still loading — press Connect WhatsApp again in a moment.'));
      return;
    }

    let phoneNumberId = '';
    let wabaId = '';
    let heardFromMeta = false;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com') return;
      heardFromMeta = true;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        // Meta has shipped at least three shapes for this payload. Accept all of them.
        const inner = data.data ?? data.session_info ?? {};
        const pid = inner.phone_number_id ?? inner.phone_id ?? data.phone_number_id ?? '';
        const wid = inner.waba_id ?? inner.business_id ?? inner.business_account_id ?? data.waba_id ?? '';
        if (pid) phoneNumberId = String(pid);
        if (wid) wabaId = String(wid);
      } catch { /* not our message */ }
    };
    window.addEventListener('message', onMessage);

    // NOT an async function: the FB SDK refuses one as a callback.
    window.FB.login((response: any) => {
      window.removeEventListener('message', onMessage);
      const code = response?.authResponse?.code;
      if (!code) {
        reject(new Error(heardFromMeta
          ? 'Login was cancelled before it finished.'
          : `Facebook closed the popup without returning anything. This almost always means "${location.origin}/" is not listed under Valid OAuth Redirect URIs in your Meta app (Facebook Login for Business › Settings). Add it, save, and try again.`));
        return;
      }
      resolve({ code, phone_number_id: phoneNumberId, waba_id: wabaId });
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: '2' },
    });
  });
}
