import {
  DEFAULT_SCORE_CONFIG, EVALUATORS, LeadFacts, RULE_TYPES, ScoreRule, bandOf, scoreLead,
} from './score.engine';

/**
 * THE SCORE ENGINE — the client's own examples, executable.
 *
 * "Admin defines rules in Settings (e.g. source = Meta -> +10, budget >= X -> +20,
 *  no response 7 days -> -15, walk-in -> +25). Score -> band Hot/Warm/Cold with
 *  configurable thresholds."
 *
 * Every rule type gets a match case AND a no-match case, because a rule that fires when
 * it shouldn't is the same bug as one that never fires.
 */

const facts = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  lead_id: 1,
  source_id: null, source_channel: null, campaign_id: null, course_id: null,
  budget_id: null, budget_amount: null, priority: 'med',
  email: null, whatsapp_phone: null, alt_phone: null,
  stage_type: 'open', is_duplicate: false, is_walk_in: false, is_referral: false,
  followups_done: 0, days_since_activity: 0, days_since_created: 0,
  ...over,
});
const rule = (over: Partial<ScoreRule> = {}): ScoreRule => ({
  id: 1, name: 'r', rule_type: 'walk_in', config: {}, points: 10, is_active: true, sort_order: 0, ...over,
});

describe('score engine — the client\'s four examples', () => {
  it('source = Meta -> +10', () => {
    const r = [rule({ rule_type: 'source_channel', config: { channels: ['meta'] }, points: 10 })];
    expect(scoreLead(facts({ source_channel: 'meta' }), r).score).toBe(10);
    expect(scoreLead(facts({ source_channel: 'google' }), r).score).toBe(0);
  });

  it('budget >= X -> +20', () => {
    const r = [rule({ rule_type: 'budget_min', config: { min: 50000 }, points: 20 })];
    expect(scoreLead(facts({ budget_amount: 75000 }), r).score).toBe(20);
    expect(scoreLead(facts({ budget_amount: 50000 }), r).score).toBe(20);   // inclusive
    expect(scoreLead(facts({ budget_amount: 49999 }), r).score).toBe(0);
    // a Budget master with no amount can never match — documented, never a crash
    expect(scoreLead(facts({ budget_amount: null }), r).score).toBe(0);
  });

  it('no response for 7 days -> -15 (and clamps at the floor)', () => {
    const r = [rule({ rule_type: 'no_response_days', config: { days: 7 }, points: -15 })];
    expect(scoreLead(facts({ days_since_activity: 8 }), r).score).toBe(0);  // clamped at min 0
    const withBase = [
      rule({ id: 1, rule_type: 'walk_in', points: 25 }),
      rule({ id: 2, rule_type: 'no_response_days', config: { days: 7 }, points: -15 }),
    ];
    expect(scoreLead(facts({ is_walk_in: true, days_since_activity: 9 }), withBase).score).toBe(10);
    expect(scoreLead(facts({ is_walk_in: true, days_since_activity: 3 }), withBase).score).toBe(25);
  });

  it('walk-in -> +25', () => {
    const r = [rule({ rule_type: 'walk_in', points: 25 })];
    expect(scoreLead(facts({ is_walk_in: true }), r).score).toBe(25);
    expect(scoreLead(facts({ is_walk_in: false }), r).score).toBe(0);
  });
});

describe('score engine — every rule type matches and fails to match', () => {
  const cases: Array<[string, ScoreRule, LeadFacts, LeadFacts]> = [
    ['source_channel', rule({ rule_type: 'source_channel', config: { channels: ['meta', 'google'] } }),
      facts({ source_channel: 'google' }), facts({ source_channel: 'sheet' })],
    ['source', rule({ rule_type: 'source', config: { source_ids: [7, 8] } }),
      facts({ source_id: 8 }), facts({ source_id: 9 })],
    ['campaign', rule({ rule_type: 'campaign', config: { campaign_ids: [5] } }),
      facts({ campaign_id: 5 }), facts({ campaign_id: 6 })],
    ['course', rule({ rule_type: 'course', config: { course_ids: [21] } }),
      facts({ course_id: 21 }), facts({ course_id: 22 })],
    ['budget', rule({ rule_type: 'budget', config: { budget_ids: [3] } }),
      facts({ budget_id: 3 }), facts({ budget_id: 4 })],
    ['priority', rule({ rule_type: 'priority', config: { values: ['high'] } }),
      facts({ priority: 'high' }), facts({ priority: 'med' })],
    ['has_field', rule({ rule_type: 'has_field', config: { field: 'email' } }),
      facts({ email: 'a@b.com' }), facts({ email: null })],
    ['walk_in', rule({ rule_type: 'walk_in' }), facts({ is_walk_in: true }), facts({ is_walk_in: false })],
    ['referral', rule({ rule_type: 'referral' }), facts({ is_referral: true }), facts({ is_referral: false })],
    ['stage_type', rule({ rule_type: 'stage_type', config: { types: ['won'] } }),
      facts({ stage_type: 'won' }), facts({ stage_type: 'open' })],
    ['duplicate', rule({ rule_type: 'duplicate' }), facts({ is_duplicate: true }), facts({ is_duplicate: false })],
    ['age_days', rule({ rule_type: 'age_days', config: { days: 30 } }),
      facts({ days_since_created: 31 }), facts({ days_since_created: 29 })],
    ['no_response_days', rule({ rule_type: 'no_response_days', config: { days: 7 } }),
      facts({ days_since_activity: 7 }), facts({ days_since_activity: 6 })],
  ];

  it.each(cases)('%s', (_name, r, hit, miss) => {
    expect(scoreLead(hit, [r]).breakdown).toHaveLength(1);
    expect(scoreLead(miss, [r]).breakdown).toHaveLength(0);
  });

  it('every rule type in the UI catalogue has an evaluator (no dead options in the form)', () => {
    for (const t of RULE_TYPES) expect(EVALUATORS[t.type]).toBeDefined();
  });

  it('has_field treats an empty string / 0 / null as NOT filled', () => {
    const r = [rule({ rule_type: 'has_field', config: { field: 'whatsapp_phone' }, points: 5 })];
    expect(scoreLead(facts({ whatsapp_phone: '' }), r).score).toBe(0);
    expect(scoreLead(facts({ whatsapp_phone: '+919810000001' }), r).score).toBe(5);
  });

  it('followup_done is cumulative AND capped (a chatty lead cannot run away with the score)', () => {
    const r = [rule({ rule_type: 'followup_done', config: { points_each: 5, max: 20 }, points: 5 })];
    expect(scoreLead(facts({ followups_done: 0 }), r).score).toBe(0);
    expect(scoreLead(facts({ followups_done: 2 }), r).score).toBe(10);
    expect(scoreLead(facts({ followups_done: 4 }), r).score).toBe(20);
    expect(scoreLead(facts({ followups_done: 99 }), r).score).toBe(20);   // capped
  });

  it('ageing penalties NEVER apply to a won or lost lead', () => {
    const r = [
      rule({ id: 1, rule_type: 'walk_in', points: 60 }),
      rule({ id: 2, rule_type: 'no_response_days', config: { days: 7 }, points: -15 }),
      rule({ id: 3, rule_type: 'age_days', config: { days: 30 }, points: -10 }),
    ];
    const stale = { is_walk_in: true, days_since_activity: 90, days_since_created: 200 };
    expect(scoreLead(facts({ ...stale, stage_type: 'open' }), r).score).toBe(35);
    expect(scoreLead(facts({ ...stale, stage_type: 'won' }), r).score).toBe(60);
    expect(scoreLead(facts({ ...stale, stage_type: 'lost' }), r).score).toBe(60);
  });
});

