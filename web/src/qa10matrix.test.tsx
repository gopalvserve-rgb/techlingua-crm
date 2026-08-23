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
import { JourneyModal, TemplateModal, SmsTemplateModal, ChannelConfigModal, BlastModal, ProviderSpec } from './sprint4';
import { RuleModal, PolicyModal, EventModal, BandModal, walkInEditSpec, referralEditSpec } from './sprint3';
import { CollectModal, EnrolmentModal, NumberingModal, QuotationModal, TargetModal } from './sprint5';
import { BatchModal, StudentModal } from './dyn';
import {
  AnnouncementModal, ArticleModal, ChannelModal, NoteModal, ScheduleModal, ShareModal,
} from './sprint6';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

/**
 * The hierarchy masters deliberately have ONE row each: a hierarchy field is required, so
 * the probe clears it and the form must refuse to submit — which proves the field matters.
 * Everything else has TWO, so the probe can switch it to a different value.
 */
const REF = {
  // MULTI-BRANCH probe (task 18): TWO branches, and branch 9 carries TWO verticals so the
  // differential probe can switch Branch Access (9→10) AND Vertical Access (1→2) independently.
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'PTE', branch_id: 9 }, { id: 3, name: 'Coaching', branch_id: 10 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }],
  // the LEAD SOURCE MASTER (m_source) — "How did you hear about us?" (DEF-S34-02)
  masterSources: [{ id: 81, name: 'Google Ads' }, { id: 82, name: 'Hoarding' }],
  // UAT-R2 #16 — a Course belongs to ONE Branch (9) → ONE Vertical (1); both rows carry
  // the same branch/vertical so the differential probe can still switch IELTS↔PTE.
  courses: [{ id: 21, name: 'IELTS', meta: { fee: 45000, branch_id: 9, vertical_id: 1 } }, { id: 22, name: 'PTE', meta: { fee: 38000, branch_id: 9, vertical_id: 1 } }],
  statuses: [{ id: 31, name: 'New' }, { id: 32, name: 'Contacted' }],
  followupTypes: [{ id: 41, name: 'Call' }, { id: 42, name: 'Visit' }],
  dispositions: [{ id: 51, name: 'Interested' }, { id: 52, name: 'Busy' }],
  budgets: [{ id: 61, name: '< 50k' }, { id: 62, name: '50k+' }],
  // UAT-R2 masters — TWO rows each so the differential probe can switch the value.
  trainings: [{ id: 71, name: 'Online', code: 'ONLINE' }, { id: 72, name: 'Offline', code: 'OFFLINE' }],
  visitPurposes: [{ id: 73, name: 'Admission enquiry', code: 'ADM_ENQ' }, { id: 74, name: 'Fee query', code: 'FEE_QUERY' }],
  walkinStatuses: [{ id: 75, name: 'Waiting', code: 'waiting' }, { id: 76, name: 'Converted', code: 'converted' }],
  // Support & Tickets — Ticket Category master; TWO rows so the differential probe can switch it.
  ticketCategories: [{ id: 91, name: 'Technical', code: 'TECH' }, { id: 92, name: 'Billing', code: 'BILL' }],
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
  /* ---- Sprint 5 ---- */
  if (path.startsWith('/enrolments/meta')) {
    return Promise.resolve({
      payment_plans: [
        { key: 'full', label: 'Full payment' }, { key: 'emi_3', label: '3 installments' },
        { key: 'emi_6', label: '6 installments' }, { key: 'custom', label: 'Custom' },
      ],
      approvals: { enabled: false, steps: [] },
    });
  }
  if (path.startsWith('/enrolments')) {
    // the CollectModal's enrolment picker — TWO rows, so the probe can switch it
    return Promise.resolve([
      {
        id: 61, enrolment_no: 'ENR-2026/0001', lead_name: 'Priya Sharma', course_name: 'IELTS',
        net_fee_minor: 4_050_000, paid_minor: 0, balance_minor: 4_050_000, status: 'active',
      },
      {
        id: 62, enrolment_no: 'ENR-2026/0002', lead_name: 'Ravi Nair', course_name: 'PTE',
        net_fee_minor: 3_800_000, paid_minor: 1_000_000, balance_minor: 2_800_000, status: 'active',
      },
    ]);
  }
  if (path.startsWith('/fees/meta')) {
    return Promise.resolve({
      modes: [
        { key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }, { key: 'card', label: 'Card' },
        { key: 'cheque', label: 'Cheque' }, { key: 'online', label: 'Online transfer' },
      ],
      online: { gateway_capture: false, phase: 3, note: 'Phase 3' },
    });
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

/**
 * A CHIP GROUP — a row of toggle buttons, not an <input>. Sprint 6 uses it for the report
 * builder's columns and for the role pickers on Share / Schedule / Announcement.
 *
 * THE HARNESS WAS TAUGHT THIS RATHER THAN THE FIELDS BEING EXEMPTED, which is the same
 * call the `type="month"` false alarm forced in Sprint 5, for the same reason: `controlOf`
 * finds no <input> in a chip group, so the probe reported "renders no editable control" —
 * a FALSE ALARM on four perfectly good fields. Allowlisting them would have silenced the
 * warning AND hidden any real phantom that ever appeared in a chip group, for ever.
 * A harness that cries wolf is the same bug as one that misses.
 */
const isChips = (el: HTMLElement) => !!el.querySelector('.chips');

/** toggle the Nth chip (-1 = clear every selected chip) */
const pickChip = (el: HTMLElement, n: number) => {
  const chips = [...el.querySelectorAll('.chips button')] as HTMLButtonElement[];
  if (!chips.length) return;
  if (n < 0) { chips.filter((c) => c.className.includes('on')).forEach((c) => fireEvent.click(c)); return; }
  fireEvent.click(chips[Math.min(n, chips.length - 1)]);
};

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
  // `month` and `time` were MISSING until Sprint 5, and the gap was not theoretical: the
  // Monthly Target form's Month field fell through to the text branch, got "QA Month",
  // which is not a valid month, so BOTH the baseline and the probe submitted the same
  // empty value — and the matrix reported a perfectly good field as a PHANTOM.
  //
  // A generic harness that silently tests the wrong thing is worse than no harness (the
  // `.btn.primary` lesson from the WhatsApp card). A harness that cries WOLF is the same
  // bug wearing a different hat: the fix is to teach it the input type, never to exempt
  // the field — an exemption would have hidden a real phantom here for ever.
  if (t === 'month') return '2026-07';
  if (t === 'time') return '09:30';
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
  if (t === 'month') return '2026-11';                // see baseline()
  if (t === 'time') return '17:45';
  if (t === 'password') return 'QaVariant#2';
  if (t === 'tel') return '9820000022';
  return `QA ${label} (probe)`;
};

