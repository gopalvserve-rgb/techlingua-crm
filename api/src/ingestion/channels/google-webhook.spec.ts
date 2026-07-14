import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook } from './fake-channels.testkit';

const GOOGLE_KEY = 'google-webhook-key-123';
const KEY = 'pubkeyGOOGLE';

const channel = (config: Record<string, unknown> = {}) => makeChannel({
  id: 2, provider: 'google_ads', public_key: KEY, secrets: { google_key: GOOGLE_KEY }, config,
});

/** A real Google Ads lead-form-extension delivery. */
const payload = (over: Record<string, unknown> = {}) => ({
  lead_id: 'GL-1',
  api_version: '1.0',
  form_id: 12345,
  campaign_id: 98765,
  gcl_id: 'abc.123',
  is_test: false,
  google_key: GOOGLE_KEY,
  user_column_data: [
    { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Amit Verma' },
    { column_id: 'PHONE_NUMBER', column_name: 'Phone number', string_value: '+919811100003' },
    { column_id: 'EMAIL', column_name: 'Email', string_value: 'amit@example.com' },
    { column_id: 'CITY', column_name: 'City', string_value: 'Mumbai' },
  ],
  ...over,
});

describe('Google Ads lead form webhook', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('a valid google_key creates a lead through the shared pipeline', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.googleReceive(KEY, payload(), { ip: '1.2.3.4' });

    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({
      full_name: 'Amit Verma', phone: '+919811100003', campaign_id: 5, source_id: 7,
    });
    expect(st.leads[0].owner_id).toBe(11);            // distribution ran
    expect(cst.events[0]).toMatchObject({ status: 'ingested', signature_ok: true, external_key: 'GL-1' });
  });

  it('a MISMATCHED google_key is rejected with 401 and no lead is created', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await expect(hooks.googleReceive(KEY, payload({ google_key: 'WRONG-KEY' }), {}))
      .rejects.toMatchObject({ http: 401 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'rejected', signature_ok: false, external_key: 'GL-1' });
    expect(cst.events[0].reason).toMatch(/google_key does not match/);
    expect(cst.events[0].raw.user_column_data).toBeDefined();     // still traceable/replayable
  });

  it('a MISSING google_key is rejected with 401', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body: any = payload();
    delete body.google_key;
    await expect(hooks.googleReceive(KEY, body, {})).rejects.toMatchObject({ http: 401 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0].reason).toMatch(/no google_key/);
  });

  it('an unknown webhook key is a 404, logged', async () => {
    const { hooks, cst } = makeWebhook([channel()]);
    await expect(hooks.googleReceive('nope', payload(), {})).rejects.toMatchObject({ http: 404 });
    expect(cst.events[0]).toMatchObject({ status: 'rejected', channel_id: null });
  });

  it('REPLAY of the same lead_id creates no second lead', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await hooks.googleReceive(KEY, payload(), {});
    const cursor = st.cursor;
    await hooks.googleReceive(KEY, payload(), {});
    expect(st.leads).toHaveLength(1);
    expect(st.cursor).toBe(cursor);
    expect(cst.events[1]).toMatchObject({ status: 'skipped' });
  });

  it("Google's TEST lead is verified and logged but creates nothing (default)", async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.googleReceive(KEY, payload({ is_test: true, lead_id: 'TEST-1' }), {});
    expect(out.http).toBe(200);                        // Google requires a 200 for "Send test data"
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped', external_key: 'TEST-1' });
    expect(cst.events[0].reason).toMatch(/test lead/i);
  });

  it('…unless the admin ticks "Import Google\'s test leads too"', async () => {
    const { hooks, st } = makeWebhook([channel({ ingest_test_leads: true })]);
    await hooks.googleReceive(KEY, payload({ is_test: true, lead_id: 'TEST-2' }), {});
    expect(st.leads).toHaveLength(1);
  });

  it('an unmappable payload (no phone) is a 200 + a failed event — Google must not retry forever', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.googleReceive(KEY, payload({
      lead_id: 'GL-BAD',
      user_column_data: [{ column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'No Phone' }],
    }), {});
    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'failed', external_key: 'GL-BAD' });
    expect(cst.events[0].reason).toMatch(/phone|mobile/i);
  });

  it('maps a custom lead-form question via the admin field_map', async () => {
    const { hooks, st } = makeWebhook([channel({ field_map: '{"Which course?":"course"}' })]);
    await hooks.googleReceive(KEY, payload({
      lead_id: 'GL-CF',
      user_column_data: [
        { column_id: 'FULL_NAME', column_name: 'Full name', string_value: 'Riya' },
        { column_id: 'PHONE_NUMBER', column_name: 'Phone number', string_value: '9811100007' },
        { column_id: 'CUSTOM_QUESTION_1', column_name: 'Which course?', string_value: 'IELTS' },
      ],
    }), {});
    expect(st.leads[0].course_id).toBe(21);            // resolved against the Course master by NAME
  });
});
