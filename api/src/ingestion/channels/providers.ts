import { IngestPayload } from '../ingestion.types';

/**
 * THE PROVIDER REGISTRY — the generic seam behind every lead-capture channel.
 *
 * Shipping today (client-confirmed): meta · google_ads · website · google_sheet.
 * JustDial and IndiaMART are explicitly OUT for now — but adding them later is
 * ONE entry in PROVIDERS below plus a mapper: no migration (provider is a free
 * VARCHAR), no new endpoint style (they are ordinary signed/keyed POSTs), no
 * change to the ingestion pipeline, and the admin UI renders their config form
 * from this metadata automatically.
 *
 * Each spec declares:
 *   - `kind`      how the leads arrive: 'webhook' (they push) | 'poll' (we pull)
 *   - `endpoint`  which public route serves it ('meta' | 'google' | 'form' | null)
 *   - `config`    NON-secret settings, editable by an admin, stored in JSONB
 *   - `secrets`   credentials — AES-256-GCM at rest, returned MASKED, never logged
 *   - `required`  the secrets/config without which the channel is "not configured"
 *                 (it must then degrade cleanly: a clear state in the UI, a 503 on
 *                 a manual pull, a rejected+logged webhook — never a crash)
 */

export type FieldType = 'text' | 'password' | 'textarea' | 'number' | 'bool' | 'list';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  /** generated server-side on create when the admin leaves it blank (Meta verify token) */
  generated?: boolean;
}

export interface ProviderSpec {
  key: string;
  label: string;
  blurb: string;
  kind: 'webhook' | 'poll';
  /** the public route family: /api/webhooks/<endpoint>/<public_key> */
  endpoint: 'meta' | 'google' | 'form' | 'push' | null;
  config: FieldSpec[];
  secrets: FieldSpec[];
  /** what Gopal must paste where (rendered verbatim in the Configure drawer) */
  setup: string[];
  /** DEF-INT-01 — hide from the Available Tools grid (still a valid provider for
   *  existing channels + ingestion, just not offered in the Integrations tool list). */
  hidden?: boolean;
  /** DEF-INT-01 — this tool is connected elsewhere; the grid tile deep-links here
   *  instead of opening the Connect drawer (e.g. Meta WhatsApp -> Settings › Channels). */
  deeplink?: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  meta: {
    key: 'meta',
    label: 'Meta Lead Ads (Facebook / Instagram)',
    blurb: 'Real-time lead-gen form submissions from Facebook & Instagram lead ads.',
    kind: 'webhook',
    endpoint: 'meta',
    config: [
      { key: 'graph_version', label: 'Graph API version', type: 'text', placeholder: 'v21.0',
        hint: 'Leave as v21.0 unless Meta asks for a newer one.' },
      { key: 'page_id', label: 'Facebook Page ID', type: 'text',
        hint: 'Optional. When set, payloads for any other Page are rejected.' },
      { key: 'field_map', label: 'Extra field mapping (JSON)', type: 'textarea',
        placeholder: '{"which_course":"course","your_city":"city"}',
        hint: 'Map YOUR lead-form question names to CRM fields. Standard names (full_name, email, phone_number, city, state) are mapped automatically.' },
    ],
    secrets: [
      { key: 'verify_token', label: 'Verify token', type: 'password', required: true, generated: true,
        hint: 'Generated for you. Paste this into Meta when you add the Callback URL.' },
      { key: 'app_secret', label: 'App secret', type: 'password', required: true,
        hint: 'Meta App Dashboard › Settings › Basic › App Secret. Used to verify X-Hub-Signature-256 — an unsigned payload is always rejected.' },
      { key: 'page_access_token', label: 'Page access token', type: 'password', required: true,
        hint: 'A long-lived Page token with leads_retrieval. Used to fetch the lead fields for a leadgen_id from the Graph API.' },
    ],
    setup: [
      'Meta App Dashboard › Webhooks › Page › Subscribe to the "leadgen" field.',
      'Callback URL = the Webhook URL shown above. Verify Token = the token above.',
      'Connect your Page and give the app leads_retrieval permission.',
      'Test with Meta\'s Lead Ads Testing Tool — the lead appears in the event log below within seconds.',
    ],
  },

