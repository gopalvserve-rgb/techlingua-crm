import { ChannelConfigService } from './channel-config.service';
import { MessagingService, nextSendableTime, DEFAULT_HOURS } from './messaging.service';
import { MessageWorker } from './message.worker';
import { PermanentSendError, TransientSendError, Transport } from './transports';
import { encryptSecret } from '../common/crypto.util';
import { isNotConfigured } from '../common/not-configured.exception';
import { makeSprint4Db, settings4 } from './sprint4.testkit';

const SMTP_ORG = {
  id: 1, channel: 'email', provider: 'smtp', vertical_id: null, is_active: true,
  config: { host: 'smtp.org', port: 587, from_email: 'org@techlingua.in' },
  secrets: { username: encryptSecret('org-user'), password: encryptSecret('org-pass') },
};
const SMTP_VERTICAL_7 = {
  id: 2, channel: 'email', provider: 'smtp', vertical_id: 7, is_active: true,
  config: { host: 'smtp.bcl', port: 587, from_email: 'bcl@techlingua.in' },
  secrets: { username: encryptSecret('bcl-user'), password: encryptSecret('bcl-pass') },
};
const WHATSAPP = {
  id: 3, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
  config: { phone_number_id: '123' }, secrets: { access_token: encryptSecret('TOK') },
};

const make = (state: Parameters<typeof makeSprint4Db>[0] = {}, settingRows = {}) => {
  const { db, st } = makeSprint4Db(state);
  const configs = new ChannelConfigService(db);
  const messaging = new MessagingService(db, configs, settings4(settingRows));
  return { db, st, configs, messaging };
};

/** A transport that records what it was handed. */
const spyTransport = (impl?: (m: any, c: any) => Promise<any>) => {
  const calls: Array<{ msg: any; cfg: any }> = [];
  const t: Transport = {
    key: 'spy',
    async send(msg, cfg) {
      calls.push({ msg, cfg });
      return impl ? impl(msg, cfg) : { provider_message_id: 'ok-1', response: { ok: true } };
    },
  };
  return { calls, resolve: () => t };
};

/* ================= NOT-CONFIGURED DEGRADATION (per channel) ================= */

describe('NOT CONFIGURED — the client has sent no credentials, and that is not a bug', () => {
  it.each(['email', 'sms', 'whatsapp'] as const)(
    '%s: require() throws NotConfiguredException (a 503 naming what is missing), not a 500',
    async (channel) => {
      const { configs } = make();
      const err = await configs.require(channel as never, null).catch((e) => e);
      expect(isNotConfigured(err)).toBe(true);
      expect(err.getStatus()).toBe(503);
      expect(err.message).toMatch(/not configured/i);
      expect(err.message).toMatch(/Settings/);
    },
  );

  it('a PARTIALLY configured channel names the exact missing field', async () => {
    const { configs } = make({
      channelConfigs: [{
        id: 9, channel: 'email', provider: 'smtp', vertical_id: null, is_active: true,
        config: { host: 'smtp.x' },        // no port, no from_email
        secrets: { username: encryptSecret('u') },  // no password
      }],
    });
    const err = await configs.require('email', null).catch((e) => e);
    expect(isNotConfigured(err)).toBe(true);
    expect(err.message).toContain('Port');
    expect(err.message).toContain('From address');
    expect(err.message).toContain('SMTP password / app password');
  });

  it('a queued message for an unconfigured channel FAILS with not_configured=true — never retried, never Error-Logged', async () => {
    const { messaging, st } = make();
    const q = await messaging.queue({ channel: 'whatsapp', to: '+919810000001', body: 'hi' });
    await messaging.deliver(q.id);

    const row = st.messages[0];
    expect(row.status).toBe('failed');
    expect(row.not_configured).toBe(true);       // amber in the UI, NOT a red Error-Log row
    expect(row.error).toMatch(/WhatsApp is not configured/);
    expect(row.attempts).toBe(0);                // a missing credential is not a transient blip
  });

  it('the send log RECORDS the attempt — "nothing happened" is never the answer', async () => {
    const { messaging, st } = make();
    await messaging.sendNow({ channel: 'sms', to: '+919810000001', body: 'hi' });
    expect(st.messages).toHaveLength(1);
    expect(st.messages[0].to_addr).toBe('+919810000001');
    expect(st.messages[0].status).toBe('failed');
  });
});

/* ====================== PER-VERTICAL SMTP SELECTION ======================= */

