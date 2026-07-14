import {
  JourneyDef, LeadFacts, conditionsMatch, matches, normaliseActions, triggerKey, waitMs,
} from './journey.engine';

const lead = (over: Partial<LeadFacts> = {}): LeadFacts => ({
  id: 1, campaign_id: 5, source_id: 7, branch_id: 9, vertical_id: 1, pipeline_id: 4,
  stage_id: 11, course_id: 21, temperature: 'hot', priority: 'high', score: 72, ...over,
});
const journey = (over: Partial<JourneyDef> = {}): JourneyDef => ({
  trigger_type: 'lead_created', status: 'active', actions: [{ kind: 'notify_user' }], ...over,
});

describe('journey conditions', () => {
  it('an EMPTY condition set matches every lead (don\'t-care, not match-nothing)', () => {
    expect(conditionsMatch({}, lead())).toBe(true);
    expect(conditionsMatch(undefined, lead())).toBe(true);
  });

  it('campaign IN — matches one of the listed campaigns', () => {
    expect(conditionsMatch({ campaign_ids: [5, 6] }, lead())).toBe(true);
    expect(conditionsMatch({ campaign_ids: [6] }, lead())).toBe(false);
  });

  it('score BAND (hot/warm/cold), case-insensitively', () => {
    expect(conditionsMatch({ bands: ['hot'] }, lead())).toBe(true);
    expect(conditionsMatch({ bands: ['HOT'] }, lead())).toBe(true);
    expect(conditionsMatch({ bands: ['cold'] }, lead())).toBe(false);
  });

  it('score WINDOW is inclusive at both ends', () => {
    expect(conditionsMatch({ score_min: 72, score_max: 72 }, lead())).toBe(true);
    expect(conditionsMatch({ score_min: 73 }, lead())).toBe(false);
    expect(conditionsMatch({ score_max: 71 }, lead())).toBe(false);
  });

  it('groups are AND-ed: campaign AND band must BOTH hold', () => {
    expect(conditionsMatch({ campaign_ids: [5], bands: ['hot'] }, lead())).toBe(true);
    expect(conditionsMatch({ campaign_ids: [5], bands: ['cold'] }, lead())).toBe(false);
  });

  it('source / branch / vertical / pipeline / stage / course / priority all narrow', () => {
    expect(conditionsMatch({ source_ids: [7] }, lead())).toBe(true);
    expect(conditionsMatch({ branch_ids: [99] }, lead())).toBe(false);
    expect(conditionsMatch({ vertical_ids: [1] }, lead())).toBe(true);
    expect(conditionsMatch({ pipeline_ids: [4] }, lead())).toBe(true);
    expect(conditionsMatch({ stage_ids: [12] }, lead())).toBe(false);
    expect(conditionsMatch({ course_ids: [21] }, lead())).toBe(true);
    expect(conditionsMatch({ priorities: ['low'] }, lead())).toBe(false);
  });

  it('a garbage condition value is ignored rather than matching nothing', () => {
    expect(conditionsMatch({ campaign_ids: ['x' as unknown as number] }, lead())).toBe(true);
  });
});

describe('journey matching', () => {
  it('a DRAFT journey never fires', () => {
    expect(matches(journey({ status: 'draft' }), 'lead_created', lead())).toBe(false);
  });

  it('a PAUSED journey never fires — the client\'s kill switch actually kills', () => {
    expect(matches(journey({ status: 'paused' }), 'lead_created', lead())).toBe(false);
  });

  it('the trigger must be the SAME trigger', () => {
    expect(matches(journey(), 'lead_created', lead())).toBe(true);
    expect(matches(journey(), 'stage_changed', lead())).toBe(false);
  });

  it('stage_changed only fires for the stages the client picked', () => {
    const j = journey({ trigger_type: 'stage_changed', trigger_config: { stage_ids: [11] } });
    expect(matches(j, 'stage_changed', lead({ stage_id: 11 }))).toBe(true);
    expect(matches(j, 'stage_changed', lead({ stage_id: 12 }))).toBe(false);
  });

  it('stage_changed with NO stages listed fires on any stage move', () => {
    const j = journey({ trigger_type: 'stage_changed', trigger_config: {} });
    expect(matches(j, 'stage_changed', lead({ stage_id: 99 }))).toBe(true);
  });

  it('a journey pinned to a branch/vertical ignores leads outside it', () => {
    expect(matches(journey({ branch_id: 9 }), 'lead_created', lead())).toBe(true);
    expect(matches(journey({ branch_id: 8 }), 'lead_created', lead())).toBe(false);
    expect(matches(journey({ vertical_id: 2 }), 'lead_created', lead())).toBe(false);
  });
});

