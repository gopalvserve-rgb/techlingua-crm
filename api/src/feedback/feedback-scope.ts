/**
 * OUT OF SCOPE (23 Nov 2026) — "while adding a feedback, if it's new or out of scope, show the
 * message: we can't take this because it's out of scope, refer the document — this task is not
 * available".
 *
 * The scope list (table feedback_scope_item, Help & Support › Feedback › Scope list) holds what the
 * agreed documents leave out, each with WHERE the document says so. A note whose words name one
 * of them — or that is left on one of its screens — is out of scope. The web panel runs the same
 * test while the person types (web/src/feedbackscope.ts mirrors matchScope), and the API runs it
 * again when the note is saved: the API's answer is the one that counts.
 *
 * Matching is by whole words, case-insensitive, punctuation ignored, and a trailing "s" allowed
 * ("conference calls" matches "conference call"). Phrases are kept specific on purpose: a bug on
 * a screen the client already has must never be turned away by a loose word.
 */
export interface ScopeItem {
  id: number;
  title: string;
  reference: string;           // where the document says it: document, section, question
  doc_says: string | null;     // what it says there, e.g. answered "Not required"
  phrases: string[];           // words in a note that mean this item
  page_paths: string[];        // the screens that belong to it
  is_active: boolean;
}

/** The documents the project was agreed on (named in the Additional Scope Statement, 18 Oct 2026). */
export const AGREED_DOCUMENTS =
  'the Client Requirements Discovery Document, the CRM/ERP Form Field Specification, the "CRM more update" list and the Assessment (test) module specification';

const norm = (s: unknown) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The first active item the note names (by its words) or sits on (by its page) — or null. */
export function matchScope(items: ScopeItem[], message: unknown, pagePath?: unknown): { item: ScopeItem; by: 'words' | 'page'; phrase?: string } | null {
  const text = norm(message);
  const path = String(pagePath ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  for (const item of items) {
    if (!item.is_active) continue;
    const onPage = (item.page_paths ?? []).some((p) => {
      const pp = String(p ?? '').trim().replace(/\/+$/, '');
      return !!pp && (path === pp || path.startsWith(`${pp}/`));
    });
    if (onPage) return { item, by: 'page' };
    for (const phrase of item.phrases ?? []) {
      const n = norm(phrase).trim();
      if (n.length >= 3 && (text.includes(` ${n} `) || text.includes(` ${n}s `))) return { item, by: 'words', phrase };
    }
  }
  return null;
}

/** What the reporter reads, for an item on the scope list. */
export function scopeNotice(item: Pick<ScopeItem, 'title' | 'reference' | 'doc_says'>): string {
  return `Out of scope — we can't take this. "${item.title}" is not available in this project. `
    + `Please refer to the scope document: ${item.reference}${item.doc_says ? ` — ${item.doc_says}` : ''}.`;
}

/** What the reporter reads when the team finds a request that is in none of the agreed documents. */
export const NEW_REQUEST_NOTICE =
  `Out of scope — we can't take this. It is a new request that is not in the agreed scope documents (${AGREED_DOCUMENTS}), `
  + 'so this task is not available in this project.';

/** Clean a list of phrases or paths typed into the scope list: trimmed, de-duplicated, sensible lengths. */
export function cleanList(v: unknown, opts: { max: number; path?: boolean }): string[] {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/);
  const out: string[] = [];
  for (const r of raw) {
    let t = String(r ?? '').trim().replace(/\s+/g, ' ');
    if (opts.path) { t = t.split(/[?#]/)[0].replace(/\/+$/, ''); if (t && !t.startsWith('/')) t = `/${t}`; }
    else t = t.toLowerCase();
    if (t.length < (opts.path ? 2 : 3) || t.length > 120) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= opts.max) break;
  }
  return out;
}
