/**
 * QA-10 — THE PHANTOM-FIELD MATRIX.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS, AND WHY IT WAS REWRITTEN
 * =============================================================================
 * The same bug has now reached this client THREE times:
 *
 *   DEF-2      · Edit Branch  — 6 fields rendered as read-only boxes; he found it.
 *   DEF-S2-02  · Campaign     — Campaign Type / Marketing Channel / Start / End Date
 *                               rendered, never sent, no columns.
 *   DEF-S2-03  · Add Lead     — WhatsApp Number rendered, never sent, no column.
 *   DEF-S34-02 · Add Walk-in  — Course Fee, "How did you hear about us?" and
 *                               "Convert to Lead" rendered, never sent, no columns.
 *
 * The OLD version of this file passed through every one of those, because it only ever
 * asserted the fields it already knew about. A test that lists the fields it checks can
 * never catch a field nobody thought about — which is the entire failure mode.
 *
 * So the matrix is now GENERIC and EXHAUSTIVE, and it knows nothing about any particular
 * form. For every form in the app it:
 *
 *   1. renders the REAL modal,
 *   2. discovers every `.fld` the user can see, from the DOM — not from a list here,
 *   3. fills EVERY control, submits, and captures the request body  (the BASELINE),
 *   4. then, for EACH field in turn, re-renders, fills everything the same way but
 *      CHANGES THAT ONE FIELD, submits again, and compares the two request bodies.
 *
 * If changing a field cannot change the request — the payloads are byte-identical — then
 * that field is a PHANTOM: the user typed into it and the API never heard about it. The
 * test fails and names it.
 *
 * This is a DIFFERENTIAL PROBE, not a key/value match, and that matters: it needs no
 * knowledge of how a label maps to a payload key. "Status: Inactive" -> `is_active:false`,
 * "Campaign: Meta Jul" -> `campaign_id: 5`, a checkbox -> `convert_to_lead: true`, a phone
 * -> `+919810000011` inside a nested object — every one of those transforms is still a
 * CHANGE, so every one of them is caught. A new form with a phantom field FAILS BY
 * DEFAULT. Nobody has to remember to add an assertion.
 *
 * The only escape hatch is EXEMPT (below): an explicit allowlist where every entry
 * carries a written reason. Adding to it is a deliberate, reviewable act.
 * =============================================================================
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { AddModal, CampaignModal, SPEC_FORMS, SAVERS, EditSpec } from './forms';
import { JourneyModal, TemplateModal, ChannelConfigModal, BlastModal, ProviderSpec } from './sprint4';
import { RuleModal, PolicyModal, EventModal, BandModal, walkInEditSpec, referralEditSpec } from './sprint3';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

/**
 * The hierarchy masters deliberately have ONE row each: a hierarchy field is required, so
 * the probe clears it and the form must refuse to submit — which proves the field matters.
 * Everything else has TWO, so the probe can switch it to a different value.
 */
const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }],
  // the LEAD SOURCE MASTER (m_source) — "How did you hear about us?" (DEF-S34-02)
  masterSources: [{ id: 81, name: 'Google Ads' }, { id: 82, name: 'Hoarding' }],
  courses: [{ id: 21, name: 'IELTS', meta: { fee: 45000 } }, { id: 22, name: 'PTE', meta: { fee: 38000 } }],
  statuses: [{ id: 31, name: 'New' }, { id: 32, name: 'Contacted' }],
  followupTypes: [{ id: 41, name: 'Call' }, { id: 42, name: 'Visit' }],
  dispositions: [{ id: 51, name: 'Interested' }, { id: 52, name: 'Busy' }],
  budgets: [{ id: 61, name: '< 50k' }, { id: 62, name: '50k+' }],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [{ id: 1, name: 'Delhi' }],
  cities: [{ id: 2, name: 'New Delhi', parent_id: 1 }],
  loaded: true,
  reload: () => undefined,
};

vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ id: 99, name: 'x' });
const patch = vi.fn().mockResolvedValue({ id: 99 });

/** The data-driven forms read their options from the API; a blanket `[]` would render
 *  a form the user never sees, so the double answers the routes they actually call. */
