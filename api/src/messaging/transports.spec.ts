import {
  GenericHttpSmsTransport, MetaWhatsAppTransport, Msg91Transport, NimbusSmsTransport,
  PermanentSendError, SmtpTransport, TransientSendError, verifyMetaSignature,
} from './transports';
import { createHmac } from 'crypto';
import { ResolvedConfig } from './channel-config.service';

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
}) as unknown as Response;

const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  id: 1, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null,
  config: { phone_number_id: '123', api_version: 'v21.0' },
  secrets: { access_token: 'TOK' }, ...over,
});

describe('WhatsApp — Meta Cloud API', () => {
  it('sends a TEMPLATE message with positional body params', async () => {
    const calls: any[] = [];
    const http = (async (url: string, init: any) => { calls.push({ url, init }); return res(200, { messages: [{ id: 'wamid.X' }] }); }) as unknown as typeof fetch;
    const out = await new MetaWhatsAppTransport(http).send(
      { to: '+919810000001', body: '', wa_template_name: 'lead_welcome', wa_language: 'en', wa_params: ['Priya', 'IELTS'] },
      cfg(),
    );
    expect(out.provider_message_id).toBe('wamid.X');
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/123/messages');
    const body = JSON.parse(calls[0].init.body);
    expect(body.type).toBe('template');
    expect(body.to).toBe('919810000001');              // Meta wants NO leading '+'
    expect(body.template.name).toBe('lead_welcome');
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Priya' }, { type: 'text', text: 'IELTS' },
    ]);
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOK');
  });

  it('with no template name it sends a SESSION (free-form) text message', async () => {
    const calls: any[] = [];
    const http = (async (_u: string, init: any) => { calls.push(init); return res(200, { messages: [{ id: 'w1' }] }); }) as unknown as typeof fetch;
    await new MetaWhatsAppTransport(http).send({ to: '+919810000001', body: 'hello' }, cfg());
    const body = JSON.parse(calls[0].body);
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('hello');
  });

  it('a 400 from Graph is PERMANENT — retrying an invalid token forever helps nobody', async () => {
    const http = (async () => res(400, { error: { message: 'Invalid OAuth access token' } })) as unknown as typeof fetch;
    await expect(new MetaWhatsAppTransport(http).send({ to: '+91981', body: 'x' }, cfg()))
      .rejects.toBeInstanceOf(PermanentSendError);
  });

  it('a 429 / 500 is TRANSIENT — that one we retry', async () => {
    const t429 = (async () => res(429, { error: { message: 'rate limited' } })) as unknown as typeof fetch;
    await expect(new MetaWhatsAppTransport(t429).send({ to: '+91', body: 'x' }, cfg()))
      .rejects.toBeInstanceOf(TransientSendError);
    const t500 = (async () => res(503, 'unavailable')) as unknown as typeof fetch;
    await expect(new MetaWhatsAppTransport(t500).send({ to: '+91', body: 'x' }, cfg()))
      .rejects.toBeInstanceOf(TransientSendError);
  });

  it('a network failure is TRANSIENT, not a 500 in our own logs', async () => {
    const http = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(new MetaWhatsAppTransport(http).send({ to: '+91', body: 'x' }, cfg()))
      .rejects.toBeInstanceOf(TransientSendError);
  });
});

describe('the Meta delivery-webhook signature (same HMAC as the Sprint-2 lead webhook)', () => {
  const secret = 'appsecret';
  const raw = Buffer.from(JSON.stringify({ entry: [] }));
  const good = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

  it('accepts a correct signature', () => expect(verifyMetaSignature(raw, good, secret)).toBe(true));
  it('rejects a forged one', () => expect(verifyMetaSignature(raw, 'sha256=deadbeef', secret)).toBe(false));
  it('rejects a MISSING signature (an unsigned payload is an impostor)', () =>
    expect(verifyMetaSignature(raw, undefined, secret)).toBe(false));
  it('rejects when the body has been tampered with', () =>
    expect(verifyMetaSignature(Buffer.from('{"entry":[1]}'), good, secret)).toBe(false));
});

