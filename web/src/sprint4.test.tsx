/**
 * SPRINT-4 web harness — every new screen rendered in jsdom, and every new FORM put
 * through the qa/09 rule: the control the user sees must exist, be prefilled on Edit, and
 * SEND what it renders. (A field that renders but never persists has reached this client
 * twice; it must not happen a third time.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  BulkSms, BulkWhatsApp, EmailCampaigns, JourneyModal, Journeys, Settings, TemplateModal, Templates,
} from './sprint4';

/** this harness has no jest-dom — assert on the DOM directly */
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ');

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 7, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 7 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }],
  courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

/* ------------------------------- API double ------------------------------- */

const TEMPLATE = {
  id: 50, channel: 'whatsapp', name: 'Welcome — new lead', code: 'welcome_wa',
  vertical_id: 7, vertical_name: 'BCL', subject: null,
  body: 'Hi {{lead.name}}, about {{course}}',
  wa_template_name: 'lead_welcome', wa_language: 'en', wa_params: ['{{lead.name}}', '{{course}}'],
  sms_sender_id: null, sms_dlt_template_id: null,
  variables: ['lead.name', 'course'], is_active: true, used_count: 4,
};
const EMAIL_TEMPLATE = {
  ...TEMPLATE, id: 51, channel: 'email', name: 'Brochure', code: 'brochure',
  subject: 'Your {{course}} details', body: '<p>Hi {{lead.name}}</p>',
  wa_template_name: null, wa_params: [],
};
const JOURNEY = {
  id: 1, name: 'Welcome new leads', description: 'Greet + task',
  trigger_type: 'lead_created', trigger_config: {},
  conditions: { campaign_ids: [5], bands: ['hot'] },
  actions: [
    { kind: 'send_message', template_id: 50 },
    { kind: 'create_task', title: 'Call the new lead', due_in_days: 2, assign_to: 'owner' },
  ],
  status: 'active', branch_id: null, vertical_id: null, runs: 3, failures: 0,
};
const MESSAGES = [
  {
    id: 1, channel: 'whatsapp', provider: 'meta_cloud', status: 'sent', to_addr: '+919810000001',
    subject: null, body: 'Hi Priya', error: null, not_configured: false, attempts: 1,
    created_at: '2026-07-14T10:00:00Z', sent_at: '2026-07-14T10:00:01Z',
    lead_id: 1, lead_name: 'Priya Sharma', template_name: 'Welcome — new lead',
    journey_name: 'Welcome new leads', user_name: null, vertical_name: 'BCL',
  },
  {
    id: 2, channel: 'whatsapp', provider: null, status: 'failed', to_addr: '+919810000002',
    subject: null, body: 'x', error: 'WhatsApp is not configured — add it in Settings',
    not_configured: true, attempts: 0, created_at: '2026-07-14T09:00:00Z', sent_at: null,
    lead_id: 2, lead_name: 'Ravi Kumar', template_name: null, journey_name: null,
    user_name: null, vertical_name: null,
  },
];
const CATALOG = {
  variables: [{ key: 'lead.name', label: 'Lead name' }, { key: 'course', label: 'Course' }],
  channels: ['whatsapp', 'sms', 'email'], sample: {},
};
const TRIGGERS = [
  { key: 'lead_created', label: 'New lead', blurb: 'Any channel', config: [] },
  { key: 'stage_changed', label: 'Stage change', blurb: 'Picked stages', config: ['stage_ids'] },
  { key: 'no_response', label: 'No response for N days', blurb: 'Swept', config: ['days'] },
  { key: 'fee_due', label: 'Fee due', blurb: '', config: ['days_before'] },
  { key: 'birthday', label: 'Birthday', blurb: '', config: ['days_before'] },
];
const SETTINGS = {
  groups: [
    { key: 'channels', label: 'Channels & credentials', blurb: 'creds', editor: 'channels' },
    {
      key: 'journey_guardrails', label: 'Automation guardrails', blurb: 'limits',
      fields: [
        { key: 'respect_business_hours', label: 'Respect business hours', type: 'bool' },
        { key: 'max_sends_per_lead_per_day', label: 'Max automated messages per lead per day', type: 'number' },
      ],
    },
    { key: 'business_hours', label: 'Business hours', blurb: 'hours', editor: 'business_hours' },
    { key: 'notification_matrix', label: 'Notification matrix', blurb: 'matrix', editor: 'matrix' },
    { key: 'numbering_series', label: 'Numbering series', blurb: 'numbers', editor: 'numbering' },
    // Sprint 5 — the approval policy card
    { key: 'enrolment_approvals', label: 'Enrolment approvals', blurb: 'optional approval per step', editor: 'approvals' },
    {
      key: 'lead_score_config', label: 'Lead score bands', blurb: 'bands', readonly: true,
      managedOn: 'Marketing & Lead Management › Lead Scoring',
      fields: [{ key: 'hot', label: 'Hot at score ≥', type: 'number' }],
    },
  ],
  values: {
    journey_guardrails: { respect_business_hours: true, max_sends_per_lead_per_day: 3 },
    business_hours: {
      enabled: true, timezone: 'Asia/Kolkata',
      days: {
        mon: ['09:00', '19:00'], tue: ['09:00', '19:00'], wed: ['09:00', '19:00'],
        thu: ['09:00', '19:00'], fri: ['09:00', '19:00'], sat: ['09:00', '19:00'], sun: [],
      },
    },
    notification_matrix: { escalation: { in_app: true, email: true, sms: false, whatsapp: false } },
    // Sprint 5: `numbering_series` is NO LONGER an app_setting value — migration 029
    // moved it to the `number_series` table and deleted the row. The card reads
    // /numbering (see NUMBERING below), so there is deliberately nothing here.
    numbering_series: {},
    lead_score_config: { hot: 70 },
  },
  providers: [
    {
      key: 'smtp', channel: 'email', label: 'SMTP (per vertical)', blurb: 'per-vertical email',
      perVertical: true,
      config: [
        { key: 'host', label: 'SMTP Host', type: 'text', required: true },
        { key: 'port', label: 'Port', type: 'number', required: true },
        { key: 'from_email', label: 'From address', type: 'text', required: true },
      ],
      secrets: [
        { key: 'username', label: 'SMTP username', type: 'password', required: true },
        { key: 'password', label: 'SMTP password / app password', type: 'password', required: true },
      ],
      setup: ['Create an app password', 'Paste it here'],
    },
    {
      key: 'meta_cloud', channel: 'whatsapp', label: 'WhatsApp — Meta Cloud API', blurb: 'wa',
      perVertical: false,
      config: [{ key: 'phone_number_id', label: 'Phone number ID', type: 'text', required: true }],
      secrets: [
        { key: 'access_token', label: 'Permanent access token', type: 'password', required: true },
        { key: 'verify_token', label: 'Webhook verify token', type: 'password', generated: true },
      ],
      setup: ['Get a permanent token'],
    },
    {
      key: 'razorpay', channel: 'payment', label: 'Razorpay (per vertical)', blurb: 'gateway',
      perVertical: true,
      config: [{ key: 'key_id', label: 'Key ID', type: 'text', required: true }],
      secrets: [{ key: 'key_secret', label: 'Key Secret', type: 'password', required: true }],
      setup: ['Generate a key'],
    },
  ],
  channels: [
    {
      id: 1, channel: 'email', provider: 'smtp', provider_label: 'SMTP (per vertical)',
      vertical_id: 7, vertical_name: 'BCL', config: { host: 'smtp.zoho.in', port: 587, from_email: 'bcl@techlingua.in' },
      secrets_masked: { username: '••••••user', password: '••••••pass' },
      is_active: true, status: 'connected', missing: [],
      last_test_at: null, last_test_ok: null, last_test_error: null,
    },
  ],
};

