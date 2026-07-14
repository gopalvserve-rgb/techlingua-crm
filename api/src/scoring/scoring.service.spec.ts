import { ScoringService } from './scoring.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * SCORING SERVICE — the RECOMPUTE TRIGGERS and the admin rule CRUD.
 *
 * The client's requirement: "Score recomputes on lead events (create, stage change,
 * follow-up done, no-response ageing) — not a nightly-only job." The engine itself is
 * proven in score.engine.spec.ts; here we prove the plumbing:
 *   · rescore() reads the facts, applies the engine and PERSISTS score + band + breakdown
 *   · editing a rule or a band threshold RE-SCORES EVERY LEAD (otherwise the list lies)
 *   · the ageing sweep picks up stale OPEN leads (that is what makes no_response fire)
 *   · a bad rule is rejected at the API, not at scoring time
 */

const FACTS = {
  lead_id: 100, source_id: 7, source_channel: 'meta', campaign_id: 5, course_id: null,
  budget_id: null, budget_amount: null, priority: 'high', email: 'a@b.com',
  whatsapp_phone: null, alt_phone: null, stage_type: 'open', is_duplicate: false,
  is_walk_in: false, is_referral: false, followups_done: 0,
  days_since_activity: 0, days_since_created: 0,
};
const RULES = [
  { id: 1, name: 'Meta', rule_type: 'source_channel', config: { channels: ['meta'] }, points: 10, is_active: true, sort_order: 1 },
  { id: 2, name: 'High priority', rule_type: 'priority', config: { values: ['high'] }, points: 15, is_active: true, sort_order: 2 },
  { id: 3, name: 'Email', rule_type: 'has_field', config: { field: 'email' }, points: 5, is_active: true, sort_order: 3 },
];

function build(opts: { facts?: any[]; rules?: any[]; setting?: Record<string, unknown>; stale?: any[] } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ id: number; score: number; band: string; breakdown: any[] }> = [];
  const settingSet: Array<{ key: string; value: any }> = [];

  const run = (sql: string, params: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ sql: s, params });
    if (/UPDATE lead SET score = /.test(s)) {
      writes.push({ id: Number(params[0]), score: Number(params[1]), band: String(params[2]), breakdown: JSON.parse(String(params[3])) });
      return [];
    }
    if (/FROM lead_score_rule/.test(s) && /SELECT/.test(s)) return opts.rules ?? RULES;
    if (/FROM app_setting/.test(s)) return opts.setting ? [{ value: opts.setting }] : [];
    if (/SELECT l.id FROM lead l/.test(s)) return opts.stale ?? [];
    if (/SELECT l.id AS lead_id/.test(s) || /FROM lead l LEFT JOIN source so/.test(s)) return opts.facts ?? [FACTS];
    if (/FROM organisation/.test(s)) return [{ id: '1' }];
    if (/INSERT INTO lead_score_rule/.test(s)) return [{ id: 9, name: params[1] }];
    if (/UPDATE lead_score_rule/.test(s)) return [{ id: 9 }];
    if (/FROM lead_score_rule WHERE id/.test(s)) return [{ id: 9, rule_type: 'walk_in' }];
    return [];
  };

  const db = {
    query: async (sql: string, params: unknown[] = []) => run(sql, params),
    one: async (sql: string, params: unknown[] = []) => run(sql, params)[0] ?? null,
  } as unknown as DatabaseService;
  const settings = {
    get: async (key: string, fallback: Record<string, unknown>) => ({ ...fallback, ...(opts.setting ?? {}) }),
    set: async (key: string, value: any) => { settingSet.push({ key, value }); },
  } as any;

  return { svc: new ScoringService(db, settings, new ScopeResolverService()), calls, writes, settingSet };
}

