/**
 * THE TEMPLATE ENGINE — a PURE function, like the scoring engine (Sprint 3).
 *
 * No DB, no clock, no I/O: `render(body, vars)` in, `{text, missing}` out. That makes
 * every rule below exhaustively unit-testable, and it makes the LIVE PREVIEW in the UI
 * provably identical to what will actually be sent — the preview calls the same function
 * with a sample lead.
 *
 * MISSING VARIABLES ARE NOT AN ERROR AND NOT A CRASH. A lead with no course must not
 * blow up a WhatsApp send at 2am, and it must not send the customer the literal string
 * "{{course}}". So an unresolved variable renders as EMPTY and is REPORTED in `missing[]`.
 * The UI shows that list in amber on the preview and on the send log, so the client can
 * see "this template will go out with a blank course for 14 leads" BEFORE he sends it.
 */

/** Everything a template may reference. Built by TemplateService from the lead + its path. */
export interface TemplateVars {
  lead?: {
    name?: string | null; phone?: string | null; email?: string | null;
    whatsapp?: string | null; city?: string | null; score?: number | null;
    temperature?: string | null; priority?: string | null; dob?: string | null;
  };
  course?: string | null;
  course_fee?: number | string | null;
  counsellor?: string | null;
  branch?: string | null;
  vertical?: string | null;
  pipeline?: string | null;
  campaign?: string | null;
  source?: string | null;
  stage?: string | null;
  org?: string | null;
  today?: string | null;
  next_follow_up?: string | null;
  [k: string]: unknown;
}

export interface RenderResult {
  text: string;
  /** the variables the template asked for and the lead could not answer */
  missing: string[];
  /** every variable the template references, resolved or not */
  used: string[];
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** `lead.name` -> vars.lead.name. Unknown paths resolve to undefined, never throw. */
export function lookup(vars: TemplateVars, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Every variable a template references — drives the "Variables" column and the preview. */
export function variablesOf(...bodies: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const b of bodies) {
    if (!b) continue;
    for (const m of String(b).matchAll(TOKEN)) out.add(m[1]);
  }
  return [...out];
}

/** Resolve `{{...}}` against the lead. Missing -> '' and reported. */
export function render(body: string | null | undefined, vars: TemplateVars): RenderResult {
  const missing = new Set<string>();
  const used = new Set<string>();
  const text = String(body ?? '').replace(TOKEN, (_m, path: string) => {
    used.add(path);
    const v = lookup(vars, path);
    if (isBlank(v)) { missing.add(path); return ''; }
    return String(v);
  });
  return { text, missing: [...missing], used: [...used] };
}

/**
 * Render a whole template (subject + body + the WhatsApp positional params) in one pass,
 * so `missing` is the union across all of them — you cannot approve a preview that looks
 * fine and then have a blank slip through in the subject line.
 */
export interface TemplateLike {
  channel: string;
  subject?: string | null;
  body?: string | null;
  wa_template_name?: string | null;
  wa_language?: string | null;
  wa_params?: string[] | null;
  sms_sender_id?: string | null;
  sms_dlt_template_id?: string | null;
}

export interface RenderedTemplate {
  subject: string | null;
  body: string;
  wa_template_name: string | null;
  wa_language: string | null;
  wa_params: string[];
  sms_sender_id: string | null;
  sms_dlt_template_id: string | null;
  missing: string[];
  used: string[];
}

export function renderTemplate(t: TemplateLike, vars: TemplateVars): RenderedTemplate {
  const missing = new Set<string>();
  const used = new Set<string>();
  const one = (s: string | null | undefined) => {
    const r = render(s, vars);
    r.missing.forEach((m) => missing.add(m));
    r.used.forEach((u) => used.add(u));
    return r.text;
  };
  const subject = t.channel === 'email' ? one(t.subject) : null;
  const body = one(t.body);
  const wa_params = (t.wa_params ?? []).map((p) => one(p));

  return {
    subject: subject || null,
    body,
    wa_template_name: t.wa_template_name || null,
    wa_language: t.wa_language || null,
    wa_params,
    sms_sender_id: t.sms_sender_id || null,
    sms_dlt_template_id: t.sms_dlt_template_id || null,
    missing: [...missing],
    used: [...used],
  };
}

/**
 * The catalogue the UI shows next to the editor — "click to insert". Keeping it here,
 * beside the resolver, is what stops the two drifting apart (a variable in this list that
 * the resolver cannot answer is a bug the client would find, not us).
 */
export const VARIABLE_CATALOG: Array<{ key: string; label: string; sample: string }> = [
  { key: 'lead.name', label: 'Lead name', sample: 'Priya Sharma' },
  { key: 'lead.phone', label: 'Lead mobile', sample: '+919810000001' },
  { key: 'lead.email', label: 'Lead email', sample: 'priya@example.com' },
  { key: 'lead.city', label: 'Lead city', sample: 'New Delhi' },
  { key: 'lead.score', label: 'Lead score', sample: '72' },
  { key: 'lead.temperature', label: 'Lead band (Hot/Warm/Cold)', sample: 'hot' },
  { key: 'course', label: 'Course', sample: 'IELTS' },
  { key: 'course_fee', label: 'Course fee', sample: '45000' },
  { key: 'counsellor', label: 'Counsellor (lead owner)', sample: 'Asha Rao' },
  { key: 'branch', label: 'Branch', sample: 'Vikaspuri' },
  { key: 'vertical', label: 'Vertical', sample: 'BCL' },
  { key: 'pipeline', label: 'Pipeline', sample: 'Admissions' },
  { key: 'campaign', label: 'Campaign', sample: 'Meta July' },
  { key: 'source', label: 'Lead source', sample: 'Meta Ads' },
  { key: 'stage', label: 'Current stage', sample: 'Contacted' },
  { key: 'org', label: 'Organisation', sample: 'Tech Lingua LLP' },
  { key: 'today', label: "Today's date", sample: '14/07/2026' },
  { key: 'next_follow_up', label: 'Next follow-up', sample: '16/07/2026 11:00' },
];

/** The sample lead the live preview uses when the client has not picked a real one. */
export const SAMPLE_VARS: TemplateVars = {
  lead: { name: 'Priya Sharma', phone: '+919810000001', email: 'priya@example.com', city: 'New Delhi', score: 72, temperature: 'hot', priority: 'high' },
  course: 'IELTS', course_fee: 45000, counsellor: 'Asha Rao',
  branch: 'Vikaspuri', vertical: 'BCL', pipeline: 'Admissions',
  campaign: 'Meta July', source: 'Meta Ads', stage: 'Contacted',
  org: 'Tech Lingua LLP', today: '14/07/2026', next_follow_up: '16/07/2026 11:00',
};
