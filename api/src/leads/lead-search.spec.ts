import { buildLeadSearch } from './leads.service';

/**
 * Client update #2 — lead search matching matrix: q matches name (ILIKE),
 * email (ILIKE) and phone (digits-normalised contains, country-code agnostic).
 */
describe('buildLeadSearch', () => {
  const build = (q: string) => {
    const params: unknown[] = [];
    const sql = buildLeadSearch(q, params);
    return { sql, params };
  };

  it('text query -> name + email + every phone column LIKE on one param', () => {
    const { sql, params } = build('asha');
    expect(sql).toBe('(l.full_name ILIKE $1 OR lower(l.email) LIKE lower($1)'
      + ' OR l.phone LIKE $1 OR l.whatsapp_phone LIKE $1 OR l.alt_phone LIKE $1)');
    expect(params).toEqual(['%asha%']);
  });

  // FB-2026-019 — Quick Contact has an Alternate Mobile + a WhatsApp Number box, and
  // "search any lead" always searched all three columns; the list search must too.
  it('a phone query searches the alternate and WhatsApp numbers as well', () => {
    const { sql } = build('98111 00001');
    for (const col of ['l.phone', 'l.whatsapp_phone', 'l.alt_phone']) {
      expect(sql).toContain(`regexp_replace(${col}, '\\D', '', 'g') LIKE $2`);
    }
  });

  // FB-2026-019 — the phone box always emits "+91<national>", but an imported / web-form
  // lead can hold the bare 10 digits. The +91 query has to find it (and the other way round).
  it('a +91 query also searches the bare 10-digit national number', () => {
    const { params } = build('+91 98111 00001');
    expect(params).toContain('%919811100001%');
    expect(params).toContain('%9811100001%');
  });

  it('00 91 and a trunk-0 +91 query collapse to the same national digits', () => {
    expect(build('0091 98111 00001').params).toContain('%9811100001%');
    expect(build('09811100001').params).toContain('%9811100001%');
  });

  it('a non-Indian country code is NOT collapsed (a +44 number is not a +91 number)', () => {
    const { params } = build('+44 7911 123456');
    expect(params).toContain('%447911123456%');
    expect(params).not.toContain('%7911123456%');
  });

  // OBS backlog (b): the email clause must be sargable against the
  // lower(email) index from migration 014 (trgm GIN or btree fallback).
  it('email clause uses lower(email) LIKE lower(...) so the lower(email) index applies', () => {
    const { sql } = build('someone@example.com');
    expect(sql).toContain('lower(l.email) LIKE lower(');
    expect(sql).not.toContain('l.email ILIKE');
  });

  it('email fragment stays a plain ILIKE (no digit clause)', () => {
    const { sql } = build('asha@techlingua');
    expect(sql).not.toContain('regexp_replace');
  });

  it('phone-like query adds a digits-contains clause', () => {
    const { sql, params } = build('98111 00001');
    expect(sql).toContain("regexp_replace(l.phone, '\\D', '', 'g') LIKE $2");
    expect(params[1]).toBe('%9811100001%');
  });

  it('country-code agnostic: trunk-0 query also searches without the 0', () => {
    const { params } = build('07911 123456');
    expect(params).toContain('%07911123456%');
    expect(params).toContain('%7911123456%');
  });

  it('00-prefixed international query also searches the bare cc digits', () => {
    const { params } = build('0044 7911 123456');
    expect(params).toContain('%447911123456%');
  });

  it('+cc fragment searches by digits (finds +44… stored rows)', () => {
    const { sql, params } = build('+44 7911');
    expect(sql).toContain('regexp_replace');
    expect(params).toContain('%447911%');
  });

  it('offsets its placeholders after existing params', () => {
    const params: unknown[] = ['x', 'y'];
    const sql = buildLeadSearch('asha', params);
    expect(sql).toContain('$3');
    expect(params).toHaveLength(3);
  });
});
