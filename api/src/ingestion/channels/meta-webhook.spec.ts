import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook, metaSign } from './fake-channels.testkit';
import { WebhookRejected } from './webhook.service';

const APP_SECRET = 'meta-app-secret-abc';
const VERIFY = 'verify-token-xyz';
const KEY = 'pubkeyMETA';

const channel = () => makeChannel({
  id: 1, provider: 'meta', public_key: KEY,
  secrets: { verify_token: VERIFY, app_secret: APP_SECRET, page_access_token: 'PAGE_TOKEN' },
  config: { graph_version: 'v21.0' },
});

/** A real Meta leadgen delivery. field_data is inlined (Lead Ads Testing Tool shape). */
const payload = (leadgenId = 'LG-1', fields?: any[]) => ({
  object: 'page',
  entry: [{
    id: '1010', time: 1752460000,
    changes: [{
      field: 'leadgen',
      value: {
        leadgen_id: leadgenId, page_id: '1010', form_id: 'F1', created_time: 1752460000,
        field_data: fields ?? [
          { name: 'full_name', values: ['Priya Sharma'] },
          { name: 'phone_number', values: ['+919811100001'] },
          { name: 'email', values: ['priya@example.com'] },
        ],
      },
    }],
  }],
});

describe('Meta Lead Ads webhook', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  // ---------------------------------------------------------- GET handshake

  it('GET handshake: the right verify token echoes hub.challenge and logs "verified"', async () => {
    const { hooks, cst } = makeWebhook([channel()]);
    const out = await hooks.metaVerify(KEY, {
      'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444',
    }, {});
    expect(out.http).toBe(200);
    expect(out.body).toBe('1158201444');           // the BARE challenge, not JSON
    expect(cst.events[0]).toMatchObject({ status: 'verified', signature_ok: true, method: 'GET' });
  });

  it('GET handshake: a wrong verify token is 403 and is logged as rejected', async () => {
    const { hooks, cst } = makeWebhook([channel()]);
    await expect(hooks.metaVerify(KEY, {
      'hub.mode': 'subscribe', 'hub.verify_token': 'WRONG', 'hub.challenge': 'c',
    }, {})).rejects.toMatchObject({ http: 403 });
    expect(cst.events[0]).toMatchObject({ status: 'rejected' });
    expect(cst.events[0].reason).toMatch(/verify_token does not match/);
  });

  it('GET handshake: an unknown webhook key is a 404, still logged', async () => {
    const { hooks, cst } = makeWebhook([channel()]);
    await expect(hooks.metaVerify('nope', { 'hub.mode': 'subscribe' }, {})).rejects.toMatchObject({ http: 404 });
    expect(cst.events[0]).toMatchObject({ status: 'rejected', channel_id: null });
  });

  // ------------------------------------------------------------- signature

  it('rejects a payload with NO signature (401) — an unsigned payload is never accepted', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body = payload();
    await expect(hooks.metaReceive(KEY, body, { rawBody: Buffer.from(JSON.stringify(body)) }))
      .rejects.toMatchObject({ http: 401 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'rejected', signature_ok: false });
    expect(cst.events[0].reason).toMatch(/Missing X-Hub-Signature-256/);
    expect(cst.events[0].raw).toMatchObject({ object: 'page' });   // payload kept verbatim
  });

  it('rejects a payload signed with the WRONG app secret (401)', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body = payload();
    const { raw, signature } = metaSign('not-the-app-secret', body);
    await expect(hooks.metaReceive(KEY, body, { rawBody: raw, signature }))
      .rejects.toMatchObject({ http: 401 });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0].reason).toMatch(/does not match/);
  });

  it('rejects a tampered body — the HMAC is over the RAW bytes', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    const good = payload();
    const { raw, signature } = metaSign(APP_SECRET, good);
    const tampered = payload('LG-EVIL');
    await expect(hooks.metaReceive(KEY, tampered, { rawBody: Buffer.from(JSON.stringify(tampered)), signature }))
      .rejects.toMatchObject({ http: 401 });
    expect(raw).toBeDefined();
    expect(st.leads).toHaveLength(0);
  });

  // -------------------------------------------------------------- the lead

  it('a VALID signed payload creates a lead through the shared ingestion pipeline', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body = payload('LG-100');
    const { raw, signature } = metaSign(APP_SECRET, body);

    const out = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });

    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0]).toMatchObject({
      full_name: 'Priya Sharma',
      phone: '+919811100001',           // normalised to E.164 by the pipeline
      campaign_id: 5, source_id: 7, branch_id: 2, vertical_id: 3, pipeline_id: 4,
    });
    expect(st.leads[0].owner_id).toBe(11);          // campaign distribution ran (round-robin)
    expect(st.audit).toHaveLength(1);               // audited even though nobody was logged in
    expect(cst.events[0]).toMatchObject({ status: 'ingested', signature_ok: true, external_key: 'LG-100' });
    expect(cst.events[0].lead_id).toBe(st.leads[0].id);
  });

  it('REPLAY of the same delivery creates NO second lead and does not move the round-robin cursor', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body = payload('LG-100');
    const { raw, signature } = metaSign(APP_SECRET, body);

    await hooks.metaReceive(KEY, body, { rawBody: raw, signature });
    const cursorAfterFirst = st.cursor;
    const second = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });

    expect(second.http).toBe(200);
    expect(st.leads).toHaveLength(1);               // the leadgen_id is the idempotency key
    expect(st.cursor).toBe(cursorAfterFirst);       // no second agent burned
    expect(cst.events[1]).toMatchObject({ status: 'skipped' });
    expect(cst.events[1].reason).toMatch(/Already imported/i);
  });

  it('fetches the lead fields from the Graph API when Meta sends only a leadgen_id', async () => {
    const { hooks, st } = makeWebhook([channel()]);
    const calls: string[] = [];
    hooks.http = async (url: string) => {
      calls.push(url);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          id: 'LG-200', created_time: '2026-07-14T10:00:00+0000',
          field_data: [
            { name: 'full_name', values: ['Graph Lead'] },
            { name: 'phone_number', values: ['9811100009'] },
          ],
        }),
      };
    };
    const body = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-200', page_id: '1010' } }] }] };
    const { raw, signature } = metaSign(APP_SECRET, body);

    const out = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });

    expect(out.http).toBe(200);
    expect(calls[0]).toContain('https://graph.facebook.com/v21.0/LG-200');
    expect(calls[0]).toContain('access_token=PAGE_TOKEN');
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0].full_name).toBe('Graph Lead');
  });

  it('a Graph API failure is 200 (Meta must not retry forever) + a failed event with the raw payload', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    hooks.http = async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"expired token"}}' });
    const body = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-300' } }] }] };
    const { raw, signature } = metaSign(APP_SECRET, body);

    const out = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });

    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'failed', signature_ok: true });
    expect(cst.events[0].reason).toMatch(/Graph API returned 400/);
    expect(cst.events[0].raw.entry).toBeDefined();     // replayable
  });

  it('a payload for another Facebook Page is refused when the channel is bound to one', async () => {
    const ch = channel();
    ch.config = { ...ch.config, page_id: '1010' };
    const { hooks, st, cst } = makeWebhook([ch]);
    const body = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'LG-X', page_id: '9999', field_data: [{ name: 'full_name', values: ['X'] }, { name: 'phone_number', values: ['9811100010'] }] } }] }] };
    const { raw, signature } = metaSign(APP_SECRET, body);

    await hooks.metaReceive(KEY, body, { rawBody: raw, signature });
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'failed' });
    expect(cst.events[0].reason).toMatch(/bound to Page 1010/);
  });

  it('a non-leadgen change (Meta sends other events) is a verified no-op, not an error', async () => {
    const { hooks, st, cst } = makeWebhook([channel()]);
    const body = { object: 'page', entry: [{ changes: [{ field: 'feed', value: { item: 'status' } }] }] };
    const { raw, signature } = metaSign(APP_SECRET, body);
    const out = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });
    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped' });
  });

  it('a channel with no app secret configured rejects everything (401) rather than trusting it', async () => {
    const ch = makeChannel({ id: 1, provider: 'meta', public_key: KEY, secrets: { verify_token: VERIFY } });
    const { hooks, cst } = makeWebhook([ch]);
    const body = payload();
    const { raw, signature } = metaSign(APP_SECRET, body);
    await expect(hooks.metaReceive(KEY, body, { rawBody: raw, signature })).rejects.toBeInstanceOf(WebhookRejected);
    expect(cst.events[0].reason).toMatch(/App secret not configured/);
  });

  it('a paused channel logs the payload and creates nothing', async () => {
    const ch = channel();
    ch.is_active = false;
    const { hooks, st, cst } = makeWebhook([ch]);
    const body = payload('LG-PAUSED');
    const { raw, signature } = metaSign(APP_SECRET, body);
    const out = await hooks.metaReceive(KEY, body, { rawBody: raw, signature });
    expect(out.http).toBe(200);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped' });
  });

  it('honours the campaign duplicate rule — a second leadgen with the same phone MERGES, no 2nd lead', async () => {
    const { hooks, st, cst } = makeWebhook([channel()], {
      duplicacy: { check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'merge' },
    });
    const first = payload('LG-A');
    const s1 = metaSign(APP_SECRET, first);
    await hooks.metaReceive(KEY, first, { rawBody: s1.raw, signature: s1.signature });

    // same phone, NEW leadgen id, and an email the first lead did not have
    const second = payload('LG-B', [
      { name: 'full_name', values: ['Priya S'] },
      { name: 'phone_number', values: ['+919811100001'] },
      { name: 'city', values: ['Delhi'] },
    ]);
    const s2 = metaSign(APP_SECRET, second);
    await hooks.metaReceive(KEY, second, { rawBody: s2.raw, signature: s2.signature });

    expect(st.leads).toHaveLength(1);                     // merged, not duplicated
    expect(st.merges).toHaveLength(1);
    expect(cst.events[1]).toMatchObject({ status: 'duplicate' });
    expect(cst.events[1].reason).toMatch(/merge/);
  });
});