  /**
   * DEF-INT-01 — Meta WhatsApp tile. WhatsApp is NOT a lead-capture webhook; it is
   * connected by Embedded Signup in Settings › Channels (permanent token / WABA /
   * phone-number id are minted there, never pasted). This registry entry exists so
   * the Available Tools grid carries the client's named tile; the tile deep-links to
   * Settings and is NOT creatable as a capture_channel (endpoint is null, guarded in
   * ChannelService.create).
   */
  meta_whatsapp: {
    key: 'meta_whatsapp',
    label: 'Meta WhatsApp (WhatsApp Business API)',
    blurb: 'Connect WhatsApp by Embedded Signup — click, log in to Meta, done. Set up in Settings › Channels; the permanent token, WABA and phone-number id are minted there.',
    kind: 'webhook',
    endpoint: null,
    deeplink: '/m/admin/settings',
    config: [],
    secrets: [],
    setup: [
      'This tile opens Settings › Channels, where "Connect WhatsApp" runs Meta Embedded Signup.',
      'You log in to Meta once; the app mints a PERMANENT token, resolves your WABA + phone number id, and subscribes the webhook automatically.',
      'Inbound WhatsApp and template messaging are then managed on the Engagement channels — not from this Integrations grid.',
    ],
  },

  google_ads: {
    key: 'google_ads',
    label: 'Google Ads lead form extension',
    blurb: 'Leads submitted on a Google Ads lead form asset, posted to our webhook.',
    kind: 'webhook',
    endpoint: 'google',
    config: [
      { key: 'ingest_test_leads', label: 'Import Google\'s test leads too', type: 'bool',
        hint: 'Off (recommended): a "Send test data" lead is verified and logged below, but no lead is created.' },
      { key: 'field_map', label: 'Extra field mapping (JSON)', type: 'textarea',
        placeholder: '{"WHICH_COURSE":"course"}',
        hint: 'Map custom lead-form question column_ids to CRM fields. FULL_NAME / EMAIL / PHONE_NUMBER / CITY etc. are automatic.' },
    ],
    secrets: [
      { key: 'google_key', label: 'Webhook key', type: 'password', required: true, generated: true,
        hint: 'Generated for you. Paste this into Google Ads as the "Key" — Google echoes it back in every payload and we reject any payload whose key does not match.' },
    ],
    setup: [
      'Google Ads › the lead form asset › Delivery options › Webhook integration.',
      'Webhook URL = the URL above. Key = the Webhook key above.',
      'Click "Send test data" — Google must get a 200 back, and the test appears in the event log below.',
    ],
  },

  website: {
    key: 'website',
    label: 'Website form',
    blurb: 'A public endpoint your website posts to. No login required — protected by a public key, allowed origins, a honeypot and a rate limit.',
    kind: 'webhook',
    endpoint: 'form',
    // DEF-INT-01 — the website-form capture stays fully functional, but it is NOT one
    // of the client's 12 Integrations tools, so it is hidden from the Available Tools grid.
    hidden: true,
    config: [
      { key: 'allowed_origins', label: 'Allowed website origins', type: 'list', required: true,
        placeholder: 'https://techlingua.in, https://www.techlingua.in',
        hint: 'Only these origins may post from a browser (CORS). Use * only for a server-to-server integration.' },
      { key: 'honeypot_field', label: 'Honeypot field name', type: 'text', placeholder: 'company_website',
        hint: 'A hidden input in your form. If a bot fills it, the submission is dropped (and logged).' },
      { key: 'rate_limit_per_min', label: 'Max submissions / minute', type: 'number', placeholder: '60',
        hint: 'Per key. A single IP is separately capped at a tenth of this.' },
      { key: 'field_map', label: 'Extra field mapping (JSON)', type: 'textarea',
        placeholder: '{"interested_in":"course"}',
        hint: 'Map your own input names to CRM fields. name/phone/email/city/course/message are automatic.' },
    ],
    secrets: [],
    setup: [
      'Copy the HTML snippet below into your website page (or POST the same JSON from your backend).',
      'Add your site\'s origin(s) above — a browser post from any other origin is refused.',
      'Keep the hidden honeypot input in the form and leave it empty.',
    ],
  },

