/**
 * QA-10 — the qa/09 edit-form matrix, as an executable harness.
 *
 * The tester's Sprint-2 acceptance cycle rendered every form and asked the two
 * questions an API test cannot answer:
 *   1. does the control the user sees actually exist (and is it prefilled)?
 *   2. does Save SEND what the form RENDERS?
 * That caught three more instances of the DEF-2 class the client had already hit:
 *
 *   DEF-S2-02 — Campaign: Campaign Type / Marketing Channel / Start Date / End Date
 *               rendered, never sent, no columns.
 *   DEF-S2-03 — Add Lead: WhatsApp Number rendered, never sent, no column.
 *   DEF-S2-04 — Add Vertical: Vertical Head + Description sent, but dropped by the
 *               INSERT (pinned server-side in api/src/hierarchy/entity-edit-fields.spec.ts).
 *
 * These tests now assert the FIXED behaviour and must stay green: every live input
 * on a wired form reaches the API, and comes back prefilled on Edit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddModal, CampaignModal, SPEC_FORMS } from './forms';
import { JourneyModal, TemplateModal } from './sprint4';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }],
  courses: [{ id: 21, name: 'IELTS' }], statuses: [{ id: 31, name: 'New' }],
  followupTypes: [], dispositions: [], budgets: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }],
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

/**
 * The Sprint-4 forms are DATA-DRIVEN: the journey builder's trigger list and its template
 * dropdown come from the API. A blanket `get -> []` would make those selects empty, and
 * the test would then be asserting against a form the user never sees. So the double
 * answers the routes those forms actually call.
 */
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
    return Promise.resolve([{ id: 50, channel: 'whatsapp', name: 'Welcome', wa_params: [], variables: [] }]);
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

const fld = (label: string) => {
  const el = [...document.querySelectorAll('.fld')].find(
    (f) => f.querySelector('label')?.textContent?.trim().startsWith(label),
  );
  if (!el) throw new Error(`field "${label}" is not rendered at all`);
  return el as HTMLElement;
};
const control = (label: string) => fld(label).querySelector('input, select, textarea') as HTMLElement | null;
const telInput = (label: string) => fld(label).querySelector('input[type=tel]') as HTMLInputElement;
/** the modal's primary action ("Save" / "Save changes") — unambiguous */
const save = () => fireEvent.click(document.querySelector('.add-modal .btn.primary') as HTMLButtonElement);

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

/* ===================== DEF-S2-02 — the Campaign modal ===================== */

const CAMPAIGN_ROW = {
  id: 5, name: 'Meta Jul', branch_id: 9, vertical_id: 1, pipeline_id: 4,
  branch_name: 'Vikaspuri', vertical_name: 'BCL', pipeline_name: 'Admissions',
  utm: { utm_campaign: 'meta_jul' }, cost: 5000, priority: 'med',
  distribution_config: { mode: 'on_demand', batch_size: 10 },
  duplicacy_config: { check_scope: 'this_campaign', on_duplicate: 'ignore' },
  campaign_type: 'Digital', marketing_channel: 'Meta',
  start_date: '2026-07-01', end_date: '2026-07-31',
};