describe('SMS — the provider-agnostic HTTP adapter', () => {
  const smsCfg = (over: Record<string, unknown> = {}): ResolvedConfig => ({
    id: 2, channel: 'sms', provider: 'sms_http', vertical_id: null,
    config: {
      url: 'https://gw.example.com/send?key={{api_key}}&to={{to}}&text={{text}}',
      method: 'GET', sender_id: 'TCHLNG', ...over,
    },
    secrets: { api_key: 'K1' },
  });

  it('substitutes {{to}} {{text}} {{api_key}} into the URL', async () => {
    let seen = '';
    const http = (async (u: string) => { seen = u; return res(200, { message_id: 'm1' }); }) as unknown as typeof fetch;
    const out = await new GenericHttpSmsTransport(http).send({ to: '+919810000001', body: 'Hi Priya' }, smsCfg());
    expect(seen).toBe('https://gw.example.com/send?key=K1&to=%2B919810000001&text=Hi%20Priya');
    expect(out.provider_message_id).toBe('m1');
  });

  it('PERCENT-ENCODES url substitutions — an "&" in the message must not forge a query param', async () => {
    let seen = '';
    const http = (async (u: string) => { seen = u; return res(200, 'ok'); }) as unknown as typeof fetch;
    await new GenericHttpSmsTransport(http).send({ to: '+91', body: 'A&sender=EVIL' }, smsCfg());
    expect(seen).toContain('text=A%26sender%3DEVIL');
    expect(seen).not.toContain('&sender=EVIL');
  });

  it('POSTs a JSON body template with the DLT fields substituted', async () => {
    let init: any;
    const http = (async (_u: string, i: any) => { init = i; return res(200, { id: 'x' }); }) as unknown as typeof fetch;
    await new GenericHttpSmsTransport(http).send(
      { to: '+919810000001', body: 'Hi', sms_sender_id: 'TLDEMO', sms_dlt_template_id: '1207161' },
      smsCfg({
        url: 'https://gw.example.com/send', method: 'POST', content_type: 'application/json',
        body: '{"to":"{{to}}","message":"{{text}}","sender":"{{sender_id}}","dlt":"{{dlt_template_id}}"}',
      }),
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      to: '+919810000001', message: 'Hi', sender: 'TLDEMO', dlt: '1207161',
    });
  });

  it('honours the success marker: a 200 that says "ERROR" is a FAILURE, not a send', async () => {
    const http = (async () => res(200, 'ERROR: invalid sender id')) as unknown as typeof fetch;
    await expect(new GenericHttpSmsTransport(http).send({ to: '+91', body: 'x' }, smsCfg({ success_contains: 'success' })))
      .rejects.toThrow(/did not report success/);
  });

  it('a malformed extra-headers JSON is ignored, not fatal', async () => {
    const http = (async () => res(200, 'success')) as unknown as typeof fetch;
    await expect(new GenericHttpSmsTransport(http).send({ to: '+91', body: 'x' }, smsCfg({ headers: '{not json' })))
      .resolves.toBeTruthy();
  });

  it('MSG91: a 200 with type=error is a permanent rejection', async () => {
    const http = (async () => res(200, { type: 'error', message: 'Invalid authkey' })) as unknown as typeof fetch;
    await expect(new Msg91Transport(http).send({ to: '+919810000001', body: 'x' }, {
      id: 3, channel: 'sms', provider: 'msg91', vertical_id: null,
      config: { sender_id: 'TCHLNG' }, secrets: { authkey: 'bad' },
    })).rejects.toBeInstanceOf(PermanentSendError);
  });
});