const getRoute = (path: string): Promise<unknown> => {
  if (path.startsWith('/journeys/triggers')) {
    return Promise.resolve([
      { key: 'lead_created', label: 'New lead', blurb: 'Any channel', config: [] },
      { key: 'stage_changed', label: 'Stage change', blurb: '', config: ['stage_ids'] },
      { key: 'no_response', label: 'No response for N days', blurb: '', config: ['days'] },
    ]);
  }
  if (path.startsWith('/templates/catalog')) {
    return Promise.resolve({ variables: [{ key: 'lead.name', label: 'Lead name' }], channels: [], sample: {} });
  }
  if (path.startsWith('/templates')) {
    return Promise.resolve([
      { id: 50, channel: 'whatsapp', name: 'Welcome', wa_params: [], variables: [] },
      { id: 51, channel: 'whatsapp', name: 'Reminder', wa_params: [], variables: [] },
    ]);
  }
  if (path.startsWith('/roles')) return Promise.resolve([{ id: 11, name: 'Counsellor' }, { id: 12, name: 'Manager' }]);
  if (path.startsWith('/users')) return Promise.resolve(REF.users);   // the UserPicker's own fetch
  if (/^\/pipelines\/\d+\/stages/.test(path)) return Promise.resolve([{ id: 56, name: 'New' }, { id: 57, name: 'Contacted' }]);
  if (path.startsWith('/leads?q=')) {
    return Promise.resolve({ rows: [{ id: 77, full_name: 'Existing Lead', phone: '+919810000077' }] });
  }
  return Promise.resolve([]);
};

vi.mock('./api', () => ({
  api: {
    get: (p: string) => getRoute(p),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    del: vi.fn(), put: vi.fn(),
  },
}));

/* ========================================================================== */
/*  THE ENGINE — it knows nothing about any specific form.                     */
/* ========================================================================== */

interface Fld { label: string; el: HTMLElement }

/** The field's OWN label — the `<label>` also carries the hint and the "＋ Master" link. */
const labelOf = (el: Element): string => {
  const lab = el.querySelector('label');
  if (!lab) return '';
  const clone = lab.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.fhint, .mlink, .star').forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\*/g, '').trim();
};

/** Every field the user can see, read from the rendered DOM. */
const fieldsNow = (): Fld[] =>
  [...document.querySelectorAll('.add-modal .fld')]
    .map((el) => ({ label: labelOf(el), el: el as HTMLElement }))
    .filter((f) => f.label);

/** The control a user actually types into. A phone field carries a country <select> AND
 *  the number <input type=tel> — the number is the one that matters. */
const controlOf = (el: HTMLElement): HTMLElement | null =>
  (el.querySelector('input[type=tel]')
    ?? el.querySelector('input, select, textarea')) as HTMLElement | null;

const isLeadLookup = (el: HTMLElement) =>
  !!el.querySelector('input[placeholder^="Search lead"]');

/** the searchable multi-select behind the campaign agent pool — not a plain <select> */
const isUserPicker = (el: HTMLElement) => !!el.querySelector('.upick');

/** open the picker and toggle the Nth offered user (-1 = clear the selection) */
const pickUser = async (el: HTMLElement, n: number) => {
  fireEvent.click(el.querySelector('.upick-ctl') as HTMLElement);
  await waitFor(() => expect(el.querySelectorAll('.upick-row').length).toBeGreaterThan(0), { timeout: 1500 });
  if (n < 0) {
    el.querySelectorAll('.upick-chip button').forEach((b) => fireEvent.click(b));
    return;
  }
  const rows = [...el.querySelectorAll('.upick-row')];
  fireEvent.mouseDown(rows[Math.min(n, rows.length - 1)]);
};

/** A React state flush. `fireEvent` needs no timer, so the default is a microtask —
 *  the timer form is only for the passes that wait on a fetched option list. */
const flush = async (ms = 0) => {
  await act(async () => { await (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()); });
};

/** Deterministic values: the SAME field always gets the same baseline, so two runs of a
 *  form differ ONLY by the field being probed. */
const baseline = (label: string, c: HTMLElement): string => {
  if (c.tagName === 'SELECT') {
    const opts = [...(c as HTMLSelectElement).options].filter((o) => o.value !== '');
    return opts[0]?.value ?? '';
  }
  const t = (c as HTMLInputElement).type;
  if (t === 'checkbox') return '1';
  if (t === 'number') return '1000';
  if (t === 'email') return 'qa.baseline@techlingua.test';
  if (t === 'date') return '2026-07-20';
  if (t === 'datetime-local') return '2026-07-20T10:00';
  if (t === 'password') return 'QaBaseline#1';
  if (t === 'tel') return '9810000011';
  return `QA ${label}`;
};