const setControl = async (el: HTMLElement, value: string) => {
  if (isChips(el)) { pickChip(el, value === 'probe' ? 1 : value === '' ? -1 : 0); return; }
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
      const special = isUserPicker(f.el) || isLeadLookup(f.el) || isChips(f.el);
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
  // The SAVE action is the primary button in the modal FOOTER (`.af`). Prefer it
  // explicitly: some modals now carry a primary button in the BODY too (WhatsApp's
  // "Connect WhatsApp"), and a bare `.btn.primary` picks that one instead — which
  // looked exactly like "the form does not submit". Fall back to the old selector so
  // every form without a footer keeps behaving as before.
  const btn = (document.querySelector('.add-modal .af .btn.primary')
    ?? document.querySelector('.add-modal .btn.primary')) as HTMLButtonElement;
  if (!btn || btn.disabled) return null;               // e.g. a blast with no template
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
    // Client Aug 2026 (#3) — a SEARCH helper shown only for an Existing-Student referrer. Picking a
    // student AUTO-FILLS the other referrer fields (name/phone/branch/vertical/course) from
    // GET /students/:id; it carries no payload of its own, so it never reaches the request body.
    // Its search + autofill are proven behaviourally (StudentLookup) — here it is display-only.
    'Find Existing Student': 'type "studentlookup" — an existing-student search that auto-fills the other referrer fields; it has no own payload and never reaches the body (client Aug 2026 #3)',
  },
  'leads.pipelinemaster': {
    Branch: 'cascade filter only — a pipeline\'s parent is the VERTICAL (pipeline.vertical_id); the branch is derived from it, so sending both could contradict itself',
    'Pipeline Stages': 'type "table" — a structured multi-row stage sub-editor (add / edit / reorder / delete rows, one default). The generic single-field differential probe cannot drive a multi-row widget; its full add/persist/prefill behaviour is proven end-to-end in pipeline-stages.test.tsx instead (UAT-R2 #9).',
  },
  'admin.users': {
    // nothing exempt — every field on Add User reaches the API
  },
  // UAT-R3 #21 — the Add Source form now walks Branch \u2192 Vertical \u2192 Pipeline \u2192 Campaign.
  // Only Campaign reaches the payload (source.campaign_id); the source's whole path is
  // DERIVED from the Campaign server-side, so Branch/Vertical/Pipeline are cascade filters.
  'leads.sources': {
    Branch: 'cascade filter only — a source\'s path is DERIVED from its Campaign, server-side',
    Vertical: 'cascade filter only — derived from the Campaign (see Branch)',
    Pipeline: 'cascade filter only — derived from the Campaign (see Branch)',
  },
};
// UAT (Aug 2026) — the course form gained an OPTIONAL Pipeline \u2192 Campaign cascade on top of its
// required Branch \u2192 Vertical ownership. Both ARE sent (meta.pipeline_id / meta.campaign_id — see
// SAVERS['students.courses'] and courseEditSpec), but the shared REF fixture carries a single
// pipeline (id 4) under vertical 1 and a single campaign (id 5) under it, so the differential probe
// cannot SWITCH them to a second value to observe the payload change. Their persistence, strict
// gating and parent-reset are proven directly in coursecascade.test.tsx instead.
// dev/100 removed Pipeline/Campaign from the ERP course form (CRM-only concepts), so they are no
// longer rendered and need no exemption. The one exempt field now is the Levels sub-editor:
EXEMPT['students.courses'] = {
  // Course LEVELS (enrollment re-model, batch 1) \u2014 a repeatable per-level fee sub-editor (\uff0b Add level;
  // each row = level code + its own fee). Persisted by a SEPARATE PUT /courses/:id/levels, not the main
  // course POST body, so the single-field differential probe cannot observe it; its full add/persist/
  // reload behaviour is proven directly in courselevels.test.tsx.
  Levels: 'type "levels" \u2014 a structured multi-row per-level fee editor persisted via PUT /courses/:id/levels; proven in courselevels.test.tsx',
};
EXEMPT['admin.courseconfig'] = EXEMPT['students.courses'];
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

