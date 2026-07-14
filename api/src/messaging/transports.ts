import { createHmac, timingSafeEqual } from 'crypto';
import { ResolvedConfig } from './channel-config.service';

/**
 * THE WIRE. One tiny class per provider; each turns "send this text to this address"
 * into that provider's HTTP/SMTP call and returns a normalised result.
 *
 * They are deliberately dumb: no DB, no settings lookup, no retry, no logging. All of
 * that lives in MessagingService/MessageWorker, so a transport can be unit-tested by
 * handing it a config and a fake `fetch`, and a new gateway never has to re-learn
 * retries, rate limits, opt-out or the send log.
 */

export interface OutboundMessage {
  to: string;                       // E.164 phone, or an email address
  subject?: string | null;
  body: string;                     // rendered text / HTML
  /** WhatsApp only — when set we send a TEMPLATE message, else a session message */
  wa_template_name?: string | null;
  wa_language?: string | null;
  wa_params?: string[];             // already-rendered positional params
  /** SMS only */
  sms_sender_id?: string | null;
  sms_dlt_template_id?: string | null;
}

export interface SendResult {
  provider_message_id?: string | null;
  response: Record<string, unknown>;
}

/** A provider rejected us for a reason that will never fix itself (bad token, bad number). */
export class PermanentSendError extends Error {
  readonly permanent = true;
  constructor(message: string, readonly response: Record<string, unknown> = {}) { super(message); }
}
/** Rate-limited / timeout / 5xx — retry with backoff. */
export class TransientSendError extends Error {
  readonly permanent = false;
  constructor(message: string, readonly response: Record<string, unknown> = {}) { super(message); }
}

export interface Transport {
  readonly key: string;
  send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult>;
}

/** 4xx (except 408/429) is the caller's fault and will not fix itself. */
const classify = (status: number, text: string, body: Record<string, unknown>) => {
  if (status === 408 || status === 429 || status >= 500) return new TransientSendError(text, body);
  return new PermanentSendError(text, body);
};

const asJson = (t: string): Record<string, unknown> => {
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : { raw: t }; } catch { return { raw: t.slice(0, 500) }; }
};

/* ============================== WhatsApp — Meta Cloud API ============================== */

export class MetaWhatsAppTransport implements Transport {
  readonly key = 'meta_cloud';
  constructor(private readonly http: typeof fetch = fetch) {}

