/**
 * Facebook Page Monitor + Form Mapping — service + ingestion behaviour.
 *
 * Same test double as meta-webhook.spec: the real ChannelService / WebhookService /
 * FbPagesService run against the in-memory DB, and every Graph call goes through the
 * `hooks.http` seam. Nothing here touches the network.
 */
import { BadRequestException } from '@nestjs/common';
import { decryptSecret, resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook, metaSign } from './fake-channels.testkit';
import { FB_SCOPES } from './source-adapters';
import {
  META_CRM_FIELDS, cleanFormFieldMap, mappedCount, overlayFieldMap, parseFbForms, storedPages,
  suggestFieldMap, webhookPageId,
} from './fb-pages.util';

const APP_SECRET = 'meta-app-secret-abc';
const KEY = 'pubkeyMETA';

/** A Graph API stub: every request is recorded; the handler decides the answer. */
function graphStub(handler: (url: string, init?: any) => any) {
  const calls: Array<{ url: string; method: string }> = [];
  const http = async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const out = handler(url, init);
    if (out instanceof Error) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: out.message } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(out ?? {}) };
  };
  return { http: http as any, calls };
}

/** A channel that has been through the multi-Page OAuth callback: 2 Pages, P1 monitored. */
const multiPage = (over: any = {}) => makeChannel({
  id: 1, provider: 'meta', public_key: KEY,
  secrets: { verify_token: 'v', app_secret: APP_SECRET, page_access_token: 'TOK1', page_token_P1: 'TOK1', page_token_P2: 'TOK2' },
  config: {
    graph_version: 'v21.0', page_id: 'P1', page_name: 'School A',
    pages: [
      { page_id: 'P1', page_name: 'School A', monitored: true, subscribed: true },
      { page_id: 'P2', page_name: 'School B', monitored: false, subscribed: null },
    ],
  },
  ...over,
});

const delivery = (pageId: string, leadgenId: string, formId = 'F1', fields?: any[]) => ({
  object: 'page',
  entry: [{ id: pageId, time: 1, changes: [{ field: 'leadgen', value: {
    leadgen_id: leadgenId, page_id: pageId, form_id: formId, created_time: 1,
    field_data: fields ?? [
      { name: 'full_name', values: ['Asha Verma'] },
      { name: 'phone_number', values: ['+919811100031'] },
      { name: 'which_course', values: ['IELTS'] },
    ],
  } }] }],
});

async function send(hooks: any, body: any) {
  const { raw, signature } = metaSign(APP_SECRET, body);
  return hooks.metaReceive(KEY, body, { rawBody: raw, signature });
}

