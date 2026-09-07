import { adaptMarketplace } from './source-adapters';

describe('marketplace source adapters', () => {
  it('IndiaMART single: maps name/phone/email + UNIQUE_QUERY_ID as source_ref', () => {
    const r = adaptMarketplace('indiamart', {
      SENDER_NAME: 'Asha Rao', SENDER_MOBILE: '9876543210', SENDER_EMAIL: 'a@x.com',
      UNIQUE_QUERY_ID: 'IM-1', QUERY_MESSAGE: 'Need IELTS', SENDER_CITY: 'Pune',
    });
    expect(r).toHaveLength(1);
    expect(r[0].full_name).toBe('Asha Rao');
    expect(r[0].phone).toBe('9876543210');
    expect(r[0].email).toBe('a@x.com');
    expect(r[0].external_id).toBe('IM-1');
    expect(r[0].note).toContain('Need IELTS');
  });

  it('IndiaMART batch RESPONSE[] fans out to multiple leads', () => {
    const r = adaptMarketplace('indiamart', { RESPONSE: [
      { SENDER_NAME: 'A', SENDER_MOBILE: '111', UNIQUE_QUERY_ID: 'q1' },
      { SENDER_NAME: 'B', SENDER_MOBILE: '222', UNIQUE_QUERY_ID: 'q2' },
    ]});
    expect(r).toHaveLength(2);
    expect(r[1].external_id).toBe('q2');
  });

  it('JustDial: mobile + leadid', () => {
    const r = adaptMarketplace('justdial', { name: 'Ravi', mobile: '9000000000', leadid: 'JD-9', city: 'Delhi' });
    expect(r[0].full_name).toBe('Ravi');
    expect(r[0].external_id).toBe('JD-9');
  });

  it('TradeIndia webhook: GLUSR fields + QUERY_ID', () => {
    const r = adaptMarketplace('tradeindia', { GLUSR_USR_FNAME: 'Sam', GLUSR_USR_PHONE: '8000000000', QUERY_ID: 'TI-3' });
    expect(r[0].full_name).toBe('Sam');
    expect(r[0].external_id).toBe('TI-3');
  });

  it('unknown source falls back to generic name/phone', () => {
    const r = adaptMarketplace('magicbricks', { name: 'Neha', mobile: '7000000000', id: 'MB-2' });
    expect(r[0].full_name).toBe('Neha');
    expect(r[0].external_id).toBe('MB-2');
  });

  it('drops records with neither name nor phone', () => {
    expect(adaptMarketplace('indiamart', { QUERY_MESSAGE: 'hi' })).toHaveLength(0);
  });
});

describe('WhatsApp inbound parse', () => {
  const { parseWhatsApp, tradeIndiaRows, buildFbAuthUrl, parseFbPages, FB_SCOPES } = require('./source-adapters');

  it('flattens a Cloud API text message with the contact name', () => {
    const body = { entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '919812345678', profile: { name: 'Neha' } }],
      messages: [{ from: '919812345678', id: 'wamid.ABC', type: 'text', text: { body: 'Hi, course info?' } }],
    } }] }] };
    const msgs = parseWhatsApp(body);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ phone: '919812345678', text: 'Hi, course info?', name: 'Neha', wamid: 'wamid.ABC' });
  });

  it('uses interactive/button titles and a type fallback; ignores status callbacks', () => {
    const body = { entry: [{ changes: [{ value: {
      messages: [
        { from: '911111111111', id: 'w1', type: 'button', button: { text: 'Yes' } },
        { from: '912222222222', id: 'w2', type: 'image' },
      ],
    } }] }] };
    const msgs = parseWhatsApp(body);
    expect(msgs.map((m: any) => m.text)).toEqual(['Yes', '[image]']);
    // a delivery/status-only payload yields nothing
    expect(parseWhatsApp({ entry: [{ changes: [{ value: { statuses: [{ id: 's1', status: 'delivered' }] } }] }] })).toHaveLength(0);
  });

  it('returns [] for junk', () => {
    expect(parseWhatsApp(null)).toEqual([]);
    expect(parseWhatsApp({})).toEqual([]);
  });

  it('tradeIndiaRows tolerates array, {data:[]}, {RESPONSE:[]} and a single object', () => {
    expect(tradeIndiaRows([{ a: 1 }])).toHaveLength(1);
    expect(tradeIndiaRows({ data: [{ a: 1 }, { b: 2 }] })).toHaveLength(2);
    expect(tradeIndiaRows({ RESPONSE: [{ a: 1 }] })).toHaveLength(1);
    expect(tradeIndiaRows({ QUERY_ID: 'Q1' })).toHaveLength(1);
    expect(tradeIndiaRows(null)).toEqual([]);
  });

  it('a TradeIndia row adapts to a lead with QUERY_ID as source_ref', () => {
    const rows = tradeIndiaRows({ RESPONSE: [
      { GLUSR_USR_FNAME: 'Sam', GLUSR_USR_PHONE: '9000000001', QUERY_ID: 'TI-7', PRODUCT: 'Spanish A1' },
    ] });
    const { adaptMarketplace } = require('./source-adapters');
    const p = rows.flatMap((r: any) => adaptMarketplace('tradeindia', r));
    expect(p[0].full_name).toBe('Sam');
    expect(p[0].external_id).toBe('TI-7');
    expect(p[0].note).toContain('Spanish A1');
  });

  it('buildFbAuthUrl carries client_id, redirect_uri, state and the leadgen scopes', () => {
    const url = buildFbAuthUrl('APPID', 'https://x/cb', 'STATE123');
    expect(url).toContain('client_id=APPID');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fx%2Fcb');
    expect(url).toContain('state=STATE123');
    expect(url).toContain('leads_retrieval');
    expect(FB_SCOPES).toContain('pages_show_list');
  });

  it('parseFbPages keeps only pages that carry an access_token', () => {
    const pages = parseFbPages({ data: [
      { id: '1', name: 'Alpha', access_token: 'tokA' },
      { id: '2', name: 'NoToken' },
    ] });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page_id: '1', page_name: 'Alpha', access_token: 'tokA' });
  });
});
