import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook } from './fake-channels.testkit';

const KEY = 'pubkeyWA';

const waChannel = (over: any = {}) => makeChannel({
  id: 11, provider: 'whatsapp_inbound', public_key: KEY,
  secrets: { verify_token: 'VTOK' }, config: { auto_create: false }, ...over,
});

describe('WhatsApp inbound → lead', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('GET verify: right token echoes challenge; wrong token 403', async () => {
    const { hooks } = makeWebhook([waChannel()]);
    const out = await hooks.whatsappVerify(KEY, { 'hub.mode': 'subscribe', 'hub.verify_token': 'VTOK', 'hub.challenge': 'ECHO42' }, {});
    expect(out.body).toBe('ECHO42');
    await expect(hooks.whatsappVerify(KEY, { 'hub.mode': 'subscribe', 'hub.verify_token': 'NOPE', 'hub.challenge': 'x' }, {}))
      .rejects.toMatchObject({ http: 403 });
  });

  it('logs an inbound message on the matching lead (by last-10 digits)', async () => {
    const { hooks, st, cst } = makeWebhook([waChannel()], {
      leads: [{ id: 501, org_id: 1, branch_id: 2, phone: '+919812345678', full_name: 'Neha' }],
    });
    const body = { entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '919812345678', profile: { name: 'Neha' } }],
      messages: [{ from: '919812345678', id: 'wamid.1', type: 'text', text: { body: 'Course fees?' } }],
    } }] }] };
    const out = await hooks.whatsappReceive(KEY, body, {});
    expect(out.body).toMatchObject({ received: true, messages: 1, logged: 1, created: 0 });
    const act = st.activities.find((a: any) => Number(a.lead_id) === 501);
    expect(act.type).toBe('message');
    expect(act.note).toContain('[WhatsApp] Course fees?');
    expect(cst.events.at(-1)).toMatchObject({ status: 'ingested', lead_id: 501 });
  });

  it('unknown number, auto_create OFF: logged only, no lead', async () => {
    const { hooks, st } = makeWebhook([waChannel()]);
    const body = { entry: [{ changes: [{ value: { messages: [{ from: '918888888888', id: 'w2', type: 'text', text: { body: 'hi' } }] } }] }] };
    const out = await hooks.whatsappReceive(KEY, body, {});
    expect(out.body).toMatchObject({ messages: 1, logged: 0, created: 0 });
    expect(st.leads).toHaveLength(0);
  });

  it('unknown number, auto_create ON: creates a lead AND logs the first message on it', async () => {
    const { hooks, st } = makeWebhook([waChannel({ config: { auto_create: true } })]);
    const body = { entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '917777777777', profile: { name: 'Ravi' } }],
      messages: [{ from: '917777777777', id: 'w3', type: 'text', text: { body: 'Interested in German' } }],
    } }] }] };
    const out = await hooks.whatsappReceive(KEY, body, {});
    expect(out.body).toMatchObject({ messages: 1, created: 1, logged: 1 });
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0].full_name).toBe('Ravi');
    expect(st.activities.some((a: any) => a.note.includes('[WhatsApp] Interested in German'))).toBe(true);
  });

  it('status/delivery callback (no messages) is acknowledged, nothing created', async () => {
    const { hooks, st } = makeWebhook([waChannel()]);
    const out = await hooks.whatsappReceive(KEY, { entry: [{ changes: [{ value: { statuses: [{ id: 's', status: 'read' }] } }] }] }, {});
    expect(out.body).toMatchObject({ received: true, messages: 0 });
    expect(st.leads).toHaveLength(0);
  });
});

