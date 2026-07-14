import { resetSecretKeyCache } from '../../common/crypto.util';
import { makeChannel, makeWebhook } from './fake-channels.testkit';
import { SheetWorker } from './sheet.worker';
import { SheetNotConfiguredError, SheetsClient } from './sheets.client';

const KEY = 'pubkeySHEET';

const channel = (over: { config?: Record<string, unknown>; secrets?: Record<string, string>; cursor?: any } = {}) =>
  makeChannel({
    id: 4, provider: 'google_sheet', public_key: KEY,
    secrets: over.secrets ?? { api_key: 'AIza-test-key' },
    config: { sheet_id: 'SHEET-1', range: 'Sheet1!A:Z', poll_minutes: 15, ...(over.config ?? {}) },
    cursor: over.cursor ?? {},
  } as any);

const GRID = [
  ['Name', 'Mobile', 'Email', 'Course'],
  ['Asha Rao', '9811100001', 'asha@example.com', 'IELTS'],
  ['Ravi Kumar', '9811100002', 'ravi@example.com', 'Spoken English'],
];

/** Stub the Sheets HTTP call — the tests never touch the network. */
function withGrid(hooks: any, grid: string[][]) {
  hooks.sheets.http = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ values: grid }) });
}

describe('Google Sheet pull', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  // ------------------------------------------------ the "no credentials" state

  it('NOT CONFIGURED (no Google credentials yet): the poll is skipped cleanly — never a crash', async () => {
    const ch = channel({ secrets: {} });                    // exactly today's reality
    const { hooks, st, cst } = makeWebhook([ch]);
    const out = await hooks.pollSheet(ch);

    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/not configured/i);
    expect(st.leads).toHaveLength(0);
    expect(cst.events[0]).toMatchObject({ status: 'skipped', provider: 'google_sheet', method: 'POLL' });
    expect(ch.next_poll_at).toBeTruthy();                   // and it re-schedules itself
  });

  it('NOT CONFIGURED: no sheet id is the same clean skip', async () => {
    const ch = channel({ config: { sheet_id: '' } });
    const { hooks } = makeWebhook([ch]);
    const out = await hooks.pollSheet(ch);
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/not configured/i);
  });

  it('the worker tick survives a channel that throws, and never takes the API down', async () => {
    const ch = channel({ secrets: {} });
    const { db, hooks } = makeWebhook([ch]);
    const worker = new SheetWorker(db, hooks);
    (worker as any).claim = async () => [ch];
    hooks.pollSheet = async () => { throw new Error('boom'); };
    await expect(worker.tick()).resolves.toBe(1);
  });

  it('the ChannelService reports exactly WHAT is missing (drives the UI + the 503)', async () => {
    const ch = channel({ secrets: {}, config: { sheet_id: '' } });
    const { channelSvc } = makeWebhook([ch]);
    const missing = channelSvc.missing(ch);
    expect(missing).toEqual(expect.arrayContaining([
      'Spreadsheet ID', 'Google credentials (service-account JSON or API key)',
    ]));
    expect(channelSvc.isConfigured(ch)).toBe(false);
    expect(channelSvc.isConfigured(channel())).toBe(true);   // lights up the moment a key is pasted
  });

  // -------------------------------------------------------------- the pull

  it('ingests every new row and advances the cursor', async () => {
    const ch = channel();
    const { hooks, st, cst } = makeWebhook([ch]);
    withGrid(hooks, GRID);

    const out = await hooks.pollSheet(ch);

    expect(out).toMatchObject({ status: 'ingested', read: 2, created: 2, last_row: 3 });
    expect(st.leads).toHaveLength(2);
    expect(st.leads[0]).toMatchObject({ full_name: 'Asha Rao', phone: '+919811100001', campaign_id: 5, source_id: 7 });
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 12]);      // distribution ran
    expect(ch.cursor).toEqual({ last_row: 3 });
    expect(cst.events[0]).toMatchObject({ status: 'ingested' });
  });

  it('CURSOR: a second poll over the same sheet re-ingests NOTHING', async () => {
    const ch = channel();
    const { hooks, st } = makeWebhook([ch]);
    withGrid(hooks, GRID);

    await hooks.pollSheet(ch);
    const cursorAfter = st.cursor;
    const second = await hooks.pollSheet(ch);

    expect(second).toMatchObject({ status: 'skipped', read: 0 });
    expect(second.reason).toMatch(/No new rows/);
    expect(st.leads).toHaveLength(2);                 // still two
    expect(st.cursor).toBe(cursorAfter);              // round-robin cursor untouched
  });

  it('only a NEWLY APPENDED row is ingested on the next poll', async () => {
    const ch = channel();
    const { hooks, st } = makeWebhook([ch]);
    withGrid(hooks, GRID);
    await hooks.pollSheet(ch);

    withGrid(hooks, [...GRID, ['Sunil M', '9811100005', 's@example.com', 'IELTS']]);
    const out = await hooks.pollSheet(ch);

    expect(out).toMatchObject({ status: 'ingested', read: 1, created: 1, last_row: 4 });
    expect(st.leads).toHaveLength(3);
    expect(st.leads[2].full_name).toBe('Sunil M');
  });

  it('even with the cursor RESET by hand, the ingest ledger stops a re-import', async () => {
    const ch = channel();
    const { hooks, st } = makeWebhook([ch]);
    withGrid(hooks, GRID);
    await hooks.pollSheet(ch);

    ch.cursor = {};                                   // simulate a manual cursor reset
    const out = await hooks.pollSheet(ch);

    expect(out.read).toBe(2);
    expect(out.skipped).toBe(2);                      // idempotency ledger: sheet:<id>:<row>
    expect(out.created).toBe(0);
    expect(st.leads).toHaveLength(2);                 // NO duplicates
  });

  it('blank rows are stepped over, a bad row is counted and the poll carries on', async () => {
    const ch = channel();
    const { hooks, st, cst } = makeWebhook([ch]);
    withGrid(hooks, [
      ['Name', 'Mobile'],
      ['Asha Rao', '9811100001'],
      ['', ''],                                       // blank
      ['Broken', '12'],                               // invalid phone
      ['Ravi Kumar', '9811100002'],
    ]);
    const out = await hooks.pollSheet(ch);

    expect(out).toMatchObject({ created: 2, failed: 1 });
    expect(st.leads).toHaveLength(2);
    expect(cst.events[0].status).toBe('ingested');
    expect(ch.cursor).toEqual({ last_row: 5 });       // the bad row does not wedge the cursor
  });

  it('honours the campaign duplicate rule on a re-entered phone', async () => {
    const ch = channel();
    const { hooks, st } = makeWebhook([ch], {
      duplicacy: { check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'merge' },
    });
    withGrid(hooks, [
      ['Name', 'Mobile', 'Email'],
      ['Asha Rao', '9811100001', ''],
      ['Asha R', '9811100001', 'asha@example.com'],  // same phone, fills the blank email
    ]);
    const out = await hooks.pollSheet(ch);
    expect(out).toMatchObject({ created: 1, duplicate: 1 });
    expect(st.leads).toHaveLength(1);
    expect(st.leads[0].email).toBe('asha@example.com');   // merged, non-destructively
  });

  it('a paused channel is skipped', async () => {
    const ch = channel();
    ch.is_active = false;
    const { hooks, st } = makeWebhook([ch]);
    withGrid(hooks, GRID);
    const out = await hooks.pollSheet(ch);
    expect(out.status).toBe('skipped');
    expect(st.leads).toHaveLength(0);
  });

  it('a Google API error is a failed event, not a crash', async () => {
    const ch = channel();
    const { hooks, cst } = makeWebhook([ch]);
    hooks.sheets.http = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
    const out = await hooks.pollSheet(ch);
    expect(out.status).toBe('failed');
    expect(out.reason).toMatch(/403/);
    expect(cst.events[0]).toMatchObject({ status: 'failed' });
  });
});

