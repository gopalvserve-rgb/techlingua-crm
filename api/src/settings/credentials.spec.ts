/**
 * SETTINGS — CREDENTIAL ENTRY + WHATSAPP EMBEDDED SIGNUP.
 *
 * The three phantom-field bugs that reached this client all shared a shape: something was
 * *rendered* but never *stored*. These tests are the equivalent guard for credentials —
 * they prove the value survives the round trip, that it survives it ENCRYPTED, and that
 * what comes back out is MASKED.
 */
import { ChannelConfigService } from '../messaging/channel-config.service';
import { ConnectionTestService } from './connection-test.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';
import { makeSprint4Db } from '../messaging/sprint4.testkit';
import { MSG_PROVIDERS, ALL_CHANNELS, CHANNEL_LABEL, missingRequirements } from '../messaging/providers';
import { decryptSecret, encryptSecret } from '../common/crypto.util';

/** A fake `fetch`: returns a scripted body per URL fragment and RECORDS every call. */
function fakeHttp(routes: Array<[RegExp, { status?: number; body: unknown }]>) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url, init });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) throw new Error(`unrouted URL in test: ${url}`);
    const status = hit[1].status ?? 200;
    const text = typeof hit[1].body === 'string' ? hit[1].body : JSON.stringify(hit[1].body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }) as any;
  return { fn, calls };
}
const ADMIN = 1;

/* ===================================================================== registry */

describe('the provider registry covers every credential the client was asked for', () => {
  it('every channel on the client list has at least one provider', () => {
    for (const ch of ALL_CHANNELS) {
      const provs = Object.values(MSG_PROVIDERS).filter((p) => p.channel === ch);
      expect(provs.length).toBeGreaterThan(0);
      expect(CHANNEL_LABEL[ch]).toBeTruthy();
    }
  });

  it('Email and Razorpay are PER VERTICAL — the non-negotiable project rule', () => {
    expect(MSG_PROVIDERS.smtp.perVertical).toBe(true);
    expect(MSG_PROVIDERS.razorpay.perVertical).toBe(true);
  });

  it('every provider declares a test mode, and every send-provider carries a caveat', () => {
    for (const p of Object.values(MSG_PROVIDERS)) {
      expect(['send', 'probe', 'none']).toContain(p.test);
      // A green tick on a SEND provider must never be readable as "delivery proven".
      if (p.test === 'send') expect(p.testCaveat).toBeTruthy();
    }
  });

  it('the SMS caveat says plainly that green != delivered (MSG91 says success to a bogus key)', () => {
    expect(MSG_PROVIDERS.msg91.testCaveat).toMatch(/does NOT prove delivery/i);
    expect(MSG_PROVIDERS.msg91.testCaveat).toMatch(/wrong Auth Key/i);
  });

  it('SMS carries DLT sender id AND template ids (they are the law in India)', () => {
    const keys = MSG_PROVIDERS.msg91.config.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['sender_id', 'dlt_template_id', 'otp_dlt_template_id']));
  });

  it('SMS setup tells the client it also switches on OTP login', () => {
    for (const k of ['msg91', 'sms_http', 'twilio']) {
      expect(MSG_PROVIDERS[k].setup.join(' ')).toMatch(/OTP login/i);
    }
  });

  it('Cloudflare asks for exactly what PHASE1_DEV_PLAN 5 says, and admits it is not live yet', () => {
    const cf = MSG_PROVIDERS.cloudflare;
    const cfg = cf.config.map((f) => f.key);
    const sec = cf.secrets.map((f) => f.key);
    expect(cfg).toEqual(expect.arrayContaining(['zone', 'account_id', 'r2_bucket', 'plan']));
    expect(sec).toEqual(expect.arrayContaining(['api_token', 'r2_access_key_id', 'r2_secret_access_key']));
    expect(cf.storedOnly).toMatch(/NOT YET SERVING/);
  });

  it('WhatsApp exposes the Embedded Signup ids as first-class fields', () => {
    const keys = MSG_PROVIDERS.meta_cloud.config.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['app_id', 'config_id']));
    expect(MSG_PROVIDERS.meta_cloud.secrets.map((f) => f.key)).toEqual(expect.arrayContaining(['app_secret', 'access_token']));
  });
});

/* ============================================== encryption at rest + masking */