describe('DEF-S2-02 — every field the Campaign modal renders is persisted', () => {
  it('all four fields render as live inputs', () => {
    render(<CampaignModal onClose={() => undefined} />);
    for (const label of ['Campaign Type', 'Marketing Channel', 'Start Date', 'End Date']) {
      expect(control(label)).not.toBeNull();
    }
  });

  it('Create SENDS campaign_type / marketing_channel / start_date / end_date', async () => {
    render(<CampaignModal onClose={() => undefined} />);
    fireEvent.change(control('Campaign Name')!, { target: { value: 'Google Aug' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Pipeline')!, { target: { value: '4' } });
    fireEvent.change(control('Campaign Type')!, { target: { value: 'Event' } });
    fireEvent.change(control('Marketing Channel')!, { target: { value: 'Google' } });
    fireEvent.change(control('Start Date')!, { target: { value: '2026-08-01' } });
    fireEvent.change(control('End Date')!, { target: { value: '2026-08-31' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/campaigns');
    expect(post.mock.calls[0][1]).toMatchObject({
      campaign_type: 'Event', marketing_channel: 'Google',
      start_date: '2026-08-01', end_date: '2026-08-31',
    });
  });

  it('Edit PREFILLS all four from the record (the client\'s "it went blank" complaint)', () => {
    render(<CampaignModal onClose={() => undefined} initial={CAMPAIGN_ROW} />);
    expect((control('Campaign Type') as HTMLSelectElement).value).toBe('Digital');
    expect((control('Marketing Channel') as HTMLSelectElement).value).toBe('Meta');
    expect((control('Start Date') as HTMLInputElement).value).toBe('2026-07-01');
    expect((control('End Date') as HTMLInputElement).value).toBe('2026-07-31');
  });

  it('Edit SENDS the changed Start Date in the PATCH body', async () => {
    render(<CampaignModal onClose={() => undefined} initial={CAMPAIGN_ROW} />);
    fireEvent.change(control('Start Date')!, { target: { value: '2026-07-05' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/campaigns/5');
    expect(patch.mock.calls[0][1]).toMatchObject({ start_date: '2026-07-05', campaign_type: 'Digital' });
  });

  it('a campaign created before migration 024 (no dates) can still be edited and saved', async () => {
    render(<CampaignModal onClose={() => undefined}
      initial={{ ...CAMPAIGN_ROW, campaign_type: null, marketing_channel: null, start_date: null, end_date: null }} />);
    expect((control('Start Date') as HTMLInputElement).value).toBe('');
    fireEvent.change(control('Campaign Name')!, { target: { value: 'Meta Jul (renamed)' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Meta Jul (renamed)', start_date: null });
  });

  it('the "Leads per hand-out" batch size still round-trips (WS4 regression)', async () => {
    render(<CampaignModal onClose={() => undefined} initial={CAMPAIGN_ROW} />);
    const batch = screen.getByLabelText('Leads per hand-out') as HTMLInputElement;
    expect(batch.value).toBe('10');
    fireEvent.change(batch, { target: { value: '15' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect((patch.mock.calls[0][1] as any).distribution_config.batch_size).toBe(15);
  });
});

/* ===================== DEF-S2-03 — Add Lead: WhatsApp ===================== */

describe('DEF-S2-03 — Add Lead sends the WhatsApp Number', () => {
  it('the field is a live input', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    expect(telInput('WhatsApp Number')).toBeTruthy();
  });

  it('POST /leads carries whatsapp_phone', async () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Zed Wa' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000001' } });
    fireEvent.change(telInput('WhatsApp Number'), { target: { value: '9810000002' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/leads');
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(String(body.whatsapp_phone)).toContain('9810000002');
  });
});

/* ============ the sweep: an Add-form Status of "Inactive" sticks ========== */

describe('QA-10 sweep — a Status the user picks on Add is sent to the API', () => {
  const cases: Array<[string, string, Record<string, string>, string]> = [
    ['admin.branches', '/branches', { 'Branch Name': 'Pune', 'Branch Code': 'PUN' }, 'is_active'],
    ['leads.sources', '/sources', { 'Source Name': 'Meta Ads' }, 'is_active'],
    ['students.courses', '/masters/course', { 'Course Name': 'IELTS', 'Course Code': 'IEL' }, 'is_active'],
  ];

  it.each(cases)('%s posts is_active=false when Status = Inactive', async (formKey, path, vals) => {
    render(<AddModal formKey={formKey} onClose={() => undefined} />);
    for (const [label, value] of Object.entries(vals)) {
      fireEvent.change(control(label)!, { target: { value } });
    }
    if (formKey === 'leads.sources') fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Status')!, { target: { value: 'Inactive' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe(path);
    expect((post.mock.calls[0][1] as any).is_active).toBe(false);
  });

  it('Add Vertical sends head_user_id + description (DEF-S2-04, client half)', async () => {
    render(<AddModal formKey="admin.verticals" onClose={() => undefined} />);
    fireEvent.change(control('Vertical Name')!, { target: { value: 'Bootcamp' } });
    fireEvent.change(control('Vertical Code')!, { target: { value: 'BCL' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical Head')!, { target: { value: '3' } });
    fireEvent.change(control('Description')!, { target: { value: 'Bootcamp Learning' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ head_user_id: 3, description: 'Bootcamp Learning' });
  });

  it('the Add User Status options match what the backend stores (no phantom "Suspended")', () => {
    const status = SPEC_FORMS['admin.users'].fields.find((f) => f.label === 'Status')!;
    expect(status.opts).toEqual(['Active', 'Deactivated']);
  });
});

/* ============ SPRINT 3 — the new forms join the matrix (qa/09 rule) ============ */

/**
 * The rule from docs/qa/09: EVERY new form must pass "Add with all fields -> the API
 * receives them". A field that renders but never persists is a client-visible bug, and
 * this class has already reached the client twice. So both Sprint-3 forms are pinned here.
 */

describe('QA-10 (Sprint 3) — Add Walk-in: every field it renders is SENT', () => {
  it('renders the full hierarchy path (a walk-in becomes a lead, so it needs one)', () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    for (const label of ['Name', 'Mobile Number', 'Branch', 'Vertical', 'Pipeline', 'Campaign',
      'Lead Source', 'Counsellor Assigned', 'Purpose of Visit']) {
      expect(control(label)).not.toBeNull();
    }
  });

  it('POST /walk-ins carries the visitor, the path AND the counsellor (assign on add)', async () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Priya Sharma' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000011' } });
    fireEvent.change(telInput('WhatsApp Number'), { target: { value: '9810000012' } });
    fireEvent.change(control('Email ID')!, { target: { value: 'priya@x.com' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Pipeline')!, { target: { value: '4' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    fireEvent.change(control('Purpose of Visit')!, { target: { value: 'Admission enquiry' } });
    fireEvent.change(control('Counsellor Assigned')!, { target: { value: '3' } });
    fireEvent.change(control('Remarks')!, { target: { value: 'Wants weekend batch' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/walk-ins');
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      visitor_name: 'Priya Sharma', email: 'priya@x.com',
      branch_id: 9, vertical_id: 1, campaign_id: 5, source_id: 7,
      counsellor_id: 3,                              // ASSIGN ON ADD
      purpose: 'Admission enquiry', remarks: 'Wants weekend batch',
    });
    expect(String(body.phone)).toContain('9810000011');
    expect(String(body.whatsapp_phone)).toContain('9810000012');
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
    await new Promise((r) => setTimeout(r, 0));
    expect(post).not.toHaveBeenCalled();
  });
});

describe('QA-10 (Sprint 3) — Add Referral: every field it renders is SENT', () => {
  it('renders the referrer, the referred person and the full path', () => {
    render(<AddModal formKey="dash.referrals" onClose={() => undefined} />);
    for (const label of ['Referrer Type', 'Referrer Name', 'Referred Person Name',
      'Referred Person Contact Number', 'Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source']) {
      expect(control(label)).not.toBeNull();
    }
  });

  it('POST /referrals carries the referrer AND the referred person', async () => {
    render(<AddModal formKey="dash.referrals" onClose={() => undefined} />);
    fireEvent.change(control('Referrer Type')!, { target: { value: 'Existing Student' } });
    fireEvent.change(control('Referrer Name')!, { target: { value: 'Asha Rao' } });
    fireEvent.change(telInput('Referrer Contact Number'), { target: { value: '9810000001' } });
    fireEvent.change(control('Referred Person Name')!, { target: { value: 'Ravi Kumar' } });
    fireEvent.change(telInput('Referred Person Contact Number'), { target: { value: '9810000022' } });
    fireEvent.change(control('Relationship to Referrer')!, { target: { value: 'Cousin' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    fireEvent.change(control('Pipeline')!, { target: { value: '4' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    fireEvent.change(control('Incentive / Reward Applicable')!, { target: { value: '10% off' } });
    fireEvent.change(control('Referral Status')!, { target: { value: 'Pending' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/referrals');
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      referrer_type: 'Existing Student', referrer_name: 'Asha Rao',
      referred_name: 'Ravi Kumar', relationship: 'Cousin',
      branch_id: 9, vertical_id: 1, campaign_id: 5, source_id: 7,
      incentive: '10% off', status: 'pending',
    });
    expect(String(body.referred_phone)).toContain('9810000022');
    expect(String(body.referrer_phone)).toContain('9810000001');
  });

  it('the Campaign is MANDATORY (the referred person becomes a lead, and leads carry the path)', async () => {
    render(<AddModal formKey="dash.referrals" onClose={() => undefined} />);
    fireEvent.change(control('Referrer Type')!, { target: { value: 'Parent' } });
    fireEvent.change(control('Referrer Name')!, { target: { value: 'X' } });
    fireEvent.change(control('Referred Person Name')!, { target: { value: 'Y' } });
    fireEvent.change(telInput('Referred Person Contact Number'), { target: { value: '9810000033' } });
    fireEvent.change(control('Branch')!, { target: { value: '9' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    save();
    await new Promise((r) => setTimeout(r, 0));
    expect(post).not.toHaveBeenCalled();
  });
});


/* ============ SPRINT 4 — the new forms join the matrix (qa/09 rule) ============ */

/**
 * Sprint 4 adds three forms. The rule from docs/qa/09 applies to every one of them:
 * "Add with all fields -> the API receives them" and "Edit -> prefilled -> save -> the
 * change is in the PATCH". A field that renders but never persists has reached this
 * client TWICE. It does not happen a third time.
 *
 * (The screens themselves — send log, journey run history, Settings — are rendered and
 * asserted in `sprint4.test.tsx`; this file pins the FORM CONTRACT.)
 */

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

describe('QA-10 (Sprint 4) — Add Lead: the new Date of Birth field is SENT', () => {
  it('renders as a live date input', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    const dob = control('Date of Birth') as HTMLInputElement;
    expect(dob).not.toBeNull();
    expect(dob.type).toBe('date');
  });

  it('POST /leads carries dob — the `birthday` journey has nothing to fire on otherwise', async () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(control('Name')!, { target: { value: 'Birthday Lead' } });
    fireEvent.change(telInput('Mobile Number'), { target: { value: '9810000044' } });
    fireEvent.change(control('Date of Birth')!, { target: { value: '2001-03-14' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Lead Source')!, { target: { value: '7' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/leads');
    expect(post.mock.calls[0][1]).toMatchObject({ dob: '2001-03-14' });
  });
});

describe('QA-10 (Sprint 4) — Message Template: renders -> sends -> prefills -> re-sends', () => {
  it('Add SENDS every WhatsApp field the form shows', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(control('Template Name')!, { target: { value: 'Welcome' } });
    fireEvent.change(control('Meta template name')!, { target: { value: 'lead_welcome' } });
    fireEvent.change(control('Body parameters')!, { target: { value: '{{lead.name}}' } });
    fireEvent.change(control('Message Body')!, { target: { value: 'Hi {{lead.name}}' } });
    fireEvent.change(control('Vertical')!, { target: { value: '1' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/templates', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/templates')![1] as Record<string, unknown>;
    expect(body).toMatchObject({
      channel: 'whatsapp', name: 'Welcome', wa_template_name: 'lead_welcome',
      body: 'Hi {{lead.name}}', vertical_id: 1,
    });
    expect(body.wa_params).toEqual(['{{lead.name}}']);
  });

  it('Edit PREFILLS every field, and the PATCH carries the change', async () => {
    render(<TemplateModal initial={TPL as never} onClose={() => undefined} onSaved={() => undefined} />);
    expect((control('Template Name') as HTMLInputElement).value).toBe('Welcome');
    expect((control('Meta template name') as HTMLInputElement).value).toBe('lead_welcome');
    expect((control('Message Body') as HTMLTextAreaElement).value).toBe('Hi {{lead.name}}');
    expect((control('Vertical') as HTMLSelectElement).value).toBe('1');

    fireEvent.change(control('Template Name')!, { target: { value: 'Welcome (v2)' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/templates/50');
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Welcome (v2)', wa_template_name: 'lead_welcome' });
  });
});

describe('QA-10 (Sprint 4) — Journey builder: trigger + conditions + actions all persist', () => {
  it('Add SENDS the trigger, the conditions and the ordered actions', async () => {
    render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(control('Trigger')).not.toBeNull());
    fireEvent.change(control('Journey Name')!, { target: { value: 'Welcome Meta leads' } });
    fireEvent.change(control('Campaign')!, { target: { value: '5' } });
    fireEvent.change(control('Status')!, { target: { value: 'active' } });
    await waitFor(() => expect(control('Template')).not.toBeNull());
    fireEvent.change(control('Template')!, { target: { value: '50' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/journeys', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/journeys')![1] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Welcome Meta leads', trigger_type: 'lead_created', status: 'active',
      conditions: { campaign_ids: [5] },
    });
    expect(body.actions).toEqual([{ kind: 'send_message', template_id: 50 }]);
  });

  it('Edit PREFILLS the trigger, the condition and the action step', async () => {
    render(<JourneyModal initial={JNY as never} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(control('Trigger')).not.toBeNull());
    expect((control('Journey Name') as HTMLInputElement).value).toBe('Welcome new leads');
    expect((control('Trigger') as HTMLSelectElement).value).toBe('lead_created');
    expect((control('Status') as HTMLSelectElement).value).toBe('active');
    expect((control('Campaign') as HTMLSelectElement).value).toBe('5');
    expect((control('Step 1') as HTMLSelectElement).value).toBe('send_message');

    fireEvent.change(control('Journey Name')!, { target: { value: 'Welcome (renamed)' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/journeys/7');
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Welcome (renamed)' });
  });
});
