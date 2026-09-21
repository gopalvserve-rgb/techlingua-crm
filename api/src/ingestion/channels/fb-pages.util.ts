/**
 * FACEBOOK PAGE MONITOR + FORM MAPPING — the pure helpers (no I/O, no Nest).
 *
 * STORAGE CONTRACT (one Meta capture channel can watch MANY Pages):
 *   · secrets.page_token_<page_id>  one AES-GCM ciphertext per Page (ChannelService.mergeSecrets
 *                                   encrypts FLAT string values only, hence one key per Page).
 *   · secrets.page_access_token     LEGACY — the primary Page's token, still written so a
 *                                   channel connected before this feature keeps working.
 *   · config.pages                  [{ page_id, page_name, monitored, subscribed, … }] — NO tokens.
 *   · config.page_id / page_name    LEGACY — the primary Page.
 *
 * `monitored` is the ADMIN'S INTENT and is what ingestion gates on. `subscribed` is the
 * last status Facebook reported for our app on that Page. They are deliberately separate:
 * a transient Graph error during "Refresh status" must never start dropping leads.
 */
import { CHANNEL_TARGETS, resolveTarget } from './providers';

export interface FbPageEntry {
  page_id: string;
  page_name: string;
  /** leads for this Page are ingested (false -> deliveries are logged as skipped) */
  monitored: boolean;
  /** last known Graph status of our app's leadgen subscription; null = never checked */
  subscribed: boolean | null;
  subscribed_at: string | null;
  checked_at: string | null;
  last_error: string | null;
}

export interface FbQuestion { key: string; label: string; type: string }
export interface FbForm { form_id: string; form_name: string; status: string; locale: string; questions: FbQuestion[] }

const S = (v: unknown): string => (v == null ? '' : String(v)).trim();

/** The secrets key that holds one Page's token. */
export const pageTokenKey = (pageId: string): string => `page_token_${pageId}`;
export const isPageTokenKey = (k: string): boolean => k.startsWith('page_token_');

/** A target meaning "drop this answer" — beats the built-in aliases (full_name, email…). */
export const IGNORE_TARGET = '_ignore';

/** config.pages, tolerant of anything a hand-edited row could contain. Pure. */
export function storedPages(config: unknown): FbPageEntry[] {
  const raw = (config as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(raw)) return [];
  const out: FbPageEntry[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = S(r?.page_id);
    if (!id || out.some((p) => p.page_id === id)) continue;
    out.push({
      page_id: id,
      page_name: S(r.page_name),
      monitored: r.monitored === true,
      subscribed: typeof r.subscribed === 'boolean' ? r.subscribed : null,
      subscribed_at: S(r.subscribed_at) || null,
      checked_at: S(r.checked_at) || null,
      last_error: S(r.last_error) || null,
    });
  }
  return out;
}

/**
 * The Page a leadgen change belongs to: `changes[].value.page_id`, else the enclosing
 * `entry[].id` (for `object: "page"` deliveries the entry id IS the Page id). Pure.
 */
export function webhookPageId(entryId: unknown, value: unknown): string {
  return S((value as { page_id?: unknown } | null)?.page_id) || S(entryId);
}

/** Does /{page_id}/subscribed_apps list OUR app with the leadgen field? Pure. */
export function isLeadgenSubscribed(json: unknown, appId: string): boolean {
  const rows = Array.isArray((json as { data?: unknown[] } | null)?.data) ? (json as { data: any[] }).data : [];
  return rows.some((r) => {
    const fields: unknown[] = Array.isArray(r?.subscribed_fields) ? r.subscribed_fields : [];
    const mine = !appId || S(r?.id) === appId;
    return mine && fields.map(S).includes('leadgen');
  });
}

/** One Graph `questions[]` array -> [{key,label,type}]. `key` is what field_data[].name carries. */
export function parseFbQuestions(raw: unknown): FbQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: FbQuestion[] = [];
  for (const q of raw as Array<Record<string, unknown>>) {
    const key = S(q?.key) || S(q?.id);
    if (!key || out.some((x) => x.key === key)) continue;
    out.push({ key, label: S(q.label) || key, type: S(q.type) || 'CUSTOM' });
  }
  return out;
}

/** One page of /{page_id}/leadgen_forms. Pure. */
export function parseFbForms(json: unknown): FbForm[] {
  const rows = Array.isArray((json as { data?: unknown[] } | null)?.data) ? (json as { data: any[] }).data : [];
  return rows.filter((r) => r?.id).map((r) => ({
    form_id: S(r.id), form_name: S(r.name) || S(r.id), status: S(r.status) || 'UNKNOWN',
    locale: S(r.locale), questions: parseFbQuestions(r.questions),
  }));
}

