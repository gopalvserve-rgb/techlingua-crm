/**
 * THE MESSAGING PROVIDER REGISTRY — the Settings framework's schema.
 *
 * This is the same idea as `ingestion/channels/providers.ts` (lead capture), applied
 * to outbound channels: a provider declares WHICH fields it needs, which of them are
 * SECRET, whether it is configured PER VERTICAL, and what the client has to do in the
 * provider's own console to get the values. The Settings UI is generated from this —
 * adding a gateway is ONE entry here, no migration and no UI work.
 *
 * The client has not sent credentials for ANY of these yet. That is a first-class
 * state, not an error: `missingRequirements()` drives the "Not configured" badge and
 * the NotConfiguredException (503 + the reason), and the channel lights up the moment
 * he pastes the values into Settings — no deploy.
 */

export type MsgChannel = 'email' | 'sms' | 'whatsapp' | 'payment' | 'ai';

export interface MsgFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'bool' | 'textarea' | 'select';
  hint?: string;
  placeholder?: string;
  required?: boolean;
  opts?: string[];
  /** minted by us if absent (the WhatsApp webhook verify token) */
  generated?: boolean;
}

export interface MsgProviderSpec {
  key: string;
  channel: MsgChannel;
  label: string;
  blurb: string;
  /**
   * TRUE => one row PER VERTICAL (falling back to an org-wide row).
   * Email is per-vertical because the project rules say SMTP is per vertical:
   * each course line sends from its own domain. Razorpay is per-vertical because
   * the client banks each vertical separately.
   */
  perVertical: boolean;
  config: MsgFieldSpec[];
  secrets: MsgFieldSpec[];
  /** verbatim instructions rendered in the UI — this is what Gopal follows */
  setup: string[];
}

