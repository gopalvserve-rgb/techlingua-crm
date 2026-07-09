/**
 * Canonical phone normalisation (QA DEF-QA4-02 — NeoDove duplicacy `match_key: phone`).
 *
 * All common representations of the same Indian number collapse to ONE canonical
 * form, `+91XXXXXXXXXX`, which is what we persist and compare on:
 *   `+91-98111-00001`, `98111 00001`, `09811100001`, `0091 98111 00001`,
 *   `(+91) 98111-00001` and `+919811100001`  ->  `+919811100001`
 *
 * Rules (kept in exact sync with db/migrations/009_phone_canonical.sql):
 *   1. strip everything that is not a digit (spaces, dashes, parens, dots, +)
 *   2. `00` international-call prefix (>12 digits)  -> drop the `00`
 *   3. 11 digits starting `0` (trunk prefix)        -> drop the `0`
 *   4. 10 digits                                    -> prepend `+91`
 *   5. 12 digits starting `91`                      -> prepend `+`
 *   6. anything else (short/foreign): keep the digits, preserving a leading `+`
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return trimmed;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length > 12 && digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return `+91${digits}`;
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
