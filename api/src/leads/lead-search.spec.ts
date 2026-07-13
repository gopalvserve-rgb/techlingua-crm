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

  it('text query -> name + email + phone LIKE on one param', () => {
    const { sql, params } = build('asha');
    expect(sql).toBe('(l.full_name ILIKE $1 OR lower(l.email) LIKE lower($1) OR l.phone LIKE $1)');
    expect(params).toEqual(['%asha%']);
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