const SPECS: MsgProviderSpec[] = [
  /* ------------------------------------------------------------------ EMAIL */
  {
    key: 'smtp',
    channel: 'email',
    label: 'SMTP (per vertical)',
    blurb: 'Send email through your own SMTP server. Configure one per vertical so each course line sends from its own domain and reputation.',
    perVertical: true,
    config: [
      { key: 'host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'smtp.zoho.in' },
      { key: 'port', label: 'Port', type: 'number', required: true, placeholder: '587', hint: '587 (STARTTLS) or 465 (SSL)' },
      { key: 'secure', label: 'Use SSL (port 465)', type: 'bool', hint: 'Leave OFF for port 587' },
      { key: 'from_email', label: 'From address', type: 'text', required: true, placeholder: 'admissions@techlingua.in' },
      { key: 'from_name', label: 'From name', type: 'text', placeholder: 'Tech Lingua Admissions' },
      { key: 'reply_to', label: 'Reply-To', type: 'text', placeholder: 'admissions@techlingua.in' },
    ],
    secrets: [
      { key: 'username', label: 'SMTP username', type: 'password', required: true },
      { key: 'password', label: 'SMTP password / app password', type: 'password', required: true },
    ],
    setup: [
      'In your mail provider (Zoho / Google Workspace / Microsoft 365), create or pick the mailbox this vertical sends from.',
      'Generate an APP PASSWORD for it — not the human login password.',
      'Paste host, port, the from address and the app password here, choose the Vertical, and press Send test email.',
      'Repeat for every vertical that must send from a different address.',
    ],
  },

  /* -------------------------------------------------------------------- SMS */
  {
    key: 'msg91',
    channel: 'sms',
    label: 'MSG91 (India, DLT)',
    blurb: 'India-first bulk SMS with DLT sender-id and template-id support.',
    perVertical: false,
    config: [
      { key: 'sender_id', label: 'DLT Sender ID', type: 'text', required: true, placeholder: 'TCHLNG', hint: '6 characters, approved on the DLT portal' },
      { key: 'route', label: 'Route', type: 'text', placeholder: '4', hint: '4 = transactional' },
      { key: 'country', label: 'Country code', type: 'text', placeholder: '91' },
    ],
    secrets: [{ key: 'authkey', label: 'Auth Key', type: 'password', required: true }],
    setup: [
      'Log in to MSG91 › Settings › API keys and copy the Auth Key.',
      'Register your Sender ID and every SMS template on the DLT portal (this is a legal requirement in India).',
      'Paste the Auth Key + Sender ID here. Put each approved DLT template id on its template in Message Templates.',
    ],
  },
  {
    key: 'sms_http',
    channel: 'sms',
    label: 'Any SMS gateway (generic HTTP)',
    blurb: 'Provider-agnostic adapter: give us the URL and the body, and we substitute {{to}}, {{text}}, {{sender_id}} and {{dlt_template_id}}. Works with any Indian gateway that exposes an HTTP API.',
    perVertical: false,
    config: [
      { key: 'url', label: 'Endpoint URL', type: 'text', required: true, placeholder: 'https://api.gateway.com/send?to={{to}}&text={{text}}' },
      { key: 'method', label: 'Method', type: 'select', opts: ['GET', 'POST'], required: true },
      { key: 'content_type', label: 'Content type', type: 'select', opts: ['application/json', 'application/x-www-form-urlencoded'] },
      { key: 'body', label: 'Request body template', type: 'textarea', placeholder: '{"to":"{{to}}","message":"{{text}}","sender":"{{sender_id}}"}', hint: 'POST only. {{to}} {{text}} {{sender_id}} {{dlt_template_id}} are substituted.' },
      { key: 'headers', label: 'Extra headers (JSON)', type: 'textarea', placeholder: '{"Content-Type":"application/json"}' },
      { key: 'sender_id', label: 'Default DLT Sender ID', type: 'text', placeholder: 'TCHLNG' },
      { key: 'success_contains', label: 'Success marker', type: 'text', placeholder: 'success', hint: 'If the response body contains this, we treat the send as accepted. Leave blank to accept any 2xx.' },
    ],
    secrets: [
      { key: 'api_key', label: 'API key / token', type: 'password', required: true, hint: 'Available in the URL/body/headers as {{api_key}}' },
    ],
    setup: [
      'Open your SMS gateway\'s API documentation and find the "send SMS" HTTP endpoint.',
      'Paste the URL here. Use {{to}}, {{text}}, {{sender_id}}, {{dlt_template_id}} and {{api_key}} wherever the gateway expects those values.',
      'Paste the API key into the API key box (it is encrypted at rest and never shown again).',
      'Press Send test SMS to your own number.',
    ],
  },
  {
    key: 'twilio',
    channel: 'sms',
    label: 'Twilio',
    blurb: 'International SMS via Twilio.',
    perVertical: false,
    config: [
      { key: 'account_sid', label: 'Account SID', type: 'text', required: true },
      { key: 'from', label: 'From number', type: 'text', required: true, placeholder: '+15005550006' },
    ],
    secrets: [{ key: 'auth_token', label: 'Auth Token', type: 'password', required: true }],
    setup: [
      'Twilio console › Account Info: copy the Account SID and the Auth Token.',
      'Copy a Twilio phone number capable of SMS into "From number".',
    ],
  },

  /* --------------------------------------------------------------- WHATSAPP */
  {
    key: 'meta_cloud',
    channel: 'whatsapp',
    label: 'WhatsApp — Meta Cloud API',
    blurb: 'Send approved template messages and (within the 24h window) free-form session messages. Delivery/read receipts and STOP replies arrive on the webhook.',
    perVertical: false,
    config: [
      { key: 'phone_number_id', label: 'Phone number ID', type: 'text', required: true, hint: 'Meta › WhatsApp › API Setup' },
      { key: 'waba_id', label: 'WhatsApp Business Account ID', type: 'text' },
      { key: 'api_version', label: 'Graph API version', type: 'text', placeholder: 'v21.0' },
      { key: 'default_language', label: 'Default template language', type: 'text', placeholder: 'en' },
    ],
    secrets: [
      { key: 'access_token', label: 'Permanent access token', type: 'password', required: true, hint: 'System-user token with whatsapp_business_messaging' },
      { key: 'app_secret', label: 'App secret', type: 'password', hint: 'Used to verify the X-Hub-Signature-256 on the delivery webhook' },
      { key: 'verify_token', label: 'Webhook verify token', type: 'password', generated: true, hint: 'We generate this — paste it into Meta' },
    ],
    setup: [
      'Meta for Developers › your app › WhatsApp › API Setup: copy the Phone number ID and the WhatsApp Business Account ID.',
      'Create a SYSTEM USER with a PERMANENT access token holding whatsapp_business_messaging + whatsapp_business_management. (The 24-hour test token will stop working tomorrow.)',
      'App Settings › Basic: copy the App Secret.',
      'Paste all three here and Save. We then show you a Callback URL and a Verify Token.',
      'Meta › WhatsApp › Configuration › Webhook: paste that Callback URL + Verify Token, and subscribe to the "messages" field.',
      'Get your message templates APPROVED in Meta, then create a matching template here with the same name.',
    ],
  },

  /* ---------------------------------------------------------------- PAYMENT */
  {
    key: 'razorpay',
    channel: 'payment',
    label: 'Razorpay (per vertical)',
    blurb: 'Vertical-wise payment gateway. Stored now; fee collection uses it in Sprint 5 / Phase 3.',
    perVertical: true,
    config: [
      { key: 'key_id', label: 'Key ID', type: 'text', required: true, placeholder: 'rzp_live_xxxxxxxx' },
      { key: 'currency', label: 'Currency', type: 'text', placeholder: 'INR' },
      { key: 'account_label', label: 'Settlement account label', type: 'text', hint: 'Free text — which bank account this vertical settles to' },
    ],
    secrets: [
      { key: 'key_secret', label: 'Key Secret', type: 'password', required: true },
      { key: 'webhook_secret', label: 'Webhook secret', type: 'password' },
    ],
    setup: [
      'Razorpay Dashboard › Settings › API Keys › Generate Key. Copy the Key ID and Key Secret.',
      'Choose the Vertical this account belongs to and Save. Repeat per vertical.',
      'Razorpay › Settings › Webhooks: add a webhook and copy its secret here (needed in Phase 3).',
    ],
  },

  /* --------------------------------------------------------------------- AI */
  {
    key: 'deepseek',
    channel: 'ai',
    label: 'DeepSeek',
    blurb: 'AI key placeholder — used by the Phase-2 AI features (lead insights, call summaries).',
    perVertical: false,
    config: [
      { key: 'model', label: 'Model', type: 'text', placeholder: 'deepseek-chat' },
      { key: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://api.deepseek.com' },
    ],
    secrets: [{ key: 'api_key', label: 'API key', type: 'password', required: true }],
    setup: ['DeepSeek platform › API keys › Create new key. Paste it here.'],
  },
  {
    key: 'gemini',
    channel: 'ai',
    label: 'Google Gemini',
    blurb: 'AI key placeholder — used by the Phase-2 AI features.',
    perVertical: false,
    config: [{ key: 'model', label: 'Model', type: 'text', placeholder: 'gemini-2.0-flash' }],
    secrets: [{ key: 'api_key', label: 'API key', type: 'password', required: true }],
    setup: ['Google AI Studio › Get API key. Paste it here.'],
  },
];

export const MSG_PROVIDERS: Record<string, MsgProviderSpec> = Object.fromEntries(SPECS.map((s) => [s.key, s]));

export const providersFor = (channel: MsgChannel): MsgProviderSpec[] => SPECS.filter((s) => s.channel === channel);

/** The channels that actually SEND a message (as opposed to payment/AI config). */
export const SENDING_CHANNELS: MsgChannel[] = ['email', 'sms', 'whatsapp'];

/**
 * Which required fields are still empty. An empty array = configured.
 * `generated` secrets never count as missing — we mint them ourselves.
 */
export function missingRequirements(
  provider: string,
  config: Record<string, unknown>,
  presentSecretKeys: string[],
): string[] {
  const spec = MSG_PROVIDERS[provider];
  if (!spec) return [`Unknown provider "${provider}"`];
  const missing: string[] = [];
  for (const f of spec.config) {
    if (!f.required) continue;
    const v = config?.[f.key];
    if (v === undefined || v === null || v === '') missing.push(f.label);
  }
  for (const f of spec.secrets) {
    if (!f.required || f.generated) continue;
    if (!presentSecretKeys.includes(f.key)) missing.push(f.label);
  }
  return missing;
}
