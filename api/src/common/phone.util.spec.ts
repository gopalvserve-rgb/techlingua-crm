import { looksLikePhoneQuery, normalizePhone, phoneDigits, phoneQueryFragments } from './phone.util';

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

  // client update #2 — country-aware E.164
  it.each([
    ['+44 7911 123456', '+447911123456'],
    ['+44-7911-123456', '+447911123456'],
    ['0044 7911 123456', '+447911123456'],
    ['+1 (212) 555-0100', '+12125550100'],
    ['001 212 555 0100', '+12125550100'],
    ['+971 50 123 4567', '+971501234567'],
  ])('canonicalises international %s to E.164 %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('keeps the +91 default ONLY for bare 10-digit Indian nationals', () => {
    expect(normalizePhone('9811100001')).toBe('+919811100001');   // national -> +91
    expect(normalizePhone('09811100001')).toBe('+919811100001');  // trunk 0 -> +91
    expect(normalizePhone('+447911123456')).toBe('+447911123456'); // explicit cc untouched
    expect(normalizePhone('00447911123456')).toBe('+447911123456'); // 00-prefix keeps real cc
  });

  it('is idempotent — already-canonical +91 rows re-normalise to themselves (no migration needed)', () => {
    for (const v of ['+919811100001', '+447911123456', '+12125550100']) {
      expect(normalizePhone(v)).toBe(v);
    }
  });

  it('dedupe negative: +44 and +91 with the same national digits do NOT collide', () => {
    const uk = normalizePhone('+44 9811100001');
    const india = normalizePhone('9811100001');
    expect(uk).toBe('+449811100001');
    expect(india).toBe('+919811100001');
    expect(uk).not.toBe(india);
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

describe('phoneQueryFragments (country-agnostic search variants)', () => {
  it('raw digits are always a fragment', () => {
    expect(phoneQueryFragments('7911 123456')).toEqual(['7911123456']);
  });
  it('strips 00 dialing prefix as an extra variant', () => {
    expect(phoneQueryFragments('0044 7911')).toEqual(['00447911', '447911']);
  });
  it('strips trunk 0 as an extra variant', () => {
    expect(phoneQueryFragments('07911 123456')).toEqual(['07911123456', '7911123456']);
  });
  it('drops fragments shorter than 4 digits', () => {
    expect(phoneQueryFragments('0091')).toEqual(['0091']);
  });
});