/* ---------------------------------------------------------------------------
 * THE NEW CREDENTIAL FIELD-SETS.
 *
 * ChannelConfigModal is ONE generic form driven by a provider spec, so a new
 * provider is not a new component — but it IS a new set of fields, rendered
 * through code paths the SMTP spec never exercises: `select`, `bool`, and a
 * secrets list longer than two. Those are exactly the shapes the three phantom
 * bugs hid in. Each spec below mirrors the real one in api/src/messaging/providers.ts.
 * ------------------------------------------------------------------------- */

const CLOUDFLARE_SPEC: ProviderSpec = {
  key: 'cloudflare', channel: 'storage', label: 'Cloudflare (R2, DNS, CDN)', blurb: '',
  perVertical: false, test: 'probe',
  config: [
    { key: 'zone', label: 'Domain / zone', type: 'text', required: true },
    { key: 'zone_id', label: 'Zone ID', type: 'text' },
    { key: 'account_id', label: 'Account ID', type: 'text', required: true },
    { key: 'r2_bucket', label: 'R2 bucket name', type: 'text', required: true },
    { key: 'r2_public_domain', label: 'R2 public/custom domain', type: 'text' },
    // the `select` path — untested by the SMTP spec
    { key: 'plan', label: 'Plan level', type: 'select', opts: ['Free', 'Pro', 'Business', 'Enterprise'] },
  ],
  secrets: [
    { key: 'api_token', label: 'API token', type: 'password', required: true },
    { key: 'r2_access_key_id', label: 'R2 access key ID', type: 'password', required: true },
    { key: 'r2_secret_access_key', label: 'R2 secret access key', type: 'password', required: true },
  ],
  setup: [],
};