/** The probe value: a DIFFERENT legal value where one exists, otherwise "cleared".
 *  (Clearing a required field makes the form refuse to submit — which also proves the
 *  field is consumed, so both outcomes are a pass.) */
const variant = (label: string, c: HTMLElement): string => {
  if (c.tagName === 'SELECT') {
    const opts = [...(c as HTMLSelectElement).options].filter((o) => o.value !== '');
    return opts[1]?.value ?? '';                       // a second option, else clear
  }
  const t = (c as HTMLInputElement).type;
  if (t === 'checkbox') return '';                     // untick
  if (t === 'number') return '2000';
  if (t === 'email') return 'qa.variant@techlingua.test';
  if (t === 'date') return '2026-08-15';
  if (t === 'datetime-local') return '2026-08-15T16:45';
  if (t === 'password') return 'QaVariant#2';
  if (t === 'tel') return '9820000022';
  return `QA ${label} (probe)`;
};

const setControl = async (el: HTMLElement, value: string) => {
  if (isUserPicker(el)) { await pickUser(el, value === 'probe' ? 1 : value === '' ? -1 : 0); return; }
  if (isLeadLookup(el)) {
    const inp = el.querySelector('input') as HTMLInputElement;
    if (!value) { fireEvent.change(inp, { target: { value: '' } }); return; }
    fireEvent.change(inp, { target: { value: 'Existing' } });
    await waitFor(() => expect(el.querySelector('.lrow')).toBeTruthy(), { timeout: 1500 });
    fireEvent.click(el.querySelector('.lrow') as HTMLElement);
    return;
  }
  const c = controlOf(el);
  if (!c) return;
  if ((c as HTMLInputElement).type === 'checkbox') {
    const box = c as HTMLInputElement;
    if (box.checked !== (value === '1')) fireEvent.click(box);
    return;
  }
  fireEvent.change(c, { target: { value } });
};

/**
 * Fill EVERY rendered field. Re-reads the DOM between passes, because choosing a value can
 * reveal new fields (a journey action reveals its Template select; a rule type reveals its
 * config inputs) — and those new fields must be filled and probed too.
 */
const fillAll = async (probe?: string): Promise<Fld[]> => {
  const done = new Set<string>();
  const seen: Fld[] = [];
  for (let pass = 0; pass < 5; pass++) {
    const fs = fieldsNow();
    let progressed = false;
    for (const f of fs) {
      if (done.has(f.label)) continue;
      const c = controlOf(f.el);
      // A <select> whose options are still being fetched must NOT be ticked off as done —
      // it would be left empty and the form would refuse to submit. Retry it next pass.
      // (This is exactly what made the blast composer look broken on the first draft.)
      if (c?.tagName === 'SELECT' && !isUserPicker(f.el)
          && ![...(c as HTMLSelectElement).options].some((o) => o.value !== '')
          && pass < 4) { progressed = true; continue; }

      done.add(f.label);
      seen.push(f);
      progressed = true;
      const special = isUserPicker(f.el) || isLeadLookup(f.el);
      if (!c && !special) continue;                                 // display-only (see EXEMPT)
      const isProbe = f.label === probe;
      const v = special
        ? (isProbe ? (isUserPicker(f.el) ? 'probe' : '') : (isUserPicker(f.el) ? 'base' : 'pick'))
        : (isProbe ? variant(f.label, c!) : baseline(f.label, c!));
      await setControl(f.el, v);
      await flush();
    }
    if (!progressed) break;
    await flush(10);            // let any option-list fetch resolve before the next pass
  }
  // a probed field may only have appeared on a later pass — apply the probe again, last,
  // so a cascade cannot overwrite it
  if (probe) {
    const f = fieldsNow().find((x) => x.label === probe);
    if (f) {
      const c = controlOf(f.el);
      if (isUserPicker(f.el)) { await setControl(f.el, 'probe'); await flush(); }
      else if (isLeadLookup(f.el)) { await setControl(f.el, ''); await flush(); }
      else if (c) { await setControl(f.el, variant(probe, c)); await flush(); }
    }
  }
  return seen;
};

const calls = () => [...post.mock.calls, ...patch.mock.calls];

/** Click the modal's primary action and return the request body — or null if the form
 *  refused to submit (a cleared required field). */