  google_sheet: {
    key: 'google_sheet',
    label: 'Google Sheet pull',
    blurb: 'We poll a Google Sheet on a schedule; each NEW row becomes a lead. A cursor guarantees a row is never imported twice.',
    kind: 'poll',
    endpoint: null,
    config: [
      { key: 'sheet_id', label: 'Spreadsheet ID', type: 'text', required: true,
        placeholder: '1AbC…the long id in the sheet URL',
        hint: 'From https://docs.google.com/spreadsheets/d/<THIS PART>/edit' },
      { key: 'range', label: 'Range', type: 'text', placeholder: 'Sheet1!A:Z',
        hint: 'Row 1 must be the header row.' },
      { key: 'poll_minutes', label: 'Check every (minutes)', type: 'number', placeholder: '15' },
      { key: 'field_map', label: 'Column mapping (JSON)', type: 'textarea',
        placeholder: '{"Mobile":"phone","Interested In":"course"}',
        hint: 'Map sheet header names to CRM fields. Name / Phone / Email / City / Course headers are matched automatically.' },
    ],
    secrets: [
      { key: 'service_account_json', label: 'Service-account JSON', type: 'textarea',
        hint: 'Preferred. Paste the whole key file, then SHARE the sheet with the service account\'s client_email (Viewer).' },
      { key: 'api_key', label: 'or API key', type: 'password',
        hint: 'Only works if the sheet is shared as "Anyone with the link — Viewer".' },
    ],
    setup: [
      'Either paste a service-account JSON and share the Sheet with its client_email, or make the Sheet link-viewable and paste an API key.',
      'Row 1 = headers. Map the columns above.',
      'Press "Pull now" to test. Until credentials are supplied the channel stays "Not configured" and is skipped — nothing breaks.',
    ],
  },
};

/* ------------------------------------------------------------------ *
 *  PUSH INTEGRATIONS — Indian marketplaces + a generic keyed webhook.
 *
 *  Client-confirmed set (NeoDove-modelled Integrations): IndiaMART · JustDial ·
 *  TradeIndia · Housing.com · 99acres · Google Form · Custom Integration ·
 *  Webhook. Every one of them is an ordinary server-to-server JSON/urlencoded
 *  POST to ONE public route family — /api/webhooks/push/<public_key> — normalised
 *  through the SAME field-map + LeadIngestionService as every other channel. A
 *  marketplace is therefore ONE registry entry: no migration, no new endpoint,
 *  no change to dedupe/distribution/idempotency/audit.
 *
 *  Auth = the unguessable, rotatable public key in the URL (exactly like the
 *  website form). An OPTIONAL generated `webhook_key` adds defence-in-depth for
 *  callers that can send a header/param; a caller that sends a WRONG key is
 *  rejected, a caller that sends none is allowed (the URL is the secret) — so a
 *  marketplace that cannot attach a custom header still works.
 * ------------------------------------------------------------------ */

const PUSH_FIELD_MAP: FieldSpec = {
  key: 'field_map', label: 'Field mapping (JSON)', type: 'textarea',
  placeholder: '{"MOBILE":"phone","SENDER_NAME":"full_name","SENDER_EMAIL":"email","QUERY_MESSAGE":"note"}',
  hint: 'Map the incoming field names to CRM lead fields. Contact Name, Contact Number and Email are matched automatically for common names; add anything the source calls differently here.',
};
const PUSH_CAPTURE_EXTRA: FieldSpec = {
  key: 'capture_extra', label: 'Capture other fields (page / form name) — visible to all users', type: 'bool',
  hint: 'On: any field not mapped above (form name, page name, product enquired, city…) is appended to the lead note so nothing the source sent is lost.',
};
const PUSH_KEY: FieldSpec = {
  key: 'webhook_key', label: 'Webhook key', type: 'password', generated: true,
  hint: 'Generated for you. Optional shared secret — send it as the header X-Webhook-Key (or ?key= / a "key" field) and any payload with a WRONG key is rejected. A source that cannot send it still works: the URL itself is unguessable.',
};

