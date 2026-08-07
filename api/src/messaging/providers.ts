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

export type MsgChannel = 'email' | 'sms' | 'whatsapp' | 'payment' | 'ai' | 'calendar' | 'storage';

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
  /**
   * How "Test connection" behaves for this provider:
   *   'send'  — actually delivers a message to an address the admin types (email/sms/whatsapp)
   *   'probe' — calls the provider's own API read-only and reports what it said
   *   'none'  — nothing to call (credentials only become meaningful after an OAuth consent)
   */
  test: 'send' | 'probe' | 'none';
  /**
   * Rendered verbatim next to a GREEN test result. The Tester found that MSG91 answers
   * `type:success` to a BOGUS key — so a green result must never be allowed to read as
   * "delivery proven". Every 'send' provider says what green actually means.
   */
  testCaveat?: string;
  /** Shown in the UI when the stored config is not yet wired to anything live. */
  storedOnly?: string;
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
    test: 'send',
    testCaveat: 'Green means your SMTP server accepted the mail for delivery. Check the inbox (and the spam folder) to confirm it actually landed.',
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
      { key: 'dlt_template_id', label: 'Default DLT Template ID', type: 'text', placeholder: '1707161234567890123', hint: 'Used when a message template does not carry its own DLT id — and for the OTP login SMS.' },
      { key: 'otp_dlt_template_id', label: 'OTP DLT Template ID', type: 'text', placeholder: '1707161234567890123', hint: 'The DLT template registered for your login OTP text. Falls back to the default above.' },
      { key: 'route', label: 'Route', type: 'text', placeholder: '4', hint: '4 = transactional' },
      { key: 'country', label: 'Country code', type: 'text', placeholder: '91' },
    ],
    secrets: [{ key: 'authkey', label: 'Auth Key', type: 'password', required: true }],
    setup: [
      'Log in to MSG91 › Settings › API keys and copy the Auth Key.',
      'Register your Sender ID and every SMS template on the DLT portal (this is a legal requirement in India).',
      'Paste the Auth Key + Sender ID here. Put each approved DLT template id on its template in Message Templates.',
      'Saving this ALSO switches on OTP login — the login OTP is sent through this same gateway.',
    ],
    test: 'send',
    // The Tester proved this: MSG91 answers `type:success` to a request signed with a
    // BOGUS auth key. A green tick here therefore means "MSG91 accepted the request",
    // NOT "the SMS was delivered". Saying so plainly is the whole point.
    testCaveat: 'Green means MSG91 ACCEPTED the request — it does NOT prove delivery. MSG91 answers "success" even to a wrong Auth Key, and DLT rejections happen later, silently. Only an SMS actually arriving on the handset proves the gateway works.',
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
      { key: 'dlt_template_id', label: 'Default DLT Template ID', type: 'text', placeholder: '1707161234567890123', hint: 'Substituted as {{dlt_template_id}} when a message template does not carry its own.' },
      { key: 'otp_dlt_template_id', label: 'OTP DLT Template ID', type: 'text', hint: 'The DLT template registered for your login OTP text.' },
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
      'Saving this ALSO switches on OTP login — the login OTP goes through this same gateway.',
    ],
    test: 'send',
    testCaveat: 'Green means your gateway returned a success response — it does NOT prove delivery. Many Indian gateways accept a request and drop it later at the DLT layer. Only an SMS arriving on the handset proves it works.',
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
      'Saving this ALSO switches on OTP login — the login OTP goes through this same gateway.',
    ],
    test: 'send',
    testCaveat: 'Green means Twilio queued the message — it does NOT prove delivery. Check the handset.',
  },

  {
    key: 'nimbus',
    channel: 'sms',
    label: 'Nimbus IT (India, DLT)',
    blurb: 'The client\'s Indian DLT SMS gateway (nimbusit.net). Per-template DLT Header (sender) + Template ID come from the SMS Templates screen; the user, Auth Key and DLT Entity ID live here.',
    perVertical: false,
    config: [
      { key: 'user', label: 'Nimbus user / profile ID', type: 'text', required: true, hint: 'Your Nimbus IT account user id (the `user` parameter).' },
      { key: 'entityid', label: 'DLT Entity ID', type: 'text', required: true, placeholder: '1101xxxxxxxxxxxxxxx', hint: 'Your Principal Entity ID from the DLT portal (the `entityid` parameter).' },
      { key: 'sender_id', label: 'Default DLT Header (sender)', type: 'text', placeholder: 'BRTISC', hint: 'Fallback header when a template has none. Each SMS Template carries its OWN Header (e.g. BRTISC / INSTAI) and that wins.' },
      { key: 'dlt_template_id', label: 'Default DLT Template ID', type: 'text', hint: 'Used only when a message has no template of its own (e.g. the OTP login SMS).' },
      { key: 'otp_dlt_template_id', label: 'OTP DLT Template ID', type: 'text', hint: 'The DLT template registered for your login OTP text. Falls back to the default above.' },
      { key: 'base_url', label: 'Send endpoint', type: 'text', placeholder: 'http://nimbusit.net/api/pushsms', hint: 'Leave blank to use the standard Nimbus pushsms endpoint.' },
    ],
    secrets: [
      { key: 'authkey', label: 'Auth Key', type: 'password', required: true, hint: 'Your Nimbus IT authkey. Encrypted at rest, shown masked, never returned in clear.' },
    ],
    setup: [
      'Get your Nimbus IT user id, Auth Key and DLT Entity ID from Nimbus / your DLT portal.',
      'Paste the user id, Auth Key and DLT Entity ID here and Save. (Saving this ALSO switches on OTP login — the login OTP goes through Nimbus too.)',
      'Open Engagement & Workflow › SMS Templates and add one row per lead type: pick the Branch + Vertical, paste the DLT-approved body (with its {#var#} markers), the DLT Header and the DLT Template ID.',
      'Press Send test SMS on a template to your own number to confirm it arrives.',
    ],
    test: 'send',
    testCaveat: 'Green means Nimbus ACCEPTED the request — it does NOT prove delivery. DLT rejections (wrong Template ID, header not linked, or the sent text not matching the approved template) happen later. Only an SMS arriving on the handset proves it works.',
  },
  /* --------------------------------------------------------------- WHATSAPP */
  {
    key: 'meta_cloud',
    channel: 'whatsapp',
    label: 'WhatsApp — Meta Cloud API',
    blurb: 'Click "Connect WhatsApp", log in to Meta, and we store the permanent token, the WABA, the phone number and the app secret ourselves — then subscribe the webhook for you. No token pasting, no 24-hour-token trap.',
    perVertical: false,
    config: [
      // ---- Embedded Signup: the two ids that make the Connect button work. Not secret
      // in the same way (the App ID is public in the browser), but they live here with
      // everything else so there is ONE place the client configures WhatsApp.
      { key: 'app_id', label: 'Meta App ID', type: 'text', placeholder: '1234567890123456', hint: 'Meta for Developers › your app › Settings › Basic. Public — it ships to the browser.' },
      { key: 'config_id', label: 'Embedded Signup Configuration ID', type: 'text', hint: 'Meta › Facebook Login for Business › Configurations. Required for the Connect WhatsApp button.' },
      // ---- Filled BY Embedded Signup. Still editable, because the manual path must stay.
      { key: 'phone_number_id', label: 'Phone number ID', type: 'text', required: true, hint: 'Filled automatically by Connect WhatsApp. Meta › WhatsApp › API Setup if you are doing it by hand.' },
      { key: 'waba_id', label: 'WhatsApp Business Account ID', type: 'text', hint: 'Filled automatically by Connect WhatsApp.' },
      { key: 'display_phone_number', label: 'Connected number', type: 'text', hint: 'Read from Meta after connecting.' },
      { key: 'verified_name', label: 'Verified business name', type: 'text', hint: 'Read from Meta after connecting.' },
      { key: 'connected_via', label: 'Connected via', type: 'text', hint: 'embedded_signup or manual — set by the system.' },
      { key: 'api_version', label: 'Graph API version', type: 'text', placeholder: 'v21.0' },
      { key: 'default_language', label: 'Default template language', type: 'text', placeholder: 'en' },
    ],
    secrets: [
      { key: 'access_token', label: 'Permanent access token', type: 'password', required: true, hint: 'Filled automatically by Connect WhatsApp (a business-integration system-user token — it does not expire). Only paste one by hand if you are using the advanced fallback.' },
      { key: 'app_secret', label: 'App secret', type: 'password', hint: 'Meta › Settings › Basic › App Secret. Needed to exchange the login code AND to verify the X-Hub-Signature-256 on the delivery webhook.' },
      { key: 'verify_token', label: 'Webhook verify token', type: 'password', generated: true, hint: 'We generate this — only needed for the manual webhook path.' },
    ],
    setup: [
      'Meta for Developers › your app › Settings › Basic: copy the App ID and the App Secret into the two boxes below, and Save.',
      'Add a "Facebook Login for Business" product, create a Configuration with the WhatsApp Embedded Signup use case, and copy its Configuration ID here.',
      'In that same Login-for-Business product › Settings, add this CRM\'s address to "Valid OAuth Redirect URIs" — otherwise Meta silently closes the popup.',
      'Press CONNECT WHATSAPP and log in with the Facebook account that owns the WhatsApp Business Account. Pick (or create) the WABA and the phone number in Meta\'s dialog.',
      'That is it. We exchange the login for a PERMANENT token and subscribe the webhook automatically. Templates still have to be approved inside Meta before you can send them.',
    ],
    test: 'probe',
    testCaveat: 'Green means Meta accepted the stored token and returned this phone number\'s details. Sending still requires an APPROVED template.',
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
    test: 'probe',
    testCaveat: 'Green means Razorpay accepted the Key ID + Key Secret. No payment is created and no money moves.',
    storedOnly: 'STORED, NOT YET CHARGING. The keys are saved and verified now; fee collection starts using them in Sprint 5 / Phase 3.',
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
    test: 'probe',
    storedOnly: 'STORED, NOT YET ACTIVE. The key is saved and verified now; the AI features that use it land in Phase 2.',
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
    test: 'probe',
    storedOnly: 'STORED, NOT YET ACTIVE. The key is saved and verified now; the AI features that use it land in Phase 2.',
  },

  /* --------------------------------------------------------------- CALENDAR */
  /**
   * THE GAP THIS CLOSES: calendar sync used to keep its OAuth client id AND CLIENT
   * SECRET in the plain `app_setting` JSON blob — unencrypted, and readable by anyone
   * with settings.read. Moving it here puts it behind the same AES-256-GCM + masking
   * as every other credential. Migration 028 carries any existing value across and
   * blanks the plaintext copy.
   */
  {
    key: 'google_oauth',
    channel: 'calendar',
    label: 'Google Calendar sync',
    blurb: 'Two-way sync between the CRM calendar and Google Calendar. The in-app calendar works fully without this — only the sync is blocked.',
    perVertical: false,
    config: [
      { key: 'client_id', label: 'OAuth client ID', type: 'text', required: true, placeholder: '1234-abc.apps.googleusercontent.com' },
      { key: 'calendar_id', label: 'Calendar ID', type: 'text', placeholder: 'primary' },
    ],
    secrets: [
      { key: 'client_secret', label: 'OAuth client secret', type: 'password', required: true },
      { key: 'refresh_token', label: 'Refresh token', type: 'password', hint: 'Filled by the OAuth consent — you do not paste this by hand.' },
    ],
    setup: [
      'Google Cloud Console › APIs & Services › Credentials › Create OAuth client ID (type: Web application).',
      'Add this CRM\'s address as an Authorized redirect URI, and enable the Google Calendar API for the project.',
      'Paste the client ID + client secret here and Save, then press Connect account to grant consent.',
    ],
    test: 'none',
    storedOnly: 'STORED. An OAuth client id + secret cannot be verified without a user consent — press Connect account to finish, and the sync lights up then.',
  },
  {
    key: 'outlook_oauth',
    channel: 'calendar',
    label: 'Outlook Calendar sync',
    blurb: 'Two-way sync between the CRM calendar and Outlook / Microsoft 365.',
    perVertical: false,
    config: [
      { key: 'client_id', label: 'Application (client) ID', type: 'text', required: true },
      { key: 'tenant_id', label: 'Directory (tenant) ID', type: 'text', placeholder: 'common' },
    ],
    secrets: [
      { key: 'client_secret', label: 'Client secret', type: 'password', required: true },
      { key: 'refresh_token', label: 'Refresh token', type: 'password', hint: 'Filled by the OAuth consent.' },
    ],
    setup: [
      'Azure Portal › App registrations › New registration.',
      'Certificates & secrets › New client secret. Copy the VALUE (not the id).',
      'API permissions: add Calendars.ReadWrite (delegated). Paste both values here, then press Connect account.',
    ],
    test: 'none',
    storedOnly: 'STORED. Needs an OAuth consent before the sync can run — press Connect account.',
  },

  /* ---------------------------------------------------------------- STORAGE */
  {
    key: 'cloudflare',
    channel: 'storage',
    label: 'Cloudflare (R2, DNS, CDN)',
    blurb: 'R2 object storage for uploads and static assets, plus the DNS zone and cache purge. Per PHASE1_DEV_PLAN §5.',
    perVertical: false,
    config: [
      { key: 'zone', label: 'Domain / zone', type: 'text', required: true, placeholder: 'crm.techlingua.in', hint: 'The zone the CRM runs on — it must already be on Cloudflare DNS.' },
      { key: 'zone_id', label: 'Zone ID', type: 'text', hint: 'Cloudflare dashboard › your domain › Overview (right column). Needed for cache purge.' },
      { key: 'account_id', label: 'Account ID', type: 'text', required: true, hint: 'Cloudflare dashboard › R2 › Overview. Part of the R2 endpoint.' },
      { key: 'r2_bucket', label: 'R2 bucket name', type: 'text', required: true, placeholder: 'techlingua-crm-assets' },
      { key: 'r2_public_domain', label: 'R2 public/custom domain', type: 'text', placeholder: 'assets.techlingua.in', hint: 'Where public assets are served from.' },
      { key: 'plan', label: 'Plan level', type: 'select', opts: ['Free', 'Pro', 'Business', 'Enterprise'], hint: 'Affects cache rules, WAF and image resizing.' },
    ],
    secrets: [
      { key: 'api_token', label: 'API token', type: 'password', required: true, hint: 'Scoped to R2 read/write + DNS edit + Cache Purge for this zone.' },
      { key: 'r2_access_key_id', label: 'R2 access key ID', type: 'password', required: true },
      { key: 'r2_secret_access_key', label: 'R2 secret access key', type: 'password', required: true },
    ],
    setup: [
      'Cloudflare dashboard › Manage Account › API Tokens › Create Token. Give it R2 read/write, DNS edit and Cache Purge on your zone.',
      'Cloudflare › R2 › Create bucket (e.g. techlingua-crm-assets), then Manage R2 API Tokens › Create to get the access key id + secret.',
      'Copy the Account ID from the R2 Overview page and the Zone ID from your domain\'s Overview page.',
      'Paste everything here and press Test connection — we verify the API token against Cloudflare.',
    ],
    test: 'probe',
    // Honesty about scope: the client asked to store these NOW. The R2 wiring is a
    // separate piece of work and pretending otherwise would be a lie on the screen.
    storedOnly: 'STORED AND VERIFIED, NOT YET SERVING. We check the token works and remember the bucket/zone, but uploads still go to the app server — the R2 upload path and the CDN cutover are a separate task. Nothing here changes how the app behaves today.',
  },
];