const submit = async (): Promise<{ path: string; body: unknown } | null> => {
  const btn = document.querySelector('.add-modal .btn.primary') as HTMLButtonElement;
  if (btn.disabled) return null;                       // e.g. a blast with no template
  fireEvent.click(btn);
  for (let i = 0; i < 12 && !calls().length; i++) await flush();          // the saver's promise chain
  for (let i = 0; i < 6 && !calls().length; i++) await flush(5);          // …anything genuinely async
  const c = calls();
  if (!c.length) return null;
  return { path: String(c[c.length - 1][0]), body: c[c.length - 1][1] };
};

/** Order-independent, undefined-insensitive fingerprint of a request body. */
const stable = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort()
      .filter((k) => o[k] !== undefined).map((k) => [k, stable(o[k])]));
  }
  return v;
};
const fp = (v: unknown) => JSON.stringify(stable(v));

/* ========================================================================== */
/*  THE ALLOWLIST — the ONLY way a rendered field may miss the request body.   */
/*  Every entry states WHY. Nothing gets in here without a reason.             */
/* ========================================================================== */

type Allow = Record<string, string>;

/**
 * A lead's PATH IS DERIVED FROM ITS CAMPAIGN, server-side — verified live in QA-12:
 * posting `branch_id: 10` with a campaign that lives under branch 9 correctly stores
 * branch 9. Branch / Vertical / Pipeline on these forms are therefore CASCADE FILTERS
 * that narrow the Campaign dropdown; they are not data. Sending them would let a client
 * create a lead whose path contradicts itself.
 */
const CASCADE_ONLY: Allow = {
  Branch: 'cascade filter only — the lead\'s path is DERIVED from its Campaign, server-side (QA-12 §11)',
  Vertical: 'cascade filter only — derived from the Campaign (see Branch)',
  Pipeline: 'cascade filter only — derived from the Campaign (see Branch)',
};

const EXEMPT: Record<string, Allow> = {
  'leads.all': {
    ...CASCADE_ONLY,
    'Created On': 'server-stamped (type "auto") — the form shows it, nobody can type it',
  },
  'dash.walkins': {
    // NOTE: Branch and Vertical ARE sent on a walk-in (walk_in.branch_id / vertical_id),
    // so they are deliberately NOT exempt here. Only Pipeline is.
    Pipeline: 'cascade filter only — a walk_in has no pipeline column; it is derived from the Campaign',
  },
  'dash.referrals': {
    Pipeline: 'cascade filter only — a referral has no pipeline column; it is derived from the Campaign',
  },
  'leads.pipelinemaster': {
    Branch: 'cascade filter only — a pipeline\'s parent is the VERTICAL (pipeline.vertical_id); the branch is derived from it, so sending both could contradict itself',
    'Pipeline Stages': 'type "table" — the create endpoint seeds the default stage set; stages are edited in the Stage Configurator, not here',
  },
  'admin.users': {
    // nothing exempt — every field on Add User reaches the API
  },
};
EXEMPT['dash.quickcontact'] = EXEMPT['leads.all'];
EXEMPT['leads.pipeline'] = EXEMPT['leads.all'];
EXEMPT['admin.pipelines'] = EXEMPT['leads.pipelinemaster'];

/* ========================================================================== */
/*  THE CASES — every wired form in the app.                                   */
/* ========================================================================== */

interface Case {
  name: string;
  render: () => void;
  allow?: Allow;
  /** the endpoint the form must hit (guards against a form quietly posting nowhere) */
  path: RegExp;
}

/** Every SPEC_FORMS entry that has a SAVER is auto-covered: adding a new wired form to
 *  forms.tsx puts it in this matrix WITHOUT touching this file. That is the point. */
const specCases: Case[] = [...new Set(Object.keys(SAVERS))]
  .filter((k) => SPEC_FORMS[k])
  .map((formKey) => ({
    name: `${SPEC_FORMS[formKey].title}  [${formKey}]`,
    render: () => render(<AddModal formKey={formKey} onClose={() => undefined} />),
    allow: EXEMPT[formKey],
    path: /^\//,
  }));