const post = vi.fn();
const patch = vi.fn().mockResolvedValue({ id: 1 });
const del = vi.fn().mockResolvedValue({ deleted: true });
const get = vi.fn();

vi.mock('./api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: (p: string) => del(p),
    put: vi.fn(),
  },
}));

/** Sprint 5 — the numbering card reads the TABLE, not app_setting. */
const NUMBERING = {
  kinds: [
    { key: 'quotation', label: 'Quotations' }, { key: 'enrolment', label: 'Enrolments' },
    { key: 'receipt', label: 'Fee receipts' }, { key: 'invoice', label: 'Invoices (Phase 3)' },
  ],
  series: [
    {
      id: 3, kind: 'quotation', label: 'Quotations', branch_id: null, vertical_id: null,
      branch_name: null, vertical_name: null, prefix: 'QT-', suffix: '', next_number: 7,
      padding: 4, reset_period: 'yearly', period_token: '2026', preview: 'QT-2026/0007',
    },
    {
      id: 4, kind: 'receipt', label: 'Fee receipts', branch_id: 9, vertical_id: null,
      branch_name: 'Vikaspuri', vertical_name: null, prefix: 'VKP/RCP-', suffix: '', next_number: 1,
      padding: 4, reset_period: 'yearly', period_token: '2026', preview: 'VKP/RCP-2026/0001',
    },
  ],
};