describe('actions', () => {
  it('drops malformed steps instead of throwing (one bad rule cannot break automation)', () => {
    const out = normaliseActions([
      { kind: 'send_message', template_id: 3 },
      { kind: 'send_message' },                 // no template -> dropped
      { kind: 'change_stage' },                 // no stage -> dropped
      { kind: 'nonsense' },                     // unknown -> dropped
      { kind: 'create_task', title: 'Call' },
      null, 'x', 42,
    ]);
    expect(out.map((a) => a.kind)).toEqual(['send_message', 'create_task']);
  });

  it('preserves ORDER — a journey is a sequence, not a set', () => {
    const out = normaliseActions([
      { kind: 'create_task' }, { kind: 'wait', days: 1 }, { kind: 'send_message', template_id: 1 },
    ]);
    expect(out.map((a) => a.kind)).toEqual(['create_task', 'wait', 'send_message']);
  });

  it('normaliseActions of nothing is an empty list, not a crash', () => {
    expect(normaliseActions(undefined)).toEqual([]);
    expect(normaliseActions('nope')).toEqual([]);
  });

  it('waitMs converts days + hours', () => {
    expect(waitMs({ kind: 'wait', days: 1 })).toBe(86_400_000);
    expect(waitMs({ kind: 'wait', hours: 2 })).toBe(7_200_000);
    expect(waitMs({ kind: 'wait', days: 1, hours: 1 })).toBe(90_000_000);
    expect(waitMs({ kind: 'wait' })).toBe(0);
  });
});

describe('triggerKey — THE idempotency contract', () => {
  const d = new Date('2026-07-14T10:00:00Z');

  it('lead_created is once per lead, EVER', () => {
    expect(triggerKey('lead_created', {})).toBe('created');
    expect(triggerKey('lead_created', { date: new Date('2027-01-01') })).toBe('created');
  });

  it('stage_changed is once per lead PER STAGE (so a re-entry to a NEW stage does fire)', () => {
    expect(triggerKey('stage_changed', { stage_id: 11 })).toBe('stage:11');
    expect(triggerKey('stage_changed', { stage_id: 12 })).not.toBe('stage:11');
  });

  it('no_response is once per lead PER DAY — so a 60-second sweep sends once, not 1440 times', () => {
    expect(triggerKey('no_response', { days: 3, date: d })).toBe('nr:3:2026-07-14');
    expect(triggerKey('no_response', { days: 3, date: new Date('2026-07-14T23:59:00Z') })).toBe('nr:3:2026-07-14');
    expect(triggerKey('no_response', { days: 3, date: new Date('2026-07-15T00:01:00Z') })).toBe('nr:3:2026-07-15');
  });

  it('two journeys with DIFFERENT day thresholds are different events', () => {
    expect(triggerKey('no_response', { days: 3, date: d })).not.toBe(triggerKey('no_response', { days: 7, date: d }));
  });

  it('fee_due is once per DUE DATE; birthday is once per YEAR', () => {
    expect(triggerKey('fee_due', { date: d })).toBe('fee:2026-07-14');
    expect(triggerKey('birthday', { date: d })).toBe('bday:2026');
    expect(triggerKey('birthday', { date: new Date('2027-07-14') })).toBe('bday:2027');
  });
});
