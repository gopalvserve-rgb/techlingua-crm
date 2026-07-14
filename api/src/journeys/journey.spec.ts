import { JourneyService } from './journey.service';
import { JourneyWorker } from './journey.worker';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { TemplateService } from '../templates/template.service';
import { makeSprint4Db, settings4 } from '../messaging/sprint4.testkit';
import { encryptSecret } from '../common/crypto.util';

/**
 * TRIGGER -> CONDITIONS -> ACTIONS, end to end, plus the guarantee the client will test
 * first and hardest: A LEAD MUST NOT RECEIVE THE SAME JOURNEY STEP TWICE.
 */

const WHATSAPP_CFG = {
  id: 3, channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, is_active: true,
  config: { phone_number_id: '123' }, secrets: { access_token: encryptSecret('TOK') },
};

const LEAD = {
  id: 1, org_id: 1, full_name: 'Priya Sharma', phone: '+919810000001', whatsapp_phone: '+919810000001',
  email: 'priya@example.com', branch_id: 9, vertical_id: 7, pipeline_id: 4, campaign_id: 5,
  source_id: 7, stage_id: 11, course_id: 21, owner_id: 3, temperature: 'hot', priority: 'high', score: 72,
  // the names the varsForLead() JOIN produces — the template variables resolve from these
  branch: 'Vikaspuri', vertical: 'BCL', pipeline: 'Admissions', campaign: 'Meta Jul',
  source: 'Meta Ads', stage: 'New', course: 'IELTS', counsellor: 'Asha Rao', org: 'Tech Lingua LLP',
  city: 'New Delhi', course_fee: 45000, next_follow_up_at: null, dob: null,
};

const TEMPLATE = {
  id: 50, channel: 'whatsapp', name: 'Welcome', body: 'Hi {{lead.name}}',
  wa_template_name: 'lead_welcome', wa_language: 'en', wa_params: ['{{lead.name}}'],
  subject: null, sms_sender_id: null, sms_dlt_template_id: null,
};

const JOURNEY = (over: Record<string, unknown> = {}) => ({
  id: 1, org_id: 1, name: 'Welcome new leads', trigger_type: 'lead_created', status: 'active',
  trigger_config: {}, conditions: {}, guardrails: {},
  actions: [
    { kind: 'send_message', template_id: 50 },
    { kind: 'create_task', title: 'Call the new lead', due_in_days: 1, assign_to: 'owner', priority: 'high' },
  ],
  branch_id: null, vertical_id: null, ...over,
});

const build = (state: Record<string, unknown> = {}, settingRows: Record<string, unknown> = {}) => {
  const { db, st } = makeSprint4Db({
    channelConfigs: [WHATSAPP_CFG],
    leads: { 1: { ...LEAD } },
    templates: { 50: TEMPLATE },
    stages: { 11: { id: 11, name: 'New', pipeline_id: 4 }, 12: { id: 12, name: 'Contacted', pipeline_id: 4 }, 90: { id: 90, name: 'Other pipeline', pipeline_id: 99 } },
    journeys: [],
    ...(state as any),
  });
  const settings = settings4({
    journey_guardrails: { respect_business_hours: false, max_sends_per_lead_per_day: 0, honour_opt_out: true },
    ...(settingRows as any),
  });
  const configs = new ChannelConfigService(db);
  const messaging = new MessagingService(db, configs, settings);
  const resolver = { buildScopeWhere: () => '1=1' } as any;
  const templates = new TemplateService(db, messaging, resolver);
  const notifier = { notify: async (m: any) => { st.notifications.push({ user_id: m.userId, title: m.title }); } } as any;
  const managers = { managersFor: async () => [77] } as any;
  const journeys = new JourneyService(db, messaging, templates, notifier, managers, resolver);
  return { db, st, journeys, messaging, templates };
};

/* ============================ END TO END ================================= */

