/**
 * BUILT-IN MARKETPLACE ADAPTERS (Lead Intake Blueprint §3–4).
 *
 * Turn a raw marketplace payload into one-or-more IngestPayload records with the
 * provider's own record id as external_id (→ source_ref dedup in the ingest ledger).
 * These let IndiaMART / JustDial / Sulekha / TradeIndia (and the property portals)
 * work out-of-the-box with NO per-field operator mapping. A channel's saved
 * field_map, when present, still overrides on top (handled by the caller).
 *
 * Everything non-identity is folded into `note` as a "Key: value" block so nothing
 * the source sent is lost — same rule the CSV/webhook paths use.
 */
import { IngestPayload } from '../ingestion.types';

type Raw = Record<string, unknown>;
const S = (v: unknown): string => (v == null ? '' : String(v)).trim();

/** case-insensitive first-non-empty pick across candidate keys */
function pick(o: Raw, keys: string[]): string {
  if (!o) return '';
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k];
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v != null && S(v) !== '') return S(v);
  }
  return '';
}

/** build a note from every field that is NOT already an identity field */
function noteFrom(o: Raw, used: string[]): string {
  const usedL = new Set(used.map((k) => k.toLowerCase()));
  const lines: string[] = [];
  for (const k of Object.keys(o || {})) {
    if (usedL.has(k.toLowerCase())) continue;
    const v = o[k];
    if (v == null || typeof v === 'object') continue;
    const s = S(v);
    if (s) lines.push(`${k}: ${s}`);
  }
  return lines.join('\n');
}

function one(o: Raw, m: {
  name: string[]; phone: string[]; email?: string[]; ref: string[];
  city?: string[]; extraNote?: string[];
}): IngestPayload {
  const full_name = pick(o, m.name);
  const phone = pick(o, m.phone);
  const email = m.email ? pick(o, m.email) : '';
  const external_id = pick(o, m.ref);
  const usedKeys = [...m.name, ...m.phone, ...(m.email ?? []), ...m.ref, ...(m.city ?? [])];
  const note = noteFrom(o, usedKeys);
  const p: IngestPayload = {};
  if (full_name) p.full_name = full_name;
  if (phone) p.phone = phone;
  if (email) p.email = email;
  if (m.city) { const c = pick(o, m.city); if (c) p.city = c; }
  if (external_id) p.external_id = external_id;
  if (note) p.note = note;
  return p;
}

/** IndiaMART: batch RESPONSE[] | single push object | flat. UNIQUE_QUERY_ID = ref. */
function indiamart(body: any): IngestPayload[] {
  const rows: Raw[] = Array.isArray(body?.RESPONSE) ? body.RESPONSE
    : (body?.RESPONSE && typeof body.RESPONSE === 'object') ? [body.RESPONSE]
    : [body];
  const map = {
    name: ['SENDER_NAME', 'sender_name', 'name'],
    phone: ['SENDER_MOBILE', 'sender_mobile', 'SENDER_PHONE', 'mobile'],
    email: ['SENDER_EMAIL', 'sender_email', 'email'],
    ref: ['UNIQUE_QUERY_ID', 'unique_query_id', 'QUERY_ID'],
    city: ['SENDER_CITY', 'sender_city'],
  };
  return rows.filter(Boolean).map((r) => one(r, map));
}

const ADAPTERS: Record<string, (body: any) => IngestPayload[]> = {
  indiamart,
  justdial: (b) => [one(b, {
    name: ['name', 'customer_name', 'prefix_name'],
    phone: ['mobile', 'phone', 'contact'],
    email: ['email'],
    ref: ['leadid', 'lead_id', 'docId'],
    city: ['city', 'area'],
  })],
  sulekha: (b) => [one(b, {
    name: ['customer_name', 'name'],
    phone: ['mobile', 'phone'],
    email: ['email'],
    ref: ['lead_id', 'leadid'],
    city: ['city'],
  })],
  tradeindia: (b) => [one(b, {
    name: ['GLUSR_USR_FNAME', 'sender_name', 'name'],
    phone: ['GLUSR_USR_PHONE', 'sender_mobile', 'mobile'],
    email: ['GLUSR_USR_EMAILID', 'sender_email', 'email'],
    ref: ['QUERY_ID', 'rfi_id', 'query_id'],
    city: ['GLUSR_USR_CITYNAME', 'city'],
  })],
};

// property / export portals share the generic shape
for (const g of ['magicbricks', '99acres', 'housing', 'nobroker', 'exportersindia', 'sulekhab2b']) {
  ADAPTERS[g] = (b) => [one(b, {
    name: ['name', 'full_name', 'customer_name', 'sender_name'],
    phone: ['phone', 'mobile', 'contact', 'sender_mobile', 'contact_number'],
    email: ['email', 'sender_email'],
    ref: ['id', 'lead_id', 'leadid', 'query_id', 'enquiry_id'],
    city: ['city'],
  })];
}

/** generic fallback for any unknown :source label */
function generic(body: any): IngestPayload[] {
  return [one(body ?? {}, {
    name: ['name', 'full_name', 'customer_name', 'sender_name', 'fullName'],
    phone: ['phone', 'mobile', 'contact', 'sender_mobile', 'phone_number', 'contact_number'],
    email: ['email', 'sender_email', 'email_id'],
    ref: ['external_id', 'id', 'lead_id', 'leadid', 'query_id'],
    city: ['city'],
  })];
}

export const KNOWN_SOURCES = Object.keys(ADAPTERS);

/** Adapt a marketplace payload → IngestPayload[] by source label. Always returns
 *  at least one record; records with neither name nor phone are dropped by the caller. */
export function adaptMarketplace(source: string, body: any): IngestPayload[] {
  const fn = ADAPTERS[String(source || '').toLowerCase()] ?? generic;
  const out = fn(body) || [];
  return out.filter((p) => p && (p.full_name || p.phone || p.whatsapp_phone || p.email));
}