const WALKIN_ROW = {
  id: 12, visitor_name: 'Priya Sharma', phone: '+919810000011', alt_phone: '+919810000012',
  whatsapp_phone: '+919810000013', email: 'priya@x.com', branch_id: 9, branch_name: 'Vikaspuri',
  vertical_id: 1, vertical_name: 'BCL', pipeline_id: 4, pipeline_name: 'Admissions',
  campaign_id: 5, campaign_name: 'Meta Jul', source_id: 7, source_name: 'Meta Ads',
  visited_at: '2026-07-14T10:30:00.000Z', purpose: 'Admission enquiry',
  course_id: 21, course_name: 'IELTS', course_fee: '45000', heard_about_source_id: 81,
  heard_about_name: 'Google Ads', counsellor_id: 3, counsellor_name: 'Asha Rao',
  convert_to_lead: true, lead_id: 90, remarks: 'Wants weekend batch', status: 'waiting',
};
const REFERRAL_ROW = {
  id: 6, referrer_type: 'Existing Student', referrer_name: 'Asha Rao', referrer_phone: '+919810000001',
  referred_name: 'Ravi Kumar', referred_phone: '+919810000022', referred_whatsapp: '+919810000023',
  referred_email: 'ravi@x.com', relationship: 'Cousin', branch_id: 9, branch_name: 'Vikaspuri',
  vertical_id: 1, vertical_name: 'BCL', pipeline_id: 4, pipeline_name: 'Admissions',
  campaign_id: 5, campaign_name: 'Meta Jul', source_id: 7, source_name: 'Meta Ads',
  course_id: 21, course_name: 'IELTS', incentive: '10% off', status: 'pending', lead_id: 91,
};
const TPL = {
  id: 50, channel: 'whatsapp', name: 'Welcome', code: 'welcome_wa', vertical_id: 1,
  subject: null, body: 'Hi {{lead.name}}', wa_template_name: 'lead_welcome', wa_language: 'en',
  wa_params: ['{{lead.name}}'], sms_sender_id: null, sms_dlt_template_id: null,
  variables: ['lead.name'], is_active: true,
};
const JNY = {
  id: 7, name: 'Welcome new leads', description: null, trigger_type: 'lead_created',
  trigger_config: {}, conditions: { campaign_ids: [5] },
  actions: [{ kind: 'send_message', template_id: 50 }],
  status: 'active', branch_id: null, vertical_id: null,
};
const RULE_TYPES = [
  { type: 'source_channel', label: 'Source channel', hint: '', fields: ['channels'] },
  { type: 'budget_min', label: 'Budget at least', hint: '', fields: ['amount'] },
];
const SMTP_SPEC: ProviderSpec = {
  key: 'smtp', channel: 'email', label: 'SMTP', blurb: '', perVertical: true,
  config: [
    { key: 'host', label: 'SMTP Host', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number' },
    { key: 'from_email', label: 'From address', type: 'text', required: true },
  ],
  secrets: [
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'App password', type: 'password', required: true },
  ],
  setup: [],
};

