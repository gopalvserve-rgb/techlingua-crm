import {
  decryptSecret, encryptSecret, isEncrypted, maskSecret, randomToken, resetSecretKeyCache, safeEqual,
} from './crypto.util';

describe('crypto.util — channel secrets at rest', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('encrypts and decrypts a credential', () => {
    const ct = encryptSecret('super-secret-app-secret');
    expect(ct).toMatch(/^enc:v1:/);
    expect(ct).not.toContain('super-secret');
    expect(decryptSecret(ct)).toBe('super-secret-app-secret');
  });

  it('produces a different ciphertext every time (random IV)', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });

  it('handles a multi-line service-account JSON', () => {
    const sa = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
    expect(decryptSecret(encryptSecret(sa))).toBe(sa);
  });

  it('returns null (never plaintext) for a rotated key or a corrupt value', () => {
    const ct = encryptSecret('abc');
    process.env.SECRETS_KEY = 'a-different-key';
    resetSecretKeyCache();
    expect(decryptSecret(ct)).toBeNull();          // degrades -> channel reads as "not configured"
    expect(decryptSecret('enc:v1:zz:zz:zz')).toBeNull();
  });

  it('never trusts a plaintext value that was written by hand', () => {
    expect(decryptSecret('plain-secret')).toBeNull();
    expect(isEncrypted('plain-secret')).toBe(false);
  });

  it('masks a secret for display', () => {
    expect(maskSecret('abcd1234efgh')).toBe('••••••efgh');
    expect(maskSecret('')).toBe('');
    expect(maskSecret('ab')).toBe('••••');
  });

  it('safeEqual is length-safe and correct', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);   // must not throw on a length mismatch
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
  });

  it('randomToken is url-safe and unguessable', () => {
    const t = randomToken(18);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(20);
    expect(randomToken()).not.toBe(randomToken());
  });
});