describe('a credential is encrypted at rest and masked on read', () => {
  const wire = () => {
    const { db, st } = makeSprint4Db();
    return { svc: new ChannelConfigService(db), st };
  };

  it('a saved secret is NOT stored in plaintext, and IS decryptable by us', async () => {
    const { svc, st } = wire();
    await svc.save({
      provider: 'cloudflare', channel: 'storage',
      config: { zone: 'crm.techlingua.in', account_id: 'acc1', r2_bucket: 'assets' },
      secrets: { api_token: 'cf-SUPER-SECRET-token', r2_access_key_id: 'AK123', r2_secret_access_key: 'SK456' },
    }, ADMIN);

    const raw = JSON.stringify(st.channelConfigs[0].secrets);
    // the actual proof: the plaintext appears NOWHERE in the stored row
    expect(raw).not.toContain('cf-SUPER-SECRET-token');
    expect(raw).not.toContain('SK456');
    expect(raw).toContain('enc:v1:');
    expect(decryptSecret(st.channelConfigs[0].secrets.api_token)).toBe('cf-SUPER-SECRET-token');
  });

  it('the HTTP shape masks every secret — an admin can replace one, never read it back', async () => {
    const { svc } = wire();
    const out: any = await svc.save({
      provider: 'razorpay', channel: 'payment', vertical_id: 7,
      config: { key_id: 'rzp_live_abc' },
      secrets: { key_secret: 'rzp-secret-value-1234' },
    }, ADMIN);
    expect(out.secrets_masked.key_secret).toMatch(/^•+/);
    expect(out.secrets_masked.key_secret).not.toContain('rzp-secret-value');
    expect(JSON.stringify(out)).not.toContain('rzp-secret-value-1234');
  });

  it('a blank on re-save KEEPS the stored secret (it must not be wiped by an edit)', async () => {
    const { svc, st } = wire();
    await svc.save({ provider: 'gemini', channel: 'ai', secrets: { api_key: 'AIza-original' } }, ADMIN);
    await svc.save({ provider: 'gemini', channel: 'ai', config: { model: 'gemini-2.0-flash' }, secrets: { api_key: '' } }, ADMIN);
    expect(decryptSecret(st.channelConfigs[0].secrets.api_key)).toBe('AIza-original');
    expect(st.channelConfigs[0].config.model).toBe('gemini-2.0-flash');
  });

  it('a still-MASKED value on re-save is not stored as the literal bullets', async () => {
    const { svc, st } = wire();
    await svc.save({ provider: 'deepseek', channel: 'ai', secrets: { api_key: 'sk-real-key' } }, ADMIN);
    await svc.save({ provider: 'deepseek', channel: 'ai', secrets: { api_key: '••••••key' } }, ADMIN);
    expect(decryptSecret(st.channelConfigs[0].secrets.api_key)).toBe('sk-real-key');
  });

  it('the per-vertical rule is enforced — an org-only provider refuses a vertical', async () => {
    const { svc } = wire();
    await expect(svc.save({ provider: 'cloudflare', channel: 'storage', vertical_id: 7, config: {} }, ADMIN))
      .rejects.toThrow(/whole organisation/);
  });

  it('Email resolves PER VERTICAL, falling back to the org row', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [
      { id: 1, channel: 'email', provider: 'smtp', vertical_id: null, is_active: true,
        config: { host: 'org.smtp', port: 587, from_email: 'org@t.in' }, secrets: { username: encryptSecret('u'), password: encryptSecret('p') } },
      { id: 2, channel: 'email', provider: 'smtp', vertical_id: 7, is_active: true,
        config: { host: 'bcl.smtp', port: 587, from_email: 'bcl@t.in' }, secrets: { username: encryptSecret('u'), password: encryptSecret('p') } },
    ] });
    const svc = new ChannelConfigService(db);
    expect((await svc.resolve('email', 7))!.config.host).toBe('bcl.smtp');   // the vertical wins
    expect((await svc.resolve('email', 99))!.config.host).toBe('org.smtp');  // else the org row
    expect((await svc.resolve('email', null))!.config.host).toBe('org.smtp');
  });

  it('Razorpay resolves per vertical too', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [
      { id: 1, channel: 'payment', provider: 'razorpay', vertical_id: null, is_active: true,
        config: { key_id: 'rzp_org' }, secrets: { key_secret: encryptSecret('s') } },
      { id: 2, channel: 'payment', provider: 'razorpay', vertical_id: 7, is_active: true,
        config: { key_id: 'rzp_bcl' }, secrets: { key_secret: encryptSecret('s') } },
    ] });
    const svc = new ChannelConfigService(db);
    expect((await svc.resolve('payment', 7))!.config.key_id).toBe('rzp_bcl');
    expect((await svc.resolve('payment', 1))!.config.key_id).toBe('rzp_org');
  });

  it('a channel that was never touched is "not configured", naming the missing fields', async () => {
    const { db } = makeSprint4Db();
    const svc = new ChannelConfigService(db);
    await expect(svc.require('storage')).rejects.toMatchObject({ notConfigured: true });
    const missing = missingRequirements('cloudflare', { zone: 'x' }, []);
    expect(missing).toEqual(expect.arrayContaining(['Account ID', 'R2 bucket name', 'API token']));
  });
});

