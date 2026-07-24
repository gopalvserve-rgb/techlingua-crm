import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook } from './fake-channels.testkit';

const KEY = 'pubkeyPUSH';
const SECRET = 'WHKEY-abc123';

const channel = (config: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => makeChannel({
  id: 8, provider: 'indiamart', public_key: KEY,
  secrets: { webhook_key: SECRET },
  config: {
    field_map: '{"SENDER_NAME":"full_name","SENDER_MOBILE":"phone","SENDER_EMAIL":"email","QUERY_MESSAGE":"note"}',
    capture_extra: true,
    ...config,
  },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  SENDER_NAME: 'Ravi Kumar', SENDER_MOBILE: '9811100055', SENDER_EMAIL: 'ravi@example.com',
  QUERY_MESSAGE: 'Need details on IELTS', SENDER_CITY: 'Delhi', PRODUCT_NAME: 'IELTS Coaching', ...over,
});

describe('Generic push webhook (marketplaces / custom / webhook)', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('normalises a pushed payload via the field map and creates a lead through ingestion', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const out = await hooks.pushReceive(KEY, body(), { ip: '3.3.3.3' });

    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({
      full_name: 'Ravi Kumar', phone: '+919811100055', email: 'ravi@example.com',
      campaign_id: 5, source_id: 7,
    });
    expect(st.leads[0].owner_id).toBe(11);                       // distribution ran
    expect(cst.events[0]).toMatchObject({ status: 'ingested', provider: 'indiamart' });
  });

  it('"capture other fields" appends the unmapped fields (city / product) to the lead note', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await hooks.pushReceive(KEY, body(), { ip: '3.3.3.4' });
    const note = String(st.leads[0].note ?? '');
    expect(note).toContain('Need details on IELTS');           // the mapped message
    expect(note).toContain('SENDER_CITY: Delhi');              // an unmapped field, preserved
    expect(note).toContain('PRODUCT_NAME: IELTS Coaching');
  });

  it('with capture_extra OFF, unmapped fields are dropped (only the note stays)', async () => {
    const { hooks, st } = makeWebhook([channel({ capture_extra: false })]);
    await hooks.pushReceive(KEY, body(), { ip: '3.3.3.5' });
    const note = String(st.leads[0].note ?? '');
    expect(note).toBe('Need details on IELTS');
    expect(note).not.toContain('SENDER_CITY');
  });

  it('a WRONG webhook key (when supplied) is 401 and creates nothing', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    await expect(hooks.pushReceive(KEY, body({ key: 'WRONG' }), { ip: '3.3.3.6' }))
      .rejects.toMatchObject({ http: 401 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'rejected' });
  });

  it('the RIGHT webhook key in a header is accepted', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await hooks.pushReceive(KEY, body(), { ip: '3.3.3.7', apiKey: SECRET });
    expect(st.leads).toHaveLength(1);
  });

  it('no key supplied is allowed — the unguessable URL is the secret', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await hooks.pushReceive(KEY, body(), { ip: '3.3.3.8' });
    expect(st.leads).toHaveLength(1);
  });

  it('the shared-key fields (key / secret) are never written onto the lead', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await hooks.pushReceive(KEY, body({ key: SECRET }), { ip: '3.3.3.9' });
    const note = String(st.leads[0].note ?? '');
    expect(note).not.toContain(SECRET);
    expect(note).not.toContain('key:');
  });

  it('an unknown key is 404 and nothing is created', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    await expect(hooks.pushReceive('nope', body(), { ip: '3.3.4.0' }))
      .rejects.toMatchObject({ http: 404 });
    expect(st.leads).toHaveLength(0);
  });

  it('a paused integration logs the payload but creates no lead', async () => {
    const { hooks, st, cst } = makeWebhook([channel({}, { is_active: false })]);
    const out = await hooks.pushReceive(KEY, body(), { ip: '3.3.4.1' });
    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped' });
  });
});
