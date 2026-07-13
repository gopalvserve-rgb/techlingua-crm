import { computeMergeDiff, describeDiff, diffIsEmpty, isBlank, mergedCustomFields, sameValue } from './merge.util';

/**
 * The field-merge rule, in isolation. THE contract:
 *   blank + incoming value -> filled · conflict -> existing wins, incoming recorded.
 * Nothing here may ever produce a write that destroys an existing value.
 */
describe('merge.util — non-destructive field merge', () => {
  const existing = {
    full_name: 'Asha Rao', email: 'asha@real.com', alt_phone: null,
    city_id: 71, course_id: null, budget_id: null,
    temperature: 'warm', priority: 'med', score: 0, next_follow_up_at: null,
    custom_fields: { batch: 'Morning' },
  };

  it('fills blanks from the incoming record', () => {
    const d = computeMergeDiff(existing, { course_id: 21, alt_phone: '+919812300000' });
    expect(d.filled).toEqual({ course_id: 21, alt_phone: '+919812300000' });
    expect(d.conflicts).toEqual({});
  });

  it('keeps the EXISTING value on a conflict and records the incoming one', () => {
    const d = computeMergeDiff(existing, { email: 'typo@x.com', full_name: 'A Rao', city_id: 72 });
    expect(d.filled).toEqual({});
    expect(d.conflicts.email).toEqual({ kept: 'asha@real.com', incoming: 'typo@x.com' });
    expect(d.conflicts.full_name).toEqual({ kept: 'Asha Rao', incoming: 'A Rao' });
    expect(d.conflicts.city_id).toEqual({ kept: 71, incoming: 72 });
  });

  it('is a no-op when the incoming value is identical', () => {
    const d = computeMergeDiff(existing, { email: 'asha@real.com', city_id: 71 });
    expect(diffIsEmpty(d)).toBe(true);
  });

  it('ignores blank incoming values (a sparse webhook never blanks a lead)', () => {
    const d = computeMergeDiff(existing, { email: '', full_name: '   ', city_id: null, temperature: undefined });
    expect(diffIsEmpty(d)).toBe(true);
  });

  it('treats score 0 as "not scored" (its column default) but priority med as a real choice', () => {
    expect(isBlank('score', 0)).toBe(true);
    expect(isBlank('priority', 'med')).toBe(false);
    const d = computeMergeDiff(existing, { score: 80, priority: 'high' });
    expect(d.filled).toEqual({ score: 80 });                                  // 0 -> filled
    expect(d.conflicts.priority).toEqual({ kept: 'med', incoming: 'high' });  // med kept
  });

  it('merges custom fields by the same rule, key by key', () => {
    const d = computeMergeDiff(existing, { custom_fields: { batch: 'Evening', ref: 'RJ-9' } });
    expect(d.custom_filled).toEqual({ ref: 'RJ-9' });
    expect(d.custom_conflicts.batch).toEqual({ kept: 'Morning', incoming: 'Evening' });
    expect(mergedCustomFields(existing.custom_fields, d)).toEqual({ batch: 'Morning', ref: 'RJ-9' });
  });

  it('unions tags — never replaces them', () => {
    const d = computeMergeDiff(existing, {}, [41, 42, 43], [41]);
    expect(d.tags_added).toEqual([42, 43]);
  });

  it('carries the incoming note (appended separately, never merged into a field)', () => {
    const d = computeMergeDiff(existing, {}, [], [], '  came back via Meta ');
    expect(d.note).toBe('came back via Meta');
  });

  it('compares follow-up dates by instant, not by string', () => {
    expect(sameValue('next_follow_up_at', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00Z')).toBe(true);
  });

  it('never emits a write for a conflicting field (the diff drives the UPDATE)', () => {
    const d = computeMergeDiff(existing, { email: 'typo@x.com', course_id: 21 });
    expect(Object.keys(d.filled)).toEqual(['course_id']);       // ONLY the blank is written
    expect(Object.keys(d.filled)).not.toContain('email');
  });

  it('summarises itself for the timeline', () => {
    const d = computeMergeDiff(existing, { course_id: 21, email: 'typo@x.com' });
    expect(describeDiff(d)).toMatch(/filled Course/);
    expect(describeDiff(d)).toMatch(/kept existing Email \(incoming value recorded\)/);
  });
});
