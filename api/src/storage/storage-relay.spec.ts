import { StorageService } from './storage.service';

/**
 * 22 Nov 2026 — "logo not able to update". The R2 bucket has no CORS rule, so the browser's
 * preflight for a direct PUT is refused and every browser upload failed. Uploads now go through
 * POST /storage/relay, which makes the same presigned PUT from the server. The relay must only
 * ever write to THIS bucket's endpoint with a signed link.
 */
const R2_ROW = {
  id: 42,
  config: { account_id: 'acc123', r2_bucket: 'techlingua' },
  secrets: { r2_access_key_id: 'AK', r2_secret_access_key: 'SK' },
};
const svc = () => new StorageService({ resolve: async () => R2_ROW } as any);

describe('storage relay', () => {
  const realFetch = global.fetch;
  let calls: Array<{ url: string; init: any }> = [];
  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => { calls.push({ url: String(url), init }); return { ok: true, status: 200 } as any; }) as any;
  });
  afterAll(() => { global.fetch = realFetch; });

  it('PUTs the bytes to a presigned link it signed itself, with the signed content type', async () => {
    const s = svc();
    const url = await s.presignPut('admission-forms/logo/x-logo.png', 'image/png');
    await s.relayPut(url, Buffer.from('png-bytes'), 'image/png');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers['Content-Type']).toBe('image/png');
  });

  it('refuses any other host, another bucket, an unsigned link, plain http and an empty file', async () => {
    const s = svc();
    const good = await s.presignPut('a/b.png', 'image/png');
    const sig = new URL(good).search;
    await expect(s.relayPut(`https://evil.example.com/techlingua/a/b.png${sig}`, Buffer.from('x'), 'image/png')).rejects.toThrow(/Not an upload link/);
    await expect(s.relayPut(`https://acc123.r2.cloudflarestorage.com/other-bucket/a/b.png${sig}`, Buffer.from('x'), 'image/png')).rejects.toThrow(/Not an upload link/);
    await expect(s.relayPut('https://acc123.r2.cloudflarestorage.com/techlingua/a/b.png', Buffer.from('x'), 'image/png')).rejects.toThrow(/Not an upload link/);
    await expect(s.relayPut(good.replace('https:', 'http:'), Buffer.from('x'), 'image/png')).rejects.toThrow(/Not an upload link/);
    await expect(s.relayPut('not a url', Buffer.from('x'), 'image/png')).rejects.toThrow(/Not an upload link/);
    await expect(s.relayPut(good, Buffer.alloc(0), 'image/png')).rejects.toThrow(/No file/);
    expect(calls).toHaveLength(0);
  });

  it('says plainly when storage refuses the write (an expired link)', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403 })) as any;
    const s = svc();
    const url = await s.presignPut('a/b.png', 'image/png');
    await expect(s.relayPut(url, Buffer.from('x'), 'image/png')).rejects.toThrow(/expired/);
  });
});

describe('POST /storage/relay — reading the file', () => {
  const { Readable } = require('stream');
  const { readRawBody, StorageController } = require('./storage.controller');
  const req = (chunks: Buffer[]) => { const r = Readable.from(chunks); (r as any).destroy = jest.fn(); return r; };

  it('reads the whole body as sent by the browser, in chunks', async () => {
    const body = await readRawBody(req([Buffer.from('ab'), Buffer.from('cd')]));
    expect(body.toString()).toBe('abcd');
  });

  it('refuses a file over the limit', async () => {
    await expect(readRawBody(req([Buffer.alloc(6), Buffer.alloc(6)]), 10)).rejects.toThrow(/too large/);
  });

  it('hands the bytes, the link and the content type to the storage relay', async () => {
    const seen: any[] = [];
    const ctl = new StorageController({ relayPut: async (...a: any[]) => { seen.push(a); } } as any);
    const out = await ctl.relay(req([Buffer.from('png')]) as any, 'https://signed', 'image/png');
    expect(out).toEqual({ ok: true, size: 3 });
    expect(seen[0][0]).toBe('https://signed');
    expect(seen[0][1].toString()).toBe('png');
    expect(seen[0][2]).toBe('image/png');
    await expect(ctl.relay(req([]) as any, undefined, 'image/png')).rejects.toThrow(/No upload link/);
  });
});
