/**
 * CSV column mapping — pure helpers shared by the preview endpoint, the enqueue
 * endpoint and the web mapping UI (which renders the catalog this file exports).
 */
import { IngestPayload } from './ingestion.types';

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  /** header aliases (lowercased, punctuation-stripped) used by auto-mapping */
  aliases: string[];
  hint?: string;
}

/** The standard lead fields a CSV column can be mapped to. */
export const LEAD_IMPORT_FIELDS: FieldDef[] = [
  { key: 'full_name', label: 'Name', required: true, aliases: ['name', 'fullname', 'leadname', 'customername', 'studentname', 'contactname', 'firstname'] },
  { key: 'phone', label: 'Mobile Number', required: true, aliases: ['phone', 'mobile', 'mobileno', 'mobilenumber', 'phoneno', 'phonenumber', 'contact', 'contactno', 'whatsapp', 'cell'] },
  { key: 'email', label: 'Email', aliases: ['email', 'emailid', 'emailaddress', 'mail'] },
  { key: 'alt_phone', label: 'Alternate Phone', aliases: ['altphone', 'alternatephone', 'alternatemobile', 'phone2', 'secondaryphone'] },
  // NB: bare 'whatsapp' stays an alias of `phone` (a sheet with only a WhatsApp
  // column is a phone column). An explicit "WhatsApp Number" maps here.
  { key: 'whatsapp_phone', label: 'WhatsApp Number', aliases: ['whatsappnumber', 'whatsappno', 'whatsappphone', 'wanumber', 'wano'] },
  { key: 'dob', label: 'Date of Birth', aliases: ['dateofbirth', 'birthdate', 'birthday', 'dob'] },
  { key: 'state', label: 'State', aliases: ['state'], hint: 'State master' },
  { key: 'city', label: 'City', aliases: ['city', 'town'], hint: 'City master' },
  { key: 'course', label: 'Course', aliases: ['course', 'coursename', 'coursecode', 'course_code', 'coursecd', 'program', 'programme', 'programcode', 'interestedin'], hint: 'Course master — by code (preferred) or name' },
  { key: 'qualification', label: 'Qualification', aliases: ['qualification', 'education'], hint: 'Qualification master' },
  { key: 'budget', label: 'Budget', aliases: ['budget'], hint: 'Budget master' },
  { key: 'status', label: 'Status', aliases: ['status', 'leadstatus'], hint: 'Status master' },
  { key: 'stage', label: 'Stage', aliases: ['stage', 'pipelinestage'], hint: "The campaign's pipeline stages" },
  { key: 'priority', label: 'Priority', aliases: ['priority'], hint: 'low / med / high' },
  { key: 'temperature', label: 'Temperature', aliases: ['temperature', 'temp', 'leadtemperature', 'band'], hint: 'hot / warm / cold' },
  { key: 'score', label: 'Lead Score', aliases: ['score', 'leadscore'], hint: '0-100' },
  { key: 'next_follow_up_at', label: 'Next Follow-up', aliases: ['nextfollowup', 'followupdate', 'followup', 'nextfollowupdate'], hint: 'YYYY-MM-DD or DD/MM/YYYY' },
  { key: 'tags', label: 'Tags', aliases: ['tag', 'tags', 'labels'], hint: 'Comma-separated tag names' },
  { key: 'note', label: 'Note', aliases: ['note', 'notes', 'remark', 'remarks', 'comment', 'comments', 'message'] },
  { key: 'external_id', label: 'External ID', aliases: ['externalid', 'id', 'leadid', 'recordid', 'refid', 'reference'], hint: 'Source record id — makes re-import idempotent' },
];

export const CUSTOM_PREFIX = 'cf:';

/** normalise a header for matching: lowercase, drop everything but a-z0-9 */
export const normHeader = (h: string): string => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Auto-map CSV headers to field keys by name. Exact alias match first, then a
 * "contains" fallback. Custom fields match on their field_key or label.
 * Unmatched headers map to '' (ignored) — the user remaps them in the UI.
 */
export function autoMap(
  headers: string[],
  customFields: Array<{ field_key: string; label: string }> = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();

  const candidates: Array<{ key: string; aliases: string[] }> = [
    ...LEAD_IMPORT_FIELDS.map((f) => ({ key: f.key, aliases: [normHeader(f.key), normHeader(f.label), ...f.aliases.map(normHeader)] })),
    ...customFields.map((c) => ({
      key: CUSTOM_PREFIX + c.field_key,
      aliases: [normHeader(c.field_key), normHeader(c.label)],
    })),
  ];

  for (const h of headers) {
    const n = normHeader(h);
    if (!n) { out[h] = ''; continue; }
    let hit = candidates.find((c) => !taken.has(c.key) && c.aliases.includes(n));
    if (!hit) hit = candidates.find((c) => !taken.has(c.key) && c.aliases.some((a) => a.length >= 4 && (n.includes(a) || a.includes(n))));
    out[h] = hit ? hit.key : '';
    if (hit) taken.add(hit.key);
  }
  return out;
}

/** Apply a mapping to one CSV row object -> the ingestion payload. */
export function applyMapping(raw: Record<string, string>, mapping: Record<string, string>): IngestPayload {
  const p: IngestPayload = {};
  const custom: Record<string, unknown> = {};
  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue;
    const v = (raw[header] ?? '').trim();
    if (v === '') continue;
    if (target.startsWith(CUSTOM_PREFIX)) custom[target.slice(CUSTOM_PREFIX.length)] = v;
    else (p as Record<string, unknown>)[target] = v;
  }
  if (Object.keys(custom).length) p.custom_fields = custom;
  return p;
}

/** Mapping sanity check: both required fields must be mapped exactly once. */
export function validateMapping(mapping: Record<string, string>): string[] {
  const errs: string[] = [];
  const targets = Object.values(mapping).filter(Boolean);
  for (const f of LEAD_IMPORT_FIELDS.filter((x) => x.required)) {
    if (!targets.includes(f.key)) errs.push(`Map a column to "${f.label}" — it is mandatory.`);
  }
  const dupes = targets.filter((t, i) => targets.indexOf(t) !== i);
  for (const d of [...new Set(dupes)]) errs.push(`Two columns are mapped to the same field ("${d}").`);
  return errs;
}
