/**
 * THE JOURNEY ENGINE — a PURE function, like the scoring engine and the template engine.
 *
 * `matches(journey, facts)` takes a journey definition and a snapshot of a lead, and
 * answers one question: should this journey run for this lead? No DB, no clock, no
 * network — so every combination of trigger and condition is unit-testable, and a
 * malformed journey (a rule the client typed wrong) can never take the worker down.
 *
 * The trigger says WHEN. The conditions say WHO. The actions (executed in the service)
 * say WHAT. Keeping the WHO here, in a total function, is what lets us promise
 * "this journey will only ever touch Meta leads in the Delhi branch" and prove it.
 */

export type TriggerType = 'lead_created' | 'stage_changed' | 'no_response' | 'fee_due' | 'birthday';

export const TRIGGERS: Array<{ key: TriggerType; label: string; blurb: string; config: string[] }> = [
  { key: 'lead_created', label: 'New lead', blurb: 'The moment a lead is created — from ANY channel (Meta, Google, the website form, a Sheet, a CSV import, a walk-in, a referral or a manual Add).', config: [] },
  { key: 'stage_changed', label: 'Stage change', blurb: 'A lead moves into one of the stages you pick.', config: ['stage_ids'] },
  { key: 'no_response', label: 'No response for N days', blurb: 'An open lead with no activity for N days. Swept — nobody has to touch the lead.', config: ['days'] },
  { key: 'fee_due', label: 'Fee due', blurb: 'N days before the fee due date recorded on the lead. (Reads the invoice in Phase 3.)', config: ['days_before'] },
  { key: 'birthday', label: 'Birthday', blurb: "The lead's date of birth, each year.", config: ['days_before'] },
];

export type ActionKind = 'send_message' | 'create_task' | 'change_stage' | 'notify_user' | 'wait';

export interface JourneyAction {
  kind: ActionKind;
  /** send_message */
  channel?: 'whatsapp' | 'sms' | 'email';
  template_id?: number;
  /** create_task */
  title?: string;
  followup_type_id?: number;
  due_in_days?: number;
  priority?: 'low' | 'medium' | 'high';
  /** create_task / notify_user */
  assign_to?: 'owner' | 'manager' | number;
  /** change_stage */
  stage_id?: number;
  /** notify_user */
  body?: string;
  /** wait */
  days?: number;
  hours?: number;
}

export interface JourneyConditions {
  campaign_ids?: number[];
  source_ids?: number[];
  branch_ids?: number[];
  vertical_ids?: number[];
  pipeline_ids?: number[];
  stage_ids?: number[];
  course_ids?: number[];
  /** score band: hot | warm | cold */
  bands?: string[];
  priorities?: string[];
  /** inclusive score window */
  score_min?: number;
  score_max?: number;
}

export interface JourneyDef {
  id?: number;
  trigger_type: string;
  trigger_config?: Record<string, unknown>;
  conditions?: JourneyConditions;
  actions?: JourneyAction[];
  status?: string;
  branch_id?: number | null;
  vertical_id?: number | null;
}

/** The lead snapshot the conditions are evaluated against. */
export interface LeadFacts {
  id: number;
  campaign_id?: number | null;
  source_id?: number | null;
  branch_id?: number | null;
  vertical_id?: number | null;
  pipeline_id?: number | null;
  stage_id?: number | null;
  course_id?: number | null;
  temperature?: string | null;
  priority?: string | null;
  score?: number | null;
}

const nums = (v: unknown): number[] =>
  (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const strs = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase()).filter(Boolean);

/**
 * A condition GROUP that is empty means "don't care" — it never narrows.
 * A group with values is an IN test. Groups are AND-ed.
 *
 * That is the least surprising reading of the builder UI: ticking two campaigns means
 * "either campaign", ticking a campaign AND a band means "that campaign AND hot".
 */