const WHATSAPP_SPEC: ProviderSpec = {
  key: 'meta_cloud', channel: 'whatsapp', label: 'WhatsApp — Meta Cloud API', blurb: '',
  perVertical: false, test: 'probe',
  config: [
    { key: 'app_id', label: 'Meta App ID', type: 'text' },
    { key: 'config_id', label: 'Embedded Signup Configuration ID', type: 'text' },
    { key: 'phone_number_id', label: 'Phone number ID', type: 'text', required: true },
    { key: 'waba_id', label: 'WhatsApp Business Account ID', type: 'text' },
    { key: 'display_phone_number', label: 'Connected number', type: 'text' },
    { key: 'verified_name', label: 'Verified business name', type: 'text' },
    { key: 'connected_via', label: 'Connected via', type: 'text' },
    { key: 'api_version', label: 'Graph API version', type: 'text' },
    { key: 'default_language', label: 'Default template language', type: 'text' },
  ],
  secrets: [
    { key: 'access_token', label: 'Permanent access token', type: 'password', required: true },
    { key: 'app_secret', label: 'App secret', type: 'password' },
    { key: 'verify_token', label: 'Webhook verify token', type: 'password', generated: true },
  ],
  setup: [],
};

const RAZORPAY_SPEC: ProviderSpec = {
  key: 'razorpay', channel: 'payment', label: 'Razorpay (per vertical)', blurb: '',
  perVertical: true, test: 'probe',
  config: [
    { key: 'key_id', label: 'Key ID', type: 'text', required: true },
    { key: 'currency', label: 'Currency', type: 'text' },
    { key: 'account_label', label: 'Settlement account label', type: 'text' },
  ],
  secrets: [
    { key: 'key_secret', label: 'Key Secret', type: 'password', required: true },
    { key: 'webhook_secret', label: 'Webhook secret', type: 'password' },
  ],
  setup: [],
};

const CALENDAR_SPEC: ProviderSpec = {
  key: 'google_oauth', channel: 'calendar', label: 'Google Calendar sync', blurb: '',
  perVertical: false, test: 'none',
  config: [
    { key: 'client_id', label: 'OAuth client ID', type: 'text', required: true },
    { key: 'calendar_id', label: 'Calendar ID', type: 'text' },
  ],
  secrets: [
    { key: 'client_secret', label: 'OAuth client secret', type: 'password', required: true },
    { key: 'refresh_token', label: 'Refresh token', type: 'password' },
  ],
  setup: [],
};

const SMS_SPEC: ProviderSpec = {
  key: 'msg91', channel: 'sms', label: 'MSG91 (India, DLT)', blurb: '',
  perVertical: false, test: 'send',
  config: [
    { key: 'sender_id', label: 'DLT Sender ID', type: 'text', required: true },
    { key: 'dlt_template_id', label: 'Default DLT Template ID', type: 'text' },
    { key: 'otp_dlt_template_id', label: 'OTP DLT Template ID', type: 'text' },
    { key: 'route', label: 'Route', type: 'text' },
    { key: 'country', label: 'Country code', type: 'text' },
  ],
  secrets: [{ key: 'authkey', label: 'Auth Key', type: 'password', required: true }],
  setup: [],
};

/**
 * A SENT quotation, as `GET /quotations/:id` returns it — the state the Revise form is
 * opened from. It exists here because DEF-S16-01's Revise button is a NEW WIRED FORM, and
 * every wired form goes through the phantom probe. A revision misprices a customer just
 * as effectively as a first quotation does.
 */
const SENT_QUOTE = {
  id: 1, quote_no: 'QT-2026/0001', version: 1, status: 'sent', valid_until: '2026-08-15',
  lead_id: 31, lead_name: 'Priya Sharma', notes: 'Weekend batch', terms: '50% on enrolment',
  subtotal_minor: 4_500_000, discount_minor: 450_000, tax_minor: 729_000, total_minor: 4_779_000,
  items: [{
    line_no: 1, course_id: 21, description: 'IELTS Academic', course_name: 'IELTS', qty: 1,
    unit_price_minor: 4_500_000, discount_type: 'percent', discount_value: '10',
    discount_minor: 450_000, tax_pct: '18', tax_minor: 729_000, total_minor: 4_779_000,
  }],
};