describe('Facebook Page Monitor — pure helpers', () => {
  it('storedPages tolerates junk and de-duplicates', () => {
    expect(storedPages({ pages: 'nope' })).toEqual([]);
    const p = storedPages({ pages: [{ page_id: 1, page_name: 'A', monitored: 'yes' }, { page_id: '1' }, { nope: 1 }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ page_id: '1', monitored: false, subscribed: null });
  });

  it('webhookPageId prefers value.page_id, falls back to entry.id', () => {
    expect(webhookPageId('E', { page_id: 'V' })).toBe('V');
    expect(webhookPageId('E', {})).toBe('E');
  });

  it('crm_fields are derived from the channel mapper: no external_id, first/last present, whatsapp_phone accepted', () => {
    const keys = META_CRM_FIELDS.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['full_name', '_first', '_last', 'phone', 'alt_phone', 'whatsapp_phone', 'email', 'city', 'state', 'course', 'qualification', 'budget', 'note', 'tags']));
    expect(keys).not.toContain('external_id');
  });

  it('suggestFieldMap: aliases, then Meta question type, then the label', () => {
    const qs = [
      { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
      { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
      { key: 'q_123', label: 'Your City', type: 'CUSTOM' },
      { key: 'q_999', label: 'Favourite colour', type: 'CUSTOM' },
    ];
    expect(suggestFieldMap(qs)).toEqual({ full_name: 'full_name', phone_number: 'phone', q_123: 'city' });
  });

  it('cleanFormFieldMap: blank = ignore sentinel, unknown targets reported', () => {
    const { map, unknown } = cleanFormFieldMap({ a: 'phone', b: '', c: 'nonsense' }, new Set(['phone']));
    expect(map).toEqual({ a: 'phone', b: '_ignore' });
    expect(unknown).toEqual(['nonsense']);
  });

  it('overlayFieldMap: the form map wins even on a format-insensitive collision', () => {
    const eff = overlayFieldMap({ 'Which Course': 'note', city: 'state' }, { which_course: 'course' });
    expect(eff).toEqual({ city: 'state', which_course: 'course' });
  });

  it('mappedCount reflects what ingestion will actually resolve (aliases + channel + form)', () => {
    const qs = [{ key: 'full_name', label: 'x', type: 'FULL_NAME' }, { key: 'q1', label: 'x', type: 'CUSTOM' }, { key: 'q2', label: 'x', type: 'CUSTOM' }];
    expect(mappedCount(qs, {})).toBe(1);                                    // alias only
    expect(mappedCount(qs, { q1: 'course' }, { q2: 'note' })).toBe(3);
    expect(mappedCount(qs, { full_name: '_ignore' }, { q2: 'note' })).toBe(1);
  });

  it('parseFbForms normalises questions to {key,label,type}', () => {
    const forms = parseFbForms({ data: [{ id: 'F1', name: 'Enquiry', status: 'ACTIVE', locale: 'en_GB',
      questions: [{ key: 'full_name', label: 'Full name', type: 'FULL_NAME' }, { key: 'q1', label: 'Course?', type: 'CUSTOM' }] }] });
    expect(forms[0]).toMatchObject({ form_id: 'F1', form_name: 'Enquiry', status: 'ACTIVE' });
    expect(forms[0].questions).toEqual([
      { key: 'full_name', label: 'Full name', type: 'FULL_NAME' }, { key: 'q1', label: 'Course?', type: 'CUSTOM' },
    ]);
  });
});

describe('Facebook OAuth callback — keeps EVERY granted Page', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; process.env.FB_APP_ID = 'APP123'; process.env.FB_APP_SECRET = 'SEC'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; delete process.env.FB_APP_ID; delete process.env.FB_APP_SECRET; resetSecretKeyCache(); });

  const graph = () => graphStub((url) => {
    if (url.includes('/oauth/access_token')) return { access_token: 'USERTOK' };
    if (url.includes('/me/accounts')) return { data: [
      { id: 'P1', name: 'School A', access_token: 'TOK1' },
      { id: 'P2', name: 'School B', access_token: 'TOK2' },
      { id: 'P3', name: 'School C', access_token: 'TOK3' },
    ] };
    if (url.includes('subscribed_apps')) return { success: true };
    return new Error('unexpected ' + url);
  });

  async function connect(hooks: any) {
    const state = (await hooks.fbConnectUrl(21, 'https://x/cb')).url!.match(/state=([^&]+)/)![1];
    return hooks.fbCallback({ code: 'THECODE', state: decodeURIComponent(state) }, 'https://x/cb');
  }

  it('first connect: all 3 Pages stored with their own encrypted token; legacy fields = the first Page; only it is monitored + subscribed', async () => {
    const ch = makeChannel({ id: 21, provider: 'meta', public_key: 'pubkeyM', secrets: { verify_token: 'v', app_secret: 'as' }, config: {} });
    const { hooks, cst } = makeWebhook([ch]);
    const g = graph(); hooks.http = g.http;

    const out = await connect(hooks);
    expect(String(out.body)).toContain('Connected Page "School A"');
    expect(String(out.body)).toContain('2 more Page(s)');

    const row = cst.channels[0];
    // tokens: encrypted at rest, one per Page, legacy key still written
    expect(decryptSecret(row.secrets.page_access_token)).toBe('TOK1');
    expect(decryptSecret(row.secrets.page_token_P1)).toBe('TOK1');
    expect(decryptSecret(row.secrets.page_token_P2)).toBe('TOK2');
    expect(decryptSecret(row.secrets.page_token_P3)).toBe('TOK3');
    expect(row.secrets.page_token_P2.startsWith('enc:v1:')).toBe(true);
    // legacy fields
    expect(row.config.page_id).toBe('P1');
    expect(row.config.page_name).toBe('School A');
    // the list
    expect(row.config.pages.map((p: any) => [p.page_id, p.monitored])).toEqual([['P1', true], ['P2', false], ['P3', false]]);
    expect(row.config.pages[0].subscribed).toBe(true);
    expect(JSON.stringify(row.config)).not.toContain('TOK');           // never a token in config
    // exactly ONE subscribe call — the primary
    expect(g.calls.filter((c) => c.url.includes('subscribed_fields=leadgen'))).toHaveLength(1);
    expect(g.calls.find((c) => c.url.includes('subscribed_fields=leadgen'))!.url).toContain('/P1/');
    expect(cst.events.at(-1)).toMatchObject({ status: 'verified' });
    expect(JSON.stringify(cst.events.at(-1).raw)).not.toContain('TOK');
  });

  it('a channel bound to a page_id picks THAT Page as primary (same as before)', async () => {
    const ch = makeChannel({ id: 21, provider: 'meta', public_key: 'pubkeyM', secrets: { verify_token: 'v', app_secret: 'as' }, config: { page_id: 'P2' } });
    const { hooks, cst } = makeWebhook([ch]);
    hooks.http = graph().http;
    await connect(hooks);
    const row = cst.channels[0];
    expect(row.config.page_id).toBe('P2');
    expect(decryptSecret(row.secrets.page_access_token)).toBe('TOK2');
    expect(row.config.pages.find((p: any) => p.page_id === 'P2').monitored).toBe(true);
    expect(row.config.pages.find((p: any) => p.page_id === 'P1').monitored).toBe(false);
  });

  it('re-authorising keeps each Page\'s monitored flag and refreshes the tokens', async () => {
    const ch = multiPage({ id: 21, public_key: 'pubkeyM' });
    ch.config.pages[1].monitored = true;                     // admin switched P2 on earlier
    const { hooks, cst } = makeWebhook([ch]);
    hooks.http = graphStub((url) => {
      if (url.includes('/oauth/access_token')) return { access_token: 'USERTOK' };
      if (url.includes('/me/accounts')) return { data: [{ id: 'P1', name: 'School A', access_token: 'NEW1' }, { id: 'P2', name: 'School B2', access_token: 'NEW2' }] };
      if (url.includes('subscribed_apps')) return { success: true };
      return new Error('unexpected');
    }).http;
    await connect(hooks);
    const row = cst.channels[0];
    expect(decryptSecret(row.secrets.page_token_P2)).toBe('NEW2');
    expect(row.config.pages.find((p: any) => p.page_id === 'P2')).toMatchObject({ monitored: true, page_name: 'School B2' });
  });
});