export const MSG_PROVIDERS: Record<string, MsgProviderSpec> = Object.fromEntries(SPECS.map((s) => [s.key, s]));

export const providersFor = (channel: MsgChannel): MsgProviderSpec[] => SPECS.filter((s) => s.channel === channel);

/** The channels that actually SEND a message (as opposed to payment/AI/infra config). */
export const SENDING_CHANNELS: MsgChannel[] = ['email', 'sms', 'whatsapp'];

/** Human names, used by `require()`'s 503 text and by the Settings UI. */
export const CHANNEL_LABEL: Record<MsgChannel, string> = {
  email: 'Email (SMTP)',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  payment: 'Payment gateway',
  ai: 'AI',
  calendar: 'Calendar sync',
  storage: 'Cloudflare storage',
};

/** Every channel the Settings screen renders, in the order it renders them. */
export const ALL_CHANNELS: MsgChannel[] = ['whatsapp', 'sms', 'email', 'calendar', 'payment', 'storage', 'ai'];

/**
 * CHANNELS WHERE SEVERAL PROVIDERS COEXIST, EACH WITH ITS OWN ROW (DEF-S5-04).
 *
 * Everywhere else, one provider per (channel, vertical) is the POINT: switching SMS from
 * MSG91 to Twilio must REPLACE the row, because two live SMS gateways on one vertical is
 * an ambiguity, not a feature — `resolve('sms')` would have to pick one and would
 * eventually pick the wrong one. So those channels stay keyed on (channel, vertical).
 *
 * `ai` is genuinely different. PROJECT_STATUS §4.8 offers "DeepSeek **and/or** Gemini" and
 * the Phase-2 features will choose per task, so they are not alternatives — they are two
 * independent credentials. They shared `channel='ai'`, so saving Gemini silently
 * OVERWROTE the DeepSeek key in place, with no warning (live: both returned `id: 17`).
 * Keying `ai` rows on the PROVIDER too makes "and/or" true, which is what the card claims.
 *
 * The web already grouped these cards `byProvider`, so it needed no change — this was
 * only ever a storage-key bug.
 */
export const MULTI_PROVIDER_CHANNELS: MsgChannel[] = ['ai'];

/** Is this a channel where each provider keeps its OWN row, rather than replacing the others? */
export function isMultiProvider(channel: string): boolean {
  return MULTI_PROVIDER_CHANNELS.includes(channel as MsgChannel);
}

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