/** Sprint 5 — DEFAULT OFF. §5 says "optional"; the default invents no bureaucracy. */
const APPROVAL_POLICY = {
  enabled: false,
  steps: [
    { key: 'closure', label: 'Enrolment closure', enabled: true, roles: ['Branch Manager', 'Vertical Manager'] },
    { key: 'discount', label: 'Discount above threshold', enabled: false, roles: ['Branch Manager'], discount_pct_over: 10 },
  ],
};

const routeGet = (path: string) => {
  if (path.startsWith('/numbering')) return Promise.resolve(NUMBERING);
  if (path.startsWith('/enrolments/approval-policy')) return Promise.resolve(APPROVAL_POLICY);
  if (path.startsWith('/templates/catalog')) return Promise.resolve(CATALOG);
  if (path.startsWith('/templates')) return Promise.resolve([TEMPLATE, EMAIL_TEMPLATE]);
  if (path.startsWith('/journeys/triggers')) return Promise.resolve(TRIGGERS);
  if (path.startsWith('/journeys/runs')) {
    return Promise.resolve([{
      id: 1, journey_name: 'Welcome new leads', lead_name: 'Priya Sharma', trigger_key: 'created',
      status: 'done', steps: [{ kind: 'send_message', status: 'done' }], created_at: '2026-07-14T10:00:00Z',
    }]);
  }
  if (path.startsWith('/journeys')) return Promise.resolve([JOURNEY]);
  if (path.startsWith('/messages/summary')) {
    return Promise.resolve({
      counts: [],
      channels: [
        { channel: 'email', provider: 'smtp', vertical_id: 7, configured: true, missing: [] },
        { channel: 'whatsapp', provider: 'meta_cloud', vertical_id: null, configured: false, missing: ['Permanent access token'] },
      ],
    });
  }
  if (path.startsWith('/messages')) {
    const ch = new URL(`http://x${path}`).searchParams.get('channel');
    return Promise.resolve(MESSAGES.filter((m) => m.channel === ch));
  }
  if (path.startsWith('/settings')) return Promise.resolve(SETTINGS);
  return Promise.resolve([]);
};

beforeEach(() => {
  cleanup();
  post.mockReset().mockResolvedValue({ id: 99, body: 'Hi Priya Sharma, about IELTS', subject: null, wa_params: ['Priya Sharma', 'IELTS'], missing: [] });
  patch.mockClear(); del.mockClear();
  get.mockReset().mockImplementation(routeGet);
  vi.stubGlobal('confirm', () => true);
});

const fld = (label: string) => {
  const el = [...document.querySelectorAll('.fld')].find(
    (f) => f.querySelector('label')?.textContent?.trim().startsWith(label),
  );
  if (!el) throw new Error(`field "${label}" is not rendered at all`);
  return el as HTMLElement;
};
const control = (label: string) => fld(label).querySelector('input, select, textarea') as HTMLElement;
const save = () => fireEvent.click(document.querySelector('.add-modal .btn.primary') as HTMLButtonElement);

/* ======================= MESSAGE TEMPLATES (screen) ======================= */