describe('"Continue with Facebook" popup — the SDK code is EXCHANGED, not discarded', () => {
  // DEF-INT-04 opened the Facebook popup, received `authResponse.code` and then only showed
  // a toast: the code was thrown away, nothing was stored, and the admin saw the popup close
  // with no Pages anywhere. These tests pin the code down to the same storage path the
  // redirect flow uses.
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; process.env.FB_APP_ID = 'APP123'; process.env.FB_APP_SECRET = 'SEC'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; delete process.env.FB_APP_ID; delete process.env.FB_APP_SECRET; resetSecretKeyCache(); });

  const graph = () => graphStub((url) => {
    if (url.includes('/oauth/access_token')) return { access_token: 'USERTOK' };
    if (url.includes('/me/accounts')) return { data: [
      { id: 'P1', name: 'School A', access_token: 'TOK1' },
      { id: 'P2', name: 'School B', access_token: 'TOK2' },
    ] };
    if (url.includes('subscribed_apps')) return { success: true };
    return new Error('unexpected ' + url);
  });

  it('stores EVERY granted Page, exactly like the redirect flow', async () => {
    const ch = makeChannel({ id: 31, provider: 'meta', public_key: 'pk', secrets: { verify_token: 'v', app_secret: 'as' }, config: {} });
    const { hooks, cst } = makeWebhook([ch]);
    hooks.http = graph().http;

    const out = await hooks.fbSdkConnect(31, 'SDKCODE');

    expect(out).toMatchObject({ pages: 2, primary: 'School A', subscribed: true, others: 1 });
    const cfg = cst.channels.find((c: any) => c.id === 31)!.config as any;
    expect(cfg.pages.map((p: any) => p.page_id)).toEqual(['P1', 'P2']);
    expect(cfg.pages.find((p: any) => p.page_id === 'P1').monitored).toBe(true);
    expect(cfg.pages.find((p: any) => p.page_id === 'P2').monitored).toBe(false);
    expect(cfg.page_id).toBe('P1');
  });

  it('exchanges the code with an EMPTY redirect_uri — omitting it is what Meta rejected in production', async () => {
    const ch = makeChannel({ id: 32, provider: 'meta', public_key: 'pk', secrets: { verify_token: 'v', app_secret: 'as' }, config: {} });
    const { hooks } = makeWebhook([ch]);
    const g = graph(); hooks.http = g.http;

    await hooks.fbSdkConnect(32, 'SDKCODE');

    const exchange = g.calls.find((c: any) => String(c.url).includes('/oauth/access_token'))!;
    expect(String(exchange.url)).toContain('code=SDKCODE');
    // present, and empty — Meta compares it against the redirect the JS SDK used
    expect(String(exchange.url)).toMatch(/[?&]redirect_uri=(&|$)/);
  });

  it('a code-100 refusal from Facebook is turned into an instruction the admin can act on', async () => {
    const ch = makeChannel({ id: 35, provider: 'meta', public_key: 'pk', secrets: { verify_token: 'v', app_secret: 'as' }, config: {} });
    const { hooks } = makeWebhook([ch]);
    hooks.http = graphStub(() => new Error(
      'Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request')).http;

    await expect(hooks.fbSdkConnect(35, 'SDKCODE')).rejects.toThrow(/Connect Page.*fb\/callback/s);
  });

  it('never stores a token in readable form and refuses a blank code / a non-Meta channel', async () => {
    const ch = makeChannel({ id: 33, provider: 'meta', public_key: 'pk', secrets: { verify_token: 'v', app_secret: 'as' }, config: {} });
    const other = makeChannel({ id: 34, provider: 'justdial', public_key: 'pk2', secrets: {}, config: {} });
    const { hooks, cst } = makeWebhook([ch, other]);
    hooks.http = graph().http;

    await expect(hooks.fbSdkConnect(33, '')).rejects.toThrow(/authorisation code/i);
    await expect(hooks.fbSdkConnect(34, 'SDKCODE')).rejects.toThrow(/not a Meta Lead Ads channel/i);

    await hooks.fbSdkConnect(33, 'SDKCODE');
    const row = cst.channels.find((c: any) => c.id === 33)!;
    expect(JSON.stringify(row.secrets)).not.toContain('TOK1');
    expect(JSON.stringify(row.config)).not.toContain('TOK1');
  });
});

