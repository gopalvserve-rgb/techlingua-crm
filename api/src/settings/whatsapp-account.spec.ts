/**
 * ENGAGEMENT › WHATSAPP ACCOUNT — numbers table, Set default, Register, Verify, Disconnect
 * and webhook health. Meta is mocked through the injected HttpFn: no test here may touch
 * a network, and `fakeHttp` throws on any URL a test did not script.
 */
import 'reflect-metadata';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { ConnectionTestService } from './connection-test.service';
import { WhatsAppAccountService, numbersOf } from './whatsapp-account.service';
import { WhatsAppAccountController } from './whatsapp-account.controller';
import { MessagingService } from '../messaging/messaging.service';
import { WhatsAppWebhookController } from '../messaging/messaging.controller';
import { makeSprint4Db } from '../messaging/sprint4.testkit';
import { MSG_PROVIDERS } from '../messaging/providers';
import { decryptSecret, encryptSecret } from '../common/crypto.util';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';

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
const noHttp = (async (url: string) => { throw new Error(`NETWORK TOUCHED: ${url}`); }) as any;
const ADMIN = 7;

const ROW = (config: Record<string, unknown> = {}) => ({
  id: 1, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
  config: {
    app_id: '99887766', config_id: 'cfg-1', api_version: 'v21.0',
    waba_id: '777', phone_number_id: '555', display_phone_number: '+91 98100 00001',
    verified_name: 'Tech Lingua', connected_via: 'embedded_signup', ...config,
  } as Record<string, unknown>,
  secrets: {
    access_token: encryptSecret('PERMANENT-TOKEN-xyz'),
    app_secret: encryptSecret('APP-SECRET'),
    verify_token: encryptSecret('verify-me-123'),
  } as Record<string, string>,
});

const TWO_NUMBERS = [
  { phone_number_id: '555', display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua', waba_id: '777', status: 'CONNECTED', label: 'Sales line', is_default: true },
  { phone_number_id: '556', display_phone_number: '+91 98100 00002', verified_name: 'Tech Lingua Support', waba_id: '777', status: 'CONNECTED', label: 'Support', is_default: false },
];

/**
 * The Sprint-4 DB fake, plus the three things it does not model: `list()`, the soft
 * delete behind `remove()` (and therefore "a deleted row is not the existing row"), and
 * the webhook-health read.
 */
function makeDb(rows: any[], health: { last?: Date | null; count?: number; throws?: boolean } = {}) {
  const { db: inner, st } = makeSprint4Db({ channelConfigs: rows });
  const live = () => (st.channelConfigs as any[]).filter((c) => !c.deleted_at);
  const route = async (sql: string, params: unknown[] = []): Promise<any[] | undefined> => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM wa_webhook_event/.test(s)) {
      if (health.throws) throw new Error('relation "wa_webhook_event" does not exist');
      return [{ last_inbound_at: health.last ?? null, events_24h: String(health.count ?? 0) }];
    }
    if (/FROM channel_config c LEFT JOIN vertical v/.test(s) && /WHERE c\.deleted_at IS NULL/.test(s)) {
      return live().filter((c) => !params[0] || c.channel === params[0]).map((c) => ({ ...c, vertical_name: null }));
    }
    if (/^SELECT id FROM channel_config WHERE id = \$1 AND deleted_at IS NULL/.test(s)) {
      return live().filter((c) => c.id === Number(params[0]));
    }
    if (/^UPDATE channel_config SET deleted_at = now\(\)/.test(s)) {
      const row = (st.channelConfigs as any[]).find((c) => c.id === Number(params[0]));
      if (row) { row.deleted_at = new Date(); row.deleted_by = params[1]; row.is_active = false; }
      return [];
    }
    if (/^SELECT \* FROM channel_config WHERE org_id = \$1 AND channel = \$2/.test(s)) {
      return live().filter((c) => c.channel === params[1] && (c.vertical_id ?? null) === (params[2] ?? null));
    }
    return undefined;
  };
  const db: any = {
    query: async (sql: string, p: unknown[] = []) => (await route(sql, p)) ?? (inner as any).query(sql, p),
    one: async (sql: string, p: unknown[] = []) => {
      const r = await route(sql, p);
      return r ? (r[0] ?? null) : (inner as any).one(sql, p);
    },
  };
  return { db, st: st as any };
}

