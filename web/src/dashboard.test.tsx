/**
 * ROLE-BASED DASHBOARDS + the score band on the lead list — rendered in jsdom.
 *
 * The client's two asks, checked as a user experiences them:
 *   · "Counsellor -> own leads/tasks/targets ... Admin -> org-wide. Same design language;
 *      widget mix + data scope differ by role."   -> a counsellor's screen must not contain
 *      a team leaderboard or branch SLA numbers AT ALL.
 *   · "Show the band on the lead list/Kanban/lead sheet, and make it filterable/sortable."
 *      -> the filter and the sort must actually reach the API.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

let ROUTES: Record<string, unknown> = {};
const paths: string[] = [];
const get = vi.fn(async (p: string) => {
  paths.push(p);
  const key = Object.keys(ROUTES).find((k) => p.startsWith(k));
  return key === undefined ? [] : ROUTES[key];
});
vi.mock('./api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}),
    del: vi.fn(), put: vi.fn(),
  },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
const draw = (key: string) => {
  const C = DYN[key];
  return render(<ScreenCtx.Provider value={CTX}>{<C />}</ScreenCtx.Provider>);
};

const BASE = {
  range: { from: '2026-07-01', to: '2026-07-14' },
  kpis: { total: 12, today: 3, in_range: 12, won: 2, won_in_range: 2, lost: 1,
    hot: 4, warm: 6, cold: 2, flagged: 1, unassigned: 0 },
  follow_ups: { pending: 5, due_today: 2, overdue: 1, done_today: 1, escalated: 1,
    my_open: 4, my_due_today: 2, my_overdue: 1 },
  by_stage: [{ stage_id: 11, name: 'New', stage_type: 'open', sort_order: 1, ct: 8 }],
  series: [{ day: '2026-07-14', leads: 3, won: 1 }],
  leaderboard: [], sla: null,
  walkins: { total: 0, today: 0, converted: 0 },
  referrals: { total: 0, mtd: 0, converted: 0, rewardable: 0 },
};

const COUNSELLOR = {
  ...BASE, view: 'counsellor',
  widgets: ['kpis', 'my_tasks', 'today_followups', 'my_leads', 'my_targets', 'ai_insights'],
};
const BRANCH_MGR = {
  ...BASE, view: 'branch',
  widgets: ['kpis', 'today_followups', 'overdue', 'team_leaderboard', 'funnel', 'series', 'sla',
    'walkins', 'referrals', 'ai_insights'],
  leaderboard: [{ user_id: 3, name: 'Asha Rao', leads: 12, won: 2, new_in_range: 3 }],
  sla: { open_breaches: 2, breaches_today: 1, avg_response_seconds: 5400 },
  walkins: { total: 4, today: 2, converted: 1 },
  referrals: { total: 3, mtd: 3, converted: 1, rewardable: 1 },
};

beforeEach(() => { cleanup(); ROUTES = {}; paths.length = 0; get.mockClear(); CTX.openLead.mockClear(); });
afterEach(cleanup);

describe('the dashboard renders the view the SERVER decided (not a client-side role guess)', () => {
  it("a COUNSELLOR sees personal KPIs and NO team leaderboard, NO branch SLA block", async () => {
    ROUTES = { '/dashboard': COUNSELLOR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };
    draw('dashOverview');

    expect(await screen.findByText('My work')).toBeTruthy();
    expect(screen.getByText('My leads')).toBeTruthy();
    expect(screen.getByText('My open tasks')).toBeTruthy();

    // the things a counsellor must NOT be shown
    expect(screen.queryByText('Team performance')).toBeNull();
    expect(screen.queryByText('Open SLA breaches')).toBeNull();
    expect(screen.queryByText('Walk-ins today')).toBeNull();
    expect(screen.queryByText('Org-wide')).toBeNull();
  });

  it('a BRANCH MANAGER gets the unit KPIs, the leaderboard AND the SLA block', async () => {
    ROUTES = { '/dashboard': BRANCH_MGR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };
    draw('dashOverview');

    expect(await screen.findByText('My branch')).toBeTruthy();
    expect(screen.getByText('Team performance')).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('Open SLA breaches')).toBeTruthy();
    expect(screen.getByText('Walk-ins today')).toBeTruthy();
    expect(screen.getByText('1h 30m')).toBeTruthy();          // avg first response
    // and NOT the personal framing
    expect(screen.queryByText('My leads')).toBeNull();
  });

  it('an ADMIN is labelled org-wide', async () => {
    ROUTES = {
      '/dashboard': { ...BRANCH_MGR, view: 'admin', widgets: [...BRANCH_MGR.widgets, 'sources'] },
      '/follow-ups': [], '/leads': { total: 0, rows: [] },
    };
    draw('dashOverview');
    expect(await screen.findByText('Organisation')).toBeTruthy();
    expect(screen.getByText('Org-wide')).toBeTruthy();
  });

  it('the widget list — not the component — decides: no leaderboard means no leaderboard', async () => {
    ROUTES = {
      // a manager VIEW whose widget list omits the leaderboard (a custom role could do this)
      '/dashboard': { ...BRANCH_MGR, widgets: ['kpis', 'today_followups', 'ai_insights'] },
      '/follow-ups': [], '/leads': { total: 0, rows: [] },
    };
    draw('dashOverview');
    await screen.findByText('My branch');
    expect(screen.queryByText('Team performance')).toBeNull();
    expect(screen.queryByText('Open SLA breaches')).toBeNull();
  });

  it('AI Insights stays an honest EMPTY SHELL — it never fakes an insight', async () => {
    ROUTES = { '/dashboard': COUNSELLOR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };
    draw('dashOverview');
    expect(await screen.findByText(/AI insights switch on once the Gemini key is configured/)).toBeTruthy();
  });

  it('the dashboard asks the SERVER for its scope — it never passes a role of its own', async () => {
    ROUTES = { '/dashboard': COUNSELLOR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };
    draw('dashOverview');
    await screen.findByText('My work');
    expect(paths).toContain('/dashboard');
    expect(paths.some((p) => /role=|view=/.test(p))).toBe(false);
  });
});

describe('Quick Stats — the CUSTOM DATE RANGE the client asked for', () => {
  const STATS = {
    range: { from: '2026-07-01', to: '2026-07-14' }, view: 'admin',
    leads: 12, won: 2, lost: 1, hot: 4, duplicates: 0,
    followups_done: 5, followups_scheduled: 9, conversion_rate: 17,
  };

  it('offers presets AND a real from/to picker, and hits the API with them', async () => {
    ROUTES = { '/dashboard/quick-stats': STATS };
    draw('quickStats');
    await waitFor(() => expect(paths.some((p) => p.startsWith('/dashboard/quick-stats'))).toBe(true));

    // a custom range reaches the API verbatim
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    await waitFor(() => expect(paths.some((p) => p.includes('from=2026-01-01') && p.includes('to=2026-03-31'))).toBe(true));
  });

  it('a preset switches the range (This week / Today / Last 90 days)', async () => {
    ROUTES = { '/dashboard/quick-stats': STATS };
    draw('quickStats');
    fireEvent.click(await screen.findByText('Today'));
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await waitFor(() => expect(paths.some((p) => p.includes(`from=${iso}`) && p.includes(`to=${iso}`))).toBe(true));
  });

  it('renders the numbers, including the conversion rate', async () => {
    ROUTES = { '/dashboard/quick-stats': STATS };
    draw('quickStats');
    expect(await screen.findByText('17%')).toBeTruthy();
    expect(screen.getByText('Follow-ups done')).toBeTruthy();
  });
});

describe('the lead LIST — band filterable + sortable, breach visible', () => {
  const LEADS = {
    total: 2,
    rows: [
      { id: 100, full_name: 'Asha Rao', phone: '+919810000001', temperature: 'hot', score: 82,
        stage_name: 'New', stage_type: 'open', vertical_name: 'BCL', pipeline_name: 'Admissions',
        source_name: 'Meta Ads', sla_breached: true, is_flagged: true },
      { id: 101, full_name: 'Ravi Kumar', phone: '+919810000002', temperature: 'cold', score: 20,
        stage_name: 'New', stage_type: 'open', vertical_name: 'BCL', pipeline_name: 'Admissions',
        source_name: 'Meta Ads', sla_breached: false, is_flagged: true, flag_reason: 'Follow-up overdue' },
    ],
  };

  it('shows the BAND badge, plus an SLA badge on the breached lead', async () => {
    ROUTES = { '/leads': LEADS };
    draw('leadsAll');
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('Hot 82')).toBeTruthy();
    expect(screen.getByText('Cold 20')).toBeTruthy();
    expect(screen.getByTitle('SLA breached')).toBeTruthy();          // only the breached one
    expect(screen.getByTitle('Follow-up overdue')).toBeTruthy();     // the flagged-but-not-breached one
  });

  it('the band filter is REAL — it reaches the API as ?temperature=', async () => {
    ROUTES = { '/leads': LEADS };
    draw('leadsAll');
    fireEvent.change(await screen.findByLabelText('Filter by score band'), { target: { value: 'hot' } });
    await waitFor(() => expect(paths.some((p) => p.includes('temperature=hot'))).toBe(true));
  });

  it('the sort is REAL — it reaches the API as ?sort=score', async () => {
    ROUTES = { '/leads': LEADS };
    draw('leadsAll');
    fireEvent.change(await screen.findByLabelText('Sort leads'), { target: { value: 'score' } });
    await waitFor(() => expect(paths.some((p) => p.includes('sort=score'))).toBe(true));
  });

  it('the "SLA breached" chip filters the list', async () => {
    ROUTES = { '/leads': LEADS };
    draw('leadsAll');
    fireEvent.click(await screen.findByText('SLA breached'));
    await waitFor(() => expect(paths.some((p) => p.includes('sla_breached=1'))).toBe(true));
  });
});

/**
 * #13(c) — the Task SUMMARY tiles must open the My Tasks list.
 *
 * Batch E wired only the My Tasks CARD-HEADER "View all ›" link. But the client clicks the
 * KPI summary TILE (the number) — "My open tasks" / "Due today" (counsellor) or
 * "Pending follow-ups" (manager) — and nothing happened because the `Kpis` tiles had no
 * onClick/role. These tests assert the tiles are a real, keyboard-activatable button that
 * navigates via go('dash','mytasks'). They were PROVEN to fail against the pre-fix code
 * (tiles had no button role and clicking called go 0 times).
 */