describe('rescore() — reads the facts, applies the engine, PERSISTS the result', () => {
  it('writes score, band and the breakdown onto the lead', async () => {
    const { svc, writes } = build();
    const res = await svc.rescore(100);
    expect(res).toEqual({
      score: 30, band: 'cold',
      breakdown: [
        { rule_id: 1, name: 'Meta', rule_type: 'source_channel', points: 10 },
        { rule_id: 2, name: 'High priority', rule_type: 'priority', points: 15 },
        { rule_id: 3, name: 'Email', rule_type: 'has_field', points: 5 },
      ],
    });
    expect(writes).toEqual([{ id: 100, score: 30, band: 'cold', breakdown: res!.breakdown }]);
  });

  it('the BAND follows the configured thresholds — lower them and the same lead turns Hot', async () => {
    const { svc, writes } = build({ setting: { bands: { hot: 25, warm: 10 }, min: 0, max: 100 } });
    const res = await svc.rescore(100);
    expect(res!.score).toBe(30);
    expect(res!.band).toBe('hot');              // same score, different policy
    expect(writes[0].band).toBe('hot');
  });

  it('a missing lead is a no-op, not a crash', async () => {
    const { svc, writes } = build({ facts: [] });
    expect(await svc.rescore(999)).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('safeRescore NEVER throws (a scoring hiccup must not stop a lead being created)', async () => {
    const { svc } = build();
    (svc as any).db.query = async () => { throw new Error('db exploded'); };
    await expect(svc.safeRescore(100)).resolves.toBeUndefined();
    await expect(svc.safeRescore(null)).resolves.toBeUndefined();
  });
});

describe('the facts query gives the engine everything the rules need', () => {
  it('joins the walk-in, referral, follow-up-count and ageing facts', async () => {
    const { svc, calls } = build();
    await svc.rescore(100);
    const facts = calls.find((c) => /FROM lead l LEFT JOIN source so/.test(c.sql))!.sql;
    expect(facts).toContain('so.channel AS source_channel');
    expect(facts).toContain("bu.meta->>'amount'");                 // budget_min
    expect(facts).toContain('FROM walk_in w WHERE w.lead_id = l.id');
    expect(facts).toContain('FROM referral rf WHERE rf.lead_id = l.id');
    expect(facts).toContain("f.status = 'done'");                  // followups_done
    expect(facts).toContain('days_since_activity');
    expect(facts).toContain('days_since_created');
  });
});

describe('RECOMPUTE TRIGGERS — a rule or band edit re-scores every lead', () => {
  it('creating a rule re-scores (otherwise the list would lie until someone touched a lead)', async () => {
    const { svc, writes } = build();
    await svc.createRule({ name: 'Walk-in', rule_type: 'walk_in', points: 25 }, 1);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('updating a rule re-scores', async () => {
    const { svc, writes } = build();
    await svc.updateRule(9, { points: 40 }, 1);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('deleting a rule re-scores', async () => {
    const { svc, writes } = build();
    (svc as any).db.one = async (sql: string, p: unknown[]) => {
      if (/UPDATE lead_score_rule SET deleted_at/.test(sql)) return { id: 9, name: 'x' };
      return null;
    };
    (svc as any).db.query = async (sql: string, _params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/UPDATE lead SET score/.test(s)) { writes.push({ id: 1, score: 0, band: 'cold', breakdown: [] }); return []; }
      if (/FROM lead l LEFT JOIN source so/.test(s)) return [FACTS];
      return [];
    };
    await svc.deleteRule(9, 1);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('changing the BAND THRESHOLDS re-bands every lead immediately', async () => {
    const { svc, settingSet, writes } = build();
    const out = await svc.saveConfig({ hot: 20, warm: 10 }, 1);
    expect(settingSet[0].key).toBe('lead_score_config');
    expect(settingSet[0].value.bands).toEqual({ hot: 20, warm: 10 });
    expect(out.rescored).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('the AGEING SWEEP is what makes "no response for 7 days" actually fire', () => {
  it('selects only STALE, OPEN leads (a won lead is never re-aged)', async () => {
    const { svc, calls } = build({ stale: [{ id: '100' }, { id: '101' }] });
    const n = await svc.ageingSweep(50);
    expect(n).toBe(2);
    const sweep = calls.find((c) => /SELECT l.id FROM lead l/.test(c.sql))!;
    expect(sweep.sql).toContain('l.scored_at IS NULL OR l.scored_at <');
    expect(sweep.sql).toContain("st.stage_type = 'open'");
    expect(sweep.sql).toContain('ORDER BY l.scored_at NULLS FIRST');   // oldest first, never starves
    expect(sweep.params).toEqual(['6', 50]);                            // age_sweep_hours, batch
  });

  it('is BOUNDED per tick so it never hogs the API process', async () => {
    const { svc, calls } = build({ stale: [] });
    await svc.ageingSweep(25);
    expect(calls.find((c) => /SELECT l.id FROM lead l/.test(c.sql))!.params[1]).toBe(25);
  });
});

describe('rule validation — a bad rule is rejected at the API, not at scoring time', () => {
  const bad = async (dto: any, msg: RegExp) => {
    const { svc } = build();
    await expect(svc.createRule(dto, 1)).rejects.toThrow(msg);
  };
  it('needs a name', () => bad({ rule_type: 'walk_in', points: 10 }, /name is required/));
  it('rejects an unknown rule type, and LISTS the valid ones', () =>
    bad({ name: 'x', rule_type: 'vibes', points: 10 }, /unknown rule type "vibes"/));
  it('needs numeric points', () => bad({ name: 'x', rule_type: 'walk_in', points: 'lots' }, /points must be a number/));
  it('ACCEPTS negative points (penalties are the whole point of no_response_days)', async () => {
    const { svc } = build();
    await expect(svc.createRule({ name: 'stale', rule_type: 'no_response_days', config: { days: 7 }, points: -15 }, 1))
      .resolves.toBeTruthy();
  });
  it('rejects a warm threshold at or above hot', async () => {
    const { svc } = build();
    await expect(svc.saveConfig({ hot: 50, warm: 50 }, 1)).rejects.toThrow(/Warm threshold must be below/);
  });
});

describe('the band distribution is SCOPED (a counsellor sees only their own leads)', () => {
  it('narrows to the caller\'s records', async () => {
    const { svc, calls } = build();
    const own: ResolvedScope = {
      permissionKey: 'score.read', allowed: true, all: false,
      filters: [{ kind: 'own', userId: 3 }], allowedFields: null, deniedFields: [],
    };
    await svc.distribution(own);
    const q = calls.find((c) => /COUNT\(\*\) FILTER \(WHERE l.temperature/.test(c.sql))!;
    expect(q.sql).toContain('l.owner_id = $1');
    expect(q.params[0]).toBe(3);
  });
});
