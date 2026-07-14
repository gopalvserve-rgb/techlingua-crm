/**
 * UI test for the Start Calling screen (jsdom).
 *
 * The DEF-2 lesson, applied: an API-only suite cannot see a broken screen. These
 * tests render what a counsellor actually sees and clicks — the pool size, the
 * Start Calling button, the batch as a queue, the "3 of 10" progress, the
 * disposition form, Save & next, the completed-batch state, the empty pool, and
 * the manager's pool-status tables.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/** this harness has no jest-dom — assert on the DOM directly */
const txt = (el: HTMLElement | null) => (el?.textContent ?? '');
const enabled = (el: HTMLElement) => !(el as HTMLButtonElement).disabled;
import StartCalling, { Batch, PullCampaign, PoolStatus } from './calling';

let CAN: (p: string) => boolean = () => true;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (p: string) => CAN(p), me: { user: { id: 11, name: 'Anita' } } }) }));

const REF = {
  branches: [], verticals: [], pipelines: [], campaigns: [], sources: [], users: [], courses: [],
  statuses: [], followupTypes: [],
  dispositions: [{ id: 81, name: 'Interested' }, { id: 82, name: 'Not picking up' }],
  budgets: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
const toastFn = vi.fn((_t: string, _e?: boolean) => undefined);
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: (t: string, e?: boolean) => toastFn(t, e) };
});

const CAMPAIGNS: PullCampaign[] = [
  { id: 5, name: 'Meta July', branch_name: 'Delhi', vertical_name: 'TLA', pipeline_name: 'Admissions', batch_size: 10, waiting: 25 },
];

const mkLead = (i: number, actioned = false) => ({
  id: 1000 + i, position: i + 1,
  actioned_at: actioned ? '2026-07-14T10:00:00Z' : null,
  disposition_id: actioned ? 81 : null, disposition_name: actioned ? 'Interested' : null,
  full_name: `Lead ${i + 1}`, phone: `+91900000000${i}`, email: null,
  priority: 'med', temperature: 'warm', score: 40,
  stage_id: 51, stage_name: 'New', status_id: 31,
  course_name: 'IELTS', city_name: 'Delhi', source_name: 'Meta Lead Ads',
  next_follow_up_at: null, created_at: '2026-07-01T09:00:00Z',
});

const BATCH: Batch & { status?: string } = {
  status: 'ok',
  handout: {
    id: 701, campaign_id: 5, campaign_name: 'Meta July', size: 10, requested_size: 10,
    actioned_count: 0, status: 'open', created_at: '2026-07-14T10:00:00Z', completed_at: null,
  },
  leads: Array.from({ length: 10 }, (_, i) => mkLead(i)),
  stages: [{ id: 51, name: 'New', stage_type: 'open', sort_order: 1 }, { id: 52, name: 'Contacted', stage_type: 'open', sort_order: 2 }],
  waiting: 15,
};

const POOL: PoolStatus = {
  campaigns: [{
    id: 5, name: 'Meta July', branch_name: 'Delhi', vertical_name: 'TLA', batch_size: 10, agents: 2,
    waiting: 15, oldest_waiting_at: '2026-07-13T10:00:00Z', handouts_today: 1, leads_handed_today: 10, open_batches: 1,
  }],
  handouts: [{
    id: 701, campaign_id: 5, campaign_name: 'Meta July', user_id: 11, user_name: 'Anita',
    size: 10, actioned_count: 3, status: 'open', created_at: '2026-07-14T10:00:00Z', completed_at: null,
  }],
  guard: { enabled: false, min_actioned_pct: 100 },
};

/** route the screen's fetches; `current` decides whether the agent already has a queue */
function mockApi(opts: { current?: Batch; pull?: unknown; action?: unknown; campaigns?: PullCampaign[] } = {}) {
  const posts: Array<[string, unknown]> = [];
  const g = globalThis as any;
  g.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) } as any);
    if (init?.method === 'POST') {
      posts.push([path, body]);
      if (path.endsWith('/action')) return json(opts.action ?? BATCH);
      return json(opts.pull ?? { ...BATCH, status: 'ok' });
    }
    if (path.includes('/handout/campaigns')) return json(opts.campaigns ?? CAMPAIGNS);
    if (path.includes('/handout/current')) return json(opts.current ?? { handout: null, leads: [], stages: [], waiting: 0 });
    if (path.includes('/handout/pool')) return json(POOL);
    return json(null);
  });
  return posts;
}

beforeEach(() => { cleanup(); CAN = () => true; toastFn.mockClear(); });

