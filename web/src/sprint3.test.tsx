/**
 * Sprint-3 SCREENS, rendered in jsdom.
 *
 * The DEF-2 lesson (docs/qa/09): an API test cannot see a broken screen. So every new
 * screen is rendered here as a user sees it, and the assertions are about what the user
 * gets and what Save actually SENDS — not about what the component "should" do.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { ScreenCtx } from './dyn';
import { Calendar, Referrals, Scoring, Sla, WalkIns, dur } from './sprint3';
import { NotificationBell } from './notifications';

/* ------------------------------- harness ------------------------------- */

const perms = { value: new Set<string>() };
vi.mock('./auth', () => ({
  useAuth: () => ({
    can: (k: string) => perms.value.has(k),
    me: { user: { id: 1, name: 'Super Admin' } },
  }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }],
  courses: [{ id: 21, name: 'IELTS' }], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  trainings: [], visitPurposes: [], walkinStatuses: [{ id: 75, name: 'Waiting', code: 'waiting' }, { id: 76, name: 'Converted', code: 'converted' }],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }], states: [], cities: [],
  loaded: true, reload: () => undefined,
};
const toastSpy = vi.fn();
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: (...a: unknown[]) => toastSpy(...a) };
});

/** The API double: a route table the tests can override per case. */
let ROUTES: Record<string, unknown> = {};
const get = vi.fn(async (p: string) => {
  const key = Object.keys(ROUTES).find((k) => p.startsWith(k));
  if (key === undefined) return [];
  return ROUTES[key];
});
const post = vi.fn().mockResolvedValue({ id: 1, marked: 0 });
const patch = vi.fn().mockResolvedValue({ id: 1, rescored: 3 });
const del = vi.fn().mockResolvedValue({ id: 1 });
vi.mock('./api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: (p: string) => del(p),
    put: vi.fn(),
  },
}));

const CTX = {
  go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn(),
};
const draw = (node: JSX.Element) =>
  render(<ScreenCtx.Provider value={CTX}>{node}</ScreenCtx.Provider>);

const modal = () => document.querySelector('.add-modal') as HTMLElement;
const fld = (label: string, root: HTMLElement = document.body) => {
  const el = [...root.querySelectorAll('.fld')].find(
    (f) => f.querySelector('label')?.textContent?.trim().startsWith(label),
  );
  if (!el) throw new Error(`field "${label}" is not rendered at all`);
  return el.querySelector('input, select, textarea') as HTMLElement;
};
const primary = () => fireEvent.click(document.querySelector('.add-modal .btn.primary') as HTMLButtonElement);

beforeEach(() => {
  cleanup();
  perms.value = new Set(['score.manage', 'score.read', 'sla.manage', 'sla.read',
    'calendar.read', 'calendar.create', 'calendar.update',
    'walkin.read', 'walkin.create', 'walkin.update', 'referral.read', 'referral.create',
    'referral.update', 'lead.read']);
  ROUTES = {};
  get.mockClear(); post.mockClear(); patch.mockClear(); del.mockClear(); toastSpy.mockClear();
  CTX.openLead.mockClear(); CTX.openAdd.mockClear();
});
afterEach(cleanup);

/* ======================= LEAD SCORING (admin-configurable) ======================= */

const RULES = [
  { id: 1, name: 'Walk-in visitor', rule_type: 'walk_in', config: {}, points: 25, sort_order: 10, is_active: true },
  { id: 2, name: 'No response for 7 days', rule_type: 'no_response_days', config: { days: 7 }, points: -15, sort_order: 20, is_active: true },
];
const RULE_TYPES = [
  { type: 'walk_in', label: 'Walk-in visitor', hint: 'Captured at the branch desk', fields: [] },
  { type: 'source_channel', label: 'Source channel', hint: 'e.g. Meta / Google', fields: ['channels'] },
  { type: 'no_response_days', label: 'No response for N days', hint: 'Use NEGATIVE points', fields: ['days'] },
];
const SCORE_SUMMARY = {
  hot: 4, warm: 9, cold: 2, unscored: 0, total: 15, avg_score: 47,
  config: { bands: { hot: 70, warm: 40 }, min: 0, max: 100 },
};

const scoringRoutes = () => {
  ROUTES = {
    '/scoring/summary': SCORE_SUMMARY,
    '/scoring/rules': RULES,
    '/scoring/rule-types': RULE_TYPES,
  };
};