describe('Email — SMTP', () => {
  const mailCfg: ResolvedConfig = {
    id: 4, channel: 'email', provider: 'smtp', vertical_id: 7,
    config: { host: 'smtp.zoho.in', port: 587, from_email: 'bcl@techlingua.in', from_name: 'BCL' },
    secrets: { username: 'u', password: 'p' },
  };

  it('sends HTML + a text alternative, with the From name', async () => {
    let sent: any;
    const t = new SmtpTransport(() => ({ sendMail: async (m: any) => { sent = m; return { messageId: '<abc>', accepted: ['x@y.com'] }; } }));
    const out = await t.send({ to: 'x@y.com', subject: 'Hi', body: '<p>Hello <b>Priya</b></p>' }, mailCfg);
    expect(out.provider_message_id).toBe('<abc>');
    expect(sent.from).toBe('"BCL" <bcl@techlingua.in>');
    expect(sent.html).toBe('<p>Hello <b>Priya</b></p>');
    expect(sent.text).toBe('Hello Priya');      // tags stripped for the plain-text part
  });

  it('BOUNCE CAPTURE: an SMTP-rejected recipient is a PERMANENT failure, never a silent "sent"', async () => {
    const t = new SmtpTransport(() => ({ sendMail: async () => ({ messageId: '<a>', accepted: [], rejected: ['nope@x.com'] }) }));
    await expect(t.send({ to: 'nope@x.com', subject: 's', body: 'b' }, mailCfg))
      .rejects.toBeInstanceOf(PermanentSendError);
  });

  it('an AUTH failure is permanent (a wrong password will still be wrong in 30 seconds)', async () => {
    const t = new SmtpTransport(() => ({
      sendMail: async () => { const e: any = new Error('Invalid login'); e.code = 'EAUTH'; throw e; },
    }));
    await expect(t.send({ to: 'x@y.com', subject: 's', body: 'b' }, mailCfg)).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('a connection blip is TRANSIENT — that one we retry', async () => {
    const t = new SmtpTransport(() => ({
      sendMail: async () => { const e: any = new Error('connect ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; },
    }));
    await expect(t.send({ to: 'x@y.com', subject: 's', body: 'b' }, mailCfg)).rejects.toBeInstanceOf(TransientSendError);
  });

  it('port 465 implies secure, without the admin having to know that', async () => {
    let opts: any;
    const t = new SmtpTransport((o) => { opts = o; return { sendMail: async () => ({ messageId: '1' }) }; });
    await t.send({ to: 'x@y.com', subject: 's', body: 'b' }, { ...mailCfg, config: { ...mailCfg.config, port: 465 } });
    expect(opts.secure).toBe(true);
  });
});

describe('SMS — Nimbus IT (DLT)', () => {
  const nimbusCfg = (over: Record<string, unknown> = {}): ResolvedConfig => ({
    id: 4, channel: 'sms', provider: 'nimbus', vertical_id: null,
    config: { user: 'techlingua', entityid: '1101234567890', sender_id: 'BRTISC', ...over },
    secrets: { authkey: '92wgQ8noCHyY' },
  });

  it('composes the pushsms URL: user/authkey/sender/mobile/text/entityid/templateid/rpt=1', async () => {
    let seen = '';
    const http = (async (u: string) => { seen = u; return res(200, '12345'); }) as unknown as typeof fetch;
    const out = await new NimbusSmsTransport(http).send(
      { to: '+917827878780', body: 'Dear Priya, interest in IELTS. - BCL',
        sms_sender_id: 'BRTISC', sms_dlt_template_id: '1707160000000000001' },
      nimbusCfg(),
    );
    expect(seen.startsWith('http://nimbusit.net/api/pushsms?')).toBe(true);
    expect(seen).toContain('user=techlingua');
    expect(seen).toContain('authkey=92wgQ8noCHyY');
    expect(seen).toContain('sender=BRTISC');
    expect(seen).toContain('mobile=917827878780');           // '+' stripped
    expect(seen).toContain('entityid=1101234567890');
    expect(seen).toContain('templateid=1707160000000000001');
    expect(seen).toContain('rpt=1');
    expect(seen).toContain('text=Dear%20Priya%2C%20interest%20in%20IELTS.%20-%20BCL');
    expect(seen).not.toContain('type=1');
    expect(out.provider_message_id).toBe('12345');
  });

  it('adds &type=1 when the text is unicode (non-GSM)', async () => {
    let seen = '';
    const http = (async (u: string) => { seen = u; return res(200, 'ok-1'); }) as unknown as typeof fetch;
    await new NimbusSmsTransport(http).send({ to: '+919810000001', body: 'प्रिय, IELTS' }, nimbusCfg());
    expect(seen).toContain('type=1');
  });

  it('the template Header wins as `sender` over the config default', async () => {
    let seen = '';
    const http = (async (u: string) => { seen = u; return res(200, 'ok'); }) as unknown as typeof fetch;
    await new NimbusSmsTransport(http).send(
      { to: '+919810000001', body: 'hi', sms_sender_id: 'INSTAI' }, nimbusCfg({ sender_id: 'BRTISC' }));
    expect(seen).toContain('sender=INSTAI');
  });

  it('a body carrying ERROR/Invalid is a PERMANENT failure (DLT/authkey rejection)', async () => {
    const http = (async () => res(200, 'ERROR: invalid template id')) as unknown as typeof fetch;
    await expect(new NimbusSmsTransport(http).send({ to: '+919810000001', body: 'hi' }, nimbusCfg()))
      .rejects.toBeInstanceOf(PermanentSendError);
  });

  it('a 5xx is TRANSIENT (retryable)', async () => {
    const http = (async () => res(503, 'busy')) as unknown as typeof fetch;
    await expect(new NimbusSmsTransport(http).send({ to: '+919810000001', body: 'hi' }, nimbusCfg()))
      .rejects.toBeInstanceOf(TransientSendError);
  });
});

