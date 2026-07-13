import { evalCondition, matchCondition, pickFromPool } from './distribution.util';

/**
 * NeoDove distribution engine — pure-logic unit tests (agent pool feature).
 * The DB-backed round-robin (campaign_distribution_state cursor) is covered
 * end-to-end by qa-full.mjs §9.11; here we pin the pick/eval semantics.
 */

describe('pickFromPool — round-robin with pool-edit safety', () => {
  it('rotates the pool in configured order', () => {
    const pool = [11, 22, 33];
    expect([0, 1, 2, 3, 4, 5].map((c) => pickFromPool(pool, c))).toEqual([11, 22, 33, 11, 22, 33]);
  });

  it('a shrunk pool never strands the cursor (modulo at pick time)', () => {
    // cursor advanced to 7 while the pool had 3 agents; pool edited down to 1
    expect(pickFromPool([99], 7)).toBe(99);
    // ...and down to 2: rotation simply continues over the current pool
    expect(pickFromPool([5, 6], 7)).toBe(6);
    expect(pickFromPool([5, 6], 8)).toBe(5);
  });

  it('a grown pool includes the new agents in the rotation', () => {
    expect(pickFromPool([1, 2, 3, 4], 3)).toBe(4);
  });

  it('empty pool -> null (on_demand semantics preserved)', () => {
    expect(pickFromPool([], 0)).toBeNull();
    expect(pickFromPool(undefined as any, 4)).toBeNull();
  });

  it('is negative-safe (fresh state row starts at 0, legacy -1 default too)', () => {
    expect(pickFromPool([7, 8], -1)).toBe(8);
  });
});

describe('evalCondition — ops', () => {
  it('equals is loose + case-insensitive (ids vs strings, NeoDove style)', () => {
    expect(evalCondition({ field: 'course', value: 'IELTS', assign_to_user_ids: [1] }, { course: 'ielts' })).toBe(true);
    expect(evalCondition({ field: 'course_id', value: 12, assign_to_user_ids: [1] }, { course_id: '12' })).toBe(true);
    expect(evalCondition({ field: 'priority', value: 'high', assign_to_user_ids: [1] }, { priority: 'med' })).toBe(false);
  });

  it('not_equals / contains / in', () => {
    expect(evalCondition({ field: 'city', op: 'not_equals', value: 'Delhi', assign_to_user_ids: [1] }, { city: 'Mumbai' })).toBe(true);
    expect(evalCondition({ field: 'full_name', op: 'contains', value: 'sh', assign_to_user_ids: [1] }, { full_name: 'Ashish' })).toBe(true);
    expect(evalCondition({ field: 'full_name', op: 'contains', value: 'zz', assign_to_user_ids: [1] }, { full_name: 'Ashish' })).toBe(false);
    expect(evalCondition({ field: 'priority', op: 'in', value: ['high', 'med'], assign_to_user_ids: [1] }, { priority: 'high' })).toBe(true);
    expect(evalCondition({ field: 'priority', op: 'in', value: ['high'], assign_to_user_ids: [1] }, { priority: 'low' })).toBe(false);
  });

  it('missing lead field never matches equals/contains', () => {
    expect(evalCondition({ field: 'ghost', value: 'x', assign_to_user_ids: [1] }, {})).toBe(false);
    expect(evalCondition({ field: 'ghost', op: 'contains', value: 'x', assign_to_user_ids: [1] }, {})).toBe(false);
  });
});

describe('matchCondition — first matching rule wins', () => {
  const rules = [
    { field: 'course', value: 'IELTS', assign_to_user_ids: [4] },
    { field: 'priority', value: 'high', assign_to_user_ids: [5, 6] },
  ];
  it('returns the first hit with its index', () => {
    expect(matchCondition(rules, { course: 'PTE', priority: 'high' })).toEqual({ rule: rules[1], index: 1 });
    expect(matchCondition(rules, { course: 'IELTS', priority: 'high' })).toEqual({ rule: rules[0], index: 0 });
  });
  it('no rule matches -> null (lead stays unassigned)', () => {
    expect(matchCondition(rules, { course: 'PTE', priority: 'low' })).toBeNull();
    expect(matchCondition(undefined, { course: 'IELTS' })).toBeNull();
  });
  it('rules with an empty pool are skipped defensively', () => {
    expect(matchCondition([{ field: 'x', value: 1, assign_to_user_ids: [] as number[] }], { x: 1 })).toBeNull();
  });
});