describe('OAuth scopes — what Facebook actually needs', () => {
  it("asks for pages_manage_ads: without it Facebook refuses to LIST a Page's lead forms", () => {
    // Production hit "(#200) Requires pages_manage_ads permission to manage the object" the
    // first time anyone opened Form Mapping. leads_retrieval only covers reading the ANSWERS
    // of a lead we were notified about, which is why delivery worked and listing did not.
    expect(FB_SCOPES).toContain('pages_manage_ads');
    expect(FB_SCOPES).toContain('leads_retrieval');
    expect(FB_SCOPES).toContain('pages_show_list');
  });

  it('the connect endpoint hands the popup the SAME list, so the two cannot drift again', async () => {
    process.env.FB_APP_ID = 'APP123';
    const ch = makeChannel({ id: 41, provider: 'meta', public_key: 'pk', secrets: {}, config: {} });
    const { hooks } = makeWebhook([ch]);
    const out = await hooks.fbConnectUrl(41, 'https://x/cb');
    expect(out.scopes).toBe(FB_SCOPES.join(','));
    expect(decodeURIComponent(out.url!)).toContain(FB_SCOPES.join(','));
    delete process.env.FB_APP_ID;
  });
});

describe('Facebook Page Monitor — service', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; process.env.FB_APP_ID = 'APP123'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; delete process.env.FB_APP_ID; resetSecretKeyCache(); });

  it('listPages: every stored Page, no tokens, lead stats from the event log', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    await send(hooks, delivery('P1', 'LG-1'));
    await send(hooks, delivery('P1', 'LG-2', 'F1', [{ name: 'full_name', values: ['B'] }, { name: 'phone_number', values: ['+919811100032'] }]));
    await send(hooks, delivery('P2', 'LG-3'));                 // P2 not monitored -> skipped, not counted

    const out = await fb.listPages(1);
    expect(out.connected).toBe(true);
    expect(out.pages.map((p) => p.page_id)).toEqual(['P1', 'P2']);
    expect(out.pages[0]).toMatchObject({ monitored: true, is_primary: true, has_token: true, leads: 2 });
    expect(out.pages[0].last_lead_at).toBeTruthy();
    expect(out.pages[1]).toMatchObject({ monitored: false, is_primary: false, has_token: true, leads: 0 });
    expect(JSON.stringify(out)).not.toMatch(/TOK|access_token/);
    expect(cst.events.filter((e) => e.status === 'skipped')).toHaveLength(1);
  });

  it('listPages on a LEGACY channel (page_access_token + page_id only) shows that one Page as monitored', async () => {
    const ch = makeChannel({ id: 1, provider: 'meta', public_key: KEY,
      secrets: { verify_token: 'v', app_secret: APP_SECRET, page_access_token: 'OLD' }, config: { page_id: '1010', page_name: 'Old Page' } });
    const { fb } = makeWebhook([ch]);
    const out = await fb.listPages(1);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]).toMatchObject({ page_id: '1010', page_name: 'Old Page', monitored: true, has_token: true, is_primary: true, subscribed: null });
  });

  it('listPages with nothing connected is an empty, honest state', async () => {
    const ch = makeChannel({ id: 1, provider: 'meta', public_key: KEY, secrets: { verify_token: 'v', app_secret: APP_SECRET }, config: {} });
    const { fb } = makeWebhook([ch]);
    expect(await fb.listPages(1)).toEqual({ connected: false, pages: [] });
  });

  it('rejects a non-Meta channel', async () => {
    const ch = makeChannel({ id: 1, provider: 'google_ads', public_key: KEY, secrets: { google_key: 'g' } });
    const { fb } = makeWebhook([ch]);
    await expect(fb.listPages(1)).rejects.toMatchObject({ notConfigured: true });
  });

  it('subscribe: Graph POST with subscribed_fields=leadgen + that Page\'s OWN token; monitored on; event logged', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    const g = graphStub(() => ({ success: true })); hooks.http = g.http;

    const out = await fb.subscribe(1, 'P2');
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({ method: 'POST' });
    expect(g.calls[0].url).toContain('/P2/subscribed_apps?subscribed_fields=leadgen&access_token=TOK2');
    const p2 = out.pages.find((p) => p.page_id === 'P2')!;
    expect(p2).toMatchObject({ monitored: true, subscribed: true, last_error: null });
    expect(p2.subscribed_at).toBeTruthy();
    expect(cst.channels[0].config.pages[1].monitored).toBe(true);        // persisted
    expect(cst.events.at(-1)).toMatchObject({ status: 'verified', method: 'ADMIN' });
    expect(cst.events.at(-1).reason).toMatch(/School B.*now monitored/);
  });

  it('subscribe: a Graph refusal is a 400, monitored stays OFF, the error is stored on the Page', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => new Error('(#200) Requires pages_manage_metadata')).http;
    await expect(fb.subscribe(1, 'P2')).rejects.toBeInstanceOf(BadRequestException);
    const p2 = cst.channels[0].config.pages[1];
    expect(p2.monitored).toBe(false);
    expect(p2.last_error).toMatch(/pages_manage_metadata/);
    expect(cst.events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('subscribe on an unknown Page is a 404', async () => {
    const { fb } = makeWebhook([multiPage()]);
    await expect(fb.subscribe(1, 'P9')).rejects.toMatchObject({ status: 404 });
  });

  it('unsubscribe: Graph DELETE, monitored off, event logged', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    const g = graphStub(() => ({ success: true })); hooks.http = g.http;
    const out = await fb.unsubscribe(1, 'P1');
    expect(g.calls[0]).toMatchObject({ method: 'DELETE' });
    expect(g.calls[0].url).toContain('/P1/subscribed_apps?access_token=TOK1');
    expect(out.pages[0]).toMatchObject({ monitored: false, subscribed: false });
    expect(out.warning).toBeNull();
    expect(cst.events.at(-1).reason).toMatch(/no longer monitored/);
  });

  it('unsubscribe: our gate closes even when Facebook errors — with a warning', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => new Error('token expired')).http;
    const out = await fb.unsubscribe(1, 'P1');
    expect(out.pages[0].monitored).toBe(false);
    expect(out.warning).toMatch(/token expired/);
    expect(cst.channels[0].config.pages[0].monitored).toBe(false);
  });

  it('refresh: asks /subscribed_apps per Page with its own token, updates subscribed/last_error, never touches monitored', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    const g = graphStub((url) => {
      if (url.includes('/P1/')) return { data: [{ id: 'APP123', name: 'Our app', subscribed_fields: ['leadgen'] }] };
      return new Error('Error validating access token');
    });
    hooks.http = g.http;
    const out = await fb.refresh(1);
    expect(g.calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/P1/subscribed_apps?access_token=TOK1'),
      expect.stringContaining('/P2/subscribed_apps?access_token=TOK2'),
    ]);
    expect(out.pages[0]).toMatchObject({ subscribed: true, last_error: null, monitored: true });
    expect(out.pages[1]).toMatchObject({ subscribed: null, monitored: false });
    expect(out.pages[1].last_error).toMatch(/validating access token/);
    expect(out.pages[1].checked_at).toBeTruthy();
    expect(cst.channels[0].config.pages[0].subscribed).toBe(true);
  });

  it('refresh: a Page subscribed by a DIFFERENT app is "not subscribed" for us', async () => {
    const { hooks, fb } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => ({ data: [{ id: 'OTHERAPP', subscribed_fields: ['leadgen'] }] })).http;
    const out = await fb.refresh(1);
    expect(out.pages[0].subscribed).toBe(false);
  });

  it('disconnect: unsubscribes every MONITORED Page, wipes ALL page tokens + page config; mappings survive', async () => {
    const ch = multiPage();
    const { hooks, fb, cst } = makeWebhook([ch]);
    cst.formMappings.push({ id: 1, org_id: 1, channel_id: 1, page_id: 'P1', form_id: 'F1', form_name: 'Enquiry', is_enabled: true, field_map: { q1: 'course' }, questions: null });
    const g = graphStub(() => ({ success: true })); hooks.http = g.http;

    const out = await fb.disconnect(1);
    expect(out).toMatchObject({ disconnected: true, pages_removed: 2, unsubscribe_failures: [] });
    expect(g.calls).toHaveLength(1);                                    // only P1 was monitored
    expect(g.calls[0]).toMatchObject({ method: 'DELETE' });
    const row = cst.channels[0];
    expect(row.secrets.page_access_token).toBeUndefined();
    expect(row.secrets.page_token_P1).toBeUndefined();
    expect(row.secrets.page_token_P2).toBeUndefined();
    expect(row.secrets.app_secret).toBeDefined();                       // the app secret is NOT a Page token
    expect(row.config.pages).toBeUndefined();
    expect(row.config.page_id).toBeUndefined();
    expect(row.config.page_name).toBeUndefined();
    expect(row.config.graph_version).toBe('v21.0');
    expect(cst.formMappings).toHaveLength(1);
    expect(await fb.listPages(1)).toEqual({ connected: false, pages: [] });
    expect(cst.events.at(-1).reason).toMatch(/Facebook disconnected/);
  });
});

