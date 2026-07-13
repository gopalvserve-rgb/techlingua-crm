/**
 * Canonical phone normalisation — country-aware E.164
 * (client update #2; supersedes the +91-only rules of QA DEF-QA4-02).
 *
 * Canonical form: `+<dialcode><national>` — what we persist and dedupe on
 * (NeoDove duplicacy `match_key: phone`). A +44 and a +91 number with the same
 * national digits are DIFFERENT leads.
 *
 * Rules (kept in exact sync with db/migrations/014_phone_e164_search.sql):
 *   1. strip everything that is not a digit (spaces, dashes, parens, dots)
 *   2. input starts with `+`               -> trust the dial code: `+<digits>`
 *   3. `00` international-call prefix      -> `+<digits after 00>`
 *   4. 11 digits starting `0` (trunk 0)    -> drop the `0`, treat as national
 *   5. 10 digits, no country info          -> assume Indian national: `+91<digits>`
 *      (the ONLY +91 default — preserves all existing stored +91 data)
 *   6. 12 digits starting `91`             -> `+<digits>` (bare 91XXXXXXXXXX)
 *   7. anything else (short/unknown): keep the digits, preserving a leading `+`
 *
 *   `+91-98111-00001`, `98111 00001`, `09811100001`, `0091 98111 00001`
 *     -> `+919811100001`
 *   `+44 7911 123456`, `0044 7911 123456` -> `+447911123456`
 *   `+1 (212) 555-0100`                   -> `+12125550100`
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return trimmed;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && digits.length > 6) return `+${digits}`;      // explicit country code wins
  if (digits.startsWith('00') && digits.length > 11) return `+${digits.slice(2)}`; // 00 international prefix
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);    // trunk 0
  if (digits.length === 10) return `+91${digits}`;                            // bare Indian national
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Digits-only projection of a string (for phone-fragment searches). */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * True when a search query looks like (part of) a phone number typed by a human:
 * only digits plus phone punctuation, with at least 4 digits (QA DEF-QA4-05).
 */
export function looksLikePhoneQuery(q: string): boolean {
  const t = q.trim();
  return /^[+(]?[\d\s\-().]+$/.test(t) && phoneDigits(t).length >= 4;
}

/**
 * Country-agnostic digit fragments to search stored phones with:
 * the raw digits plus variants without the 00/leading-0 dialing prefixes, so
 * "07911 123456" still finds `+447911123456` and "0044…" finds it too.
 */
export function phoneQueryFragments(q: string): string[] {
  const d = phoneDigits(q);
  const out = new Set<string>([d]);
  if (d.startsWith('00')) out.add(d.slice(2));
  else if (d.startsWith('0')) out.add(d.slice(1));
  return [...out].filter((f) => f.length >= 4);
}
