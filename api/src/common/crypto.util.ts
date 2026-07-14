import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * SECRETS AT REST (Sprint 2 / WS3 — lead capture channels).
 *
 * Channel credentials (Meta app secret + page access token, Google Ads
 * `google_key`, Google service-account JSON / API key) are supplied by the
 * client in the Settings UI and MUST NOT exist in the repo, in an env var per
 * channel, in audit_log, or in any API response.
 *
 * They are therefore stored in `capture_channel.secrets` as AES-256-GCM
 * ciphertexts (`enc:v1:<iv>:<tag>:<ct>`, all base64) and only ever decrypted in
 * memory at the moment a signature is verified or an API is called. The API
 * returns them MASKED (`••••••1234`) — an admin can see that a secret is set and
 * replace it, never read it back.
 *
 * The data-encryption key is derived (scrypt) from `SECRETS_KEY`. If that env var
 * is absent we fall back to `JWT_SECRET` so a fresh dev/CI box works with no
 * setup; production sets SECRETS_KEY explicitly (see docs/CHANNEL_SETUP.md).
 * Rotating the key makes existing ciphertexts unreadable — decryptSecret() then
 * returns null and the channel degrades to "not configured" rather than crashing.
 */

const PREFIX = 'enc:v1:';
const SALT = 'techlingua.channel.secrets.v1';

let cached: Buffer | null = null;
function dek(): Buffer {
  if (cached) return cached;
  const material = process.env.SECRETS_KEY || process.env.JWT_SECRET || 'dev-only-secret-change-me';
  cached = scryptSync(material, SALT, 32);
  return cached;
}

/** Test/rotation hook: forget the derived key (next call re-derives from env). */
export function resetSecretKeyCache(): void { cached = null; }

export function isEncrypted(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/** Returns null when the value cannot be decrypted (wrong/rotated key, corrupt row). */
export function decryptSecret(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (!isEncrypted(v)) return null;          // plaintext is never trusted or returned
  try {
    const [ivB, tagB, ctB] = v.slice(PREFIX.length).split(':');
    const d = createDecipheriv('aes-256-gcm', dek(), Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** What an admin sees instead of the secret: proof it is set, not the value. */
export function maskSecret(plain: string | null | undefined): string {
  if (!plain) return '';
  const s = String(plain);
  return s.length <= 4 ? '••••' : '••••••' + s.slice(-4);
}

/** Constant-time compare that never throws and never leaks length via early return. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // hash both so unequal lengths still take the same path (timingSafeEqual throws on length mismatch)
  const ha = createHmac('sha256', 'cmp').update(ba).digest();
  const hb = createHmac('sha256', 'cmp').update(bb).digest();
  return timingSafeEqual(ha, hb);
}

/** URL-safe random token — channel public keys and Meta verify tokens. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