describe('Lead Scoring — the rules are DATA the admin edits', () => {
  it('renders the band KPIs and every configured rule', async () => {
    scoringRoutes();
    draw(<Scoring />);
    expect(await screen.findByText('Walk-in visitor')).toBeTruthy();
    expect(screen.getByText('No response for 7 days')).toBeTruthy();
    expect(screen.getByText('+25')).toBeTruthy();
    expect(screen.getByText('-15')).toBeTruthy();          // penalties render as negative
    expect(screen.getByText('47')).toBeTruthy();           // average score KPI
  });

  it('the band legend uses the CONFIGURED thresholds, not hard-coded ones', async () => {
    scoringRoutes();
    draw(<Scoring />);
    expect(await screen.findByText('Hot (70–100)')).toBeTruthy();
    expect(screen.getByText('Warm (40–69)')).toBeTruthy();
    expect(screen.getByText('Cold (0–39)')).toBeTruthy();
  });

  it('ADD RULE: the config inputs are GENERATED from the rule type, and Save sends them', async () => {
    scoringRoutes();
    draw(<Scoring />);
    fireEvent.click(await screen.findByText('+ Add rule'));

    // the default type (source_channel) declares ONE config field -> name, type, points, channels, status
    expect(modal().querySelectorAll('.fld').length).toBe(5);
    expect(fld('channels')).toBeTruthy();
    // a type with NO config fields shrinks the form back — the inputs are GENERATED, not hard-coded
    fireEvent.change(fld('Rule Type'), { target: { value: 'walk_in' } });
    expect(modal().querySelectorAll('.fld').length).toBe(4);
    // ...and a type with a different config field grows it again
    fireEvent.change(fld('Rule Type'), { target: { value: 'no_response_days' } });
    expect(fld('days')).toBeTruthy();
    fireEvent.change(fld('Rule Type'), { target: { value: 'source_channel' } });

    fireEvent.change(fld('Rule Name'), { target: { value: 'Paid social (Meta)' } });
    fireEvent.change(fld('Points'), { target: { value: '10' } });
    fireEvent.change(fld('channels'), { target: { value: 'meta, google' } });
    primary();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/scoring/rules');
    expect(post.mock.calls[0][1]).toMatchObject({
      name: 'Paid social (Meta)', rule_type: 'source_channel', points: 10,
      config: { channels: ['meta', 'google'] },     // the comma list became a real array
      is_active: true,
    });
  });

  it('EDIT RULE: prefilled from the record, and Save PATCHes the change (the qa/09 matrix)', async () => {
    scoringRoutes();
    draw(<Scoring />);
    await screen.findByText('No response for 7 days');
    // the pencil on the second row
    const pencils = document.querySelectorAll('.ract[title="Edit"]');
    fireEvent.click(pencils[1] as HTMLElement);

    expect((fld('Rule Name') as HTMLInputElement).value).toBe('No response for 7 days');
    expect((fld('Rule Type') as HTMLSelectElement).value).toBe('no_response_days');
    expect((fld('Points') as HTMLInputElement).value).toBe('-15');
    expect((fld('days') as HTMLInputElement).value).toBe('7');   // the CONFIG is prefilled too

    fireEvent.change(fld('days'), { target: { value: '10' } });
    fireEvent.change(fld('Points'), { target: { value: '-20' } });
    primary();

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/scoring/rules/2');
    expect(patch.mock.calls[0][1]).toMatchObject({ points: -20, config: { days: 10 } });
  });

  it('BAND THRESHOLDS are editable and saving re-bands every lead', async () => {
    scoringRoutes();
    draw(<Scoring />);
    fireEvent.click(await screen.findByText('Band thresholds'));
    expect((fld('Hot at or above') as HTMLInputElement).value).toBe('70');
    fireEvent.change(fld('Hot at or above'), { target: { value: '60' } });
    primary();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/scoring/config');
    expect(patch.mock.calls[0][1]).toMatchObject({ hot: 60, warm: 40 });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/3 leads re-banded/)));
  });

  it('RBAC — without score.manage the rules are READ-ONLY (no add, no edit, no delete)', async () => {
    perms.value = new Set(['score.read']);
    scoringRoutes();
    draw(<Scoring />);
    await screen.findByText('Walk-in visitor');
    expect(screen.queryByText('+ Add rule')).toBeNull();
    expect(screen.queryByText('Band thresholds')).toBeNull();
    expect(document.querySelectorAll('.ract[title="Edit"]').length).toBe(0);
    expect(document.querySelectorAll('.ract[title="Delete"]').length).toBe(0);
  });
});