const bespokeCases: Case[] = [
  {
    name: 'Campaign (NeoDove) — Add',
    render: () => render(<CampaignModal onClose={() => undefined} />),
    // NOTE: Pipeline is deliberately NOT exempt — a campaign's parent IS the pipeline
    // (`pipeline_id` is in the POST body), so it must be probed like any other field.
    allow: { Branch: CASCADE_ONLY.Branch, Vertical: CASCADE_ONLY.Vertical },
    path: /^\/campaigns$/,
  },
  {
    name: 'Message Template — Add',
    render: () => render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />),
    allow: {
      Variables: 'a PALETTE, not a field — clicking a chip inserts {{lead.name}} into the Message Body, which IS sent. There is nothing here for the user to fill in.',
    },
    path: /^\/templates$/,
  },
  {
    name: 'Automation Journey — Add',
    render: () => render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />),
    allow: {
      'Conditions — leave a box empty to mean "any"': 'a SECTION HEADING, not a field — it has no control. The conditions themselves (Campaign, Score band, Priority…) are separate fields and are each probed.',
    },
    path: /^\/journeys$/,
  },
  {
    name: 'Lead Scoring rule — Add',
    render: () => render(<RuleModal types={RULE_TYPES} onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/scoring\/rules$/,
  },
  {
    name: 'Score bands',
    render: () => render(<BandModal cfg={{ bands: { hot: 70, warm: 40 } } as never}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/scoring\/config$/,
  },
  {
    name: 'SLA policy — Add',
    render: () => render(<PolicyModal onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/sla\/policies$/,
  },
  {
    name: 'Calendar event — Add',
    render: () => render(<EventModal onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/calendar$/,
  },
  {
    name: 'Channel config (SMTP) — Add',
    render: () => render(<ChannelConfigModal spec={SMTP_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Bulk message blast',
    render: () => render(<BlastModal channel="whatsapp" onClose={() => undefined} onSent={() => undefined} />),
    path: /^\/messages\/bulk$/,
  },
  /* ---- DEF-S34-03: the two Edit forms that did not exist until this commit ---- */
  {
    name: 'Edit Walk-in  [DEF-S34-03]',
    render: () => render(<AddModal formKey="dash.walkins" onClose={() => undefined}
      edit={walkInEditSpec(WALKIN_ROW, () => undefined) as EditSpec} />),
    path: /^\/walk-ins\/12$/,
  },
  {
    name: 'Edit Referral  [DEF-S34-03]',
    render: () => render(<AddModal formKey="dash.referrals" onClose={() => undefined}
      edit={referralEditSpec(REFERRAL_ROW, () => undefined) as EditSpec} />),
    path: /^\/referrals\/6$/,
  },
];

/** Fields an EDIT form renders read-only. qa/09 allows `lock` for ONE thing: an immutable
 *  parent link. A locked field has no control, so it can never reach the payload — and it
 *  must not. The lock lists are asserted separately (see "lock discipline" below). */
const LOCKED: Record<string, string[]> = {
  'Edit Walk-in  [DEF-S34-03]': ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'],
  'Edit Referral  [DEF-S34-03]': ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'],
};

const CASES: Case[] = [...specCases, ...bespokeCases];

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

/* ========================================================================== */
/*  THE TEST                                                                   */
/* ========================================================================== */

describe('QA-10 — every field a form RENDERS must reach the request body', () => {
  it('the matrix covers every wired form in the app (nothing silently skipped)', () => {
    // if someone wires a new SAVER, it appears here automatically — and gets probed.
    for (const k of Object.keys(SAVERS)) expect(SPEC_FORMS[k], `SAVERS['${k}'] has no spec form`).toBeTruthy();
    expect(CASES.length).toBeGreaterThanOrEqual(Object.keys(SAVERS).length);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s — no phantom fields', async (_name, c) => {
    const allow = { ...(c.allow ?? {}) };
    const locked = LOCKED[c.name] ?? [];

    /* ---------- BASELINE: fill everything, submit, capture the body ---------- */
    c.render();
    const fields = await fillAll();
    const base = await submit();
    expect(base, `${c.name}: the form did not submit at all with every field filled`).not.toBeNull();
    expect(base!.path).toMatch(c.path);
    const baseFp = fp(base!.body);

    const phantoms: string[] = [];

    for (const f of fields) {
      if (locked.includes(f.label)) continue;             // read-only by design (see LOCKED)
      if (allow[f.label]) continue;                       // documented display-only

      cleanup(); post.mockClear(); patch.mockClear();
      c.render();
      const seen = await fillAll(f.label);

      // a field that renders NO control at all, and is not allowlisted, is a phantom by
      // definition — the user is shown a box that can never carry a value.
      const still = seen.find((x) => x.label === f.label);
      if (still && !controlOf(still.el) && !isLeadLookup(still.el)) {
        phantoms.push(`${f.label} (renders no editable control)`);
        continue;
      }

      const probed = await submit();
      // no request at all => the field is REQUIRED and validated => it is consumed. Pass.
      if (probed === null) continue;
      if (fp(probed.body) === baseFp) phantoms.push(f.label);
    }

    expect(
      phantoms,
      `\n\n*** PHANTOM FIELDS on "${c.name}" ***\n` +
      `These controls are RENDERED to the user, but changing them does not change the\n` +
      `request body — whatever he types is silently discarded (the DEF-2 / DEF-S2-02 /\n` +
      `DEF-S34-02 bug, again):\n\n    ${phantoms.join('\n    ')}\n\n` +
      `Fix it by sending the field (and giving it a column), or — if it is genuinely\n` +
      `display-only — add it to EXEMPT in this file WITH A WRITTEN REASON.\n`,
    ).toEqual([]);
  }, 30_000);

  /** A stale allowlist is how an exemption outlives its reason: every exemption must
   *  still name a field that exists, and must still say why. */
  it.each(CASES.filter((c) => Object.keys(c.allow ?? {}).length).map((c) => [c.name, c] as const))(
    '%s — every allowlist entry names a real field and carries a reason', async (_n, c) => {
      cleanup();
      c.render();
      await flush(30);
      const labels = fieldsNow().map((f) => f.label);
      for (const [label, why] of Object.entries(c.allow!)) {
        expect(labels, `allowlist entry "${label}" on ${c.name} is STALE — no such field is rendered`)
          .toContain(label);
        expect(why.length, `allowlist entry "${label}" on ${c.name} has no written reason`)
          .toBeGreaterThan(20);
      }
    });

  /** qa/09's rule for developers, as an executable one: `lock` is ONLY for an immutable
   *  parent link. It must never be used to hide a field the backend does not persist. */
  it('lock discipline — an Edit form locks nothing but the hierarchy path', () => {
    const PATH = ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'];
    for (const spec of [walkInEditSpec(WALKIN_ROW, () => undefined),
      referralEditSpec(REFERRAL_ROW, () => undefined)]) {
      for (const l of spec.lock ?? []) expect(PATH).toContain(l);
    }
  });
});

/* ========================================================================== */
/*  NAMED REGRESSION PINS — the four defects that actually reached the client. */
/*  The generic sweep above would catch each of them; these say so out loud.   */
/* ========================================================================== */

const control = (label: string) => {
  const f = fieldsNow().find((x) => x.label.startsWith(label));
  if (!f) throw new Error(`field "${label}" is not rendered at all`);
  return controlOf(f.el);
};
const telInput = (label: string) => {
  const f = fieldsNow().find((x) => x.label.startsWith(label))!;
  return f.el.querySelector('input[type=tel]') as HTMLInputElement;
};
const save = () => fireEvent.click(document.querySelector('.add-modal .btn.primary') as HTMLButtonElement);

describe('DEF-S34-02 — Add Walk-in sends Course Fee, "How did you hear about us?" and Convert to Lead', () => {
  it('all three are live controls, and Convert to Lead ships TICKED', () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    expect((control('Course Fee') as HTMLInputElement).type).toBe('number');
    expect(control('How did you hear about us?')!.tagName).toBe('SELECT');
    const conv = control('Convert to Lead') as HTMLInputElement;
    expect(conv.type).toBe('checkbox');
    expect(conv.checked).toBe(true);   // a walk-in becoming an assigned lead IS the point
  });

  it('"How did you hear about us?" is backed by the LEAD SOURCE MASTER, not a hard-coded list', () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    const sel = control('How did you hear about us?') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', '81', '82']);   // m_source ids
  });

  it('POST /walk-ins carries course_fee + heard_about_source_id + convert_to_lead', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Priya Sharma' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000011' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Pipeline')!, { target: { value: '4' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    fireEvent.change(control('Counsellor Assigned')!, { target: { value: '3' } });
    fireEvent.change(control('Course Fee')!, { target: { value: '45000' } });
    fireEvent.change(control('How did you hear about us?')!, { target: { value: '81' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/walk-ins');
    expect(post.mock.calls[0][1]).toMatchObject({
      visitor_name: 'Priya Sharma', counsellor_id: 3,       // ASSIGN ON ADD
      course_fee: '45000', heard_about_source_id: 81, convert_to_lead: true,
    });
  });

  it('unticking Convert to Lead sends convert_to_lead:false (the checkbox is not a no-op)', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Fee Query' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000014' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    fireEvent.change(control('Counsellor Assigned')!, { target: { value: '3' } });
    fireEvent.click(control('Convert to Lead')!);   // untick
    save();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ convert_to_lead: false });
  });

  it('the counsellor is MANDATORY — saving without one does not POST', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'No Counsellor' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000013' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    save();
    await flush();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('DEF-S34-03 — Walk-in and Referral have a real Edit form, prefilled', () => {
  it('Edit Walk-in prefills EVERY field, including the three DEF-S34-02 added', () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined}
      edit={walkInEditSpec(WALKIN_ROW, () => undefined) as EditSpec} />);
    expect((control('Name') as HTMLInputElement).value).toBe('Priya Sharma');
    expect(telInput('Mobile Number').value).toContain('9810000011');
    expect(telInput('WhatsApp Number').value).toContain('9810000013');
    expect((control('Email ID') as HTMLInputElement).value).toBe('priya@x.com');
    expect((control('Purpose of Visit') as HTMLSelectElement).value).toBe('Admission enquiry');
    expect((control('Course Interested') as HTMLSelectElement).value).toBe('21');
    expect((control('Course Fee') as HTMLInputElement).value).toBe('45000');
    expect((control('How did you hear about us?') as HTMLSelectElement).value).toBe('81');
    expect((control('Counsellor Assigned') as HTMLSelectElement).value).toBe('3');
    expect((control('Convert to Lead') as HTMLInputElement).checked).toBe(true);
    expect((control('Remarks') as HTMLTextAreaElement).value).toBe('Wants weekend batch');
  });

  it('Edit Walk-in PATCHes the change (the client\'s "Edit is not editable" complaint)', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined}
      edit={walkInEditSpec(WALKIN_ROW, () => undefined) as EditSpec} />);
    fireEvent.change(control('Course Fee')!, { target: { value: '52000' } });
    fireEvent.change(control('Remarks')!, { target: { value: 'Corrected by the front desk' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/walk-ins/12');
    expect(patch.mock.calls[0][1]).toMatchObject({
      course_fee: '52000', remarks: 'Corrected by the front desk',
      visitor_name: 'Priya Sharma', heard_about_source_id: 81, counsellor_id: 3,
    });
  });

  it('an UNCONVERTED walk-in can be converted from the Edit form', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined}
      edit={walkInEditSpec({ ...WALKIN_ROW, lead_id: null, convert_to_lead: false },
        () => undefined) as EditSpec} />);
    expect((control('Convert to Lead') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(control('Convert to Lead')!);
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1]).toMatchObject({ convert_to_lead: true });
  });

  it('Edit Referral prefills and PATCHes every field, incl. the ones with no column before', async () => {
    render(<AddModal formKey="dash.referrals" onClose={() => undefined}
      edit={referralEditSpec(REFERRAL_ROW, () => undefined) as EditSpec} />);
    expect((control('Referrer Name') as HTMLInputElement).value).toBe('Asha Rao');
    expect((control('Relationship to Referrer') as HTMLInputElement).value).toBe('Cousin');
    expect(telInput('Referred Person WhatsApp Number').value).toContain('9810000023');
    expect((control('Referred Person Email') as HTMLInputElement).value).toBe('ravi@x.com');
    expect((control('Incentive / Reward Applicable') as HTMLInputElement).value).toBe('10% off');
    expect((control('Referral Status') as HTMLSelectElement).value).toBe('Pending');

    fireEvent.change(control('Incentive / Reward Applicable')!, { target: { value: '20% off' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/referrals/6');
    expect(patch.mock.calls[0][1]).toMatchObject({
      incentive: '20% off', relationship: 'Cousin', referred_email: 'ravi@x.com',
    });
  });
});

describe('DEF-S2-02 / DEF-S2-03 — the two earlier phantom-field defects stay fixed', () => {
  it('Campaign: type / channel / start / end are prefilled on Edit and sent on save', async () => {
    const CAMPAIGN_ROW = {
      id: 5, name: 'Meta Jul', branch_id: 9, vertical_id: 1, pipeline_id: 4,
      branch_name: 'Vikaspuri', vertical_name: 'BCL', pipeline_name: 'Admissions',
      utm: { utm_campaign: 'meta_jul' }, cost: 5000, priority: 'med',
      distribution_config: { mode: 'on_demand', batch_size: 10 },
      duplicacy_config: { check_scope: 'this_campaign', on_duplicate: 'ignore' },
      campaign_type: 'Digital', marketing_channel: 'Meta',
      start_date: '2026-07-01', end_date: '2026-07-31',
    };
    render(<CampaignModal onClose={() => undefined} initial={CAMPAIGN_ROW} />);
    expect((control('Campaign Type') as HTMLSelectElement).value).toBe('Digital');
    expect((control('Start Date') as HTMLInputElement).value).toBe('2026-07-01');
    const batch = screen.getByLabelText('Leads per hand-out') as HTMLInputElement;
    expect(batch.value).toBe('10');

    fireEvent.change(control('Start Date')!, { target: { value: '2026-07-05' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/campaigns/5');
    expect(patch.mock.calls[0][1]).toMatchObject({ start_date: '2026-07-05', campaign_type: 'Digital' });
  });

  it('Add Lead sends whatsapp_phone (DEF-S2-03) and dob (the birthday journey)', async () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Zed Wa' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000001' } });
    fireEvent.change(telInput('WhatsApp Number'), { target: { value: '9810000002' } });
    fireEvent.change(control('Date of Birth')!, { target: { value: '2001-03-14' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    save();
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(String(body.whatsapp_phone)).toContain('9810000002');
    expect(body.dob).toBe('2001-03-14');
  });

  it('the Add User Status options match what the backend stores (no phantom "Suspended")', () => {
    expect(SPEC_FORMS['admin.users'].fields.find((f) => f.label === 'Status')!.opts)
      .toEqual(['Active', 'Deactivated']);
  });
});
