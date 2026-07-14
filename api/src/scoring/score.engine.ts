/**
 * THE LEAD-SCORING ENGINE — rule-based and ADMIN-CONFIGURABLE (client decision, 14 Jul 2026).
 *
 * The client asked for rules he can edit himself ("source = Meta -> +10, budget >= X -> +20,
 * no response 7 days -> -15, walk-in -> +25"), not a black box. So:
 *
 *   · rules are ROWS in `lead_score_rule` (name, rule_type, config JSONB, points, active, order)
 *   · the engine is a PURE FUNCTION over (facts, rules, config) — no DB, no clock, no I/O,
 *     therefore exhaustively unit-testable and identical wherever it runs
 *   · adding a rule TYPE = one entry in EVALUATORS below. No migration (rule_type is an
 *     unconstrained VARCHAR — the same lesson as the capture-channel provider registry).
 *
 * SCORE  = clamp(sum(points of every rule that matches), min, max)   [default 0..100]
 * BAND   = score >= bands.hot -> 'hot' · >= bands.warm -> 'warm' · else 'cold'
 * WHY    = the breakdown is returned (and stored on the lead) so "why is this Hot?" is
 *          answerable in the UI without re-running anything.
 */

export type RuleType =
  | 'source_channel'    // { channels: ['meta','google',...] }   — the lead's source channel
  | 'source'            // { source_ids: [1,2] }
  | 'campaign'          // { campaign_ids: [1,2] }
  | 'course'            // { course_ids: [1,2] }
  | 'budget_min'        // { min: 50000 }  — needs m_budget.meta.amount
  | 'budget'            // { budget_ids: [1,2] }
  | 'priority'          // { values: ['high'] }
  | 'has_field'         // { field: 'email' | 'whatsapp_phone' | 'alt_phone' | 'course_id' | 'budget_id' }
  | 'walk_in'           // {} — captured as a walk-in
  | 'referral'          // {} — captured as a referral
  | 'followup_done'     // { points_each: 5, max: 20 }  — engagement, capped
  | 'no_response_days'  // { days: 7 }  — negative: no activity for N days (open leads only)
  | 'age_days'          // { days: 30 } — negative: lead open this long
  | 'stage_type'        // { types: ['won'] }
  | 'duplicate';        // {} — flagged as a duplicate

export interface ScoreRule {
  id: number;
  name: string;
  rule_type: string;
  config: Record<string, unknown>;
  points: number;
  is_active?: boolean;
  sort_order?: number;
}

/** Everything the engine may look at. One row per lead, built by ScoringService. */
export interface LeadFacts {
  lead_id: number;
  source_id: number | null;
  source_channel: string | null;
  campaign_id: number | null;
  course_id: number | null;
  budget_id: number | null;
  /** m_budget.meta.amount when the master carries one (else null → budget_min cannot match) */
  budget_amount: number | null;
  priority: string | null;
  email: string | null;
  whatsapp_phone: string | null;
  alt_phone: string | null;
  stage_type: string | null;      // open | won | lost
  is_duplicate: boolean;
  is_walk_in: boolean;
  is_referral: boolean;
  followups_done: number;
  /** whole days since the last lead_activity (or creation). Computed in SQL — the engine stays pure. */
  days_since_activity: number;
  /** whole days since the lead was created. */
  days_since_created: number;
}