describe('Facebook Form Mapping — service', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  const FORMS = { data: [
    { id: 'F1', name: 'Enquiry', status: 'ACTIVE', locale: 'en_GB', questions: [
      { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
      { key: 'phone_number', label: 'Phone', type: 'PHONE' },
      { key: 'which_course', label: 'Which course?', type: 'CUSTOM' },
    ] },
    { id: 'F2', name: 'Old form', status: 'ARCHIVED', locale: 'en_GB', questions: [
      { key: 'email', label: 'Email', type: 'EMAIL' },
    ] },
  ] };

  it('forms: Graph leadgen_forms with the Page token, paginated, merged with saved state; questions cached', async () => {
    const { hooks, fb, cst } = makeWebhook([multiPage()]);
    cst.formMappings.push({ id: 1, org_id: 1, channel_id: 1, page_id: 'P1', form_id: 'F2', form_name: 'Old form', is_enabled: false, field_map: { email: 'email' }, questions: null });
    const g = graphStub((url) => {
      if (url.includes('after=abc')) return { data: [FORMS.data[1]] };
      if (url.includes('/P1/leadgen_forms')) return { data: [FORMS.data[0]], paging: { next: 'https://graph.facebook.com/v21.0/P1/leadgen_forms?after=abc&access_token=TOK1' } };
      return new Error('unexpected ' + url);
    });
    hooks.http = g.http;

    const out = await fb.forms(1, 'P1');
    expect(g.calls[0].url).toContain('/P1/leadgen_forms?fields=id,name,status,locale,questions&limit=100&access_token=TOK1');
    expect(g.calls).toHaveLength(2);
    expect(out.page_id).toBe('P1');
    expect(out.forms).toEqual([
      expect.objectContaining({ form_id: 'F1', form_name: 'Enquiry', status: 'ACTIVE', total_fields: 3, mapped_fields: 2, is_enabled: true, has_custom_mapping: false }),
      expect.objectContaining({ form_id: 'F2', status: 'ARCHIVED', total_fields: 1, mapped_fields: 1, is_enabled: false, has_custom_mapping: true }),
    ]);
    // cached questions for the editor
    const f1 = cst.formMappings.find((m) => m.form_id === 'F1');
    expect(f1.questions).toHaveLength(3);
    expect(f1.is_enabled).toBe(true);
    // the saved row was NOT clobbered by the cache upsert
    const f2 = cst.formMappings.find((m) => m.form_id === 'F2');
    expect(f2).toMatchObject({ is_enabled: false, field_map: { email: 'email' } });
    expect(f2.questions).toHaveLength(1);
  });

  it("a permission refusal from Facebook tells the admin to re-authorise, not to read Meta's wording", async () => {
    const { fb, hooks } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => new Error(
      '(#200) Requires pages_manage_ads permission to manage the object')).http;

    await expect(fb.forms(1, 'P1')).rejects.toThrow(/Connect Page.*approve Facebook again/s);
  });

  it('forms: an unmonitored Page still lists (mapping can be prepared before switching on); unknown Page 404s', async () => {
    const { hooks, fb } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => ({ data: [] })).http;
    expect((await fb.forms(1, 'P2')).forms).toEqual([]);
    await expect(fb.forms(1, 'P9')).rejects.toMatchObject({ status: 404 });
  });

  it('getMapping: cached questions, crm_fields (built-in + custom), auto-map suggestion, nothing saved yet', async () => {
    const { hooks, fb } = makeWebhook([multiPage()]);
    hooks.http = graphStub(() => FORMS).http;
    await fb.forms(1, 'P1');
    const m = await fb.getMapping(1, 'F1');
    expect(m.form).toMatchObject({ form_id: 'F1', form_name: 'Enquiry', page_id: 'P1' });
    expect(m.questions.map((q) => q.key)).toEqual(['full_name', 'phone_number', 'which_course']);
    expect(m.saved).toBe(false);
    expect(m.is_enabled).toBe(true);
    expect(m.field_map).toEqual({});
    expect(m.suggested).toEqual({ full_name: 'full_name', phone_number: 'phone', which_course: 'course' });
    expect(m.crm_fields).toEqual(expect.arrayContaining([
      { key: 'full_name', label: 'Full name' }, { key: 'phone', label: 'Phone' }, { key: 'cf:batch', label: 'Batch (custom)' },
    ]));
  });

  it('getMapping on a never-listed form reads the form node with the hinted Page token', async () => {
    const { hooks, fb } = makeWebhook([multiPage()]);
    const g = graphStub(() => ({ id: 'F7', name: 'Deep link', questions: [{ key: 'email', label: 'Email', type: 'EMAIL' }] })); hooks.http = g.http;
    const m = await fb.getMapping(1, 'F7', 'P2');
    expect(g.calls[0].url).toContain('/F7?fields=id,name,status,locale,questions&access_token=TOK2');
    expect(m.form.form_name).toBe('Deep link');
    expect(m.questions).toEqual([{ key: 'email', label: 'Email', type: 'EMAIL' }]);
  });

  it('saveMapping: validates targets, stores ignore as a sentinel, returns the editor payload, logs an event', async () => {
    const { fb, cst, hooks } = makeWebhook([multiPage()]);
    // saveMapping refreshes the form's cached questions. WITHOUT this stub the service falls
    // through to the real graph.facebook.com — the suite was making live network calls (the
    // failure is swallowed as a warning, so it passed while quietly going online).
    hooks.http = graphStub(() => ({ id: 'F1', name: 'Enquiry', questions: [] })).http;
    await expect(fb.saveMapping(1, 'F1', { field_map: { which_course: 'colour_of_car' } }, 7))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Unknown CRM field.*colour_of_car/) });
    expect(cst.formMappings).toHaveLength(0);

    const out = await fb.saveMapping(1, 'F1', {
      field_map: { which_course: 'course', full_name: '', phone_number: 'phone', extra: 'cf:batch' },
      is_enabled: false, page_id: 'P1', form_name: 'Enquiry',
    }, 7);
    const row = cst.formMappings[0];
    expect(row).toMatchObject({ channel_id: 1, form_id: 'F1', page_id: 'P1', form_name: 'Enquiry', is_enabled: false, updated_by: 7 });
    expect(row.field_map).toEqual({ which_course: 'course', full_name: '_ignore', phone_number: 'phone', extra: 'cf:batch' });
    expect(out.saved).toBe(true);
    expect(out.is_enabled).toBe(false);
    expect(out.field_map).toEqual({ which_course: 'course', full_name: '', phone_number: 'phone', extra: 'cf:batch' });
    expect(cst.events.at(-1).reason).toMatch(/Form mapping saved.*3 field\(s\) mapped, DISABLED/);

    // toggling enabled alone keeps the map
    await fb.saveMapping(1, 'F1', { is_enabled: true }, 7);
    expect(cst.formMappings[0]).toMatchObject({ is_enabled: true, field_map: { which_course: 'course', full_name: '_ignore' } });
  });
});