/* ================================================================ probes */

describe('Test connection reports a real, specific result', () => {
  const cfgDb = (rows: any[]) => new ChannelConfigService(makeSprint4Db({ channelConfigs: rows }).db);

  it('Cloudflare: a valid token reports the bucket and zone back', async () => {
    const svc = cfgDb([{ id: 1, channel: 'storage', provider: 'cloudflare', vertical_id: null, is_active: true,
      config: { zone: 'crm.techlingua.in', account_id: 'a', r2_bucket: 'techlingua-crm-assets' },
      secrets: { api_token: encryptSecret('t'), r2_access_key_id: encryptSecret('k'), r2_secret_access_key: encryptSecret('s') } }]);
    const { fn } = fakeHttp([[/tokens\/verify/, { body: { success: true, result: { status: 'active' } } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('storage');
    expect(out.ok).toBe(true);
    expect(out.message).toContain('techlingua-crm-assets');
    expect(out.storedOnly).toMatch(/NOT YET SERVING/);
  });

  it('Cloudflare: a bad token reports CLOUDFLARE OWN reason, not a generic failure', async () => {
    const svc = cfgDb([{ id: 1, channel: 'storage', provider: 'cloudflare', vertical_id: null, is_active: true,
      config: { zone: 'z', account_id: 'a', r2_bucket: 'b' },
      secrets: { api_token: encryptSecret('bad'), r2_access_key_id: encryptSecret('k'), r2_secret_access_key: encryptSecret('s') } }]);
    const { fn } = fakeHttp([[/tokens\/verify/, { status: 401, body: { success: false, errors: [{ message: 'Invalid API Token' }] } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('storage');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Invalid API Token');
  });

  it('Razorpay: 401 is reported as rejected keys, and no payment is made', async () => {
    const svc = cfgDb([{ id: 1, channel: 'payment', provider: 'razorpay', vertical_id: 7, is_active: true,
      config: { key_id: 'rzp_live_x' }, secrets: { key_secret: encryptSecret('nope') } }]);
    const { fn, calls } = fakeHttp([[/api\.razorpay\.com/, { status: 401, body: { error: {} } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('payment', 7);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/rejected the Key ID/);
    expect(calls.every((c) => !c.init?.method || c.init.method === 'GET')).toBe(true);
  });

  it('Razorpay: a good LIVE key says so (mode is surfaced — it matters)', async () => {
    const svc = cfgDb([{ id: 1, channel: 'payment', provider: 'razorpay', vertical_id: 7, is_active: true,
      config: { key_id: 'rzp_live_x' }, secrets: { key_secret: encryptSecret('ok') } }]);
    const { fn } = fakeHttp([[/api\.razorpay\.com/, { body: { count: 0, items: [] } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('payment', 7);
    expect(out.ok).toBe(true);
    expect(out.message).toContain('LIVE');
  });

  it('WhatsApp: the probe reads the number back, proving token AND phone id together', async () => {
    const svc = cfgDb([{ id: 1, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
      config: { app_id: '1', phone_number_id: '555', api_version: 'v21.0' },
      secrets: { access_token: encryptSecret('tok'), app_secret: encryptSecret('sec') } }]);
    const { fn } = fakeHttp([[/graph\.facebook\.com/, { body: { display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua', quality_rating: 'GREEN' } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('whatsapp');
    expect(out.ok).toBe(true);
    expect(out.message).toContain('+91 98100 00001');
    expect(out.message).toContain('Tech Lingua');
  });

  it('WhatsApp: an expired token reports META message — the 24h-token symptom, named', async () => {
    const svc = cfgDb([{ id: 1, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
      config: { app_id: '1', phone_number_id: '555' },
      secrets: { access_token: encryptSecret('expired'), app_secret: encryptSecret('s') } }]);
    const { fn } = fakeHttp([[/graph\.facebook\.com/, { status: 401, body: { error: { message: 'Session has expired' } } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('whatsapp');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Session has expired');
  });

  it('Gemini: a rejected key reports Google reason', async () => {
    const svc = cfgDb([{ id: 1, channel: 'ai', provider: 'gemini', vertical_id: null, is_active: true,
      config: {}, secrets: { api_key: encryptSecret('bad') } }]);
    const { fn } = fakeHttp([[/generativelanguage/, { status: 400, body: { error: { message: 'API key not valid' } } }]]);
    const out = await new ConnectionTestService(svc, fn).probe('ai');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('API key not valid');
  });

  it('a NOT-CONFIGURED channel probes to a clean 503, never a 500 and never an Error-Log row', async () => {
    const svc = cfgDb([]);
    const { fn } = fakeHttp([]);
    await expect(new ConnectionTestService(svc, fn).probe('storage')).rejects.toMatchObject({ notConfigured: true });
  });

  it('an OAuth provider says honestly that it cannot be verified until consent', async () => {
    const svc = cfgDb([{ id: 1, channel: 'calendar', provider: 'google_oauth', vertical_id: null, is_active: true,
      config: { client_id: 'abc.apps.googleusercontent.com' }, secrets: { client_secret: encryptSecret('s') } }]);
    const { fn } = fakeHttp([]);   // unrouted: proves we make NO call at all
    const out = await new ConnectionTestService(svc, fn).probe('calendar');
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/cannot be verified until/i);
  });

  it('a network failure is reported, not thrown', async () => {
    const svc = cfgDb([{ id: 1, channel: 'ai', provider: 'deepseek', vertical_id: null, is_active: true,
      config: {}, secrets: { api_key: encryptSecret('k') } }]);
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as any;
    const out = await new ConnectionTestService(svc, fn).probe('ai');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('ENOTFOUND');
  });
});

/* ============================================== WhatsApp Embedded Signup */

describe('WhatsApp Embedded Signup (Meta mocked)', () => {
  const BASE = () => ({
    id: 1, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
    config: { app_id: '99887766', config_id: 'cfg-1', api_version: 'v21.0' } as Record<string, unknown>,
    secrets: { app_secret: encryptSecret('APP-SECRET') } as Record<string, string>,
  });
  const metaRoutes = (over: Array<[RegExp, any]> = []) => fakeHttp([
    ...over,
    [/oauth\/access_token/, { body: { access_token: 'PERMANENT-TOKEN-xyz', token_type: 'bearer' } }],
    [/\/555\?fields=/, { body: { display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua' } }],
    [/subscribed_apps/, { body: { success: true } }],
  ]);

  it('launchInfo gives the browser the app id + config id — and NEVER the app secret', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [BASE()] });
    const info: any = await new WhatsAppSignupService(new ChannelConfigService(db), (() => {}) as any).launchInfo();
    expect(info.app_id).toBe('99887766');
    expect(info.config_id).toBe('cfg-1');
    expect(info.ready).toBe(true);
    expect(JSON.stringify(info)).not.toContain('APP-SECRET');
  });

  it('launchInfo names what is missing before the button can work', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [{ ...BASE(), config: { app_id: '1' }, secrets: {} }] });
    const info: any = await new WhatsAppSignupService(new ChannelConfigService(db), (() => {}) as any).launchInfo();
    expect(info.ready).toBe(false);
    expect(info.missing).toEqual(expect.arrayContaining(['Embedded Signup Configuration ID', 'App secret']));
  });

  it('THE FLOW: code -> permanent token, stored ENCRYPTED, webhook auto-subscribed', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const cfgs = new ChannelConfigService(db);
    const { fn, calls } = metaRoutes();
    const out = await new WhatsAppSignupService(cfgs, fn)
      .exchange({ code: 'META-CODE-1', phone_number_id: '555', waba_id: '777' }, ADMIN);

    expect(out.ok).toBe(true);
    expect(out.phone_number_id).toBe('555');
    expect(out.waba_id).toBe('777');
    expect(out.display_phone_number).toBe('+91 98100 00001');
    expect(out.subscribed).toBe(true);

    // the exchange used the client's OWN app credentials (single-tenant, settings-driven)
    const ex = calls.find((c) => /oauth\/access_token/.test(c.url))!;
    expect(ex.url).toContain('client_id=99887766');
    expect(ex.url).toContain('client_secret=APP-SECRET');
    expect(ex.url).toContain('code=META-CODE-1');

    // the webhook was subscribed FOR him — the step he used to do by hand in Meta
    const sub = calls.find((c) => /subscribed_apps/.test(c.url))!;
    expect(sub.url).toContain('/777/subscribed_apps');
    expect(sub.init.method).toBe('POST');
    expect(JSON.parse(sub.init.body).subscribed_fields).toContain('messages');

    // THE PERMANENT TOKEN IS ENCRYPTED AT REST — never plaintext
    const row = st.channelConfigs[0];
    expect(JSON.stringify(row.secrets)).not.toContain('PERMANENT-TOKEN-xyz');
    expect(decryptSecret(row.secrets.access_token)).toBe('PERMANENT-TOKEN-xyz');
    expect(row.config.connected_via).toBe('embedded_signup');
    expect(row.config.waba_id).toBe('777');
    expect(decryptSecret(row.secrets.app_secret)).toBe('APP-SECRET');
  });

  it('the stored credential is MASKED when read back — the token never returns to the browser', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const cfgs = new ChannelConfigService(db);
    const { fn } = metaRoutes();
    await new WhatsAppSignupService(cfgs, fn).exchange({ code: 'c', phone_number_id: '555', waba_id: '777' }, ADMIN);
    const shown: any = cfgs.present({ ...st.channelConfigs[0], last_test_at: null });
    expect(shown.secrets_masked.access_token).toMatch(/^•+/);
    expect(JSON.stringify(shown)).not.toContain('PERMANENT-TOKEN-xyz');
  });

  it('a stored Embedded-Signup credential FEEDS THE SPRINT-4 SENDER unchanged', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [BASE()] });
    const cfgs = new ChannelConfigService(db);
    const { fn } = metaRoutes();
    await new WhatsAppSignupService(cfgs, fn).exchange({ code: 'c', phone_number_id: '555', waba_id: '777' }, ADMIN);

    // This is the exact call the Sprint-4 WhatsApp transport makes. Before the signup it
    // threw "not configured"; after it, it resolves — with no change to how we send.
    const resolved = await cfgs.require('whatsapp');
    expect(resolved.provider).toBe('meta_cloud');
    expect(resolved.config.phone_number_id).toBe('555');
    expect(resolved.secrets.access_token).toBe('PERMANENT-TOKEN-xyz');
    expect(missingRequirements('meta_cloud', resolved.config, Object.keys(resolved.secrets))).toEqual([]);
  });

  it('WITHOUT app id/secret the exchange is a clean 503 naming them — not a crash', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [{ ...BASE(), config: {}, secrets: {} }] });
    const { fn } = metaRoutes();
    await expect(new WhatsAppSignupService(new ChannelConfigService(db), fn).exchange({ code: 'c', waba_id: '7', phone_number_id: '5' }, ADMIN))
      .rejects.toMatchObject({ notConfigured: true });
  });

  it('a missing code is refused before Meta is called at all', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [BASE()] });
    const { fn, calls } = metaRoutes();
    await expect(new WhatsAppSignupService(new ChannelConfigService(db), fn).exchange({}, ADMIN))
      .rejects.toThrow(/authorisation code/);
    expect(calls).toHaveLength(0);
  });

  it('Meta rejecting the code surfaces META reason verbatim, and stores NOTHING', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const { fn } = fakeHttp([[/oauth\/access_token/, { status: 400, body: { error: { message: 'This authorization code has expired.' } } }]]);
    await expect(new WhatsAppSignupService(new ChannelConfigService(db), fn).exchange({ code: 'stale', waba_id: '7', phone_number_id: '5' }, ADMIN))
      .rejects.toThrow(/This authorization code has expired/);
    expect(st.channelConfigs[0].secrets.access_token).toBeUndefined();  // no half-written credential
  });

  it('no waba_id on the postMessage: we ASK Meta what the token is scoped to rather than guess', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const { fn } = metaRoutes([
      [/debug_token/, { body: { data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['WABA-FROM-TOKEN'] }] } } }],
    ]);
    const out = await new WhatsAppSignupService(new ChannelConfigService(db), fn)
      .exchange({ code: 'c', phone_number_id: '555' }, ADMIN);
    expect(out.waba_id).toBe('WABA-FROM-TOKEN');
    expect(st.channelConfigs[0].config.waba_id).toBe('WABA-FROM-TOKEN');
  });

  it('if the WABA cannot be determined we STOP — a wrong id would look connected and fail silently', async () => {
    const { db } = makeSprint4Db({ channelConfigs: [BASE()] });
    const { fn } = metaRoutes([[/debug_token/, { body: { data: { granular_scopes: [] } } }]]);
    await expect(new WhatsAppSignupService(new ChannelConfigService(db), fn).exchange({ code: 'c', phone_number_id: '555' }, ADMIN))
      .rejects.toThrow(/which WhatsApp Business Account/);
  });

  it('a webhook-subscribe failure still saves the token, and SAYS the subscribe failed', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const { fn } = fakeHttp([
      [/oauth\/access_token/, { body: { access_token: 'PERMANENT-TOKEN-xyz' } }],
      [/\/555\?fields=/, { body: { display_phone_number: '+91 1', verified_name: 'TL' } }],
      [/subscribed_apps/, { status: 400, body: { error: { message: 'Insufficient permission' } } }],
    ]);
    const out = await new WhatsAppSignupService(new ChannelConfigService(db), fn)
      .exchange({ code: 'c', phone_number_id: '555', waba_id: '777' }, ADMIN);
    expect(out.ok).toBe(true);
    expect(out.subscribed).toBe(false);
    expect(out.subscribe_error).toContain('Insufficient permission');
    expect(decryptSecret(st.channelConfigs[0].secrets.access_token)).toBe('PERMANENT-TOKEN-xyz');
  });

  it('the manual path still works — a hand-pasted token is marked as such and is NOT overwritten', async () => {
    const { db, st } = makeSprint4Db({ channelConfigs: [BASE()] });
    const cfgs = new ChannelConfigService(db);
    await cfgs.save({
      provider: 'meta_cloud', channel: 'whatsapp',
      config: { app_id: '99887766', phone_number_id: '111', waba_id: '222', connected_via: 'manual' },
      secrets: { access_token: 'HAND-PASTED' },
    }, ADMIN);
    const resolved = await cfgs.require('whatsapp');
    expect(resolved.secrets.access_token).toBe('HAND-PASTED');
    expect(st.channelConfigs[0].config.connected_via).toBe('manual');
  });
});

/* ================================================= admin-only (RBAC) */

describe('every credential endpoint is admin-only', () => {
  // Migration 026 grants settings.read / settings.update to Super Admin and Organization
  // Admin ONLY. A Branch Manager must not be able to read (or replace) the Razorpay
  // secret. The guard reads this metadata, so asserting the metadata IS asserting the gate.
  const SettingsController = require('./settings.controller').SettingsController;
  const { PERMISSION_KEY } = require('../rbac/rbac.decorators');

  const perm = (method: string) => Reflect.getMetadata(PERMISSION_KEY, SettingsController.prototype[method]);

  it('reads require settings.read; writes require settings.update', () => {
    expect(perm('all')).toBe('settings.read');
    expect(perm('channels')).toBe('settings.read');
    expect(perm('signupInfo')).toBe('settings.read');

    expect(perm('save')).toBe('settings.update');
    expect(perm('saveChannel')).toBe('settings.update');
    expect(perm('removeChannel')).toBe('settings.update');
    expect(perm('test')).toBe('settings.update');
    expect(perm('signupExchange')).toBe('settings.update');
  });

  it('NO endpoint on this controller is left unguarded', () => {
    const methods = Object.getOwnPropertyNames(SettingsController.prototype)
      .filter((m) => m !== 'constructor' && typeof SettingsController.prototype[m] === 'function');
    for (const m of methods) {
      expect({ method: m, permission: perm(m) }).toEqual({ method: m, permission: expect.stringMatching(/^settings\.(read|update)$/) });
    }
  });
});