function pushProvider(key: string, label: string, blurb: string, setup: string[]): ProviderSpec {
  return {
    key, label, blurb, kind: 'webhook', endpoint: 'push',
    config: [PUSH_FIELD_MAP, PUSH_CAPTURE_EXTRA], secrets: [PUSH_KEY], setup,
  };
}

Object.assign(PROVIDERS, {
  google_form: pushProvider(
    'google_form', 'Google Form',
    'Each Google Form submission becomes a lead. A one-line Apps Script on the form posts the answers to your webhook URL in real time.',
    [
      'Open the linked Google Sheet › Extensions › Apps Script.',
      'Add an installable "On form submit" trigger that POSTs e.namedValues as JSON to the Webhook URL above.',
      'Map your question titles to CRM fields below (Name / Phone / Email are automatic).',
      'Submit a test response — it appears in the Logs within seconds.',
    ]),
  indiamart: pushProvider(
    'indiamart', 'IndiaMART',
    'Buy-leads from your IndiaMART seller panel, pushed to the CRM in real time (IndiaMART Push / Lead Manager API).',
    [
      'IndiaMART Seller Panel › Lead Manager › Push API / CRM Integration.',
      'Paste the Webhook URL above as the push endpoint (and the Webhook key if the panel lets you set a header/param).',
      'IndiaMART posts SENDER_NAME / SENDER_MOBILE / SENDER_EMAIL / QUERY_MESSAGE — these are mapped automatically.',
      'Send a test enquiry — it appears in the Logs and creates a lead in the chosen campaign.',
    ]),
  justdial: pushProvider(
    'justdial', 'JustDial',
    'JustDial JD Leads pushed to the CRM as they arrive.',
    [
      'JustDial JD-Leads / API panel (or ask JustDial support to enable lead push).',
      'Give them the Webhook URL above as the delivery endpoint.',
      'JustDial posts name / mobile / email / category — mapped automatically; map anything custom below.',
    ]),
  tradeindia: pushProvider(
    'tradeindia', 'TradeIndia',
    'TradeIndia enquiries pushed to the CRM (Lead/Inquiry API).',
    [
      'TradeIndia Seller panel › Inquiry / Lead API.',
      'Set the Webhook URL above as the delivery URL; send the Webhook key as a param if supported.',
      'Map TradeIndia\'s field names (sender_name / sender_mobile / sender_email / subject) below if they differ.',
    ]),
  housing: pushProvider(
    'housing', 'Housing.com',
    'Housing.com property enquiries pushed to the CRM.',
    [
      'Housing.com / broker dashboard › Lead integration / Webhook.',
      'Paste the Webhook URL above as the lead delivery endpoint.',
      'Map the incoming name / phone / email / project fields below.',
    ]),
  '99acres': pushProvider(
    '99acres', '99acres',
    '99acres property enquiries pushed to the CRM.',
    [
      '99acres advertiser dashboard › Lead / API integration.',
      'Paste the Webhook URL above as the lead delivery endpoint.',
      'Map the incoming name / phone / email / project fields below.',
    ]),
  custom: pushProvider(
    'custom', 'Custom Integration',
    'A generic keyed inbound endpoint for any tool that can POST a lead — your own backend, a form builder, a no-code automation (Zapier / Make / n8n).',
    [
      'POST a JSON (or form-urlencoded) body to the Webhook URL above.',
      'Optionally send the Webhook key as the header X-Webhook-Key.',
      'Use the field mapping below to match your field names to CRM lead fields.',
    ]),
  webhook: pushProvider(
    'webhook', 'Webhook',
    'A raw inbound webhook. Point anything at the URL and map its fields — the simplest way to feed leads in from a system we do not list.',
    [
      'Send an HTTP POST with a JSON body to the Webhook URL above.',
      'Contact Number is required; Contact Name and Email are matched automatically.',
      'Turn on "Capture other fields" to keep everything else on the lead note.',
    ]),
});