export function conditionsMatch(cond: JourneyConditions | undefined | null, f: LeadFacts): boolean {
  const c = cond ?? {};
  const inSet = (values: number[], v: unknown): boolean => !values.length || values.includes(Number(v));
  const inStr = (values: string[], v: unknown): boolean =>
    !values.length || values.includes(String(v ?? '').toLowerCase());

  if (!inSet(nums(c.campaign_ids), f.campaign_id)) return false;
  if (!inSet(nums(c.source_ids), f.source_id)) return false;
  if (!inSet(nums(c.branch_ids), f.branch_id)) return false;
  if (!inSet(nums(c.vertical_ids), f.vertical_id)) return false;
  if (!inSet(nums(c.pipeline_ids), f.pipeline_id)) return false;
  if (!inSet(nums(c.stage_ids), f.stage_id)) return false;
  if (!inSet(nums(c.course_ids), f.course_id)) return false;
  if (!inStr(strs(c.bands), f.temperature)) return false;
  if (!inStr(strs(c.priorities), f.priority)) return false;

  const score = Number(f.score ?? 0);
  if (c.score_min !== undefined && c.score_min !== null && score < Number(c.score_min)) return false;
  if (c.score_max !== undefined && c.score_max !== null && score > Number(c.score_max)) return false;
  return true;
}

/** A journey may additionally be pinned to one branch/vertical (its own scope). */
export function scopeMatches(j: JourneyDef, f: LeadFacts): boolean {
  if (j.branch_id && Number(j.branch_id) !== Number(f.branch_id)) return false;
  if (j.vertical_id && Number(j.vertical_id) !== Number(f.vertical_id)) return false;
  return true;
}

/** Should this journey run for this lead, on this trigger? */
export function matches(j: JourneyDef, trigger: string, f: LeadFacts): boolean {
  if (String(j.status) !== 'active') return false;      // draft & paused never fire
  if (String(j.trigger_type) !== String(trigger)) return false;
  if (!scopeMatches(j, f)) return false;

  // stage_changed carries its own gate: only the stages the client picked
  if (trigger === 'stage_changed') {
    const wanted = nums((j.trigger_config ?? {}).stage_ids);
    if (wanted.length && !wanted.includes(Number(f.stage_id))) return false;
  }
  return conditionsMatch(j.conditions, f);
}

/** Valid, ordered, non-empty actions. A malformed step is DROPPED, never thrown. */
export function normaliseActions(raw: unknown): JourneyAction[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: JourneyAction[] = [];
  for (const a of list) {
    const kind = String((a as JourneyAction)?.kind ?? '') as ActionKind;
    if (!['send_message', 'create_task', 'change_stage', 'notify_user', 'wait'].includes(kind)) continue;
    if (kind === 'send_message' && !Number((a as JourneyAction).template_id)) continue;
    if (kind === 'change_stage' && !Number((a as JourneyAction).stage_id)) continue;
    out.push({ ...(a as JourneyAction), kind });
  }
  return out;
}

/** The delay a `wait` step introduces, in milliseconds. */
export function waitMs(a: JourneyAction): number {
  const days = Number(a.days ?? 0);
  const hours = Number(a.hours ?? 0);
  return Math.max(0, days * 86_400_000 + hours * 3_600_000);
}

/**
 * THE IDEMPOTENCY KEY. This is the whole "a lead must not receive the same journey step
 * twice" guarantee, expressed as a string: whatever the trigger, the SAME event for the
 * SAME lead must produce the SAME key, and a UNIQUE index on (journey, lead, key) does
 * the rest.
 */
export function triggerKey(trigger: string, ctx: { stage_id?: number | null; days?: number; date?: Date }): string {
  const d = ctx.date ?? new Date();
  const iso = d.toISOString().slice(0, 10);
  switch (trigger) {
    case 'lead_created': return 'created';                      // once per lead, ever
    case 'stage_changed': return `stage:${ctx.stage_id ?? 0}`;  // once per lead per stage
    case 'no_response': return `nr:${ctx.days ?? 0}:${iso}`;    // once per lead per day
    case 'fee_due': return `fee:${iso}`;                        // once per lead per due date
    case 'birthday': return `bday:${d.getUTCFullYear()}`;       // once per lead per year
    default: return `${trigger}:${iso}`;
  }
}
