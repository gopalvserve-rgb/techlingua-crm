import { describe, expect, it } from '@jest/globals';
import { resolveDltBody, normaliseMapping, DEFAULT_VAR_MAPPING, pickTemplate } from './sms-template.engine';
import { composeNimbusUrl, isUnicodeSms } from '../messaging/transports';

describe('DLT {#var#} resolver', () => {
  it('resolves markers IN ORDER against the mapping (default [name, course])', () => {
    const body = 'Dear {#var#}, thank you for your interest in {#var#}. - BCL';
    const r = resolveDltBody(body, DEFAULT_VAR_MAPPING, { name: 'Priya', course: 'IELTS' });
    expect(r.text).toBe('Dear Priya, thank you for your interest in IELTS. - BCL');
    expect(r.count).toBe(2);
    expect(r.missing).toEqual([]);
  });

  it('respects a custom ordered mapping', () => {
    const body = '{#var#} enquired about {#var#}';
    const r = resolveDltBody(body, ['course', 'name'], { name: 'Priya', course: 'IELTS' });
    expect(r.text).toBe('IELTS enquired about Priya');
  });

  it('a missing value renders BLANK (never the literal marker) and is reported', () => {
    const body = 'Dear {#var#}, interested in {#var#}?';
    const r = resolveDltBody(body, DEFAULT_VAR_MAPPING, { name: 'Priya', course: '' });
    expect(r.text).toBe('Dear Priya, interested in ?');
    expect(r.missing).toEqual(['course']);
    expect(r.text.includes('{#var#}')).toBe(false);
  });

  it('normaliseMapping accepts array, csv and json; defaults to [name, course]', () => {
    expect(normaliseMapping(['a', 'b'])).toEqual(['a', 'b']);
    expect(normaliseMapping('name, course')).toEqual(['name', 'course']);
    expect(normaliseMapping('["x","y"]')).toEqual(['x', 'y']);
    expect(normaliseMapping(null)).toEqual(['name', 'course']);
  });
});

describe('Nimbus URL composition', () => {
  const base = {
    user: 'techlingua', authkey: '92wgQ8noCHyY', sender: 'BRTISC',
    mobile: '917827878780', text: 'Dear Priya, interest in IELTS. - BCL',
    entityid: '1101234567890', templateid: '1707161234567890123',
  };

  it('composes the exact pushsms URL with rpt=1 and url-encoded text', () => {
    const url = composeNimbusUrl(base);
    expect(url.startsWith('http://nimbusit.net/api/pushsms?')).toBe(true);
    expect(url).toContain('user=techlingua');
    expect(url).toContain('authkey=92wgQ8noCHyY');
    expect(url).toContain('sender=BRTISC');
    expect(url).toContain('mobile=917827878780');
    expect(url).toContain('entityid=1101234567890');
    expect(url).toContain('templateid=1707161234567890123');
    expect(url).toContain('rpt=1');
    // the space and comma in the text MUST be percent-encoded, never raw
    expect(url).toContain('text=Dear%20Priya%2C%20interest%20in%20IELTS.%20-%20BCL');
    expect(url).not.toContain('type=1');          // ASCII text => no unicode flag
  });

  it('adds &type=1 for unicode text only', () => {
    expect(isUnicodeSms('hello')).toBe(false);
    expect(isUnicodeSms('प्रिय')).toBe(true);
    const url = composeNimbusUrl({ ...base, text: 'प्रिय', unicode: true });
    expect(url).toContain('type=1');
  });

  it('honours a custom base url', () => {
    const url = composeNimbusUrl({ ...base, baseUrl: 'http://alt.example/send' });
    expect(url.startsWith('http://alt.example/send?')).toBe(true);
  });
});

describe('branch+vertical template match (pickTemplate)', () => {
  const BCL = { id: 1, branch_id: 9, vertical_id: 1, name: 'BCL Lead Creation II' };
  const INSTA = { id: 2, branch_id: 9, vertical_id: 2, name: 'insta Lead Creation IV' };
  const ORGWIDE = { id: 3, branch_id: null, vertical_id: null, name: 'Fallback' };

  it('a BCL lead gets the BCL template, an INSTA lead gets the INSTA template', () => {
    expect(pickTemplate([BCL, INSTA], 9, 1)?.name).toBe('BCL Lead Creation II');
    expect(pickTemplate([BCL, INSTA], 9, 2)?.name).toBe('insta Lead Creation IV');
  });

  it('no matching branch+vertical => no template (no send)', () => {
    expect(pickTemplate([BCL, INSTA], 10, 3)).toBeNull();
    expect(pickTemplate([], 9, 1)).toBeNull();
  });

  it('most-specific wins: exact branch+vertical beats an org-wide fallback', () => {
    expect(pickTemplate([ORGWIDE, BCL], 9, 1)?.id).toBe(1);
    // a lead with no exact row still falls back to the org-wide template
    expect(pickTemplate([ORGWIDE, BCL], 9, 5)?.id).toBe(3);
  });
});