/**
 * Fields the payload carried that mapped to NO CRM target — surfaced on the lead
 * note when "capture other fields" is on, so a page/form name is never lost.
 */
export function extraFields(
  body: Record<string, unknown>, fieldMap: Record<string, string> = {}, drop: string[] = [],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const dropSet = new Set(drop.map((d) => norm(d)));
  for (const [k, rawV] of Object.entries(body ?? {})) {
    if (rawV == null) continue;
    if (dropSet.has(norm(k))) continue;
    const v = Array.isArray(rawV) ? rawV.filter((x) => x != null).join(', ') : String(rawV);
    if (!String(v).trim()) continue;
    if (resolveTarget(k, fieldMap)) continue;   // it mapped somewhere — not "extra"
    out.push([k, v]);
  }
  return out;
}

/** google_sheet needs sheet_id AND (service_account_json OR api_key) — not both. */
export function missingRequirements(provider: string, config: Record<string, unknown>, secretKeys: string[]): string[] {
  const spec = PROVIDERS[provider];
  if (!spec) return ['Unknown provider'];
  const miss: string[] = [];
  for (const f of spec.config) {
    if (f.required && !String(config?.[f.key] ?? '').trim()) miss.push(f.label);
  }
  for (const f of spec.secrets) {
    if (f.required && !secretKeys.includes(f.key)) miss.push(f.label);
  }
  if (provider === 'google_sheet' && !secretKeys.includes('service_account_json') && !secretKeys.includes('api_key')) {
    miss.push('Google credentials (service-account JSON or API key)');
  }
  return miss;
}

/* ------------------------------------------------------------------ *
 *  FIELD MAPPING — provider field names -> the CRM's IngestPayload
 * ------------------------------------------------------------------ */

/** The lead fields a channel may write (custom fields via the `cf:` prefix). */
export const CHANNEL_TARGETS = [
  'full_name', 'phone', 'alt_phone', 'email', 'state', 'city', 'course',
  'qualification', 'budget', 'note', 'tags', 'external_id',
] as const;

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Aliases every provider shares — the shapes real lead forms actually use. */
const ALIASES: Record<string, string> = {
  fullname: 'full_name', name: 'full_name', yourname: 'full_name', leadname: 'full_name',
  studentname: 'full_name', contactname: 'full_name', customername: 'full_name',
  firstname: '_first', lastname: '_last', givenname: '_first', familyname: '_last', surname: '_last',
  phone: 'phone', phonenumber: 'phone', mobile: 'phone', mobilenumber: 'phone', contactnumber: 'phone',
  contact: 'phone', whatsapp: 'phone', whatsappnumber: 'phone', tel: 'phone', telephone: 'phone',
  altphone: 'alt_phone', alternatenumber: 'alt_phone', alternatephone: 'alt_phone', secondaryphone: 'alt_phone',
  email: 'email', emailaddress: 'email', workemail: 'email', mail: 'email',
  city: 'city', town: 'city', citycity: 'city',
  state: 'state', region: 'state', province: 'state',
  course: 'course', courseinterested: 'course', interestedin: 'course', coursename: 'course',
  program: 'course', programme: 'course', interest: 'course',
  qualification: 'qualification', education: 'qualification', highestqualification: 'qualification',
  budget: 'budget', budgetrange: 'budget',
  note: 'note', message: 'note', comments: 'note', comment: 'note', query: 'note', remarks: 'note',
  tags: 'tags', tag: 'tags',
};