  async send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult> {
    const version = String(cfg.config.api_version || 'v21.0');
    const phoneId = String(cfg.config.phone_number_id);
    const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
    // Meta wants the number WITHOUT the leading '+'
    const to = String(msg.to).replace(/^\+/, '');

    const payload: Record<string, unknown> = msg.wa_template_name
      ? {
        messaging_product: 'whatsapp', to, type: 'template',
        template: {
          name: msg.wa_template_name,
          language: { code: msg.wa_language || String(cfg.config.default_language || 'en') },
          // positional body params, already rendered against the lead
          components: (msg.wa_params ?? []).length
            ? [{ type: 'body', parameters: (msg.wa_params ?? []).map((t) => ({ type: 'text', text: t })) }]
            : [],
        },
      }
      // no template name => a SESSION message (only valid inside the 24-hour window; Meta
      // rejects it otherwise, and that rejection is permanent and is shown verbatim)
      : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: msg.body } };

    let res: Response;
    try {
      res = await this.http(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.secrets.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new TransientSendError(`WhatsApp network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const body = asJson(text);
    if (!res.ok) {
      const err = (body as any)?.error?.message || text || `HTTP ${res.status}`;
      throw classify(res.status, `WhatsApp: ${err}`, body);
    }
    const id = (body as any)?.messages?.[0]?.id ?? null;
    return { provider_message_id: id, response: body };
  }
}

/** Meta signs the delivery webhook exactly like the lead-ads one (Sprint 2). */
export function verifyMetaSignature(raw: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret)
    .update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ==================================== SMS ==================================== */

/** MSG91 — India, DLT-aware. */
export class Msg91Transport implements Transport {
  readonly key = 'msg91';
  constructor(private readonly http: typeof fetch = fetch) {}

  async send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult> {
    const payload = {
      sender: msg.sms_sender_id || cfg.config.sender_id,
      route: String(cfg.config.route || '4'),
      country: String(cfg.config.country || '91'),
      sms: [{ message: msg.body, to: [String(msg.to).replace(/^\+/, '')] }],
      DLT_TE_ID: msg.sms_dlt_template_id || undefined,
    };
    let res: Response;
    try {
      res = await this.http('https://api.msg91.com/api/v2/sendsms', {
        method: 'POST',
        headers: { authkey: cfg.secrets.authkey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new TransientSendError(`MSG91 network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const body = asJson(text);
    if (!res.ok) throw classify(res.status, `MSG91: ${text || res.status}`, body);
    if (String((body as any)?.type).toLowerCase() === 'error') {
      throw new PermanentSendError(`MSG91: ${(body as any)?.message ?? 'rejected'}`, body);
    }
    return { provider_message_id: (body as any)?.message ?? null, response: body };
  }
}

/** Twilio. */
export class TwilioTransport implements Transport {
  readonly key = 'twilio';
  constructor(private readonly http: typeof fetch = fetch) {}

  async send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult> {
    const sid = String(cfg.config.account_sid);
    const auth = Buffer.from(`${sid}:${cfg.secrets.auth_token}`).toString('base64');
    const form = new URLSearchParams({ To: msg.to, From: String(cfg.config.from), Body: msg.body });
    let res: Response;
    try {
      res = await this.http(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (e) {
      throw new TransientSendError(`Twilio network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const body = asJson(text);
    if (!res.ok) throw classify(res.status, `Twilio: ${(body as any)?.message ?? text}`, body);
    return { provider_message_id: (body as any)?.sid ?? null, response: body };
  }
}

/**
 * THE PROVIDER-AGNOSTIC SMS ADAPTER.
 *
 * The client has not chosen a gateway. Rather than guess, this adapter takes the URL,
 * the method and the body straight from Settings and substitutes {{to}} {{text}}
 * {{sender_id}} {{dlt_template_id}} {{api_key}}. Any Indian gateway with an HTTP API
 * works with zero code — which is precisely the requirement ("third-party API,
 * configured in Settings").
 */
export class GenericHttpSmsTransport implements Transport {
  readonly key = 'sms_http';
  constructor(private readonly http: typeof fetch = fetch) {}

  static substitute(tpl: string, vars: Record<string, string>, encode: boolean): string {
    return String(tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => {
      const v = vars[k] ?? '';
      return encode ? encodeURIComponent(v) : v;
    });
  }

  async send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult> {
    const vars: Record<string, string> = {
      to: msg.to,
      text: msg.body,
      sender_id: String(msg.sms_sender_id || cfg.config.sender_id || ''),
      dlt_template_id: String(msg.sms_dlt_template_id || ''),
      api_key: String(cfg.secrets.api_key ?? ''),
    };
    // the URL is a URL: its substitutions MUST be percent-encoded or a '&' in the
    // message text would silently forge a new query parameter.
    const url = GenericHttpSmsTransport.substitute(String(cfg.config.url ?? ''), vars, true);
    const method = String(cfg.config.method || 'GET').toUpperCase();
    const contentType = String(cfg.config.content_type || 'application/json');

    let headers: Record<string, string> = {};
    try {
      const h = cfg.config.headers ? JSON.parse(String(cfg.config.headers)) : {};
      if (h && typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) headers[k] = GenericHttpSmsTransport.substitute(String(v), vars, false);
      }
    } catch { headers = {}; }   // a malformed header JSON must not take the send down

    let body: string | undefined;
    if (method === 'POST') {
      body = GenericHttpSmsTransport.substitute(String(cfg.config.body ?? ''), vars,
        contentType === 'application/x-www-form-urlencoded');
      if (!headers['Content-Type']) headers['Content-Type'] = contentType;
    }

    let res: Response;
    try {
      res = await this.http(url, { method, headers, body });
    } catch (e) {
      throw new TransientSendError(`SMS gateway network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const payload = asJson(text);
    if (!res.ok) throw classify(res.status, `SMS gateway: ${text.slice(0, 200) || res.status}`, payload);

    // Some gateways answer 200 with "ERROR: invalid sender". If the admin told us what a
    // success looks like, we hold them to it.
    const marker = String(cfg.config.success_contains ?? '').trim();
    if (marker && !text.toLowerCase().includes(marker.toLowerCase())) {
      throw new PermanentSendError(`SMS gateway did not report success: ${text.slice(0, 200)}`, payload);
    }
    return { provider_message_id: (payload as any)?.message_id ?? (payload as any)?.id ?? null, response: payload };
  }
}

/* =================================== Email =================================== */

/** Injected so tests never open a socket. Matches nodemailer's createTransport shape. */
export type MailerFactory = (opts: Record<string, unknown>) => {
  sendMail(m: Record<string, unknown>): Promise<{ messageId?: string; response?: string; accepted?: unknown[]; rejected?: unknown[] }>;
};

export class SmtpTransport implements Transport {
  readonly key = 'smtp';
  constructor(private readonly factory?: MailerFactory) {}

  private async mailer(): Promise<MailerFactory> {
    if (this.factory) return this.factory;
    // required lazily: an API boot must not pay for nodemailer if nobody ever sends email
    const nodemailer = await import('nodemailer');
    return (opts) => (nodemailer as any).createTransport(opts);
  }

  async send(msg: OutboundMessage, cfg: ResolvedConfig): Promise<SendResult> {
    const create = await this.mailer();
    const port = Number(cfg.config.port || 587);
    const transporter = create({
      host: String(cfg.config.host),
      port,
      secure: cfg.config.secure === true || port === 465,
      auth: { user: cfg.secrets.username, pass: cfg.secrets.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    const from = cfg.config.from_name
      ? `"${String(cfg.config.from_name).replace(/"/g, '')}" <${cfg.config.from_email}>`
      : String(cfg.config.from_email);

    try {
      const info = await transporter.sendMail({
        from,
        to: msg.to,
        replyTo: cfg.config.reply_to || undefined,
        subject: msg.subject || '(no subject)',
        html: msg.body,
        // an HTML-only email scores badly with spam filters and is unreadable in a
        // text client; strip the tags for the alternative part.
        text: String(msg.body).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
      });
      // BOUNCE / FAILURE CAPTURE (synchronous half): the SMTP server can accept the
      // envelope but reject a recipient. `rejected` is exactly that, and it is a
      // permanent failure we must record rather than silently call "sent".
      if (Array.isArray(info.rejected) && info.rejected.length) {
        throw new PermanentSendError(`SMTP rejected the recipient: ${info.rejected.join(', ')}`,
          { rejected: info.rejected, response: info.response });
      }
      return {
        provider_message_id: info.messageId ?? null,
        response: { response: info.response ?? null, accepted: info.accepted ?? [] },
      };
    } catch (e) {
      if (e instanceof PermanentSendError) throw e;
      const err = e as Error & { responseCode?: number; code?: string };
      // 5xx SMTP codes and auth failures are permanent; connection blips are not.
      const code = Number(err.responseCode ?? 0);
      const permanent = (code >= 500 && code < 600) || err.code === 'EAUTH' || err.code === 'EENVELOPE';
      const message = `SMTP: ${err.message}`;
      throw permanent
        ? new PermanentSendError(message, { code: err.code ?? null, responseCode: code || null })
        : new TransientSendError(message, { code: err.code ?? null });
    }
  }
}

/* ================================= registry ================================= */

export const TRANSPORTS: Record<string, Transport> = {
  meta_cloud: new MetaWhatsAppTransport(),
  msg91: new Msg91Transport(),
  twilio: new TwilioTransport(),
  sms_http: new GenericHttpSmsTransport(),
  smtp: new SmtpTransport(),
};

export const transportFor = (provider: string): Transport | null => TRANSPORTS[provider] ?? null;