const QUOTE_ALLOW = {
  Number: 'display-only — the quote number is ALLOCATED SERVER-SIDE from the numbering series on save (atomically, so two counsellors cannot get the same one). There is nothing here for the user to type; the box shows "Allocated on save".',
  'Line total': 'display-only — computed from Rate/Qty/Discount/Tax by money.ts and RE-COMPUTED server-side. The client never posts a total, so a total can never disagree with its lines.',
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
    name: 'SMS Template (DLT / Nimbus) — Add',
    render: () => render(<SmsTemplateModal onClose={() => undefined} onSaved={() => undefined} />),
    // Branch + Vertical ARE data here (branch_id / vertical_id in the body — they scope the
    // new-lead auto-send), so they are probed like any other field, NOT exempt.
    path: /^\/sms-templates$/,
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
    name: 'Channel config (Cloudflare) — Add',
    render: () => render(<ChannelConfigModal spec={CLOUDFLARE_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Channel config (WhatsApp / Embedded Signup) — Add',
    render: () => render(<ChannelConfigModal spec={WHATSAPP_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Channel config (Razorpay, per vertical) — Add',
    render: () => render(<ChannelConfigModal spec={RAZORPAY_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Channel config (Google Calendar) — Add',
    render: () => render(<ChannelConfigModal spec={CALENDAR_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Channel config (SMS / MSG91 + DLT) — Add',
    render: () => render(<ChannelConfigModal spec={SMS_SPEC} existing={null}
      onClose={() => undefined} onSaved={() => undefined} />),
    path: /^\/settings\/channels\/save$/,
  },
  {
    name: 'Bulk message blast',
    render: () => render(<BlastModal channel="whatsapp" onClose={() => undefined} onSent={() => undefined} />),
    path: /^\/messages\/bulk$/,
  },
  /* ================= SPRINT 5 — conversion & money-lite ================= */
  /*
   * These forms take PRICES and MONEY. A phantom field on the walk-in form lost a
   * course fee nobody noticed; a phantom field here would misprice a customer or lose a
   * payment. They go through exactly the same generic probe as everything else.
   */


  {
    name: 'Quotation — Add (line items, discounts, tax)',
    render: () => render(<QuotationModal onClose={() => undefined} />),
    // A one-line quotation is rendered by default, so the probe sees each line field
    // exactly once. Every one of them IS sent (inside `items[0]`) and IS probed.
    allow: QUOTE_ALLOW,
    path: /^\/quotations$/,
  },
  /*
   * DEF-S16-01 — THE REVISE FORM, PROBED LIKE EVERY OTHER.
   *
   * The defect was a form with no door. Having built the door, the form behind it gets
   * the same treatment as the rest: render the real modal, discover every field from the
   * DOM, and prove each one can change the request body. A phantom here would silently
   * drop a renegotiated price into a version the customer is then quoted from — which is
   * the walk-in course-fee bug (DEF-S34-02) wearing a suit.
   */
  {
    name: 'Quotation — Revise  [DEF-S16-01]',
    render: () => render(<QuotationModal initial={SENT_QUOTE} mode="revise" onClose={() => undefined} />),
    allow: {
      ...QUOTE_ALLOW,
      Number: 'display-only — a revision KEEPS its parent\'s number and takes the next -R suffix, allocated server-side on save. The box shows "QT-2026/0001-R…".',
    },
    path: /^\/quotations\/1\/revise$/,
  },
  {
    name: 'Enrolment / Sale Closure — Add',
    render: () => render(<EnrolmentModal onClose={() => undefined} />),
    allow: {
      'Net fee': 'display-only — DERIVED as Total fee less Discount, and re-derived server-side. A net the user could type is a net that can disagree with its own fee and discount, which is the kind of thing an accountant finds in April.',
    },
    path: /^\/enrolments$/,
  },
  {
    name: 'Monthly target — Add',
    render: () => render(<TargetModal onClose={() => undefined} />),
    path: /^\/performance\/targets$/,
  },
  {
    name: 'Fee collection — Record payment',
    render: () => render(<CollectModal onClose={() => undefined} />),
    path: /^\/fees\/collect$/,
  },
  {
    name: 'Numbering series — Edit',
    render: () => render(<NumberingModal
      initial={{ id: 3, kind: 'quotation', prefix: 'QT-', suffix: '', next_number: 7, padding: 4, reset_period: 'yearly' }}
      kinds={[{ key: 'quotation', label: 'Quotations' }, { key: 'receipt', label: 'Fee receipts' }]}
      onClose={() => undefined} />),
    allow: {
      Document: 'LOCKED on an existing series — the `kind` is what the series IS, and changing it would silently renumber a different document type. A new series is created from the "Add" button, where the field is live.',
      'The next number will be': 'display-only — a live preview assembled from Prefix / period / Next number / Padding, all four of which are themselves probed.',
    },
    path: /^\/numbering$/,
  },

  /* ================= SPRINT 6 — reports & workspace ==================== */
  /*
   * Four of these forms decide WHO SEES WHAT. A phantom field on the Share form is a
   * report the client believes he shared and did not; a phantom on the Schedule form is
   * a report that silently emails the wrong people, or nobody, every morning. They go
   * through exactly the same generic probe as everything else — which is the point of
   * the probe being generic.
   */
  {
    name: 'Report — Share',
    render: () => render(<ShareModal report={{ id: 1, name: 'Won this month', shares: [] }} onClose={() => undefined} />),
    path: /^\/reports\/1\/share$/,
  },
  {
    name: 'Report — Schedule delivery',
    render: () => render(<ScheduleModal report={{ id: 1, name: 'Won this month' }} onClose={() => undefined} />),
    path: /^\/reports\/schedules$/,
  },
  {
    name: 'Workspace — New channel',
    render: () => render(<ChannelModal onClose={() => undefined} />),
    allow: {
      // A vertical belongs to a branch, so the two together would let a client scope a
      // channel to "Vikaspuri + a vertical that lives under Rohini" — a contradiction.
      // Vertical narrows to the chosen branch; picking one is picking the branch too.
      Vertical: 'cascade filter — a vertical already implies its branch, and both are sent; the probe cannot change it independently because the REF fixture has one vertical under one branch',
    },
    path: /^\/workspace\/channels$/,
  },
  {
    name: 'Workspace — New note',
    render: () => render(<NoteModal note={{}} onClose={() => undefined} />),
    path: /^\/workspace\/notes$/,
  },
  {
    name: 'Workspace — New KB article',
    render: () => render(<ArticleModal article={{}} onClose={() => undefined} />),
    allow: {
      Vertical: 'cascade filter — see New channel',
    },
    path: /^\/workspace\/kb$/,
  },
  {
    name: 'Workspace — New announcement',
    render: () => render(<AnnouncementModal announcement={{}} onClose={() => undefined} />),
    allow: {
      Vertical: 'cascade filter — see New channel',
    },
    path: /^\/workspace\/announcements$/,
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
    // Client Aug 2026 (#3) — the existing-student search helper carries no payload (see EXEMPT['dash.referrals']).
    allow: { 'Find Existing Student': 'type "studentlookup" — search helper that auto-fills other referrer fields; no own payload (client Aug 2026 #3)' },
    path: /^\/referrals\/6$/,
  },

  /* ---- Phase 2 — Students & Academics: the Add Batch form (module-audit fix) ---- */
  {
    // The client's finding made a test: Add Batch MUST capture Branch + Vertical (+ Course),
    // and every field must reach the request. Branch/Vertical/Course are REAL data on a batch
    // (unlike a lead, whose path derives from its campaign), so none is exempt — changing any
    // one must change the POST body, or clear a required child and refuse to submit.
    name: 'New batch  [students.batches]',
    render: () => render(<BatchModal onClose={() => undefined} onSaved={() => undefined} />),
    allow: {
      'Class days': "coupled to Frequency (081): a non-custom frequency (Daily/Weekdays/Weekends) DERIVES and LOCKS the class-day checkboxes — exactly the 'Current Address ↔ Same as Permanent' shape — so the generic single-field probe cannot toggle them once fillAll picks a non-custom frequency. class_days IS sent on every save (see the request body) and the server re-derives it from the frequency; the Frequency field itself is probed and proven to change the body.",
    },
    path: /^\/batches$/,
  },

  /* ---- Phase 2 — the full Student Admission form (Identity/Contact/Guardian/Address/ID/Education) ---- */
  {
    // The big one. Every rendered field must reach POST /students or be allow-listed with a
    // reason. Student ID is auto (no control); Current Address is coupled to "Same as
    // Permanent" (disabled while ticked), so the generic single-field probe cannot drive it —
    // its independent persistence + the copy are proven in studentform.test.tsx instead.
    name: 'New student  [students.all]',
    render: () => render(<StudentModal onClose={() => undefined} onSaved={() => undefined} />),
    allow: {
      'Student ID': 'auto — minted by the numbering series on save; shown read-only, never typed by the user',
      'Current Address': "coupled to the 'Same as Permanent' checkbox: while ticked, Current mirrors Permanent and the textarea is disabled, so the generic differential probe cannot change it. Its independent save AND the copy behaviour are proven directly in studentform.test.tsx",
    },
    path: /^\/students$/,
  },
];

/** Fields an EDIT form renders read-only. qa/09 allows `lock` for ONE thing: an immutable
 *  parent link. A locked field has no control, so it can never reach the payload — and it
 *  must not. The lock lists are asserted separately (see "lock discipline" below). */
const LOCKED: Record<string, string[]> = {
  'Edit Walk-in  [DEF-S34-03]': ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'],
  'Edit Referral  [DEF-S34-03]': ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'],
  // A revision inherits its parent's lead and path — `revise()` never re-derives them
  // from the client payload, so a revision cannot be moved to another customer. The
  // field renders read-only on purpose; it is locked, not phantom.
  'Quotation — Revise  [DEF-S16-01]': ['Lead', 'Number'],
};

const CASES: Case[] = [...specCases, ...bespokeCases];

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

/* ========================================================================== */
/*  THE TEST                                                                   */
/* ========================================================================== */

describe('QA-10 — every field a form RENDERS must reach the request body', () => {
  /**
   * THE HARNESS MUST KNOW EVERY INPUT TYPE THE APP RENDERS.
   *
   * If a form renders an input type `baseline()`/`variant()` do not handle, the probe
   * feeds it a value the browser rejects, both passes submit the SAME empty value, and a
   * perfectly good field is reported as a phantom. That is a FALSE ALARM, and a harness
   * that cries wolf gets ignored — which is how the real phantom gets through.
   *
   * (This is exactly what Sprint 5's `type="month"` did on its first run.)
   */
  it('the matrix understands every input type any form actually renders', () => {
    const KNOWN = ['text', 'number', 'email', 'date', 'datetime-local', 'month', 'time',
      'password', 'tel', 'checkbox', 'search', 'url', ''];
    const seen = new Set<string>();
    for (const c of CASES) {
      cleanup();
      c.render();
      for (const el of document.querySelectorAll('.add-modal .fld input')) {
        seen.add((el as HTMLInputElement).type.toLowerCase());
      }
    }
    cleanup();
    expect(seen.size).toBeGreaterThan(4);
    expect([...seen].filter((t) => !KNOWN.includes(t))).toEqual([]);
  });

  /**
   * THE SAME SELF-TEST, ONE LEVEL UP: the harness must understand every KIND OF CONTROL a
   * form renders, not just every input TYPE.
   *
   * Sprint 6 shipped a chip-toggle (a row of <button>s) and the probe immediately reported
   * four good fields as phantoms, because `controlOf` looks for `input, select, textarea`
   * and found none. The fix was to teach it — but nothing would have FAILED if we had
   * quietly allowlisted the fields instead, and the next chip-group phantom would have
   * been invisible for ever.
   *
   * So: every `.fld` in every form must contain a control the harness can drive. A new
   * widget fails this test on the day it is written, and whoever wrote it has to teach the
   * harness rather than reach for the allowlist.
   */
  it('the matrix understands every KIND of control any form renders (not just <input> types)', () => {
    const undrivable: string[] = [];
    for (const c of CASES) {
      cleanup();
      c.render();
      const allow = { ...(c.allow ?? {}) };
      const locked = LOCKED[c.name] ?? [];
      for (const f of fieldsNow()) {
        if (allow[f.label] || locked.includes(f.label)) continue;   // documented display-only
        const drivable = !!controlOf(f.el) || isChips(f.el) || isUserPicker(f.el) || isLeadLookup(f.el);
        if (!drivable) undrivable.push(`${c.name} > ${f.label}`);
      }
    }
    cleanup();
    // If this is red, TEACH THE HARNESS (add an `isX`/`setControl` branch above).
    // Do NOT add the field to EXEMPT — that hides every future phantom in that widget.
    expect(undrivable).toEqual([]);
  });

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
      if (still && !controlOf(still.el) && !isLeadLookup(still.el) && !isChips(still.el)) {
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