/* ============================== SLA & TAT ============================== */

const SLA_SUMMARY = {
  kpis: { open_breaches: 2, breaches_today: 1, escalated_today: 1, responded: 8, avg_response_seconds: 5400, met_on_time: 6 },
  tat: [{ stage_name: 'New', moves: 12, avg_seconds: 7200 }],
};
const BREACHES = [{
  id: 1, lead_id: 100, metric: 'first_response', policy_name: 'First response within 60 minutes',
  threshold_minutes: 60, overdue_seconds: 5400, lead_name: 'Asha Rao', owner_name: 'Ravi',
  temperature: 'hot', score: 82, stage_name: 'New',
}];
const POLICIES = [{
  id: 1, name: 'First response within 60 minutes', metric: 'first_response',
  pipeline_id: null, stage_id: null, threshold_minutes: 60, escalate_after_minutes: 0,
  notify_manager: true, is_active: true,
}];

const slaRoutes = () => {
  ROUTES = { '/sla/summary': SLA_SUMMARY, '/sla/breaches': BREACHES, '/sla/policies': POLICIES, '/pipelines/': [] };
};

describe('SLA & TAT', () => {
  it('renders the breach manager view, the TAT-by-stage table and the policies', async () => {
    slaRoutes();
    draw(<Sla />);
    expect(await screen.findByText('SLA breaches — manager view')).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getAllByText('1h 30m').length).toBeGreaterThanOrEqual(1);  // duration formatting
    expect(screen.getByText('Turnaround time (TAT) by stage')).toBeTruthy();
    expect(screen.getByText('2h 0m')).toBeTruthy();       // avg time in stage
    // the policy name shows in BOTH the breach row and the policy table
    expect(screen.getAllByText('First response within 60 minutes').length).toBe(2);
  });

  it('clicking a breach opens the lead', async () => {
    slaRoutes();
    draw(<Sla />);
    fireEvent.click(await screen.findByText('Asha Rao'));
    expect(CTX.openLead).toHaveBeenCalledWith(100);
  });

  it('ADD POLICY: a stage-duration policy without a stage is refused before it hits the API', async () => {
    slaRoutes();
    draw(<Sla />);
    fireEvent.click(await screen.findByText('+ Add policy'));
    fireEvent.change(fld('Policy Name'), { target: { value: 'No lead sits in Negotiation > 3d' } });
    fireEvent.change(fld('Metric'), { target: { value: 'stage_duration' } });
    primary();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/must name a stage/), true));
    expect(post).not.toHaveBeenCalled();
  });

  it('ADD POLICY: a first-response policy saves with its target and escalation delay', async () => {
    slaRoutes();
    draw(<Sla />);
    fireEvent.click(await screen.findByText('+ Add policy'));
    fireEvent.change(fld('Policy Name'), { target: { value: 'Respond in 15 minutes' } });
    fireEvent.change(fld('Target (minutes)'), { target: { value: '15' } });
    fireEvent.change(fld('Escalate after breach (minutes)'), { target: { value: '30' } });
    primary();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/sla/policies');
    expect(post.mock.calls[0][1]).toMatchObject({
      name: 'Respond in 15 minutes', metric: 'first_response',
      threshold_minutes: 15, escalate_after_minutes: 30, notify_manager: true,
    });
  });

  it('EDIT POLICY prefills every field and PATCHes the change', async () => {
    slaRoutes();
    draw(<Sla />);
    await screen.findByText('SLA policies');
    await waitFor(() => expect(document.querySelector('.ract[title="Edit"]')).not.toBeNull());
    fireEvent.click(document.querySelector('.ract[title="Edit"]') as HTMLElement);
    expect((fld('Policy Name') as HTMLInputElement).value).toBe('First response within 60 minutes');
    expect((fld('Target (minutes)') as HTMLInputElement).value).toBe('60');
    expect((fld('Notify manager on breach') as HTMLSelectElement).value).toBe('Yes');
    fireEvent.change(fld('Target (minutes)'), { target: { value: '30' } });
    primary();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][0]).toBe('/sla/policies/1');
    expect(patch.mock.calls[0][1]).toMatchObject({ threshold_minutes: 30 });
  });

  it('RBAC — without sla.manage the policies are read-only, but the BREACHES are still visible', async () => {
    perms.value = new Set(['sla.read', 'lead.read']);
    slaRoutes();
    draw(<Sla />);
    expect(await screen.findByText('Asha Rao')).toBeTruthy();     // a counsellor still sees their breaches
    expect(screen.queryByText('+ Add policy')).toBeNull();
    expect(document.querySelectorAll('.ract[title="Edit"]').length).toBe(0);
  });

  it('an empty state is honest — no fake breaches', async () => {
    ROUTES = { '/sla/summary': { kpis: {}, tat: [] }, '/sla/breaches': [], '/sla/policies': [] };
    draw(<Sla />);
    expect(await screen.findByText('No SLA breaches — every lead is being answered inside its target')).toBeTruthy();
  });
});

