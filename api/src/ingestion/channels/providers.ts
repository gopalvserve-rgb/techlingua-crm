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
  endpoint: 'meta' | 'google' | 'form' | null;
  config: FieldSpec[];
  secrets: FieldSpec[];
  /** what Gopal must paste where (rendered verbatim in the Configure drawer) */
  setup: string[];
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