describe('SMTP is PER VERTICAL (non-negotiable, project rules)', () => {
  it('a lead in vertical 7 sends through VERTICAL 7\'s SMTP, not the org default', async () => {
    const { messaging, st } = make({ channelConfigs: [SMTP_ORG, SMTP_VERTICAL_7] });
    const spy = spyTransport();
    const q = await messaging.queue({ channel: 'email', to: 'a@b.com', subject: 's', body: 'b', vertical_id: 7 });
    await messaging.deliver(q.id, spy.resolve);

    expect(spy.calls[0].cfg.id).toBe(2);
    expect(spy.calls[0].cfg.config.host).toBe('smtp.bcl');
    expect(spy.calls[0].cfg.config.from_email).toBe('bcl@techlingua.in');
    expect(st.messages[0].status).toBe('sent');
  });

  it('a vertical with NO row of its own falls back to the ORG-wide SMTP', async () => {
    const { messaging } = make({ channelConfigs: [SMTP_ORG, SMTP_VERTICAL_7] });
    const spy = spyTransport();
    const q = await messaging.queue({ channel: 'email', to: 'a@b.com', subject: 's', body: 'b', vertical_id: 99 });
    await messaging.deliver(q.id, spy.resolve);
    expect(spy.calls[0].cfg.config.host).toBe('smtp.org');
  });

  it('the secrets reaching the transport are DECRYPTED, and the ciphertext never leaves the DB', async () => {
    const { messaging, configs } = make({ channelConfigs: [SMTP_VERTICAL_7] });
    const spy = spyTransport();
    const q = await messaging.queue({ channel: 'email', to: 'a@b.com', subject: 's', body: 'b', vertical_id: 7 });
    await messaging.deliver(q.id, spy.resolve);
    expect(spy.calls[0].cfg.secrets.password).toBe('bcl-pass');

    // ...but the HTTP shape only ever shows a mask
    const presented = configs.present({ ...SMTP_VERTICAL_7 });
    expect(presented.secrets_masked.password).toMatch(/^•+/);
    expect(JSON.stringify(presented)).not.toContain('bcl-pass');
  });
});

/* ========================= RETRY / FAILURE LOGGING ========================= */

describe('retry, backoff and failure logging', () => {
  it('a TRANSIENT failure is retried with exponential backoff, and the reason is kept', async () => {
    const { messaging, st } = make({ channelConfigs: [WHATSAPP] });
    const spy = spyTransport(async () => { throw new TransientSendError('rate limited'); });

    const q = await messaging.queue({ channel: 'whatsapp', to: '+91981', body: 'x' });
    st.messages[0].attempts = 1;                    // as the worker would have left it
    expect(await messaging.deliver(q.id, spy.resolve)).toBe('retry');

    const row = st.messages[0];
    expect(row.status).toBe('queued');
    expect(row.error).toBe('rate limited');
    expect(row.run_after.getTime()).toBeGreaterThan(Date.now() + 25_000);  // 2^1 * 15s
  });

  it('a PERMANENT failure is NOT retried — a bad number will still be bad in 30 seconds', async () => {
    const { messaging, st } = make({ channelConfigs: [WHATSAPP] });
    const spy = spyTransport(async () => { throw new PermanentSendError('Invalid phone number'); });
    const q = await messaging.queue({ channel: 'whatsapp', to: '+91', body: 'x' });
    expect(await messaging.deliver(q.id, spy.resolve)).toBe('failed');
    expect(st.messages[0].status).toBe('failed');
    expect(st.messages[0].error).toBe('Invalid phone number');
    expect(st.messages[0].not_configured).toBe(false);
  });

  it('retries are EXHAUSTED, not infinite', async () => {
    const { messaging, st } = make({ channelConfigs: [WHATSAPP] });
    const spy = spyTransport(async () => { throw new TransientSendError('boom'); });
    const q = await messaging.queue({ channel: 'whatsapp', to: '+91', body: 'x' });
    st.messages[0].attempts = MessagingService.MAX_ATTEMPTS;
    expect(await messaging.deliver(q.id, spy.resolve)).toBe('failed');
    expect(st.messages[0].status).toBe('failed');
  });

  it('a SUCCESS records the provider, its message id and its raw response', async () => {
    const { messaging, st } = make({ channelConfigs: [WHATSAPP] });
    const spy = spyTransport(async () => ({ provider_message_id: 'wamid.9', response: { messages: [{ id: 'wamid.9' }] } }));
    const q = await messaging.queue({ channel: 'whatsapp', to: '+919810000001', body: 'x' });
    await messaging.deliver(q.id, spy.resolve);

    const row = st.messages[0];
    expect(row.status).toBe('sent');
    expect(row.provider).toBe('meta_cloud');
    expect(row.provider_message_id).toBe('wamid.9');
    expect(row.provider_response.result).toBeTruthy();
    expect(row.sent_at).toBeTruthy();
  });
});