/** Resolve one incoming key to a CRM field (explicit map wins, then aliases). */
export function resolveTarget(rawKey: string, fieldMap: Record<string, string> = {}): string | null {
  const direct = fieldMap[rawKey] ?? fieldMap[String(rawKey ?? '').trim()];
  if (direct) return direct;
  // the admin's map is matched case/format-insensitively too
  const nk = norm(rawKey);
  for (const [k, v] of Object.entries(fieldMap)) if (norm(k) === nk) return v;
  return ALIASES[nk] ?? null;
}

/**
 * Fold a flat list of {key, value} pairs into an IngestPayload.
 * Handles first_name/last_name -> full_name, `cf:` custom fields, and drops
 * anything that maps nowhere (it stays visible in the raw webhook_event row).
 */
export function pairsToPayload(
  pairs: Array<[string, unknown]>, fieldMap: Record<string, string> = {},
): IngestPayload {
  const out: IngestPayload = {};
  const custom: Record<string, unknown> = {};
  let first = '', last = '';

  for (const [k, rawV] of pairs) {
    if (rawV == null) continue;
    const v = Array.isArray(rawV) ? rawV.filter((x) => x != null).join(', ') : String(rawV);
    if (!String(v).trim()) continue;
    const t = resolveTarget(k, fieldMap);
    if (!t) continue;
    if (t === '_first') { first = v; continue; }
    if (t === '_last') { last = v; continue; }
    if (t.startsWith('cf:')) { custom[t.slice(3)] = v; continue; }
    if (!(CHANNEL_TARGETS as readonly string[]).includes(t)) continue;
    if ((out as Record<string, unknown>)[t] == null) (out as Record<string, unknown>)[t] = v;
  }

  if (!out.full_name && (first || last)) out.full_name = [first, last].filter(Boolean).join(' ').trim();
  if (Object.keys(custom).length) out.custom_fields = custom;
  return out;
}

/** Meta Graph `field_data: [{ name, values: [...] }]`. */
export function metaToPayload(
  fieldData: Array<{ name?: string; values?: unknown[] }>, fieldMap: Record<string, string> = {},
): IngestPayload {
  return pairsToPayload(
    (fieldData ?? []).map((f) => [String(f?.name ?? ''), (f?.values ?? [])] as [string, unknown]),
    fieldMap,
  );
}

/** Google Ads `user_column_data: [{ column_id, column_name, string_value }]`. */
export function googleToPayload(
  cols: Array<{ column_id?: string; column_name?: string; string_value?: unknown }>,
  fieldMap: Record<string, string> = {},
): IngestPayload {
  const pairs: Array<[string, unknown]> = [];
  for (const c of cols ?? []) {
    const id = String(c?.column_id ?? '');
    const nm = String(c?.column_name ?? '');
    // use whichever key actually resolves: column_id ("FULL_NAME") first, then the
    // human column_name ("Full name") — custom questions only carry the latter.
    const key = id && resolveTarget(id, fieldMap) ? id
      : nm && resolveTarget(nm, fieldMap) ? nm
      : (id || nm);
    if (!key) continue;
    pairs.push([key, c?.string_value]);
  }
  return pairsToPayload(pairs, fieldMap);
}

/** A flat website-form body (JSON or urlencoded). */
export function formToPayload(body: Record<string, unknown>, fieldMap: Record<string, string> = {}): IngestPayload {
  return pairsToPayload(Object.entries(body ?? {}), fieldMap);
}

/** One Google-Sheet row against its header row. */
export function sheetRowToPayload(
  headers: string[], row: string[], fieldMap: Record<string, string> = {},
): IngestPayload {
  return pairsToPayload(headers.map((h, i) => [h, row?.[i]] as [string, unknown]), fieldMap);
}

/** Parse the admin's field_map textarea; a broken JSON blob must never break capture. */
export function parseFieldMap(v: unknown): Record<string, string> {
  if (!v) return {};
  if (typeof v === 'object') return v as Record<string, string>;
  try {
    const p = JSON.parse(String(v));
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, string>) : {};
  } catch { return {}; }
}