describe('a journey runs: trigger -> conditions -> actions', () => {
  it('NEW LEAD -> sends the WhatsApp template AND creates the follow-up task', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY()] });

    const ids = await journeys.fire('lead_created', 1);
    expect(ids).toHaveLength(1);

    // the message was queued, rendered against THIS lead
    expect(st.messages).toHaveLength(1);
    const m = st.messages[0];
    expect(m.channel).toBe('whatsapp');
    expect(m.to_addr).toBe('+919810000001');
    expect(m.body).toBe('Hi Priya Sharma');
    expect(m.journey_id).toBe(1);
    expect(m.journey_run_id).toBe(ids[0]);
    // the lead's VERTICAL rides along — this is what picks the per-vertical config
    expect(m.vertical_id).toBe(7);
    expect(m.provider_response._send).toMatchObject({ wa_template_name: 'lead_welcome', wa_params: ['Priya Sharma'] });

    // the task was created for the lead's OWNER
    expect(st.followUps).toHaveLength(1);
    expect(st.followUps[0]).toMatchObject({ lead_id: 1, owner_id: 3, priority: 'high', notes: 'Call the new lead' });

    // the run is DONE and each step is recorded
    const run = st.runs[0];
    expect(run.status).toBe('done');
    expect((run.steps as any[]).map((s) => `${s.kind}:${s.status}`))
      .toEqual(['send_message:done', 'create_task:done']);

    // ...and it is visible ON THE LEAD's timeline, not only in an admin report
    expect(st.activities.some((a) => a.note.includes('Welcome new leads'))).toBe(true);
  });

  it('CONDITIONS gate it: a journey for Hot leads only ignores a Cold one', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({ conditions: { bands: ['hot'] } })],
      leads: { 1: { ...LEAD, temperature: 'cold' } },
    });
    expect(await journeys.fire('lead_created', 1)).toHaveLength(0);
    expect(st.messages).toHaveLength(0);
    expect(st.runs).toHaveLength(0);          // no run at all — not a skipped one
  });

  it('a PAUSED journey does nothing (the kill switch)', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY({ status: 'paused' })] });
    expect(await journeys.fire('lead_created', 1)).toHaveLength(0);
    expect(st.messages).toHaveLength(0);
  });

  it('STAGE CHANGE -> change_stage + notify_user', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({
        id: 2, trigger_type: 'stage_changed', trigger_config: { stage_ids: [11] },
        actions: [
          { kind: 'change_stage', stage_id: 12 },
          { kind: 'notify_user', assign_to: 'manager', title: 'Lead moved' },
        ],
      })],
    });
    await journeys.fire('stage_changed', 1, { stage_id: 11 });
    expect(st.leads[1].stage_id).toBe(12);
    expect(st.notifications).toEqual([{ user_id: 77, title: 'Lead moved' }]);   // the MANAGER
  });

  it('change_stage REFUSES a stage from another pipeline (that would corrupt the lead\'s path)', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({ actions: [{ kind: 'change_stage', stage_id: 90 }] })],
    });
    await journeys.fire('lead_created', 1);
    expect(st.leads[1].stage_id).toBe(11);            // unchanged
    expect((st.runs[0].steps as any[])[0]).toMatchObject({ status: 'skipped' });
    expect((st.runs[0].steps as any[])[0].detail).toMatch(/another pipeline/);
  });

  it('ONE bad step does not abort the journey — the rest still run, and the failure is recorded', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({
        actions: [
          { kind: 'send_message', template_id: 999 },      // template does not exist
          { kind: 'create_task', title: 'Still happens' },
        ],
      })],
    });
    await journeys.fire('lead_created', 1);
    const steps = st.runs[0].steps as any[];
    expect(steps[0]).toMatchObject({ kind: 'send_message', status: 'failed' });
    expect(steps[1]).toMatchObject({ kind: 'create_task', status: 'done' });
    expect(st.followUps).toHaveLength(1);
    expect(st.runs[0].status).toBe('done');
  });
});

/* ========================== IDEMPOTENCY =================================== */

describe('IDEMPOTENCY — a lead must not receive the same journey step twice', () => {
  it('firing lead_created TWICE sends ONE message and creates ONE task', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY()] });

    const first = await journeys.fire('lead_created', 1);
    const second = await journeys.fire('lead_created', 1);      // a replayed webhook, a re-import…

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);          // the unique index refused the second claim
    expect(st.messages).toHaveLength(1);
    expect(st.followUps).toHaveLength(1);
    expect(st.runs).toHaveLength(1);
  });

  it('ten concurrent fires (ten replicas) still produce exactly ONE run', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY()] });
    await Promise.all(Array.from({ length: 10 }, () => journeys.fire('lead_created', 1)));
    expect(st.runs).toHaveLength(1);
    expect(st.messages).toHaveLength(1);
  });

  it('the no_response sweep runs every 60 SECONDS but sends ONCE PER DAY', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY({ trigger_type: 'no_response', trigger_config: { days: 3 } })] });
    for (let i = 0; i < 20; i++) await journeys.fire('no_response', 1, { days: 3 });
    expect(st.messages).toHaveLength(1);
    expect(st.runs[0].trigger_key).toMatch(/^nr:3:\d{4}-\d{2}-\d{2}$/);
  });

  it('but a DIFFERENT stage IS a different event — re-entering New then Contacted fires both', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({ trigger_type: 'stage_changed', trigger_config: {}, actions: [{ kind: 'create_task', title: 't' }] })],
    });
    await journeys.fire('stage_changed', 1, { stage_id: 11 });
    st.leads[1].stage_id = 12;
    await journeys.fire('stage_changed', 1, { stage_id: 12 });
    await journeys.fire('stage_changed', 1, { stage_id: 12 });   // the same stage again: no-op
    expect(st.runs).toHaveLength(2);
    expect(st.followUps).toHaveLength(2);
  });

  it('two DIFFERENT journeys on the same trigger both run (idempotency is per journey, not per lead)', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({ id: 1 }), JOURNEY({ id: 2, name: 'Second', actions: [{ kind: 'create_task', title: 'x' }] })],
    });
    expect(await journeys.fire('lead_created', 1)).toHaveLength(2);
    expect(st.runs).toHaveLength(2);
  });
});