/**
 * THE CRM FIELDS A META FORM QUESTION CAN FEED — derived from what the channel mapper
 * (providers.ts › pairsToPayload) actually accepts, not invented:
 *   · CHANNEL_TARGETS  — minus `external_id`, which the Meta handler always overwrites
 *                        with the leadgen_id (its idempotency key);
 *   · `_first`/`_last` — folded into full_name by pairsToPayload;
 *   · `cf:<field_key>` — appended per org from custom_field_def by the service.
 */
const LABELS: Record<string, string> = {
  full_name: 'Full name', phone: 'Phone', alt_phone: 'Alternate phone', whatsapp_phone: 'WhatsApp number',
  email: 'Email', state: 'State', city: 'City', course: 'Course', qualification: 'Qualification',
  budget: 'Budget', note: 'Remarks / note', tags: 'Tags',
};
export const META_CRM_FIELDS: Array<{ key: string; label: string }> = [
  ...(CHANNEL_TARGETS as readonly string[])
    .filter((k) => k !== 'external_id')
    .flatMap((k) => (k === 'full_name'
      ? [{ key: k, label: LABELS[k] }, { key: '_first', label: 'First name' }, { key: '_last', label: 'Last name' }]
      : [{ key: k, label: LABELS[k] ?? k }])),
];

/** Meta's typed (non-custom) questions -> the CRM field they obviously mean. */
const TYPE_TARGET: Record<string, string> = {
  FULL_NAME: 'full_name', FIRST_NAME: '_first', LAST_NAME: '_last',
  PHONE: 'phone', PHONE_NUMBER: 'phone', EMAIL: 'email', WORK_EMAIL: 'email',
  CITY: 'city', STATE: 'state', PROVINCE: 'state',
};

/** Last resort for a custom question: a tell-tale word in its label ("Which course?"). */
const LABEL_HINTS: Array<[RegExp, string]> = [
  [/whatsapp/, 'whatsapp_phone'], [/email|mail/, 'email'], [/phone|mobile|contact|number/, 'phone'],
  [/city|town/, 'city'], [/state|province|region/, 'state'],
  [/course|program|interested/, 'course'], [/qualification|education|degree/, 'qualification'],
  [/budget|fee/, 'budget'], [/name/, 'full_name'], [/remark|comment|message|note|query/, 'note'],
];

/**
 * The auto-map offered when nothing is saved yet: the same aliases ingestion already
 * applies (resolveTarget), then Meta's question TYPE, then the label (exact alias, then a
 * tell-tale word). Pure.
 */
export function suggestFieldMap(questions: FbQuestion[], allowed?: Set<string>): Record<string, string> {
  const ok = (t: string | null | undefined): t is string => !!t && (!allowed || allowed.has(t));
  const out: Record<string, string> = {};
  for (const q of questions) {
    const label = String(q.label ?? '').toLowerCase();
    const hint = LABEL_HINTS.find(([re]) => re.test(label))?.[1];
    const t = [resolveTarget(q.key), TYPE_TARGET[q.type.toUpperCase()], resolveTarget(q.label), hint].find(ok);
    if (t) out[q.key] = t;
  }
  return out;
}

/**
 * Validate an incoming form field_map against the allowed targets. A blank / null target
 * means "— ignore —" and is stored as IGNORE_TARGET so it also beats the built-in aliases.
 */
export function cleanFormFieldMap(
  incoming: unknown, allowed: Set<string>,
): { map: Record<string, string>; unknown: string[] } {
  const map: Record<string, string> = {};
  const unknown: string[] = [];
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return { map, unknown };
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    const key = S(k);
    if (!key) continue;
    const t = S(v);
    if (!t || t === IGNORE_TARGET) { map[key] = IGNORE_TARGET; continue; }
    if (!allowed.has(t)) { unknown.push(t); continue; }
    map[key] = t;
  }
  return { map, unknown };
}

const normKey = (k: string) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Form-level map laid OVER the channel-level map — FORM WINS. resolveTarget() matches
 * keys format-insensitively ("Which Course" == "which_course"), so a channel entry that
 * collides with a form entry is removed rather than merely shadowed. Pure.
 */
export function overlayFieldMap(
  channelMap: Record<string, string>, formMap: Record<string, string>,
): Record<string, string> {
  const taken = new Set(Object.keys(formMap ?? {}).map(normKey));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(channelMap ?? {})) if (!taken.has(normKey(k))) out[k] = v;
  return { ...out, ...(formMap ?? {}) };
}

/**
 * How many of a form's questions will actually feed a CRM field at ingestion — i.e. under
 * the built-in aliases + the channel map + this form's map, exactly as the handler resolves
 * them. Pure.
 */
export function mappedCount(
  questions: FbQuestion[], formMap: Record<string, string>, channelMap: Record<string, string> = {},
): number {
  const eff = overlayFieldMap(channelMap, formMap);
  return questions.filter((q) => {
    const t = resolveTarget(q.key, eff);
    return !!t && t !== IGNORE_TARGET;
  }).length;
}