describe('dur() — the language a TAT report speaks', () => {
  it.each([[0, '—'], [90, '1m'], [5400, '1h 30m'], [180000, '2d 2h']])('%i -> %s', (sec, out) => {
    expect(dur(sec as number)).toBe(out);
  });
});

/* ============================== CALENDAR ============================== */

const CAL_NOT_CONFIGURED = {
  range: { from: '2026-07-01', to: '2026-07-31' },
  events: [{ id: 1, title: 'IELTS demo — Priya', type: 'demo', starts_at: '2026-07-20T10:00:00.000Z', lead_id: 100 }],
  follow_ups: [{
    id: 5, lead_id: 100, lead_name: 'Asha Rao', scheduled_at: '2026-07-18T05:00:00.000Z',
    status: 'pending', type_name: 'Call', overdue: true, owner_name: 'Ravi',
  }],
  sync: {
    provider: null, configured: false,
    missing: ['Calendar provider (Google or Outlook)', 'OAuth client id + secret'],
    note: 'Google / Outlook calendar sync is built and waiting on credentials. The in-app calendar works fully without it.',
  },
};

describe('Calendar — the in-app calendar works; the SYNC degrades cleanly', () => {
  it('shows a "not configured" notice that names what is missing — and still renders the grid', async () => {
    ROUTES = { '/calendar': CAL_NOT_CONFIGURED };
    draw(<Calendar />);
    expect(await screen.findByText(/Google \/ Outlook sync — not configured/)).toBeTruthy();
    expect(screen.getByText(/Calendar provider \(Google or Outlook\), OAuth client id \+ secret/)).toBeTruthy();
    // the calendar itself is fully there
    expect(document.querySelectorAll('.cal-cell').length).toBe(42);
    expect(document.querySelectorAll('.cal-dow').length).toBe(7);
  });

  it('renders follow-ups AND events on the grid, with overdue highlighted', async () => {
    ROUTES = { '/calendar': CAL_NOT_CONFIGURED };
    draw(<Calendar />);
    await screen.findByText('This month');
    const evs = document.querySelectorAll('.cal-ev');
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelectorAll('.cal-ev.overdue').length).toBe(1);   // the pending, past follow-up
    expect(document.querySelectorAll('.cal-ev.demo').length).toBe(1);
  });

  it('"Sync now" surfaces the 503 reason verbatim instead of a crash', async () => {
    ROUTES = { '/calendar': CAL_NOT_CONFIGURED };
    post.mockRejectedValueOnce(new Error('Not configured — still needed: OAuth client id'));
    draw(<Calendar />);
    fireEvent.click(await screen.findByText('Sync now'));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Not configured — still needed: OAuth client id/), true,
    ));
  });

  it('ADD EVENT sends the title, type and times', async () => {
    ROUTES = { '/calendar': CAL_NOT_CONFIGURED };
    draw(<Calendar />);
    fireEvent.click(await screen.findByText('Add event'));
    fireEvent.change(fld('Title'), { target: { value: 'Parent meeting' } });
    fireEvent.change(fld('Type'), { target: { value: 'meeting' } });
    fireEvent.change(fld('Starts'), { target: { value: '2026-07-22T11:00' } });
    fireEvent.change(fld('Location'), { target: { value: 'Vikaspuri branch' } });
    primary();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/calendar', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/calendar')![1] as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Parent meeting', type: 'meeting', location: 'Vikaspuri branch' });
    expect(String(body.starts_at)).toContain('2026-07-22');
  });

  it('a title-less event is refused before it reaches the API', async () => {
    ROUTES = { '/calendar': CAL_NOT_CONFIGURED };
    draw(<Calendar />);
    fireEvent.click(await screen.findByText('Add event'));
    primary();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Title is required', true));
    expect(post).not.toHaveBeenCalledWith('/calendar', expect.anything());
  });

  it('a CONFIGURED provider shows no "not configured" banner', async () => {
    ROUTES = {
      '/calendar': {
        ...CAL_NOT_CONFIGURED,
        sync: { provider: 'google', configured: true, missing: [], note: 'Ready to sync.' },
      },
    };
    draw(<Calendar />);
    await screen.findByText('This month');
    expect(screen.queryByText(/not configured/i)).toBeNull();
  });
});