describe('#13(c) — the task-summary KPI tiles open the My Tasks list', () => {
  const clickList = { '/dashboard': COUNSELLOR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };

  it('COUNSELLOR: "My open tasks" tile is a button that navigates to dash/mytasks', async () => {
    ROUTES = clickList;
    draw('dashOverview');
    await screen.findByText('My work');
    const tile = screen.getByRole('button', { name: /My open tasks: 4\. Open My Tasks list/ });
    expect(tile).toBeTruthy();
    CTX.go.mockClear();
    fireEvent.click(tile);
    expect(CTX.go).toHaveBeenCalledWith('dash', 'mytasks');
  });

  it('COUNSELLOR: "Due today" tile navigates to dash/mytasks', async () => {
    ROUTES = clickList;
    draw('dashOverview');
    await screen.findByText('My work');
    const tile = screen.getByRole('button', { name: /Tasks due today: 2\. Open My Tasks list/ });
    CTX.go.mockClear();
    fireEvent.click(tile);
    expect(CTX.go).toHaveBeenCalledWith('dash', 'mytasks');
  });

  it('the tile is KEYBOARD-activatable (Enter and Space) with a button role and tabindex', async () => {
    ROUTES = clickList;
    draw('dashOverview');
    await screen.findByText('My work');
    const tile = screen.getByRole('button', { name: /My open tasks: 4\. Open My Tasks list/ });
    expect(tile.getAttribute('tabindex')).toBe('0');
    CTX.go.mockClear();
    fireEvent.keyDown(tile, { key: 'Enter' });
    expect(CTX.go).toHaveBeenCalledWith('dash', 'mytasks');
    CTX.go.mockClear();
    fireEvent.keyDown(tile, { key: ' ' });
    expect(CTX.go).toHaveBeenCalledWith('dash', 'mytasks');
  });

  it('MANAGER: "Pending follow-ups" tile navigates to dash/mytasks', async () => {
    ROUTES = { '/dashboard': BRANCH_MGR, '/follow-ups': [], '/leads': { total: 0, rows: [] } };
    draw('dashOverview');
    await screen.findByText('My branch');
    const tile = screen.getByRole('button', { name: /Pending follow-ups: 5\. Open My Tasks list/ });
    CTX.go.mockClear();
    fireEvent.click(tile);
    expect(CTX.go).toHaveBeenCalledWith('dash', 'mytasks');
  });

  it('non-task tiles stay PLAIN — "My leads" is not a button (no dead affordance)', async () => {
    ROUTES = clickList;
    draw('dashOverview');
    await screen.findByText('My work');
    // "My leads" has no navigation, so it must not carry a button role.
    expect(screen.queryByRole('button', { name: /My leads/ })).toBeNull();
    expect(screen.getByText('My leads')).toBeTruthy();     // still shown as a stat
  });

  it('the My Tasks screen summary tiles are NOT clickable-looking-but-dead', async () => {
    // On dash.mytasks the KPI tiles summarise the very list below them, so they are pure
    // display — they must carry NO button role (nothing that looks clickable yet does nothing).
    ROUTES = {
      '/follow-ups/summary': { my_open: 4, my_due_today: 2, my_overdue: 1, my_done_week: 3,
        reported_open: 0, reported_due_today: 0, reported_overdue: 0, reported_done_week: 0 },
      '/follow-ups': [],
    };
    draw('myTasks');
    expect(await screen.findByText('Open tasks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open tasks/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Overdue/ })).toBeNull();
  });
});
