import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CrossSell } from './crosssell';

/**
 * CROSS-SELL (client 12 Nov 2026 mockup) — Dashboard KPIs + pipeline strip + top recommendations,
 * recommendations → opportunity, the opportunity drawer's stage moves, lost-with-reason, the
 * Settings rule form, and the old act-on-suggestion actions (follow-up / new lead / dismiss).
 */

const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 3, name: 'Asha Rao' } } }) }));
vi.mock('./sprint5', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sprint5')>()), EnrolmentModal: () => <div data-testid="sale-closure">Sale Closure</div> }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [],
  courses: [{ id: 100, name: 'German A1', meta: { fee: '15000' } }, { id: 200, name: 'German A2', meta: { fee: '18000' } }],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], trainings: [], visitPurposes: [], walkinStatuses: [],
  ticketCategories: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const REC = {
  lead_id: 10, student_id: 77, full_name: 'Meera K', phone: '+919812345678', branch_id: 9, vertical_id: 1, owner_id: 3,
  branch_name: 'Vikaspuri', vertical_name: 'BCL', owner_name: 'Asha Rao',
  from_course_id: 100, from_course_name: 'German A1', course_id: 200, course_name: 'German A2',
  basis: 'rule', sale_type: 'upsell', match_pct: 94, match_parts: [['Cross-sell rule', 85], ['Fees fully paid', 5], ['Next step in the same course family', 4]],
  value_minor: 1800000,
};
const OPP = {
  id: 501, lead_id: 10, full_name: 'Meera K', phone: '+919812345678', from_course_name: 'German A1', course_id: 200, course_name: 'German A2',
  sale_type: 'upsell', stage: 'contacted', value_minor: 1800000, converted_value_minor: null, owner_id: 3, owner_name: 'Asha Rao',
  branch_name: 'Vikaspuri', vertical_name: 'BCL', next_follow_up_at: null, created_at: '2026-11-15T10:00:00Z', source: 'recommendation',
  history: [{ id: 1, from_stage: null, to_stage: 'new', created_at: '2026-11-15T10:00:00Z', actor_name: 'Asha Rao' }],
};
const DASH = {
  kpis: { revenue_minor: 48000000, opportunities: 126, converted: 38, conversion_pct: 30.2, avg_value_minor: 1265000, pipeline_value_minor: 21000000 },
  change: { revenue_minor: 18, opportunities: 12, converted: 20, conversion_pct: 2.5, avg_value_minor: 10 },
  by_type: [{ sale_type: 'cross_sell', revenue_minor: 31200000 }, { sale_type: 'upsell', revenue_minor: 12000000 },
    { sale_type: 'downsell', revenue_minor: 4800000 }, { sale_type: 'cross_vertical', revenue_minor: 0 }],
  stages: [['new', 48], ['assigned', 42], ['contacted', 36], ['interested', 28], ['quotation_sent', 20], ['negotiation', 14], ['converted', 38], ['lost', 10]]
    .map(([stage, count]) => ({ stage, count, value_minor: 0 })),
  months: [{ label: '2026-10', opportunities: 40, revenue_minor: 30000000 }, { label: '2026-11', opportunities: 50, revenue_minor: 48000000 }],
  recent: [OPP], followups: [],
  top_recommendations: [{ from_course_id: 100, from_course_name: 'German A1', course_id: 200, course_name: 'German A2', sale_type: 'upsell', contacts: 5, match_pct: 92 }],
};

const post = vi.fn().mockResolvedValue({ ok: true, id: 900, sale_type: 'upsell', value_minor: 1800000 });
const patch = vi.fn().mockResolvedValue({ id: 501 });
const gets: string[] = [];
const getRoute = (path: string): Promise<unknown> => {
  gets.push(path);
  if (path.startsWith('/cross-sell/dashboard')) return Promise.resolve(DASH);
  if (path.startsWith('/cross-sell/recommendations/top')) return Promise.resolve(DASH.top_recommendations);
  if (path.startsWith('/cross-sell/recommendations')) return Promise.resolve([REC]);
  if (path.startsWith('/cross-sell/opportunities/')) return Promise.resolve(OPP);
  if (path.startsWith('/cross-sell/opportunities')) return Promise.resolve([OPP]);
  if (path.startsWith('/cross-sell/campaigns/audience')) return Promise.resolve({ count: 1, contacts: [REC] });
  if (path.startsWith('/cross-sell/campaigns')) return Promise.resolve([]);
  if (path.startsWith('/cross-sell/rules')) return Promise.resolve([]);
  if (path.startsWith('/cross-sell/attempts')) return Promise.resolve([]);
  if (path.startsWith('/templates')) return Promise.resolve([{ id: 7, name: 'Offer template' }]);
  return Promise.resolve([]);
};
vi.mock('./api', () => ({
  api: {
    get: (p: string) => getRoute(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn(),
  },
}));
vi.mock('./askdialog', () => ({ askConfirm: vi.fn().mockResolvedValue(true) }));

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); gets.length = 0; can.mockReturnValue(true); });

