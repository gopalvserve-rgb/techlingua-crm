import { looksLikePhoneQuery, normalizePhone, phoneDigits } from './phone.util';

/** QA DEF-QA4-02 / DEF-QA4-05 — canonical phone form + phone-query detection. */

describe('normalizePhone', () => {
  const CANON = '+919811100001';

  it.each([
    ['+919811100001', CANON],
    ['+91 98111 00001', CANON],
    ['+91-98111-00001', CANON],
    ['98111 00001', CANON],
    ['9811100001', CANON],
    ['09811100001', CANON],
    ['0091 98111 00001', CANON],
    ['(+91) 98111-000-01', CANON],
    ['91 98111 00001', CANON],
  ])('collapses %s to the canonical form', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('all four QA repro variants collide on one canonical value', () => {
    const variants = ['+91-98111-00001', '98111 00001', '09811100001', '+919811100001'];
    expect(new Set(variants.map(normalizePhone)).size).toBe(1);
  });

  it('keeps short/invalid values as bare digits (no fake +91)', () => {
    expect(normalizePhone('123')).toBe('123');
    expect(normalizePhone('1')).toBe('1');
  });

  it('preserves a leading + on non-Indian numbers', () => {
    expect(normalizePhone('+1 (415) 555-0132')).toBe('+14155550132');
  });

  it('passes through null/empty', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBe('');
  });
});

describe('phone search-query helpers', () => {
  it('phoneDigits strips everything non-numeric', () => {
    expect(phoneDigits('98222 000 07')).toBe('9822200007');
    expect(phoneDigits('+91-98-22')).toBe('919822');
  });

  it('detects phone-like queries', () => {
    expect(looksLikePhoneQuery('98222 000 07')).toBe(true);
    expect(looksLikePhoneQuery('+91-98222-00007')).toBe(true);
    expect(looksLikePhoneQuery('9822200007')).toBe(true);
  });

  it('rejects name/email/short queries', () => {
    expect(looksLikePhoneQuery('QA Bulk 07')).toBe(false);
    expect(looksLikePhoneQuery('full@lead.test')).toBe(false);
    expect(looksLikePhoneQuery('123')).toBe(false);
  });
});