function make(rows: any[], http: any = noHttp, health: Parameters<typeof makeDb>[1] = {}) {
  const { db, st } = makeDb(rows, health);
  const cfgs = new ChannelConfigService(db);
  const svc = new WhatsAppAccountService(db, cfgs, new ConnectionTestService(cfgs, http), http);
  return { svc, cfgs, st, db };
}

/* ================================================================ the payload */

describe('GET settings/whatsapp/account — the whole screen, with NO Graph call', () => {
  it('renders the stored numbers, the account card and webhook health without touching Meta', async () => {
    const last = new Date(Date.now() - 2 * 60 * 1000);
    const { svc } = make([ROW({ numbers: TWO_NUMBERS })], noHttp, { last, count: 702 });
    const out = await svc.account();

    expect(out.connected).toBe(true);
    expect(out.accounts).toEqual([{
      config_id: 1, vertical_id: null, vertical_name: null, waba_id: '777', phone_number_id: '555',
      display_phone_number: '+91 98100 00001', verify_token: 'verify-me-123', is_active: true,
    }]);
    expect(out.numbers.map((n) => [n.phone_number_id, n.label, n.is_default, n.config_id])).toEqual([
      ['555', 'Sales line', true, 1], ['556', 'Support', false, 1],
    ]);
    expect(Object.keys(out.numbers[0]).sort()).toEqual([
      'code_verification_status', 'config_id', 'display_phone_number', 'is_default', 'label', 'name_status',
      'phone_number_id', 'quality_rating', 'status', 'verified_name', 'waba_id',
    ]);
    expect(out.webhook).toEqual({
      callback_path: '/api/webhooks/whatsapp', last_inbound_at: last.toISOString(), events_24h: 702, healthy: true,
    });
  });

  it('the ONLY secret on the wire is the verify token — never the access token or app secret', async () => {
    const { svc } = make([ROW({ numbers: TWO_NUMBERS })]);
    const wire = JSON.stringify(await svc.account());
    expect(wire).toContain('verify-me-123');
    expect(wire).not.toContain('PERMANENT-TOKEN-xyz');
    expect(wire).not.toContain('APP-SECRET');
    expect(wire).not.toContain('enc:v1');
  });

  it('a connection that was never synced still shows its one number, as the default', async () => {
    const { svc } = make([ROW()]);
    const out = await svc.account();
    expect(out.numbers).toHaveLength(1);
    expect(out.numbers[0]).toMatchObject({ phone_number_id: '555', display_phone_number: '+91 98100 00001', is_default: true, status: '' });
  });

  it('only the Meta app saved (no WABA, no number) is NOT a connection', async () => {
    const row = ROW(); row.config = { app_id: '1', config_id: 'c' }; delete (row.secrets as any).access_token;
    const out = await make([row]).svc.account();
    expect(out).toMatchObject({ connected: false, accounts: [], numbers: [] });
  });

  it('nothing stored at all -> a clean not-connected payload', async () => {
    const out = await make([]).svc.account();
    expect(out).toMatchObject({ connected: false, accounts: [], numbers: [], webhook: { last_inbound_at: null, events_24h: 0, healthy: false } });
  });

  it('no events yet / migration 119 not applied -> "nothing received", never a 500', async () => {
    expect((await make([ROW()], noHttp, { last: null, count: 0 }).svc.account()).webhook.healthy).toBe(false);
    const out = await make([ROW()], noHttp, { throws: true }).svc.account();
    expect(out.webhook).toMatchObject({ last_inbound_at: null, events_24h: 0, healthy: false });
  });

  it('an event from weeks ago is reported, but the webhook is not called healthy', async () => {
    const last = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    const out = await make([ROW()], noHttp, { last, count: 0 }).svc.account();
    expect(out.webhook.last_inbound_at).toBe(last.toISOString());
    expect(out.webhook.healthy).toBe(false);
  });
});