describe('Cross-Sell dashboard (mockup)', () => {
  it('shows the six KPI cards, the 8-stage pipeline and a top recommendation with Notify', async () => {
    render(<CrossSell />);
    expect((await screen.findAllByText('₹4.8L')).length).toBeGreaterThan(0);
    for (const k of ['Additional Revenue', 'Opportunities', 'Converted', 'Conversion Rate', 'Avg Opportunity Value', 'Pipeline Value']) {
      expect(screen.getAllByText(k).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('30.2%')).toBeTruthy();
    for (const s of ['New Opportunity', 'Assigned', 'Contacted', 'Interested', 'Quotation Sent', 'Negotiation', 'Lost']) {
      expect(screen.getAllByText(s).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('(48)')).toBeTruthy();
    expect(screen.getAllByText('German A2').length).toBeGreaterThan(0);
    expect(screen.getByTestId('cs-notify')).toBeTruthy();
  });

  it('the period and branch drive the dashboard query', async () => {
    render(<CrossSell />);
    await screen.findAllByText('₹4.8L');
    fireEvent.change(screen.getByTestId('cs-period'), { target: { value: 'last_month' } });
    await waitFor(() => expect(gets.some((g) => g.startsWith('/cross-sell/dashboard') && g.includes('period=last_month'))).toBe(true));
  });

  it('a pipeline stage opens the Opportunities tab filtered to it', async () => {
    render(<CrossSell />);
    await screen.findByText('(48)');
    fireEvent.click(screen.getByText('(36)'));
    await waitFor(() => expect(gets.some((g) => g.startsWith('/cross-sell/opportunities') && g.includes('stage=contacted'))).toBe(true));
  });
});

describe('Cross-Sell recommendations → opportunity', () => {
  it('lists a recommendation with type and match %, and Opportunity posts the pair', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Recommendations' }));
    expect(await screen.findByText('Meera K')).toBeTruthy();
    expect(screen.getAllByText('94%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('cs-rec-create-10-200'));
    expect(await screen.findByTestId('cs-opp-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cs-opp-save'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/opportunities', expect.objectContaining({
      lead_id: 10, course_id: 200, from_course_id: 100, sale_type: 'upsell', match_pct: 94, from_recommendation: true,
    })));
  });

  it('the other actions still post follow-up / new lead / dismiss', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Recommendations' }));
    await screen.findByText('Meera K');
    fireEvent.click(screen.getByTitle('Follow-up / new lead / dismiss'));
    fireEvent.click(await screen.findByText('Dismiss'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/act', expect.objectContaining({ lead_id: 10, suggested_course_id: 200, action: 'dismissed' })));
  });
});

describe('Cross-Sell opportunity drawer', () => {
  it('moves a stage, refuses a reasonless Lost, and Convert opens Sale Closure', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Opportunities' }));
    fireEvent.click(await screen.findByTestId('cs-open-501'));
    expect(await screen.findByTestId('cs-opp-detail')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cs-stage-interested'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/cross-sell/opportunities/501', { stage: 'interested' }));
    fireEvent.click(screen.getByTestId('cs-lost'));
    expect((screen.getByTestId('cs-lost-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('cs-lost-reason'), { target: { value: 'Fees too high' } });
    fireEvent.click(screen.getByTestId('cs-lost-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/cross-sell/opportunities/501', { stage: 'lost', lost_reason: 'Fees too high' }));
    fireEvent.click(screen.getByTestId('cs-convert'));
    expect(await screen.findByTestId('sale-closure')).toBeTruthy();
  });
});

describe('Cross-Sell settings (admin)', () => {
  it('only crosssell.manage sees Settings', async () => {
    can.mockImplementation((k: string) => k !== 'crosssell.manage');
    render(<CrossSell />);
    await screen.findByRole('tab', { name: 'Dashboard' });
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });

  it('a new rule posts its type and match strength', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    fireEvent.click(await screen.findByTestId('cs-rule-new'));
    const modal = await screen.findByTestId('cs-rule-modal');
    const selects = modal.querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: '100' } });
    fireEvent.change(selects[1], { target: { value: '200' } });
    fireEvent.change(selects[2], { target: { value: 'upsell' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/rules', expect.objectContaining({
      source_course_id: 100, target_course_id: 200, sale_type: 'upsell', weight: 85,
    })));
  });
});