describe('bands + clamping (configurable thresholds)', () => {
  it('uses the configured thresholds, not hard-coded ones', () => {
    const cfg = { bands: { hot: 70, warm: 40 }, min: 0, max: 100 };
    expect(bandOf(70, cfg)).toBe('hot');
    expect(bandOf(69, cfg)).toBe('warm');
    expect(bandOf(40, cfg)).toBe('warm');
    expect(bandOf(39, cfg)).toBe('cold');
    const strict = { bands: { hot: 90, warm: 80 }, min: 0, max: 100 };
    expect(bandOf(85, strict)).toBe('warm');
    expect(bandOf(85, cfg)).toBe('hot');           // the SAME score, a different band
  });

  it('clamps to [min, max]', () => {
    const r = [rule({ rule_type: 'walk_in', points: 500 })];
    expect(scoreLead(facts({ is_walk_in: true }), r, DEFAULT_SCORE_CONFIG).score).toBe(100);
    const neg = [rule({ rule_type: 'duplicate', points: -500 })];
    expect(scoreLead(facts({ is_duplicate: true }), neg, DEFAULT_SCORE_CONFIG).score).toBe(0);
  });

  it('the breakdown explains the score ("why is this lead Hot?")', () => {
    const r = [
      rule({ id: 1, name: 'Walk-in visitor', rule_type: 'walk_in', points: 25 }),
      rule({ id: 2, name: 'High priority', rule_type: 'priority', config: { values: ['high'] }, points: 15 }),
    ];
    const res = scoreLead(facts({ is_walk_in: true, priority: 'high' }), r);
    expect(res.score).toBe(40);
    expect(res.band).toBe('warm');
    expect(res.breakdown.map((b) => [b.name, b.points])).toEqual([
      ['Walk-in visitor', 25], ['High priority', 15],
    ]);
  });
});

describe('the engine is defensive — a bad rule can never break scoring for the whole org', () => {
  it('an INACTIVE rule is skipped', () => {
    expect(scoreLead(facts({ is_walk_in: true }), [rule({ points: 25, is_active: false })]).score).toBe(0);
  });
  it('an UNKNOWN rule type is ignored, not fatal', () => {
    const r = [rule({ id: 1, rule_type: 'from_the_future', points: 50 }), rule({ id: 2, rule_type: 'walk_in', points: 25 })];
    expect(scoreLead(facts({ is_walk_in: true }), r).score).toBe(25);
  });
  it('a MALFORMED config is ignored, not fatal', () => {
    const r = [
      rule({ id: 1, rule_type: 'source_channel', config: { channels: 'meta' as unknown as string[] }, points: 50 }),
      rule({ id: 2, rule_type: 'walk_in', points: 25 }),
    ];
    expect(scoreLead(facts({ source_channel: 'meta', is_walk_in: true }), r).score).toBe(25);
  });
  it('is deterministic and order-independent of the input array (sort_order decides)', () => {
    const a = rule({ id: 1, rule_type: 'walk_in', points: 25, sort_order: 2 });
    const b = rule({ id: 2, rule_type: 'referral', points: 20, sort_order: 1 });
    const f = facts({ is_walk_in: true, is_referral: true });
    expect(scoreLead(f, [a, b]).breakdown.map((x) => x.rule_id)).toEqual([2, 1]);
    expect(scoreLead(f, [b, a]).breakdown.map((x) => x.rule_id)).toEqual([2, 1]);
    expect(scoreLead(f, [a, b]).score).toBe(scoreLead(f, [b, a]).score);
  });
});