/* ============================ CONSENT / OPT-OUT =========================== */

describe('opt-out is honoured — for automation AND for a human pressing Send', () => {
  it('a queued message to an opted-out number is SKIPPED, and the log says why', async () => {
    const { messaging, st } = make({
      channelConfigs: [WHATSAPP],
      optOuts: [{ id: 1, channel: 'whatsapp', identifier: '+919810000001', lead_id: 1 }],
    });
    const out = await messaging.queue({ channel: 'whatsapp', to: '+919810000001', body: 'x', lead_id: 1 });
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/Opted out/);
    expect(st.messages[0].status).toBe('skipped');
  });

  it('sendNow() will not send to an opted-out contact either (an opt-out you can click past is not one)', async () => {
    const { messaging } = make({
      channelConfigs: [WHATSAPP],
      optOuts: [{ id: 1, channel: 'whatsapp', identifier: '+919810000001', lead_id: null }],
    });
    const spy = spyTransport();
    const out = await messaging.sendNow({ channel: 'whatsapp', to: '+919810000001', body: 'x', guarded: false });
    expect(out.status).toBe('skipped');
    expect(spy.calls).toHaveLength(0);
  });

  it('an opt-out on channel "all" blocks every channel', async () => {
    const { messaging } = make({ optOuts: [{ id: 1, channel: 'all', identifier: 'x@y.com', lead_id: null }] });
    const out = await messaging.queue({ channel: 'email', to: 'X@Y.com', subject: 's', body: 'b' });
    expect(out.status).toBe('skipped');   // note: matched case-insensitively
  });

  it('opt-out is keyed on the E.164 IDENTITY, so 9810000001 and +919810000001 are the same person', async () => {
    const { messaging } = make({ optOuts: [{ id: 1, channel: 'sms', identifier: '+919810000001', lead_id: null }] });
    expect(await messaging.isOptedOut('sms', '9810000001')).toBe(true);
    expect(await messaging.isOptedOut('sms', '+91 98100 00001')).toBe(true);
  });

  it('a second STOP from the same number is idempotent, not a 409', async () => {
    const { messaging, st } = make();
    await messaging.optOut({ channel: 'sms', identifier: '9810000001' });
    await messaging.optOut({ channel: 'sms', identifier: '+919810000001' });
    expect(st.optOuts).toHaveLength(1);
    expect(st.optOuts[0].identifier).toBe('+919810000001');
  });
});

/* ======================= GUARDRAILS: cap + hours ========================== */