export interface ScoreConfig {
  bands: { hot: number; warm: number };
  min: number;
  max: number;
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = { bands: { hot: 70, warm: 40 }, min: 0, max: 100 };

export interface ScoreLine {
  rule_id: number;
  name: string;
  rule_type: string;
  points: number;   // the points ACTUALLY applied (followup_done caps its own)
}

export interface ScoreResult {
  score: number;
  band: 'hot' | 'warm' | 'cold';
  breakdown: ScoreLine[];
}

const num = (v: unknown, dflt = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];

/**
 * One evaluator per rule type. Returns the points to apply (0 = the rule did not match).
 * `rule.points` is the configured weight; most evaluators return it verbatim, but a
 * cumulative rule (followup_done) computes its own capped total.
 */
type Evaluator = (f: LeadFacts, rule: ScoreRule) => number;

export const EVALUATORS: Record<string, Evaluator> = {
  source_channel: (f, r) =>
    f.source_channel && list(r.config.channels).includes(String(f.source_channel).toLowerCase()) ? r.points : 0,

  source: (f, r) => (f.source_id != null && ids(r.config.source_ids).includes(Number(f.source_id)) ? r.points : 0),

  campaign: (f, r) => (f.campaign_id != null && ids(r.config.campaign_ids).includes(Number(f.campaign_id)) ? r.points : 0),

  course: (f, r) => (f.course_id != null && ids(r.config.course_ids).includes(Number(f.course_id)) ? r.points : 0),

  budget: (f, r) => (f.budget_id != null && ids(r.config.budget_ids).includes(Number(f.budget_id)) ? r.points : 0),

  // "budget >= X -> +20". Needs an amount on the Budget master (m_budget.meta.amount);
  // a budget band with no amount simply never matches (documented, never a crash).
  budget_min: (f, r) => (f.budget_amount != null && f.budget_amount >= num(r.config.min) ? r.points : 0),

  priority: (f, r) => (f.priority && list(r.config.values).includes(String(f.priority).toLowerCase()) ? r.points : 0),

  has_field: (f, r) => {
    const field = String(r.config.field ?? '');
    const v = (f as unknown as Record<string, unknown>)[field];
    const present = v !== null && v !== undefined && v !== '' && v !== 0;
    return present ? r.points : 0;
  },

  walk_in: (f, r) => (f.is_walk_in ? r.points : 0),

  referral: (f, r) => (f.is_referral ? r.points : 0),

  // ENGAGEMENT — cumulative and CAPPED, so a chatty lead cannot run away with the score.
  followup_done: (f, r) => {
    const each = num(r.config.points_each, r.points);
    const cap = num(r.config.max, Number.POSITIVE_INFINITY);
    const total = each * Math.max(0, f.followups_done);
    return total >= 0 ? Math.min(total, cap) : Math.max(total, -Math.abs(cap));
  },

  // NEGATIVE ageing rules only apply to leads that are still OPEN — penalising a lead
  // that was won three months ago would be nonsense.
  no_response_days: (f, r) =>
    f.stage_type !== 'won' && f.stage_type !== 'lost' && f.days_since_activity >= num(r.config.days, 7) ? r.points : 0,

  age_days: (f, r) =>
    f.stage_type !== 'won' && f.stage_type !== 'lost' && f.days_since_created >= num(r.config.days, 30) ? r.points : 0,

  stage_type: (f, r) => (f.stage_type && list(r.config.types).includes(String(f.stage_type).toLowerCase()) ? r.points : 0),

  duplicate: (f, r) => (f.is_duplicate ? r.points : 0),
};

/** Rule types the admin UI offers, with their config shape (drives the rule form). */
export const RULE_TYPES: Array<{ type: RuleType; label: string; hint: string; fields: string[] }> = [
  { type: 'source_channel',   label: 'Source channel',        hint: 'e.g. Meta / Google / website form', fields: ['channels'] },
  { type: 'source',           label: 'Specific source',       hint: 'One or more Lead Sources',          fields: ['source_ids'] },
  { type: 'campaign',         label: 'Specific campaign',     hint: 'One or more Campaigns',             fields: ['campaign_ids'] },
  { type: 'course',           label: 'Course of interest',    hint: 'High-ticket courses score up',      fields: ['course_ids'] },
  { type: 'budget_min',       label: 'Budget at least',       hint: 'Needs an amount on the Budget master', fields: ['min'] },
  { type: 'budget',           label: 'Specific budget band',  hint: 'One or more Budget masters',        fields: ['budget_ids'] },
  { type: 'priority',         label: 'Lead priority',         hint: 'low / med / high',                  fields: ['values'] },
  { type: 'has_field',        label: 'Field is filled in',    hint: 'Data completeness',                 fields: ['field'] },
  { type: 'walk_in',          label: 'Walk-in visitor',       hint: 'Captured at the branch desk',       fields: [] },
  { type: 'referral',         label: 'Referral',              hint: 'Referred by a student / partner',   fields: [] },
  { type: 'followup_done',    label: 'Follow-ups completed',  hint: 'Engagement — points each, capped',  fields: ['points_each', 'max'] },
  { type: 'no_response_days', label: 'No response for N days',hint: 'Use NEGATIVE points',               fields: ['days'] },
  { type: 'age_days',         label: 'Open for N days',       hint: 'Ageing decay — NEGATIVE points',    fields: ['days'] },
  { type: 'stage_type',       label: 'Stage type reached',    hint: 'open / won / lost',                 fields: ['types'] },
  { type: 'duplicate',        label: 'Flagged as duplicate',  hint: 'Usually NEGATIVE points',           fields: [] },
];

export const bandOf = (score: number, cfg: ScoreConfig): 'hot' | 'warm' | 'cold' => {
  if (score >= cfg.bands.hot) return 'hot';
  if (score >= cfg.bands.warm) return 'warm';
  return 'cold';
};

/**
 * THE ENGINE. Pure: same facts + same rules -> same score, always.
 * Inactive rules and unknown rule types are skipped (an unknown type must never
 * crash scoring for every lead in the org — it is simply not applied).
 */
export function scoreLead(facts: LeadFacts, rules: ScoreRule[], cfg: ScoreConfig = DEFAULT_SCORE_CONFIG): ScoreResult {
  const breakdown: ScoreLine[] = [];
  let raw = 0;

  const ordered = [...rules]
    .filter((r) => r.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

  for (const rule of ordered) {
    const evaluate = EVALUATORS[rule.rule_type];
    if (!evaluate) continue;                       // unknown type -> ignored, never fatal
    let points = 0;
    try {
      points = evaluate(facts, { ...rule, config: rule.config ?? {} });
    } catch {
      points = 0;                                  // a malformed config can never break scoring
    }
    if (!points) continue;
    raw += points;
    breakdown.push({ rule_id: rule.id, name: rule.name, rule_type: rule.rule_type, points });
  }

  const score = Math.max(cfg.min, Math.min(cfg.max, Math.round(raw)));
  return { score, band: bandOf(score, cfg), breakdown };
}