describe('Meta ingestion with Page Monitor + Form Mapping', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('LEGACY channel (page_access_token only, no pages list, no mapping): ingests exactly as before', async () => {
    const ch = makeChannel({ id: 1, provider: 'meta', public_key: KEY,
      secrets: { verify_token: 'v', app_secret: APP_SECRET, page_access_token: 'LEGACY' }, config: { graph_version: 'v21.0', field_map: '{"which_course":"course"}' } });
    const { hooks, st, cst } = makeWebhook([ch]);
    const calls: string[] = [];
    hooks.http = (async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ field_data: [
      { name: 'full_name', values: ['Legacy Lead'] }, { name: 'phone_number', values: ['9811100040'] }, { name: 'which_course', values: ['IELTS'] },
    ] }) }; }) as any;
    const body = { object: 'page', entry: [{ id: '1010', changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-L', page_id: '1010', form_id: 'F1' } }] }] };
    const out = await send(hooks, body);
    expect(out.http).toBe(200);
    expect(calls[0]).toContain('access_token=LEGACY');
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({ full_name: 'Legacy Lead', course_id: 21 });
    expect(cst.events[0]).toMatchObject({ status: 'ingested', external_key: 'LG-L' });
  });

  it('picks the token of the Page the delivery is for (P2 -> TOK2), falling back to entry.id when value.page_id is absent', async () => {
    const ch = multiPage(); ch.config.pages[1].monitored = true;
    const { hooks, st } = makeWebhook([ch]);
    const calls: string[] = [];
    hooks.http = (async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify({ field_data: [
      { name: 'full_name', values: ['From P2'] }, { name: 'phone_number', values: ['9811100041'] },
    ] }) }; }) as any;
    const body = { object: 'page', entry: [{ id: 'P2', changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-P2', form_id: 'F1' } }] }] };
    await send(hooks, body);
    expect(calls[0]).toContain('access_token=TOK2');
    expect(st.leads[0].full_name).toBe('From P2');
  });

  it('a delivery for a stored but UNMONITORED Page is skipped with a clear reason, no lead, no Graph call', async () => {
    const { hooks, st, cst } = makeWebhook([multiPage()]);
    const calls: string[] = [];
    hooks.http = (async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => '{}' }; }) as any;
    const out = await send(hooks, delivery('P2', 'LG-U'));
    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped' });
    expect(cst.events[0].reason).toMatch(/Page "School B" \(P2\) is not monitored/);
  });

  it('a monitored non-primary Page is accepted even though config.page_id binds the primary', async () => {
    const ch = multiPage(); ch.config.pages[1].monitored = true;
    const { hooks, st } = makeWebhook([ch]);
    await send(hooks, delivery('P2', 'LG-OK'));
    expect(st.leads).toHaveLength(1);
  });

  it('an UNKNOWN Page still hits the legacy page_id binding (unchanged behaviour)', async () => {
    const { hooks, st, cst } = makeWebhook([multiPage()]);
    await send(hooks, delivery('P9', 'LG-X'));
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'failed' });
    expect(cst.events[0].reason).toMatch(/bound to Page P1/);
  });

  it('a form DISABLED in mapping is skipped with reason "form disabled in mapping"', async () => {
    const { hooks, st, cst } = makeWebhook([multiPage()]);
    cst.formMappings.push({ id: 1, org_id: 1, channel_id: 1, page_id: 'P1', form_id: 'F1', form_name: 'Enquiry', is_enabled: false, field_map: {}, questions: null });
    await send(hooks, delivery('P1', 'LG-D', 'F1'));
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped' });
    expect(cst.events[0].reason).toMatch(/form "Enquiry" \(F1\) disabled in mapping/);
    // another form on the same Page is unaffected
    await send(hooks, delivery('P1', 'LG-E', 'F2'));
    expect(st.leads).toHaveLength(1);
  });

  it('form-level field_map overlays the channel-level one — form wins, ignore drops an aliased field', async () => {
    const ch = multiPage();
    ch.config.field_map = '{"which_course":"note","extra_q":"city"}';
    const { hooks, st, cst } = makeWebhook([ch]);
    cst.formMappings.push({ id: 1, org_id: 1, channel_id: 1, page_id: 'P1', form_id: 'F1', form_name: 'Enquiry', is_enabled: true,
      field_map: { which_course: 'course', email: '_ignore' }, questions: null });
    await send(hooks, delivery('P1', 'LG-M', 'F1', [
      { name: 'full_name', values: ['Mapped Lead'] },
      { name: 'phone_number', values: ['9811100050'] },
      { name: 'email', values: ['drop@me.com'] },
      { name: 'which_course', values: ['IELTS'] },
      { name: 'extra_q', values: ['Delhi'] },
    ]));
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0].course_id).toBe(21);                 // form map: which_course -> course (channel said note)
    expect(st.leads[0].email).toBeFalsy();                  // explicit ignore beats the built-in alias
    expect(st.leads[0].note ?? null).toBeNull();            // channel's `note` mapping for that key was replaced
    expect(st.leads[0].city_id).toBe(71);                   // channel-level entries for OTHER keys still apply
  });

  it('a form with a saved-but-empty mapping (only cached from listing) behaves exactly like no mapping', async () => {
    const ch = multiPage(); ch.config.field_map = '{"which_course":"course"}';
    const { hooks, st, cst } = makeWebhook([ch]);
    cst.formMappings.push({ id: 1, org_id: 1, channel_id: 1, page_id: 'P1', form_id: 'F1', form_name: 'Enquiry', is_enabled: true, field_map: {}, questions: [] });
    await send(hooks, delivery('P1', 'LG-N', 'F1'));
    expect(st.leads[0]).toMatchObject({ full_name: 'Asha Verma', course_id: 21 });
  });
});