/* ===================== GUARDRAILS INSIDE A JOURNEY ======================== */

describe('a journey obeys the guardrails', () => {
  it('OPT-OUT: the message step is SKIPPED, the task step still runs', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY()],
      optOuts: [{ id: 1, channel: 'whatsapp', identifier: '+919810000001', lead_id: 1 }],
    });
    await journeys.fire('lead_created', 1);
    const steps = st.runs[0].steps as any[];
    expect(steps[0]).toMatchObject({ kind: 'send_message', status: 'skipped' });
    expect(steps[0].detail).toMatch(/Opted out/);
    expect(steps[1]).toMatchObject({ kind: 'create_task', status: 'done' });
    expect(st.messages[0].status).toBe('skipped');   // logged, not silently dropped
  });

  it('the DAILY CAP skips a journey send once the lead has had its quota', async () => {
    const { st, journeys, messaging } = build({ journeys: [JOURNEY()] }, {
      journey_guardrails: { max_sends_per_lead_per_day: 1, respect_business_hours: false, honour_opt_out: true },
    });
    await messaging.queue({ channel: 'sms', to: '+919810000001', body: 'earlier today', lead_id: 1, guarded: true });
    await journeys.fire('lead_created', 1);
    const steps = st.runs[0].steps as any[];
    expect(steps[0]).toMatchObject({ status: 'skipped' });
    expect(steps[0].detail).toMatch(/Daily cap/);
  });
});

/* ============================ WAIT / RESUME =============================== */

describe('a `wait` step parks the run and the worker resumes it', () => {
  it('the run stops at the wait, and nothing after it has happened yet', async () => {
    const { db, st, journeys } = build({
      journeys: [JOURNEY({
        actions: [
          { kind: 'create_task', title: 'now' },
          { kind: 'wait', days: 1 },
          { kind: 'create_task', title: 'tomorrow' },
        ],
      })],
    });
    await journeys.fire('lead_created', 1);

    expect(st.followUps).toHaveLength(1);
    expect(st.followUps[0].notes).toBe('now');
    const run = st.runs[0];
    expect(run.status).toBe('pending');            // parked, not done
    expect(run.step_index).toBe(2);                // resume AFTER the wait
    expect(run.next_run_at.getTime()).toBeGreaterThan(Date.now() + 86_000_000);

    // the worker will not touch it yet
    const worker = new JourneyWorker(db, journeys);
    expect((await worker.tick()).resumed).toBe(0);

    // ...but when its time comes, it finishes the rest — exactly once
    run.next_run_at = new Date(Date.now() - 1000);
    expect((await worker.tick()).resumed).toBe(1);
    expect(st.followUps.map((f) => f.notes)).toEqual(['now', 'tomorrow']);
    expect(st.runs[0].status).toBe('done');

    expect((await worker.tick()).resumed).toBe(0);   // and never again
    expect(st.followUps).toHaveLength(2);
  });

  it('a zero-length wait does not park the run — it just carries on', async () => {
    const { st, journeys } = build({
      journeys: [JOURNEY({ actions: [{ kind: 'wait' }, { kind: 'create_task', title: 'immediate' }] })],
    });
    await journeys.fire('lead_created', 1);
    expect(st.runs[0].status).toBe('done');
    expect(st.followUps).toHaveLength(1);
  });
});

/* ========================= SAFETY / DEGRADATION =========================== */

describe('automation can never take the CRM down', () => {
  it('fire() on a lead that does not exist is a no-op, not a throw', async () => {
    const { journeys } = build({ journeys: [JOURNEY()] });
    await expect(journeys.fire('lead_created', 999)).resolves.toEqual([]);
  });

  it('safeFire() swallows everything — a broken journey must never fail a lead INSERT', async () => {
    const { journeys } = build({ journeys: [JOURNEY()] });
    jest.spyOn(journeys as any, 'facts').mockRejectedValue(new Error('db exploded'));
    await expect(journeys.safeFire('lead_created', 1)).resolves.toBeUndefined();
  });

  it('an UNCONFIGURED WhatsApp still runs the journey — the message just lands as not_configured', async () => {
    const { st, journeys } = build({ journeys: [JOURNEY()], channelConfigs: [] });
    await journeys.fire('lead_created', 1);
    // queued fine (credentials are the WORKER's problem, not the journey's)
    expect(st.messages[0].status).toBe('queued');
    expect((st.runs[0].steps as any[])[0].status).toBe('done');
    expect(st.followUps).toHaveLength(1);            // the rest of the journey still ran
  });
});