/* ======================================================================= sync */

describe('POST …/sync — re-pull from Meta', () => {
  const META = {
    data: [
      { id: '555', display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', status: 'CONNECTED', name_status: 'APPROVED' },
      { id: '556', display_phone_number: '+91 98100 00002', verified_name: 'TL Support', quality_rating: 'YELLOW', code_verification_status: 'NOT_VERIFIED', status: 'PENDING', name_status: 'APPROVED' },
      { id: '557', display_phone_number: '+91 98100 00003', verified_name: 'TL Accounts', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', status: 'CONNECTED', name_status: 'APPROVED' },
    ],
  };

  it('calls /{waba}/phone_numbers with the documented fields and the stored token', async () => {
    const { fn, calls } = fakeHttp([[/phone_numbers/, { body: META }]]);
    await make([ROW()], fn).svc.sync(1, ADMIN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('https://graph.facebook.com/v21.0/777/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,status,name_status');
    expect(calls[0].init.headers.Authorization).toBe('Bearer PERMANENT-TOKEN-xyz');
  });

  it('MERGE: labels and the default survive; Meta fields are refreshed; new numbers arrive unlabelled', async () => {
    // the admin made 556 the default and labelled both
    const stored = [
      { ...TWO_NUMBERS[0], is_default: false },
      { ...TWO_NUMBERS[1], is_default: true, status: 'OLD' },
    ];
    const { fn } = fakeHttp([[/phone_numbers/, { body: META }]]);
    const { svc, st } = make([ROW({ numbers: stored, phone_number_id: '556', display_phone_number: '+91 98100 00002' })], fn);
    const out = await svc.sync(1, ADMIN);

    expect(out.synced).toBe(3);
    expect(out.warning).toBeNull();
    const by = Object.fromEntries(out.numbers.map((n) => [n.phone_number_id, n]));
    expect(by['555']).toMatchObject({ label: 'Sales line', is_default: false, quality_rating: 'GREEN' });
    expect(by['556']).toMatchObject({ label: 'Support', is_default: true, status: 'PENDING', verified_name: 'TL Support' });
    expect(by['557']).toMatchObject({ label: '', is_default: false, status: 'CONNECTED' });
    expect(out.numbers[0].phone_number_id).toBe('556');               // default first

    // …and it is STORED, with the sender still pointing at 556
    expect(st.channelConfigs[0].config.phone_number_id).toBe('556');
    expect(st.channelConfigs[0].config.numbers).toHaveLength(3);
    expect(st.channelConfigs[0].config.app_id).toBe('99887766');       // nothing else was lost
    expect(decryptSecret(st.channelConfigs[0].secrets.access_token)).toBe('PERMANENT-TOKEN-xyz');
  });

  it('no default yet (Meta was still provisioning at signup) -> the first number becomes it', async () => {
    const row = ROW(); delete row.config.phone_number_id; delete row.config.display_phone_number;
    const { fn } = fakeHttp([[/phone_numbers/, { body: META }]]);
    const { svc, st } = make([row], fn);
    await svc.sync(1, ADMIN);
    expect(st.channelConfigs[0].config.phone_number_id).toBe('555');
    expect(st.channelConfigs[0].config.display_phone_number).toBe('+91 98100 00001');
  });

  it('a default Meta does NOT list is left alone and reported — sync never re-points sending', async () => {
    const { fn } = fakeHttp([[/phone_numbers/, { body: META }]]);
    const { svc, st } = make([ROW({ phone_number_id: '999' })], fn);
    const out = await svc.sync(1, ADMIN);
    expect(out.warning).toMatch(/999/);
    expect(st.channelConfigs[0].config.phone_number_id).toBe('999');
    expect(out.numbers.find((n) => n.is_default)?.phone_number_id).toBe('999');
  });

  it('Meta rejecting the call is a clean 400 carrying Meta\'s words, and stores nothing', async () => {
    const { fn } = fakeHttp([[/phone_numbers/, { status: 400, body: { error: { message: 'Error validating access token: session has expired' } } }]]);
    const { svc, st } = make([ROW({ numbers: TWO_NUMBERS })], fn);
    await expect(svc.sync(1, ADMIN)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Meta rejected the sync: Error validating access token/) });
    expect(st.channelConfigs[0].config.numbers).toEqual(TWO_NUMBERS);
  });

  it('a network failure is also a readable 400, not a crash', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND graph.facebook.com'); }) as any;
    await expect(make([ROW()], fn).svc.sync(1, ADMIN)).rejects.toThrow(/could not reach Meta.*ENOTFOUND/);
  });

  it('a stale config_id is refused before Meta is called', async () => {
    const { fn, calls } = fakeHttp([[/./, { body: {} }]]);
    await expect(make([ROW()], fn).svc.sync(42, ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
  });
});

/* ================================================================ set default */

describe('POST …/number — label + Set default', () => {
  it('SET DEFAULT re-points the fields the Sprint-4 sender actually reads', async () => {
    const { svc, cfgs, st } = make([ROW({ numbers: TWO_NUMBERS })]);
    const out = await svc.updateNumber({ config_id: 1, phone_number_id: '556', is_default: true }, ADMIN);

    expect(out.numbers.map((n) => [n.phone_number_id, n.is_default])).toEqual([['556', true], ['555', false]]);
    // MetaWhatsAppTransport posts to `cfg.config.phone_number_id` of configs.resolve('whatsapp')
    const resolved = await cfgs.require('whatsapp');
    expect(resolved.config.phone_number_id).toBe('556');
    expect(resolved.config.display_phone_number).toBe('+91 98100 00002');
    expect(resolved.config.verified_name).toBe('Tech Lingua Support');
    expect(resolved.secrets.access_token).toBe('PERMANENT-TOKEN-xyz');
    // the stored flags agree with it
    expect(st.channelConfigs[0].config.numbers.map((n: any) => [n.phone_number_id, n.is_default]))
      .toEqual([['555', false], ['556', true]]);
  });

  it('a label edit changes the label and nothing else', async () => {
    const { svc, st } = make([ROW({ numbers: TWO_NUMBERS })]);
    await svc.updateNumber({ config_id: 1, phone_number_id: '556', label: '  Admissions desk  ' }, ADMIN);
    const n = st.channelConfigs[0].config.numbers.find((x: any) => x.phone_number_id === '556');
    expect(n.label).toBe('Admissions desk');
    expect(st.channelConfigs[0].config.phone_number_id).toBe('555');
  });

  it('labelling a never-synced connection materialises config.numbers', async () => {
    const { svc, st } = make([ROW()]);
    await svc.updateNumber({ config_id: 1, phone_number_id: '555', label: 'Main' }, ADMIN);
    expect(st.channelConfigs[0].config.numbers).toEqual([expect.objectContaining({ phone_number_id: '555', label: 'Main', is_default: true })]);
  });

  it('an unknown number is a 404; un-defaulting the default is refused', async () => {
    const { svc } = make([ROW({ numbers: TWO_NUMBERS })]);
    await expect(svc.updateNumber({ config_id: 1, phone_number_id: '000', label: 'x' }, ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(svc.updateNumber({ config_id: 1, phone_number_id: '555', is_default: false }, ADMIN)).rejects.toThrow(/must stay the default/);
  });

  it('A GENERIC SETTINGS SAVE can neither wipe nor forge config.numbers', async () => {
    expect(MSG_PROVIDERS.meta_cloud.systemConfig).toContain('numbers');
    expect(MSG_PROVIDERS.meta_cloud.config.map((f) => f.key)).not.toContain('numbers');   // never a form field
    const { cfgs, st } = make([ROW({ numbers: TWO_NUMBERS })]);
    // what the Settings modal posts: its copy of config, numbers and all (here: forged)
    await cfgs.save({ provider: 'meta_cloud', channel: 'whatsapp', config: { app_id: 'NEW-APP', numbers: [{ phone_number_id: 'evil' }] } }, ADMIN);
    expect(st.channelConfigs[0].config.app_id).toBe('NEW-APP');
    expect(st.channelConfigs[0].config.numbers).toEqual(TWO_NUMBERS);
    // …and one that omits it entirely
    await cfgs.save({ provider: 'meta_cloud', channel: 'whatsapp', config: { app_id: 'NEWER' } }, ADMIN);
    expect(st.channelConfigs[0].config.numbers).toEqual(TWO_NUMBERS);
  });
});

/* =================================================================== register */

describe('POST …/register — Cloud API registration', () => {
  it.each<[unknown, string]>([['', 'empty'], ['12345', '5 digits'], ['1234567', '7 digits'], ['12a456', 'a letter'], [undefined, 'missing']])(
    'pin %p (%s) is refused before Meta is called', async (pin: unknown) => {
      const { fn, calls } = fakeHttp([[/./, { body: { success: true } }]]);
      await expect(make([ROW()], fn).svc.register({ config_id: 1, phone_number_id: '555', pin }))
        .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exactly 6 digits/) });
      expect(calls).toHaveLength(0);
    });

  it('a 6-digit pin POSTs { messaging_product: whatsapp, pin } to /{phone_number_id}/register', async () => {
    const { fn, calls } = fakeHttp([[/\/556\/register$/, { body: { success: true } }]]);
    const out = await make([ROW({ numbers: TWO_NUMBERS })], fn).svc.register({ config_id: 1, phone_number_id: '556', pin: '000000' });
    expect(out).toMatchObject({ ok: true, phone_number_id: '556' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/556/register');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ messaging_product: 'whatsapp', pin: '000000' });
    expect(calls[0].init.headers.Authorization).toBe('Bearer PERMANENT-TOKEN-xyz');
  });

  it('a number that is not ours is refused; Meta\'s refusal is surfaced verbatim', async () => {
    const { fn, calls } = fakeHttp([[/register/, { status: 400, body: { error: { message: 'Two step verification PIN mismatch' } } }]]);
    const { svc } = make([ROW()], fn);
    await expect(svc.register({ config_id: 1, phone_number_id: '31337', pin: '123456' })).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(0);
    await expect(svc.register({ config_id: 1, phone_number_id: '555', pin: '123456' })).rejects.toThrow(/Meta refused to register the number: Two step verification PIN mismatch/);
  });
});

/* ===================================================================== verify */

describe('POST …/verify — the read-only probe', () => {
  it('delegates to the Settings probe and reports { ok, detail }', async () => {
    const { fn, calls } = fakeHttp([[/\/555\?fields=/, { body: { display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua', quality_rating: 'GREEN' } }]]);
    const out = await make([ROW()], fn).svc.verify(1);
    expect(out.ok).toBe(true);
    expect(out.detail).toMatch(/Connected to WhatsApp number \+91 98100 00001/);
    expect(calls.every((c) => !c.init?.method || c.init.method === 'GET')).toBe(true);   // read-only
  });

  it('a rejected token is ok:false with Meta\'s reason — not an exception', async () => {
    const { fn } = fakeHttp([[/\/555\?fields=/, { status: 401, body: { error: { message: 'Invalid OAuth access token' } } }]]);
    const out = await make([ROW()], fn).svc.verify(1);
    expect(out).toMatchObject({ ok: false, detail: expect.stringMatching(/Invalid OAuth access token/) });
  });
});

/* ================================================================= disconnect */

describe('POST …/disconnect', () => {
  it('REMOVE ONE NUMBER while others remain: the row stays, Meta is not called', async () => {
    const { svc, st } = make([ROW({ numbers: TWO_NUMBERS })]);   // noHttp: any Graph call would throw
    const out = await svc.disconnect({ config_id: 1, remove_number: '556' }, ADMIN);
    expect(out).toMatchObject({ mode: 'number_removed', removed: '556', new_default: null, connected: true });
    expect(out.numbers.map((n) => n.phone_number_id)).toEqual(['555']);
    expect(st.channelConfigs).toHaveLength(1);
    expect(st.channelConfigs[0].deleted_at).toBeUndefined();
  });

  it('removing the DEFAULT re-points the sender to a remaining number', async () => {
    const { svc, cfgs } = make([ROW({ numbers: TWO_NUMBERS })]);
    const out = await svc.disconnect({ config_id: 1, remove_number: '555' }, ADMIN);
    expect(out).toMatchObject({ mode: 'number_removed', new_default: '556' });
    expect((await cfgs.require('whatsapp')).config.phone_number_id).toBe('556');
  });

  it('FULL DISCONNECT: unsubscribes the WABA, soft-deletes through configs.remove, keeps the Meta app', async () => {
    const { fn, calls } = fakeHttp([[/\/777\/subscribed_apps$/, { body: { success: true } }]]);
    const { svc, cfgs, st } = make([ROW({ numbers: TWO_NUMBERS })], fn);
    const out = await svc.disconnect({ config_id: 1 }, ADMIN);

    expect(calls[0].init.method).toBe('DELETE');
    expect(out).toMatchObject({ ok: true, mode: 'disconnected', warning: null, connected: false, accounts: [], numbers: [], meta_app_kept: true });

    // the connection row is SOFT-deleted, with who did it
    expect(st.channelConfigs[0]).toMatchObject({ id: 1, is_active: false, deleted_by: ADMIN });
    expect(st.channelConfigs[0].deleted_at).toBeInstanceOf(Date);

    // the Meta app (shared with Facebook Lead Ads) + the verify token already pasted into
    // Meta survive as a fresh row — with NO token, NO number: it cannot send.
    const kept = st.channelConfigs[1];
    expect(kept.config).toEqual({ app_id: '99887766', config_id: 'cfg-1', api_version: 'v21.0' });
    expect(decryptSecret(kept.secrets.app_secret)).toBe('APP-SECRET');
    expect(decryptSecret(kept.secrets.verify_token)).toBe('verify-me-123');
    expect(kept.secrets.access_token).toBeUndefined();
    await expect(cfgs.require('whatsapp')).rejects.toMatchObject({ notConfigured: true });
  });

  it('an UNSUBSCRIBE FAILURE becomes a warning — the row is still removed', async () => {
    const { fn } = fakeHttp([[/subscribed_apps/, { status: 403, body: { error: { message: 'Insufficient permission' } } }]]);
    const { svc, st } = make([ROW()], fn);
    const out = await svc.disconnect({ config_id: 1 }, ADMIN);
    expect(out.mode).toBe('disconnected');
    expect(out.warning).toMatch(/Insufficient permission/);
    expect(st.channelConfigs[0].deleted_at).toBeInstanceOf(Date);
    expect(out.connected).toBe(false);
  });

  it('a NETWORK failure on unsubscribe is a warning too', async () => {
    const fn = (async () => { throw new Error('ETIMEDOUT'); }) as any;
    const { svc, st } = make([ROW()], fn);
    const out = await svc.disconnect({ config_id: 1 }, ADMIN);
    expect(out.warning).toMatch(/ETIMEDOUT/);
    expect(st.channelConfigs[0].deleted_at).toBeInstanceOf(Date);
  });

  it('removing the LAST number is a full disconnect', async () => {
    const { fn, calls } = fakeHttp([[/subscribed_apps/, { body: { success: true } }]]);
    const { svc, st } = make([ROW()], fn);
    const out = await svc.disconnect({ config_id: 1, remove_number: '555' }, ADMIN);
    expect(out).toMatchObject({ mode: 'disconnected', removed: '555' });
    expect(calls).toHaveLength(1);
    expect(st.channelConfigs[0].deleted_at).toBeInstanceOf(Date);
  });

  it('an unknown number / a stale config_id changes nothing', async () => {
    const { svc, st } = make([ROW({ numbers: TWO_NUMBERS })]);
    await expect(svc.disconnect({ config_id: 1, remove_number: '000' }, ADMIN)).rejects.toMatchObject({ status: 404 });
    await expect(svc.disconnect({ config_id: 9 }, ADMIN)).rejects.toMatchObject({ status: 404 });
    expect(st.channelConfigs[0].deleted_at).toBeUndefined();
  });
});

/* ======================================================== numbersOf + waMeta */

describe('the chat "Sending from" selector lists every stored number', () => {
  const metaDb = (rows: any[]) => ({
    one: async () => ({ id: '1' }),
    query: async (sql: string) => (/FROM channel_config cc/.test(sql) ? rows : []),
  }) as any;
  const svc = (rows: any[]) => new MessagingService(metaDb(rows), {} as any, {} as any, {} as any);

  it('config.numbers -> all of them, labelled, default first', async () => {
    const out = await svc([{ number: '+91 98100 00002', label: null, numbers: TWO_NUMBERS, default_id: '556' }]).waMeta({} as any);
    expect(out.numbers).toEqual([
      { number: '+91 98100 00002', label: 'Support', phone_number_id: '556', is_default: true },
      { number: '+91 98100 00001', label: 'Sales line', phone_number_id: '555', is_default: false },
    ]);
  });

  it('no config.numbers -> exactly the old behaviour', async () => {
    const out = await svc([{ number: '+91 98100 00001', label: null, numbers: null, default_id: '555' }]).waMeta({} as any);
    expect(out.numbers).toEqual([{ number: '+91 98100 00001', label: 'WhatsApp' }]);
  });

  it('numbersOf always lists the number the sender uses', () => {
    const list = numbersOf({ phone_number_id: '900', display_phone_number: '+1 900', numbers: TWO_NUMBERS });
    expect(list[0]).toMatchObject({ phone_number_id: '900', is_default: true });
    expect(list).toHaveLength(3);
  });
});

/* ============================================================ webhook logging */

describe('the webhook records one health row per POST — and never breaks because of it', () => {
  const res = () => { const r: any = { status: () => r, json: () => r, type: () => r, send: () => r }; return r; };
  const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, messages: [{ from: '919810000009', text: { body: 'hello' } }] } }] }] };

  it('an inbound message -> INSERT wa_webhook_event (kind=message, our phone id), no payload stored', async () => {
    const q: Array<{ sql: string; params: unknown[] }> = [];
    const db: any = { query: async (sql: string, params: unknown[]) => { q.push({ sql, params }); return []; }, one: async () => null };
    const ctl = new WhatsAppWebhookController(db, { resolve: async () => ({ secrets: {} }) } as any, {} as any);
    await ctl.receive({} as any, '', body, res());
    const ins = q.find((x) => /INSERT INTO wa_webhook_event/.test(x.sql))!;
    expect(ins.params).toEqual(['message', '555']);
    expect(JSON.stringify(ins.params)).not.toContain('hello');
  });

  it('a logging failure does NOT stop receipt handling', async () => {
    const seen: string[] = [];
    const db: any = {
      query: async (sql: string) => { if (/wa_webhook_event/.test(sql)) throw new Error('relation does not exist'); seen.push(sql); return []; },
      one: async () => null,
    };
    const ctl = new WhatsAppWebhookController(db, { resolve: async () => ({ secrets: {} }) } as any, {} as any);
    const statusBody = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] };
    await expect(ctl.receive({} as any, '', statusBody, res())).resolves.toBeUndefined();
    expect(seen.some((s) => /UPDATE message_log/.test(s))).toBe(true);
  });

  it('an UNSIGNED post is not counted when an app secret is configured', async () => {
    const q: string[] = [];
    const db: any = { query: async (sql: string) => { q.push(sql); return []; }, one: async () => null };
    const ctl = new WhatsAppWebhookController(db, { resolve: async () => ({ secrets: { app_secret: 'S' } }) } as any, {} as any);
    await ctl.receive({} as any, 'sha256=forged', body, res());
    expect(q).toHaveLength(0);
  });
});

/* ======================================================================= RBAC */

describe('every WhatsApp Account endpoint is admin-only', () => {
  const perm = (m: string) => Reflect.getMetadata(PERMISSION_KEY, (WhatsAppAccountController.prototype as any)[m]);
  it('the read needs settings.read; every write needs settings.update', () => {
    expect(perm('get')).toBe('settings.read');
    for (const m of ['sync', 'number', 'register', 'verify', 'disconnect']) expect(perm(m)).toBe('settings.update');
  });
});
