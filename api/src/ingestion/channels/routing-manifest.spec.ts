import { createHash } from 'crypto';
import { RoutingManifestService } from './routing-manifest.service';

/** SmartCRM routing manifest (spec v1, Nov 2026). */
describe('RoutingManifestService', () => {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const chan = (id: number, key: string, pages: any[], tokens: string[]) => ({
    id, public_key: key, config: { pages }, secrets: Object.fromEntries(tokens.map((p) => [`page_token_${p}`, 'enc'])),
  });
  const make = (opts: { appSecret?: string; mapped?: any[] } = {}) => {
    const chans: Record<number, any> = {
      37: chan(37, 'KEY37', [{ page_id: '1418092348302183', page_name: 'BCL', monitored: true }], ['1418092348302183']),
      38: chan(38, 'KEY38', [
        { page_id: '1418092348302183', page_name: 'BCL', monitored: true },
        { page_id: '540316859753104', page_name: 'Insta', monitored: true },
        { page_id: '999', page_name: 'Not monitored', monitored: false },
        { page_id: '777', page_name: 'No token', monitored: true },
      ], ['1418092348302183', '540316859753104']),
    };
    const db = {
      one: async (sql: string) => {
        if (/routing_manifest_token_sha256/.test(sql)) return { value: sha('good-token') };
        return { config: { numbers: [{ phone_number_id: '1391081340747771', verified_name: 'BCL', status: 'CONNECTED' }, { phone_number_id: 'x' }] } };
      },
      query: async (sql: string) => (/fb_form_mapping/.test(sql)
        ? (opts.mapped ?? [{ channel_id: '37', page_id: '1418092348302183', n: '4' }])
        : [{ id: '37' }, { id: '38' }]),
    };
    const channels = { raw: async (id: number) => chans[id], secretsOf: (r: any) => r.secrets };
    const hooks = { fbAppCreds: async () => ({ appSecret: opts.appSecret ?? 'secret' }) };
    return new RoutingManifestService(db as never, channels as never, hooks as never);
  };

  it('accepts only the issued bearer token', async () => {
    const s = make();
    expect(await s.authorised('Bearer good-token')).toBe(true);
    expect(await s.authorised('Bearer wrong')).toBe(false);
    expect(await s.authorised(undefined)).toBe(false);
  });

  it('lists each monitored page once, under the channel whose forms are mapped, with paths not URLs', async () => {
    const m = await make().build('connect.techlingua.net');
    expect(m.destination).toBe('connect.techlingua.net');
    const bcl = m.meta_pages.find((p) => p.page_id === '1418092348302183')!;
    expect(m.meta_pages.filter((p) => p.page_id === '1418092348302183')).toHaveLength(1);
    expect(bcl.webhook_path).toBe('/api/webhooks/meta/KEY37');
    expect(m.meta_pages.find((p) => p.page_id === '540316859753104')!.webhook_path).toBe('/api/webhooks/meta/KEY38');
    expect(m.meta_pages.some((p) => p.page_id === '999')).toBe(false);
    expect(m.meta_pages.find((p) => p.page_id === '777')!.ready).toBe(false);
    expect(m.whatsapp_numbers).toEqual([{ phone_number_id: '1391081340747771', display_name: 'BCL', webhook_path: '/api/webhooks/whatsapp', ready: true }]);
  });

  it('marks nothing ready without the shared app secret', async () => {
    const m = await make({ appSecret: '' }).build('connect.techlingua.net');
    expect(m.meta_pages.every((p) => !p.ready)).toBe(true);
  });
});
