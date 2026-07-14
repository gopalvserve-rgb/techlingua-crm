import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook } from './fake-channels.testkit';
import { RateLimiter } from './rate-limit.util';

const KEY = 'pubkeyFORM';

const channel = (config: Record<string, unknown> = {}) => makeChannel({
  id: 3, provider: 'website', public_key: KEY, secrets: {},
  config: {
    allowed_origins: 'https://techlingua.in, https://www.techlingua.in',
    honeypot_field: 'company_website',
    rate_limit_per_min: 60,
    ...config,
  },
});

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Neha Gupta', phone: '9811100004', email: 'neha@example.com',
  course: 'IELTS', message: 'Please call me in the evening', ...over,
});

describe('Website form endpoint', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('a submission from an allowed origin creates a lead', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.formReceive(KEY, body(), { origin: 'https://techlingua.in', ip: '1.2.3.4' });

    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({
      full_name: 'Neha Gupta', phone: '+919811100004', email: 'neha@example.com',
      campaign_id: 5, source_id: 7,
    });
    expect(st.leads[0].course_id).toBe(21);
    expect(st.leads[0].owner_id).toBe(11);                    // distribution ran
    expect(cst.events[0]).toMatchObject({ status: 'ingested', origin: 'https://techlingua.in' });
  });

  it('a server-to-server post (no Origin header) is allowed — CORS is a browser control', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await hooks.formReceive(KEY, body(), { ip: '10.0.0.1' });
    expect(st.leads).toHaveLength(1);
  });

  it('a browser post from an UNLISTED origin is 403 and creates nothing', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await expect(hooks.formReceive(KEY, body(), { origin: 'https://evil.example', ip: '9.9.9.9' }))
      .rejects.toMatchObject({ http: 403 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'rejected' });
    expect(cst.events[0].reason).toMatch(/not in this channel's allowed origins/);
  });

  it('HONEYPOT: a filled hidden field is silently dropped (200, no lead) and logged as spam', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.formReceive(
      KEY, body({ company_website: 'http://spam.example' }), { origin: 'https://techlingua.in' },
    );
    expect(out.http).toBe(200);                              // the bot learns nothing
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'rejected' });
    expect(cst.events[0].reason).toMatch(/honeypot/i);
  });

  it('the honeypot field itself is never mapped into the lead', async () => {
    const { hooks, st } = makeWebhook([channel({ honeypot_field: 'note' })]);   // pathological config
    await hooks.formReceive(KEY, { name: 'A', phone: '9811100011' }, {});
    expect(st.leads[0].note).toBeFalsy();
  });

  it('RATE LIMIT: the per-key cap returns 429 and logs the rejection', async () => {
    const { hooks, st, cst } = makeWebhook([channel({ rate_limit_per_min: 3 })]);
    for (let i = 0; i < 3; i++) {
      await hooks.formReceive(KEY, body({ phone: `98111001${20 + i}` }), { ip: `5.5.5.${i}` });
    }
    await expect(hooks.formReceive(KEY, body({ phone: '9811100199' }), { ip: '5.5.5.9' }))
      .rejects.toMatchObject({ http: 429 });
    expect(st.leads).toHaveLength(3);                        // the 4th never reached the pipeline
    expect(cst.events[3]).toMatchObject({ status: 'rejected' });
    expect(cst.events[3].reason).toMatch(/Rate limit exceeded/);
  });

  it('RATE LIMIT: one IP is capped well below the per-form budget', async () => {
    const { hooks, st } = makeWebhook([channel({ rate_limit_per_min: 60 })]);   // ip cap = 6
    let rejected = 0;
    for (let i = 0; i < 8; i++) {
      try {
        await hooks.formReceive(KEY, body({ phone: `98111003${10 + i}` }), { ip: '7.7.7.7' });
      } catch { rejected++; }
    }
    expect(st.leads).toHaveLength(6);
    expect(rejected).toBe(2);
  });

  it('REPLAY: the identical payload posted twice creates ONE lead (content-hash idempotency)', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await hooks.formReceive(KEY, body(), {});
    const cursor = st.cursor;
    await hooks.formReceive(KEY, body(), {});
    expect(st.leads).toHaveLength(1);
    expect(st.cursor).toBe(cursor);
    expect(cst.events[1]).toMatchObject({ status: 'skipped' });
  });

  it('an invalid submission (no phone) is a 400 the website can show to the visitor', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await expect(hooks.formReceive(KEY, { name: 'No Phone' }, {})).rejects.toMatchObject({ http: 400 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'failed' });
  });

  it('an unknown public key is a 404, still logged', async () => {
    const { hooks, cst } = makeWebhook([channel()]);
    await expect(hooks.formReceive('nope', body(), {})).rejects.toMatchObject({ http: 404 });
    expect(cst.events[0]).toMatchObject({ status: 'rejected', channel_id: null });
  });

  it('allowedOrigin: exact match, trailing slash, wildcard, and "not configured"', () => {
    const { hooks } = makeWebhook([channel()]);
    const ch = channel();
    expect(hooks.allowedOrigin(ch, 'https://techlingua.in')).toBe('https://techlingua.in');
    expect(hooks.allowedOrigin(ch, 'https://techlingua.in/')).toBe('https://techlingua.in/');
    expect(hooks.allowedOrigin(ch, 'https://other.in')).toBeNull();
    expect(hooks.allowedOrigin(channel({ allowed_origins: '*' }), 'https://any.example')).toBe('*');
    expect(hooks.allowedOrigin(channel({ allowed_origins: '' }), 'https://techlingua.in')).toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside the window, then blocks', () => {
    const rl = new RateLimiter();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rl.allow('k', 5, 60_000, t)).toBe(true);
    expect(rl.allow('k', 5, 60_000, t)).toBe(false);
    expect(rl.retryAfter('k', t)).toBe(60);
  });

  it('resets once the window rolls over', () => {
    const rl = new RateLimiter();
    const t = 1_000_000;
    expect(rl.allow('k', 1, 60_000, t)).toBe(true);
    expect(rl.allow('k', 1, 60_000, t)).toBe(false);
    expect(rl.allow('k', 1, 60_000, t + 60_001)).toBe(true);
  });

  it('keys are independent', () => {
    const rl = new RateLimiter();
    expect(rl.allow('a', 1)).toBe(true);
    expect(rl.allow('b', 1)).toBe(true);
    expect(rl.allow('a', 1)).toBe(false);
  });
});