describe('SheetsClient', () => {
  it('throws SheetNotConfiguredError with no credentials at all', async () => {
    const c = new SheetsClient();
    await expect(c.readValues('S1', 'A:Z', {})).rejects.toBeInstanceOf(SheetNotConfiguredError);
    await expect(c.readValues('', 'A:Z', { api_key: 'k' })).rejects.toBeInstanceOf(SheetNotConfiguredError);
  });

  it('rejects a service-account JSON that is not JSON — with a readable message', async () => {
    const c = new SheetsClient();
    await expect(c.readValues('S1', 'A:Z', { service_account_json: 'not json' }))
      .rejects.toThrow(/not valid JSON/);
  });

  it('uses the API key as a query param when there is no service account', async () => {
    const c = new SheetsClient();
    const urls: string[] = [];
    c.http = async (u: string) => { urls.push(u); return { ok: true, status: 200, text: async () => '{"values":[["A"]]}' }; };
    const rows = await c.readValues('SHEET-1', 'Sheet1!A:Z', { api_key: 'AIza-x' });
    expect(rows).toEqual([['A']]);
    expect(urls[0]).toContain('/v4/spreadsheets/SHEET-1/values/');
    expect(urls[0]).toContain('key=AIza-x');
  });

  it('exchanges a service-account JWT for a bearer token, then reads with it', async () => {
    const { generateKeyPairSync } = require('crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sa = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem });

    const c = new SheetsClient();
    const seen: Array<{ url: string; auth?: string }> = [];
    c.http = async (url: string, init?: any) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, text: async () => '{"access_token":"ya29.TOKEN","expires_in":3600}' };
      }
      return { ok: true, status: 200, text: async () => '{"values":[["Name"],["Asha"]]}' };
    };

    const rows = await c.readValues('SHEET-1', 'A:Z', { service_account_json: sa });
    expect(rows).toEqual([['Name'], ['Asha']]);
    expect(seen[0].url).toContain('oauth2.googleapis.com');
    expect(seen[1].auth).toBe('Bearer ya29.TOKEN');
    expect(seen[1].url).not.toContain('key=');           // no API key in the URL
  });
});