/* ============================== WALK-INS ============================== */

const WALKINS = [{
  id: 55, visitor_name: 'Priya Sharma', phone: '+919810000011', visited_at: '2026-07-14T10:00:00.000Z',
  purpose: 'Admission enquiry', status: 'waiting', counsellor_name: 'Asha Rao', branch_name: 'Vikaspuri',
  course_name: 'IELTS', lead_id: 100, temperature: 'warm', score: 55,
}];

describe('Walk-ins — assign on add, and it becomes a real lead', () => {
  it('renders the KPIs and today\'s walk-ins', async () => {
    ROUTES = { '/walk-ins/summary': { today: 1, converted: 0, waiting: 1, avg_wait: 12 }, '/walk-ins': WALKINS };
    draw(<WalkIns />);
    expect(await screen.findByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('12m')).toBeTruthy();               // avg wait KPI
    expect(screen.getByText(/creates a lead and assigns it/i)).toBeTruthy();
  });

  it('the status is editable inline and PATCHes', async () => {
    ROUTES = { '/walk-ins/summary': {}, '/walk-ins': WALKINS };
    draw(<WalkIns />);
    const sel = await screen.findByLabelText('Status for Priya Sharma');
    expect((sel as HTMLSelectElement).value).toBe('waiting');
    fireEvent.change(sel, { target: { value: 'converted' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/walk-ins/55', { status: 'converted' }));
  });

  it('"+ Add walk-in" opens the walk-in form (the one the qa10 matrix pins)', async () => {
    ROUTES = { '/walk-ins/summary': {}, '/walk-ins': WALKINS };
    draw(<WalkIns />);
    fireEvent.click(await screen.findByText('+ Add walk-in'));
    expect(CTX.openAdd).toHaveBeenCalledWith('dash.walkins');
  });

  it('the detail modal links through to the lead the walk-in created', async () => {
    ROUTES = { '/walk-ins/summary': {}, '/walk-ins': WALKINS };
    draw(<WalkIns />);
    await screen.findByText('Priya Sharma');
    await waitFor(() => expect(document.querySelector('.ract[title="View"]')).not.toBeNull());
    fireEvent.click(document.querySelector('.ract[title="View"]') as HTMLElement);
    fireEvent.click(await screen.findByText('Open lead #100'));
    expect(CTX.openLead).toHaveBeenCalledWith(100);
  });

  it('RBAC — without walkin.update the status select is disabled; without create there is no add link', async () => {
    perms.value = new Set(['walkin.read']);
    ROUTES = { '/walk-ins/summary': {}, '/walk-ins': WALKINS };
    draw(<WalkIns />);
    const sel = await screen.findByLabelText('Status for Priya Sharma');
    expect((sel as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByText('+ Add walk-in')).toBeNull();
  });

  it('an empty state is honest — no fake visitors', async () => {
    ROUTES = { '/walk-ins/summary': {}, '/walk-ins': [] };
    draw(<WalkIns />);
    expect(await screen.findByText(/No walk-ins recorded yet/)).toBeTruthy();
  });
});

/* ============================== REFERRALS ============================== */

const REFERRALS = [{
  id: 66, referrer_name: 'Asha Rao', referrer_type: 'Existing Student', referrer_phone: '+919810000001',
  referred_name: 'Ravi Kumar', referred_phone: '+919810000022', status: 'pending',
  incentive: '10% off', lead_id: 101, owner_name: 'Ravi', temperature: 'hot', score: 78,
  created_at: '2026-07-14T09:00:00.000Z',
}];

describe('Referrals', () => {
  it('renders the tracker with the referrer and the new lead', async () => {
    ROUTES = { '/referrals/summary': { mtd: 1, converted: 0, rewards_due: 0 }, '/referrals': REFERRALS };
    draw(<Referrals />);
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('Ravi Kumar')).toBeTruthy();
    expect(screen.getByText('10% off')).toBeTruthy();
  });

  it('clicking the referred person opens their lead', async () => {
    ROUTES = { '/referrals/summary': {}, '/referrals': REFERRALS };
    draw(<Referrals />);
    fireEvent.click(await screen.findByText('Ravi Kumar'));
    expect(CTX.openLead).toHaveBeenCalledWith(101);
  });

  it('the status is editable inline and PATCHes', async () => {
    ROUTES = { '/referrals/summary': {}, '/referrals': REFERRALS };
    draw(<Referrals />);
    fireEvent.change(await screen.findByLabelText('Status for Asha Rao'), { target: { value: 'rewarded' } });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/referrals/66', { status: 'rewarded' }));
  });

  it('RBAC — without referral.update the status is disabled', async () => {
    perms.value = new Set(['referral.read']);
    ROUTES = { '/referrals/summary': {}, '/referrals': REFERRALS };
    draw(<Referrals />);
    expect((await screen.findByLabelText('Status for Asha Rao') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByText('+ Add referral')).toBeNull();
  });
});

/* ========================= NOTIFICATION CENTRE ========================= */

const NOTIFS = [
  { id: 1, type: 'escalation', severity: 'warn', title: 'Overdue follow-up: Asha Rao',
    body: 'Call was due 200 min ago.', link_type: 'lead', link_id: 100, read_at: null,
    created_at: new Date(Date.now() - 120_000).toISOString() },
  { id: 2, type: 'sla_breach', severity: 'error', title: 'SLA breached — Ravi Kumar',
    body: 'First response SLA is 30 min past target.', link_type: 'lead', link_id: 101,
    read_at: '2026-07-14T09:00:00.000Z', created_at: '2026-07-14T08:00:00.000Z' },
];

describe('Notification centre (the bell) — the seam Sprint 4 plugs into', () => {
  it('shows the unread count on the bell', async () => {
    ROUTES = { '/notifications/count': { unread: 3 }, '/notifications': NOTIFS };
    render(<NotificationBell />);
    expect(await screen.findByText('3')).toBeTruthy();
  });

  it('opening the panel lists reminders, escalations and SLA breaches', async () => {
    ROUTES = { '/notifications/count': { unread: 1 }, '/notifications': NOTIFS };
    render(<NotificationBell />);
    fireEvent.click(await screen.findByLabelText('Notifications'));
    expect(await screen.findByText('Overdue follow-up: Asha Rao')).toBeTruthy();
    expect(screen.getByText('SLA breached — Ravi Kumar')).toBeTruthy();
    // unread rows are visually distinct
    expect(document.querySelectorAll('.notif-row.unread').length).toBe(1);
  });

  it('clicking a notification marks it read AND opens the linked lead', async () => {
    ROUTES = { '/notifications/count': { unread: 1 }, '/notifications': NOTIFS };
    const onOpenLead = vi.fn();
    render(<NotificationBell onOpenLead={onOpenLead} />);
    fireEvent.click(await screen.findByLabelText('Notifications'));
    fireEvent.click(await screen.findByText('Overdue follow-up: Asha Rao'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/notifications/1/read', undefined));
    expect(onOpenLead).toHaveBeenCalledWith(100);
  });

  it('"Mark all read" clears the badge', async () => {
    ROUTES = { '/notifications/count': { unread: 2 }, '/notifications': NOTIFS };
    post.mockResolvedValueOnce({ marked: 2 });
    render(<NotificationBell />);
    fireEvent.click(await screen.findByLabelText('Notifications'));
    fireEvent.click(await screen.findByText('Mark all read'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/notifications/read-all', undefined));
    await waitFor(() => expect(screen.queryByText('2')).toBeNull());
  });

  it('an empty bell says so — it never invents a notification', async () => {
    ROUTES = { '/notifications/count': { unread: 0 }, '/notifications': [] };
    render(<NotificationBell />);
    fireEvent.click(await screen.findByLabelText('Notifications'));
    expect(await screen.findByText(/all caught up/i)).toBeTruthy();
  });

  it('a failing count endpoint never breaks the shell', async () => {
    get.mockRejectedValueOnce(new Error('boom'));
    render(<NotificationBell />);
    expect(await screen.findByLabelText('Notifications')).toBeTruthy();
  });
});