describe('Message Templates — the screen renders', () => {
  it('lists templates with channel, vertical, variables and usage', async () => {
    render(<Templates />);
    expect(await screen.findByText('Welcome — new lead')).toBeTruthy();
    expect(screen.getAllByText('WhatsApp').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BCL').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\{\{lead\.name\}\}/).length).toBeGreaterThan(0);
  });

  it('deletes a template', async () => {
    render(<Templates />);
    await screen.findByText('Welcome — new lead');
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/templates/50'));
  });
});

/* ============ QA-10 (Sprint 4) — the TEMPLATE form persists ============== */

describe('QA-10 — Add Template: every field it renders is SENT', () => {
  it('renders the WhatsApp-specific fields (Meta template name + params)', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    for (const l of ['Channel', 'Template Name', 'Code', 'Vertical', 'Meta template name', 'Language', 'Body parameters', 'Message Body', 'Status']) {
      expect(control(l)).toBeTruthy();
    }
  });

  it('POST /templates carries EVERY WhatsApp field, including wa_params and the vertical', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(control('Template Name'), { target: { value: 'Welcome' } });
    fireEvent.change(control('Code'), { target: { value: 'welcome_wa' } });
    fireEvent.change(control('Vertical'), { target: { value: '7' } });
    fireEvent.change(control('Meta template name'), { target: { value: 'lead_welcome' } });
    fireEvent.change(control('Body parameters'), { target: { value: '{{lead.name}}, {{course}}' } });
    fireEvent.change(control('Message Body'), { target: { value: 'Hi {{lead.name}}' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/templates', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/templates')![1] as any;
    expect(body).toMatchObject({
      channel: 'whatsapp', name: 'Welcome', code: 'welcome_wa', vertical_id: 7,
      wa_template_name: 'lead_welcome', wa_language: 'en', body: 'Hi {{lead.name}}', is_active: true,
    });
    expect(body.wa_params).toEqual(['{{lead.name}}', '{{course}}']);
  });

  it('switching to EMAIL swaps in the Subject; switching to SMS swaps in the DLT fields', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    expect(() => fld('Subject')).toThrow();               // not an email yet

    fireEvent.change(control('Channel'), { target: { value: 'email' } });
    expect(control('Subject')).toBeTruthy();
    expect(() => fld('Meta template name')).toThrow();

    fireEvent.change(control('Channel'), { target: { value: 'sms' } });
    expect(control('DLT Sender ID')).toBeTruthy();
    expect(control('DLT Template ID')).toBeTruthy();      // India: legally required
    expect(() => fld('Subject')).toThrow();
  });

  it('an EMAIL template SENDS its subject', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(control('Channel'), { target: { value: 'email' } });
    fireEvent.change(control('Template Name'), { target: { value: 'Brochure' } });
    fireEvent.change(control('Subject'), { target: { value: 'Your {{course}} details' } });
    fireEvent.change(control('Message Body'), { target: { value: '<p>Hi</p>' } });
    save();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/templates', expect.anything()));
    expect(post.mock.calls.find((c) => c[0] === '/templates')![1]).toMatchObject({
      channel: 'email', subject: 'Your {{course}} details',
    });
  });

  it('an SMS template SENDS its sender id and DLT template id', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(control('Channel'), { target: { value: 'sms' } });
    fireEvent.change(control('Template Name'), { target: { value: 'Reminder' } });
    fireEvent.change(control('DLT Sender ID'), { target: { value: 'TCHLNG' } });
    fireEvent.change(control('DLT Template ID'), { target: { value: '1207161234567890' } });
    fireEvent.change(control('Message Body'), { target: { value: 'Hi {{lead.name}}' } });
    save();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/templates', expect.anything()));
    expect(post.mock.calls.find((c) => c[0] === '/templates')![1]).toMatchObject({
      sms_sender_id: 'TCHLNG', sms_dlt_template_id: '1207161234567890',
    });
  });

  it('EDIT PREFILLS every field from the record (the DEF-2 class of bug)', () => {
    render(<TemplateModal initial={TEMPLATE as never} onClose={() => undefined} onSaved={() => undefined} />);
    expect((control('Channel') as HTMLSelectElement).value).toBe('whatsapp');
    expect((control('Template Name') as HTMLInputElement).value).toBe('Welcome — new lead');
    expect((control('Code') as HTMLInputElement).value).toBe('welcome_wa');
    expect((control('Vertical') as HTMLSelectElement).value).toBe('7');
    expect((control('Meta template name') as HTMLInputElement).value).toBe('lead_welcome');
    expect((control('Body parameters') as HTMLInputElement).value).toBe('{{lead.name}}, {{course}}');
    expect((control('Message Body') as HTMLTextAreaElement).value).toBe('Hi {{lead.name}}, about {{course}}');
    expect((control('Status') as HTMLSelectElement).value).toBe('Active');
  });

  it('EDIT SENDS the changed body in the PATCH (renders -> persists)', async () => {
    render(<TemplateModal initial={TEMPLATE as never} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(control('Message Body'), { target: { value: 'Namaste {{lead.name}}' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/templates/50');
    expect(patch.mock.calls[0][1]).toMatchObject({ body: 'Namaste {{lead.name}}', wa_template_name: 'lead_welcome' });
  });

  it('an EMAIL template round-trips its subject on Edit', () => {
    render(<TemplateModal initial={EMAIL_TEMPLATE as never} onClose={() => undefined} onSaved={() => undefined} />);
    expect((control('Subject') as HTMLInputElement).value).toBe('Your {{course}} details');
  });

  it('the LIVE PREVIEW calls the server with what is on screen, and shows the rendered text', async () => {
    render(<TemplateModal initial={TEMPLATE as never} onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/templates/preview', expect.anything()));
    expect(text(await screen.findByTestId('preview-body'))).toContain('Hi Priya Sharma, about IELTS');
  });

  it('the preview WARNS about variables that will come out blank', async () => {
    post.mockResolvedValue({ subject: null, body: 'Hi Priya, about ', wa_params: [], missing: ['course'] });
    render(<TemplateModal initial={TEMPLATE as never} onClose={() => undefined} onSaved={() => undefined} />);
    const warn = await screen.findByTestId('preview-missing');
    expect(text(warn)).toContain('{{course}}');
    expect(text(warn)).toContain('These will be blank');
  });

  it('clicking a variable chip inserts it into the body', async () => {
    render(<TemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('{{lead.name}}');
    fireEvent.click(screen.getByText('{{lead.name}}'));
    expect((control('Message Body') as HTMLTextAreaElement).value).toContain('{{lead.name}}');
  });
});

/* ==================== QA-10 (Sprint 4) — the JOURNEY form ================ */

describe('Automation Journeys — the screen renders', () => {
  it('lists journeys with trigger, step count, runs and status', async () => {
    render(<Journeys />);
    // the name shows in the journey list AND again in the run history — both are correct
    await waitFor(() => expect(screen.getAllByText('Welcome new leads').length).toBeGreaterThan(0));
    expect(screen.getByText('lead created')).toBeTruthy();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });

  it('shows the RUN HISTORY (the "did it actually fire?" question)', async () => {
    render(<Journeys />);
    expect(await screen.findByText('Recent journey runs')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('created')).toBeTruthy());   // the trigger key
    expect(screen.getByText('send_message:done')).toBeTruthy();
  });

  it('PAUSE is one click, and it PATCHes the status (the client\'s kill switch)', async () => {
    render(<Journeys />);
    await waitFor(() => expect(screen.getByTitle('Pause')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Pause'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/journeys/1/status', { status: 'paused' }));
  });
});

describe('QA-10 — the Journey builder: trigger -> conditions -> actions, all persisted', () => {
  it('renders the trigger, the conditions and at least one action step', async () => {
    render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('New lead');
    for (const l of ['Journey Name', 'Trigger', 'Status', 'Campaign', 'Lead Source', 'Score band', 'Branch', 'Vertical', 'Step 1']) {
      expect(control(l)).toBeTruthy();
    }
  });

  it('POST /journeys carries the trigger, the conditions AND the ordered actions', async () => {
    render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('New lead');
    fireEvent.change(control('Journey Name'), { target: { value: 'Welcome Meta leads' } });
    fireEvent.change(control('Status'), { target: { value: 'active' } });
    fireEvent.change(control('Campaign'), { target: { value: '5' } });
    fireEvent.change(control('Score band'), { target: { value: 'hot' } });
    await screen.findByText(/Welcome — new lead/);
    fireEvent.change(control('Template'), { target: { value: '50' } });

    fireEvent.click(screen.getByText('Add step'));
    fireEvent.change(control('Step 2'), { target: { value: 'create_task' } });
    fireEvent.change(control('Task title'), { target: { value: 'Call the new lead' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/journeys', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/journeys')![1] as any;
    expect(body).toMatchObject({
      name: 'Welcome Meta leads', trigger_type: 'lead_created', status: 'active',
      conditions: { campaign_ids: [5], bands: ['hot'] },
    });
    expect(body.actions).toEqual([
      { kind: 'send_message', template_id: 50 },
      { kind: 'create_task', title: 'Call the new lead' },
    ]);
  });

  it('the NO-RESPONSE trigger reveals its "days" box, and it is sent', async () => {
    render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('New lead');
    fireEvent.change(control('Trigger'), { target: { value: 'no_response' } });
    fireEvent.change(control('No response for (days)'), { target: { value: '7' } });
    fireEvent.change(control('Journey Name'), { target: { value: 'Chase quiet leads' } });
    await screen.findByText(/Welcome — new lead/);
    fireEvent.change(control('Template'), { target: { value: '50' } });
    save();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/journeys', expect.anything()));
    expect(post.mock.calls.find((c) => c[0] === '/journeys')![1]).toMatchObject({
      trigger_type: 'no_response', trigger_config: { days: 7 },
    });
  });

  it('EDIT PREFILLS the trigger, the conditions and every action step', async () => {
    render(<JourneyModal initial={JOURNEY as never} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('New lead');
    expect((control('Journey Name') as HTMLInputElement).value).toBe('Welcome new leads');
    expect((control('Trigger') as HTMLSelectElement).value).toBe('lead_created');
    expect((control('Status') as HTMLSelectElement).value).toBe('active');
    expect((control('Campaign') as HTMLSelectElement).value).toBe('5');
    expect((control('Score band') as HTMLSelectElement).value).toBe('hot');
    expect((control('Step 1') as HTMLSelectElement).value).toBe('send_message');
    expect((control('Step 2') as HTMLSelectElement).value).toBe('create_task');
    expect((control('Task title') as HTMLInputElement).value).toBe('Call the new lead');
    expect((control('Due in (days)') as HTMLInputElement).value).toBe('2');
  });

  it('EDIT SENDS the changed actions in the PATCH', async () => {
    render(<JourneyModal initial={JOURNEY as never} onClose={() => undefined} onSaved={() => undefined} />);
    await screen.findByText('New lead');
    fireEvent.change(control('Task title'), { target: { value: 'Call within 2 hours' } });
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/journeys/1');
    expect((patch.mock.calls[0][1] as any).actions[1].title).toBe('Call within 2 hours');
  });

  it('the guardrails and the no-double-send promise are stated ON the builder', async () => {
    render(<JourneyModal onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText(/never receives the same step twice/)).toBeTruthy();
  });
});

/* ===================== THE CHANNEL SCREENS + SEND LOG ==================== */

describe('the engagement channel screens', () => {
  it('WhatsApp: renders the send log with status, template and journey', async () => {
    render(<BulkWhatsApp />);
    expect(await screen.findByText('WhatsApp send log')).toBeTruthy();
    expect(screen.getByText('+919810000001')).toBeTruthy();
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getAllByText('Welcome new leads').length).toBeGreaterThan(0);
  });

  it('a NOT-CONFIGURED channel says so in AMBER and names what is missing — no red error', async () => {
    render(<BulkWhatsApp />);
    const notice = await screen.findByTestId('not-configured');
    expect(text(notice)).toContain('WhatsApp is not configured yet');
    expect(text(notice)).toContain('Permanent access token');
    expect(text(notice)).toContain('No deploy');
    // the failed row is shown as "Not configured", not as an error
    expect(screen.getByText('Not configured')).toBeTruthy();
  });

  it('a CONFIGURED channel shows no "not configured" banner', async () => {
    render(<EmailCampaigns />);
    await screen.findByText('Email send log');
    expect(screen.queryByTestId('not-configured')).toBeNull();
  });

  it('a failed message can be RETRIED (after the client pastes the credential)', async () => {
    render(<BulkWhatsApp />);
    await screen.findByText('WhatsApp send log');
    fireEvent.click(screen.getByTitle('Retry'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/messages/2/retry', {}));
  });

  it('SMS renders its own empty log without crashing', async () => {
    render(<BulkSms />);
    expect(await screen.findByText('SMS send log')).toBeTruthy();
    expect(screen.getByText('No SMS messages sent yet.')).toBeTruthy();
  });

  it('the BLAST composer sends a template + audience to /messages/bulk', async () => {
    post.mockResolvedValue({ audience: 12, queued: 10, skipped: 2, failed: 0 });
    render(<BulkWhatsApp />);
    await screen.findByText('WhatsApp send log');
    fireEvent.click(screen.getByText(/New WhatsApp blast/));
    await screen.findByText(/Welcome — new lead/);
    fireEvent.change(control('Template'), { target: { value: '50' } });
    fireEvent.change(control('Campaign'), { target: { value: '5' } });
    fireEvent.change(control('Score band'), { target: { value: 'hot' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/messages/bulk', expect.anything()));
    expect(post.mock.calls.find((c) => c[0] === '/messages/bulk')![1]).toMatchObject({
      template_id: 50, campaign_ids: [5], temperature: 'hot',
    });
    expect(text(await screen.findByTestId('blast-result'))).toContain('10');
  });
});

/* ============================== SETTINGS ================================= */

describe('Administration › Settings', () => {
  it('renders every provider, with SMTP marked per-vertical and its status', async () => {
    render(<Settings />);
    expect(await screen.findByText('SMTP (per vertical)')).toBeTruthy();
    expect(screen.getByText('WhatsApp — Meta Cloud API')).toBeTruthy();
    expect(screen.getByText('Razorpay (per vertical)')).toBeTruthy();
    // "Connected" became FOUR distinct states. A stored-but-never-tested credential is
    // "Configured", not "Verified" — the client must never read a saved key as a proven
    // one. (See `integrationState`.)
    expect(screen.getByText(/BCL: Configured — not yet tested/)).toBeTruthy();
    expect(screen.getAllByText('Not configured').length).toBeGreaterThan(0);
  });

  it('says AT A GLANCE what is still outstanding — no opening seven cards to find the empty one', async () => {
    render(<Settings />);
    await screen.findByText('SMTP (per vertical)');
    expect(screen.getByText(/Still to set up/)).toBeTruthy();
  });

  it('states the secret policy the client keeps asking about', async () => {
    render(<Settings />);
    await screen.findByText('SMTP (per vertical)');
    expect(screen.getByText(/encrypted at rest/)).toBeTruthy();
    expect(screen.getByText(/masked on read/)).toBeTruthy();
  });

  it('the SMTP form is PER VERTICAL and PREFILLS the stored config (secrets stay masked)', async () => {
    render(<Settings />);
    await screen.findByText('SMTP (per vertical)');
    fireEvent.click(screen.getAllByText('Edit')[0]);

    expect((control('Vertical') as HTMLSelectElement).value).toBe('7');
    expect((control('SMTP Host') as HTMLInputElement).value).toBe('smtp.zoho.in');
    expect((control('Port') as HTMLInputElement).value).toBe('587');
    expect((control('From address') as HTMLInputElement).value).toBe('bcl@techlingua.in');
    // the password box is EMPTY, showing the mask as a placeholder — never the value
    const pw = control('SMTP password / app password') as HTMLInputElement;
    expect(pw.value).toBe('');
    expect(pw.type).toBe('password');
    expect(pw.placeholder).toBe('••••••pass');
    expect(screen.getAllByText(/Leave blank to keep it/).length).toBeGreaterThan(0);
  });

  it('saving SMTP posts the config + the vertical (and only the secrets that were typed)', async () => {
    render(<Settings />);
    await screen.findByText('SMTP (per vertical)');
    fireEvent.click(screen.getAllByText('Edit')[0]);
    fireEvent.change(control('SMTP Host'), { target: { value: 'smtp.newhost.in' } });
    fireEvent.change(control('SMTP password / app password'), { target: { value: 'new-app-pw' } });
    save();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/channels/save', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/settings/channels/save')![1] as any;
    expect(body).toMatchObject({ provider: 'smtp', channel: 'email', vertical_id: 7 });
    expect(body.config.host).toBe('smtp.newhost.in');
    expect(body.secrets).toEqual({ password: 'new-app-pw' });   // the untouched username is NOT re-sent
  });

  it('the WhatsApp form tells the client exactly what to fetch from Meta', async () => {
    render(<Settings />);
    await screen.findByText('WhatsApp — Meta Cloud API');
    fireEvent.click(screen.getAllByText('Configure')[0]);
    expect(screen.getByText('What you need to do')).toBeTruthy();
    expect(screen.getByText('Get a permanent token')).toBeTruthy();
    expect(control('Phone number ID')).toBeTruthy();
    expect(control('Permanent access token')).toBeTruthy();
    // the verify token is GENERATED by us — it is never an input the client fills in
    expect(() => fld('Webhook verify token')).toThrow();
  });

  it('the GUARDRAILS group renders its fields, prefilled, and saves them', async () => {
    render(<Settings />);
    await screen.findByText('Automation guardrails');
    expect((control('Respect business hours') as HTMLSelectElement).value).toBe('Yes');
    expect((control('Max automated messages per lead per day') as HTMLInputElement).value).toBe('3');

    fireEvent.change(control('Max automated messages per lead per day'), { target: { value: '5' } });
    const card = screen.getByText('Automation guardrails').closest('.card')!;
    fireEvent.click(card.querySelector('.btn.primary') as HTMLButtonElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/journey_guardrails', expect.anything()));
    expect(post.mock.calls.find((c) => c[0] === '/settings/journey_guardrails')![1])
      .toMatchObject({ max_sends_per_lead_per_day: 5 });
  });

  it('BUSINESS HOURS renders the week, with Sunday closed, and saves', async () => {
    render(<Settings />);
    await screen.findByText('Business hours');
    expect((screen.getByLabelText('Monday open') as HTMLInputElement).value).toBe('09:00');
    expect(screen.getByText('Closed')).toBeTruthy();         // Sunday — and ONLY Sunday
    expect(screen.getAllByText(/09:00 – 19:00/)).toHaveLength(6);

    fireEvent.change(screen.getByLabelText('Monday close'), { target: { value: '20:00' } });
    const card = screen.getByText('Business hours').closest('.card')!;
    fireEvent.click(card.querySelector('.btn.primary') as HTMLButtonElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/business_hours', expect.anything()));
    expect((post.mock.calls.find((c) => c[0] === '/settings/business_hours')![1] as any).days.mon)
      .toEqual(['09:00', '20:00']);
  });

  it('the NOTIFICATION MATRIX renders, in-app is locked ON, and a change saves', async () => {
    render(<Settings />);
    await screen.findByText('Notification matrix');
    const inApp = screen.getByLabelText('Overdue escalation on in_app') as HTMLInputElement;
    expect(inApp.checked).toBe(true);
    expect(inApp.disabled).toBe(true);                        // the bell is the system of record

    const sms = screen.getByLabelText('Overdue escalation on sms') as HTMLInputElement;
    expect(sms.checked).toBe(false);
    fireEvent.click(sms);
    const card = screen.getByText('Notification matrix').closest('.card')!;
    fireEvent.click(card.querySelector('.btn.primary') as HTMLButtonElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/notification_matrix', expect.anything()));
    expect((post.mock.calls.find((c) => c[0] === '/settings/notification_matrix')![1] as any).escalation.sms).toBe(true);
  });

  it('the SCORE BANDS group is READ-ONLY here and points at the screen that owns it', async () => {
    render(<Settings />);
    await screen.findByText('Lead score bands');
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText(/Marketing & Lead Management › Lead Scoring/)).toBeTruthy();
    expect((control('Hot at score ≥') as HTMLInputElement).disabled).toBe(true);
  });

  /**
   * SPRINT 5 CHANGED THIS DELIBERATELY.
   *
   * Numbering used to be a JSON textarea over `app_setting.numbering_series`. Sprint 5 is
   * the first thing that ALLOCATES from it, and allocation needs atomicity and a row per
   * branch / vertical — so the truth moved to the `number_series` TABLE and this card
   * became a real editor reading `/numbering`. Migration 029 carries the old JSON across
   * and DELETES the app_setting row, because two places to edit one number is how you get
   * two different numbers.
   *
   * The old assertion (a textarea holding 'LD-') is therefore GONE ON PURPOSE, and these
   * replace it. See docs/dev/07-sprint5-implementation.md.
   */
  it('NUMBERING SERIES is a real editor over the number_series table, not a JSON blob', async () => {
    render(<Settings />);
    await screen.findByText('Numbering series');
    // no raw-JSON escape hatch survives
    expect(screen.queryByLabelText('numbering_series')).toBeNull();
    // it reads the TABLE, not app_setting
    expect(get).toHaveBeenCalledWith('/numbering');
    expect(await screen.findByText('Quotations')).toBeTruthy();
    expect(screen.getByText('QT-2026/0007')).toBeTruthy();
    expect(screen.getByText('Org-wide (fallback)')).toBeTruthy();
  });

  it('NUMBERING SERIES saves to /numbering — and never to /settings/numbering_series', async () => {
    render(<Settings />);
    await screen.findByText('Numbering series');
    // two series in the fixture (the org-wide quotation one and a branch receipt
    // override) — edit the first, which is the org-wide fallback.
    fireEvent.click((await screen.findAllByTitle('Edit'))[0]);
    const prefix = await screen.findByLabelText('Prefix');
    fireEvent.change(prefix, { target: { value: 'QUO-' } });
    fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLButtonElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/numbering', expect.objectContaining({ prefix: 'QUO-' })));
    expect(post).not.toHaveBeenCalledWith('/settings/numbering_series', expect.anything());
  });

  it('ENROLMENT APPROVALS is OFF by default, and turning it on is one settings write', async () => {
    render(<Settings />);
    await screen.findByText('Enrolment approvals');
    const sel = screen.getByLabelText('Approvals') as HTMLSelectElement;
    expect(sel.value).toBe('off');                       // §5 says optional; the default invents no bureaucracy
    fireEvent.change(sel, { target: { value: 'on' } });
    const card = screen.getByText('Enrolment approvals').closest('.card')!;
    fireEvent.click(card.querySelector('.btn.primary') as HTMLButtonElement);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/enrolments/approval-policy',
      expect.objectContaining({ enabled: true })));
  });
});