describe('Start Calling — the agent flow', () => {
  it('shows the pool size and offers Start Calling when the agent has no batch', async () => {
    mockApi();
    render(<StartCalling />);
    await waitFor(() => expect(txt(screen.getByTestId('waiting'))).toBe('25'));
    expect(enabled(screen.getByRole('button', { name: /Start Calling/i }))).toBe(true);
    expect(screen.getByTestId('idle').textContent)
      .toMatch(/25 leads waiting.*next 10 will be assigned to you/i);
  });

  it('clicking Start Calling pulls a batch and renders it as a working queue with progress', async () => {
    const posts = mockApi();
    render(<StartCalling />);
    await waitFor(() => expect(enabled(screen.getByRole('button', { name: /Start Calling/i }))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Start Calling/i }));

    await waitFor(() => expect(txt(screen.getByTestId('progress'))).toBe('0 of 10'));
    // the POST asked for the selected campaign
    expect(posts.some(([p, b]) => p.endsWith('/api/leads/handout') && (b as any).campaign_id === 5)).toBe(true);
    // the queue: 10 leads, all pending, the first one open in the work pane
    expect(screen.getAllByText(/^\d+\. Lead \d+$/)).toHaveLength(10);
    expect(screen.getAllByText('Pending')).toHaveLength(10);
    expect(screen.getByText('Lead 1 of 10')).toBeTruthy();
    // the lead being worked, with a tel: link (NO dialler — telephony is out of scope)
    const call = screen.getByRole('link', { name: /Call \+919000000000/ });
    expect(call.getAttribute('href')).toBe('tel:+919000000000');
    expect(screen.getByText('IELTS')).toBeTruthy();
  });

  it('Save & next posts the disposition and advances the queue', async () => {
    // after the action the server returns lead 1 actioned, count = 1
    const after: Batch = {
      ...BATCH,
      handout: { ...BATCH.handout!, actioned_count: 1 },
      leads: [mkLead(0, true), ...Array.from({ length: 9 }, (_, i) => mkLead(i + 1))],
    };
    const posts = mockApi({ current: BATCH, action: after });
    render(<StartCalling />);
    await waitFor(() => expect(txt(screen.getByTestId('progress'))).toBe('0 of 10'));

    fireEvent.change(screen.getByLabelText('Disposition'), { target: { value: '81' } });
    fireEvent.change(screen.getByLabelText('Move to stage'), { target: { value: '52' } });
    fireEvent.change(screen.getByLabelText('Call note'), { target: { value: 'Wants a callback' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & next/i }));

    await waitFor(() => expect(txt(screen.getByTestId('progress'))).toBe('1 of 10'));
    const [path, body] = posts.find(([p]) => p.endsWith('/action'))!;
    expect(path).toContain('/leads/handout/701/action');
    expect(body).toMatchObject({ lead_id: 1000, disposition_id: 81, stage_id: 52, note: 'Wants a callback' });
    // the worked lead is ticked off and the pane moved to lead 2
    expect(screen.getByText('Lead 2 of 10')).toBeTruthy();
    expect(screen.getAllByText('Pending')).toHaveLength(9);
  });

  it('a completed batch invites the next 10 and shows how many are left in the pool', async () => {
    const doneBatch: Batch = {
      ...BATCH,
      handout: { ...BATCH.handout!, actioned_count: 10, status: 'completed' },
      leads: Array.from({ length: 10 }, (_, i) => mkLead(i, true)),
      waiting: 15,
    };
    mockApi({ current: doneBatch });
    render(<StartCalling />);
    await waitFor(() => expect(txt(screen.getByTestId('progress'))).toBe('10 of 10'));
    expect(screen.getByTestId('batch-done').textContent).toMatch(/Batch complete — 10 of 10 worked\..*15 more leads waiting/s);
    expect(enabled(screen.getByRole('button', { name: /Get next 10/i }))).toBe(true);
  });

  it('an EMPTY pool is a clean empty state, not an error', async () => {
    mockApi({
      campaigns: [{ ...CAMPAIGNS[0], waiting: 0 }],
      pull: { status: 'empty', handout: null, leads: [], waiting: 0, message: 'No leads are waiting in the "Meta July" pool right now.' },
    });
    render(<StartCalling />);
    await waitFor(() => expect(txt(screen.getByTestId('waiting'))).toBe('0'));
    expect(screen.getByTestId('idle').textContent).toMatch(/No leads waiting in the .Meta July. pool right now/);

    fireEvent.click(screen.getByRole('button', { name: /Start Calling/i }));
    await waitFor(() => expect(toastFn.mock.calls.map((c) => c[0]))
      .toContain('No leads are waiting in the "Meta July" pool right now.'));
    expect(screen.queryByTestId('progress')).toBeNull();     // no queue, no crash
  });

  it('an agent in no on-demand pool is told so', async () => {
    mockApi({ campaigns: [] });
    render(<StartCalling />);
    await waitFor(() => expect(screen.getByTestId('idle').textContent)
      .toMatch(/not in the agent pool of any On Demand campaign/i));
  });

  it('without lead.pull the screen explains instead of rendering a queue', async () => {
    CAN = (p) => p !== 'lead.pull';
    mockApi();
    render(<StartCalling />);
    expect(screen.getByText(/Ask an admin for the/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start Calling/i })).toBeNull();
  });
});

describe('Start Calling — the manager pool view', () => {
  it('shows pool status per campaign and who pulled what and when', async () => {
    mockApi({ current: BATCH });
    render(<StartCalling />);
    await waitFor(() => expect(screen.getByText('Pool status — On Demand campaigns')).toBeTruthy());
    expect(screen.getByText('Recent hand-outs — who pulled what, and when')).toBeTruthy();
    expect(screen.getByText(/Guardrail OFF/i)).toBeTruthy();
    expect(screen.getByText('Anita (me)')).toBeTruthy();
    expect(screen.getByText('3 of 10')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('an agent (no lead.assign) never sees the manager tables', async () => {
    CAN = (p) => p !== 'lead.assign';
    mockApi({ current: BATCH });
    render(<StartCalling />);
    await waitFor(() => expect(screen.getByTestId('progress')).toBeTruthy());
    expect(screen.queryByText('Pool status — On Demand campaigns')).toBeNull();
  });
});
