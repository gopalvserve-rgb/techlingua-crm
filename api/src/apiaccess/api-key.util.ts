import { createHash, randomBytes } from 'crypto';
import { safeEqual } from '../common/crypto.util';

/**
 * API KEYS — the plaintext exists for exactly one HTTP response and is then
 * unrecoverable. We store a SHA-256 HASH of it (indexed, UNIQUE) and never the
 * key itself, so a database leak cannot be replayed against the API.
 *
 *   plaintext : tlk_live_<43 url-safe chars>   (shown ONCE, at creation)
 *   key_prefix: tlk_live_ab12                  (display: the masked list)
 *   key_last4 : the final 4 chars              (so the mask ends recognisably)
 *   key_hash  : sha256(plaintext) as 64 hex    (what we look up + compare)
 *
 * A key authenticates a request via `Authorization: Bearer <key>` or the
 * `X-API-Key` header. Lookup is by hash (one indexed row), and the final accept
 * is a CONSTANT-TIME compare of the two hashes (safeEqual) so a timing side
 * channel cannot walk the hash byte by byte.
 */

export const KEY_PREFIX = 'tlk_live_';

export interface GeneratedKey {
  /** the ONLY time the full key is ever available */
  plaintext: string;
  key_prefix: string;
  key_last4: string;
  key_hash: string;
}

/** SHA-256 hex of the full key — what is stored and compared, never the key. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

/** Mint a fresh key. The plaintext is returned once and must not be persisted. */
export function generateApiKey(): GeneratedKey {
  const rand = randomBytes(32).toString('base64url'); // 43 url-safe chars
  const plaintext = KEY_PREFIX + rand;
  return {
    plaintext,
    key_prefix: KEY_PREFIX + rand.slice(0, 4),
    key_last4: rand.slice(-4),
    key_hash: hashApiKey(plaintext),
  };
}

/** What the list shows instead of the key: proof it exists, not the value. */
export function maskApiKey(keyPrefix: string, last4?: string | null): string {
  return last4 ? `${keyPrefix}…${last4}` : `${keyPrefix}…`;
}

/**
 * Pull the presented key out of the request headers. Accepts either
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`. A stray "Bearer " prefix
 * on the X-API-Key header is tolerated. Returns '' when nothing key-shaped is
 * present, so the caller answers a clean 401 rather than throwing.
 */
export function extractApiKey(headers: Record<string, unknown>): string {
  const xkey = headers['x-api-key'];
  if (typeof xkey === 'string' && xkey.trim()) return xkey.trim().replace(/^Bearer\s+/i, '');
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

/** Does a presented key look like one of ours at all? (cheap pre-filter). */
export function isApiKeyShaped(plaintext: string): boolean {
  return typeof plaintext === 'string' && plaintext.startsWith(KEY_PREFIX) && plaintext.length >= KEY_PREFIX.length + 20;
}

/** Constant-time confirmation that a presented key matches a stored hash. */
export function keyMatchesHash(plaintext: string, storedHash: string): boolean {
  return safeEqual(hashApiKey(plaintext), storedHash);
}
