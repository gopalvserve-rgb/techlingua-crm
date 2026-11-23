/**
 * OUT OF SCOPE (23 Nov 2026) — the Feedback panel checks a note against the scope list while it is
 * typed, so the person reads "Out of scope — we can't take this … refer to the scope document"
 * BEFORE sending. This is the same test the API runs when the note is saved
 * (api/src/feedback/feedback-scope.ts — keep the two in step); the API's answer is the one that counts.
 */
export interface ScopeItem {
  id: number;
  title: string;
  reference: string;
  doc_says: string | null;
  phrases: string[];
  page_paths: string[];
  is_active: boolean;
  sort_order?: number;
  notice?: string;
}

const norm = (s: unknown) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The first active item the note names (whole words, a plural allowed) or sits on (its screens) — or null. */
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

/** The same words the API stores for a new request (api/src/feedback/feedback-scope.ts NEW_REQUEST_NOTICE). */
export const NEW_REQUEST_NOTICE =
  'Out of scope — we can\'t take this. It is a new request that is not in the agreed scope documents (the Client Requirements Discovery Document, '
  + 'the CRM/ERP Form Field Specification, the "CRM more update" list and the Assessment (test) module specification), '
  + 'so this task is not available in this project.';

/** "… — answered "Not required"" — where the document says so, and what it says. */
export const scopeRef = (item: Pick<ScopeItem, 'reference' | 'doc_says'>) =>
  `${item.reference}${item.doc_says ? ` — ${item.doc_says}` : ''}`;