describe('Facebook Page OAuth connect', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => {
    delete process.env.SECRETS_KEY; delete process.env.FB_APP_ID; delete process.env.FB_APP_SECRET;
    resetSecretKeyCache();
  });

  const metaCh = () => makeChannel({ id: 21, provider: 'meta', public_key: 'pubkeyM',
    secrets: { verify_token: 'v', app_secret: 'as' }, config: { page_id: '' } });

  it('fbConnectUrl is 400-ish (no url) when FB_APP_ID unset, and a valid URL when set', () => {
    const { hooks } = makeWebhook([metaCh()]);
    expect(hooks.fbConnectUrl(21, 'https://x/cb').url).toBeNull();
    process.env.FB_APP_ID = 'APP123';
    const out = hooks.fbConnectUrl(21, 'https://x/cb');
    expect(out.url).toContain('client_id=APP123');
    expect(out.url).toContain('state=');
  });

  it('callback with a bad/expired state shows an error page, stores nothing', async () => {
    process.env.FB_APP_ID = 'APP123'; process.env.FB_APP_SECRET = 'SEC';
    const { hooks, cst } = makeWebhook([metaCh()]);
    const out = await hooks.fbCallback({ code: 'c', state: 'garbage' }, 'https://x/cb');
    expect(String(out.body)).toContain('invalid or has expired');
    expect((cst.channels[0].secrets as any).page_access_token).toBeUndefined();
  });

  it('full round-trip: signed state → token → /me/accounts → stores Page token + subscribes leadgen', async () => {
    process.env.FB_APP_ID = 'APP123'; process.env.FB_APP_SECRET = 'SEC';
    const { hooks, cst } = makeWebhook([metaCh()]);
    // stub the Graph API
    const calls: string[] = [];
    hooks.http = (async (url: string) => {
      calls.push(url);
      if (url.includes('/oauth/access_token')) return { ok: true, text: async () => JSON.stringify({ access_token: 'USERTOK' }) } as any;
      if (url.includes('/me/accounts')) return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'PAGE1', name: 'My School', access_token: 'PAGETOK' }] }) } as any;
      if (url.includes('subscribed_apps')) return { ok: true, text: async () => JSON.stringify({ success: true }) } as any;
      return { ok: false, text: async () => 'unexpected' } as any;
    }) as any;

    const state = hooks.fbConnectUrl(21, 'https://x/cb').url!.match(/state=([^&]+)/)![1];
    const out = await hooks.fbCallback({ code: 'THECODE', state: decodeURIComponent(state) }, 'https://x/cb');
    expect(String(out.body)).toContain('Connected Page "My School"');
    // the Page token + id are now stored on the channel
    const { decryptSecret } = require('../../common/crypto.util');
    expect(decryptSecret((cst.channels[0].secrets as any).page_access_token)).toBe('PAGETOK');
    expect((cst.channels[0].config as any).page_id).toBe('PAGE1');
    expect(calls.some((u) => u.includes('subscribed_fields=leadgen'))).toBe(true);
    expect(cst.events.at(-1)).toMatchObject({ status: 'verified' });
  });
});

describe('Marketplace pull (TradeIndia / IndiaMART)', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('TradeIndia: not-configured is a clean skip (no crash), and reschedules', async () => {
    const ch = makeChannel({ id: 31, provider: 'tradeindia_pull', public_key: 'ti', config: { poll_minutes: 60 }, secrets: {} });
    const { hooks, cst } = makeWebhook([ch]);
    const r = await hooks.pollMarketplace(ch);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/Not configured/);
    expect(cst.events.at(-1)).toMatchObject({ status: 'skipped' });
  });

  it('TradeIndia: fetches, adapts rows, dedups by QUERY_ID and imports', async () => {
    const ch = makeChannel({ id: 32, provider: 'tradeindia_pull', public_key: 'ti2',
      config: { poll_minutes: 60, lookback_days: 7 },
      secrets: { userid: 'U', profile_id: 'P', api_key: 'K' } });
    const { hooks, st } = makeWebhook([ch]);
    hooks.http = (async (url: string) => {
      expect(url).toContain('my_inquiry.html');
      return { ok: true, text: async () => JSON.stringify({ RESPONSE: [
        { GLUSR_USR_FNAME: 'Sam', GLUSR_USR_PHONE: '9000000001', QUERY_ID: 'TI-1', PRODUCT: 'Spanish' },
        { GLUSR_USR_FNAME: 'Meera', GLUSR_USR_PHONE: '9000000002', QUERY_ID: 'TI-2' },
      ] }) } as any;
    }) as any;
    const r = await hooks.pollMarketplace(ch);
    expect(r.status).toBe('ingested');
    expect(r.created).toBe(2);
    expect(st.leads).toHaveLength(2);
    // a second poll of the SAME two QUERY_IDs must not double-import (ingest ledger)
    const r2 = await hooks.pollMarketplace(ch);
    expect(r2.created).toBe(0);
    expect(st.leads).toHaveLength(2);
  });

  it('IndiaMART: CODE!=200 is a skip; a 200 RESPONSE[] imports', async () => {
    const ch = makeChannel({ id: 33, provider: 'indiamart_pull', public_key: 'im',
      config: { poll_minutes: 60 }, secrets: { crm_key: 'CRMKEY' } });
    const { hooks, st } = makeWebhook([ch]);
    hooks.http = (async () => ({ ok: true, text: async () => JSON.stringify({ CODE: 429, MESSAGE: 'throttled' }) })) as any;
    const skip = await hooks.pollMarketplace(ch);
    expect(skip.status).toBe('skipped');

    hooks.http = (async () => ({ ok: true, text: async () => JSON.stringify({ CODE: 200, RESPONSE: [
      { SENDER_NAME: 'Asha', SENDER_MOBILE: '9811100011', UNIQUE_QUERY_ID: 'IM-9', QUERY_MESSAGE: 'IELTS' },
    ] }) })) as any;
    const ok = await hooks.pollMarketplace(ch);
    expect(ok.status).toBe('ingested');
    expect(ok.created).toBe(1);
    expect(st.leads.at(-1).full_name).toBe('Asha');
  });
});