describe('automation guardrails', () => {
  it('the DAILY CAP stops the 4th automated message to one lead — and says so', async () => {
    const { messaging, st } = make(
      { channelConfigs: [WHATSAPP] },
      { journey_guardrails: { max_sends_per_lead_per_day: 3, respect_business_hours: false } },
    );
    for (let i = 0; i < 3; i++) {
      const o = await messaging.queue({ channel: 'whatsapp', to: '+91981', body: `m${i}`, lead_id: 1, guarded: true });
      expect(o.status).toBe('queued');
    }
    const blocked = await messaging.queue({ channel: 'whatsapp', to: '+91981', body: 'm4', lead_id: 1, guarded: true });
    expect(blocked.status).toBe('skipped');
    expect(blocked.reason).toMatch(/Daily cap reached \(3\/3/);
    expect(st.messages.filter((m) => m.status === 'queued')).toHaveLength(3);
  });

  it('the cap applies to AUTOMATION only — a counsellor can still message their own lead', async () => {
    const { messaging } = make(
      { channelConfigs: [WHATSAPP] },
      { journey_guardrails: { max_sends_per_lead_per_day: 1, respect_business_hours: false } },
    );
    await messaging.queue({ channel: 'whatsapp', to: '+91981', body: 'a', lead_id: 1, guarded: true });
    const human = await messaging.queue({ channel: 'whatsapp', to: '+91981', body: 'b', lead_id: 1, guarded: false });
    expect(human.status).toBe('queued');
  });

  it('a cap of 0 means NO cap', async () => {
    const { messaging } = make(
      { channelConfigs: [WHATSAPP] },
      { journey_guardrails: { max_sends_per_lead_per_day: 0, respect_business_hours: false } },
    );
    for (let i = 0; i < 5; i++) {
      const o = await messaging.queue({ channel: 'whatsapp', to: '+91981', body: 'x', lead_id: 1, guarded: true });
      expect(o.status).toBe('queued');
    }
  });

  it('BUSINESS HOURS DEFER an automated send — they never DROP it', async () => {
    const { messaging, st } = make(
      { channelConfigs: [WHATSAPP] },
      { journey_guardrails: { respect_business_hours: true, max_sends_per_lead_per_day: 0 } },
    );
    // 03:00 IST on a Tuesday = 21:30 UTC Monday
    const middleOfTheNight = new Date('2026-07-13T21:30:00Z');
    const out = await messaging.queue({
      channel: 'whatsapp', to: '+91981', body: 'x', lead_id: 1, guarded: true, run_after: middleOfTheNight,
    });
    expect(out.status).toBe('queued');                              // NOT skipped
    expect(st.messages[0].run_after.getTime()).toBeGreaterThan(middleOfTheNight.getTime());
  });
});

describe('nextSendableTime — the business-hours calculation, as a pure function', () => {
  const hours = DEFAULT_HOURS;   // Mon–Sat 09:00–19:00 IST, Sunday closed

  it('inside the window: send NOW', () => {
    const noonIst = new Date('2026-07-14T06:30:00Z');   // 12:00 IST Tuesday
    expect(nextSendableTime(noonIst, hours).getTime()).toBe(noonIst.getTime());
  });

  it('before opening: wait until 09:00 the same day', () => {
    const sixAmIst = new Date('2026-07-14T00:30:00Z');  // 06:00 IST Tuesday
    const out = nextSendableTime(sixAmIst, hours);
    expect(out.toISOString()).toBe('2026-07-14T03:30:00.000Z');   // 09:00 IST
  });

  it('after closing: roll to 09:00 TOMORROW', () => {
    const tenPmIst = new Date('2026-07-14T16:30:00Z');  // 22:00 IST Tuesday
    const out = nextSendableTime(tenPmIst, hours);
    expect(out.toISOString()).toBe('2026-07-15T03:30:00.000Z');   // 09:00 IST Wednesday
  });

  it('SUNDAY is closed: roll to Monday morning', () => {
    const sunday = new Date('2026-07-19T06:00:00Z');    // Sunday 11:30 IST
    const out = nextSendableTime(sunday, hours);
    expect(out.toISOString()).toBe('2026-07-20T03:30:00.000Z');   // Monday 09:00 IST
  });

  it('a HOLIDAY is a closed day: a message due on it goes out the next working morning', () => {
    const wed = new Date('2026-07-15T06:00:00Z');       // Wednesday 11:30 IST
    const out = nextSendableTime(wed, hours, ['2026-07-15']);
    expect(out.toISOString()).toBe('2026-07-16T03:30:00.000Z');   // Thursday 09:00 IST
  });

  it('business hours DISABLED: send whenever', () => {
    const night = new Date('2026-07-14T21:00:00Z');
    expect(nextSendableTime(night, { ...hours, enabled: false }).getTime()).toBe(night.getTime());
  });
});

/* ============================ THE WORKER ================================== */

describe('the outbound worker', () => {
  it('claims per channel, drains the queue, and RESPECTS the rate limit', async () => {
    const { db, st, configs } = make({ channelConfigs: [WHATSAPP] }, { message_rate_limits: { whatsapp: 12 } });
    const messaging = new MessagingService(db, configs, settings4({ message_rate_limits: { whatsapp: 12 } }));
    const spy = spyTransport();
    // route the worker's deliver() through the spy transport (no sockets in a unit test)
    jest.spyOn(messaging, 'deliver').mockImplementation(
      (id: number) => MessagingService.prototype.deliver.call(messaging, id, spy.resolve),
    );

    for (let i = 0; i < 5; i++) {
      await messaging.queue({ channel: 'whatsapp', to: '+91981', body: `m${i}` });
    }
    const worker = new MessageWorker(db, messaging, settings4({ message_rate_limits: { whatsapp: 12 } }));
    // 12/min * 5s tick = 1 message per tick — the throttle is real, not decorative
    expect(await worker.tick()).toBe(1);
    expect(st.messages.filter((m) => m.status === 'sent')).toHaveLength(1);
    expect(st.messages.filter((m) => m.status === 'queued')).toHaveLength(4);
  });

  it('a message whose run_after is in the future is NOT claimed (that is what deferral means)', async () => {
    const { db, st, configs } = make({ channelConfigs: [WHATSAPP] });
    const messaging = new MessagingService(db, configs, settings4());
    await messaging.queue({ channel: 'whatsapp', to: '+91', body: 'later', run_after: new Date(Date.now() + 3_600_000) });
    const worker = new MessageWorker(db, messaging, settings4());
    expect(await worker.tick()).toBe(0);
    expect(st.messages[0].status).toBe('queued');
  });
});
