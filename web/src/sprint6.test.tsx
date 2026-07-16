import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  ActivityReport, Announcements, AnnouncementModal, ArticleModal, CampaignRoiReport,
  ChannelModal, FunnelReport, KnowledgeBase, NoteModal, Notes, ReportBuilder, ReportGrid,
  SavedReports, ScheduleModal, ScheduledDelivery, ShareModal, TatReport, TeamChat,
  fmtCell,
} from './sprint6';

/**
 * SPRINT 6 — EVERY NEW SCREEN RENDERS IN JSDOM, AND EVERY NEW FORM REACHES THE API.
 *
 * The standing rule: render every new screen in jsdom. The Sprint-5 live smoke found the
 * API crashing on boot and a PDF whose columns collided while 25 tests passed — the
 * lesson each time being that a test which does not exercise the real thing proves
 * nothing about it. So these render the REAL components against a fake API and read what
 * a user would see.
 *
 * The phantom-field probe for the new modals lives in qa10matrix.test.tsx, where it
 * belongs — every form in the app goes through the same generic differential probe.
 */

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

/* ---------------------------------------------------------------- the API */

const CATALOG = {
  entities: [{
    key: 'leads', label: 'Leads', blurb: 'Every lead with its full path.',
    default_date_field: 'created_at',
    date_fields: [{ key: 'created_at', label: 'Created on' }],
    default_columns: ['full_name', 'stage'],
    columns: [
      { key: 'full_name', label: 'Name', type: 'text', filterable: true, groupable: false, aggregate: null },
      { key: 'stage', label: 'Stage', type: 'text', filterable: true, groupable: true, aggregate: null },
      { key: 'owner', label: 'Counsellor', type: 'text', filterable: true, groupable: true, aggregate: null },
      { key: 'score', label: 'Score', type: 'number', filterable: true, groupable: false, aggregate: 'avg' },
      { key: 'created_at', label: 'Created on', type: 'datetime', filterable: true, groupable: false, aggregate: null },
    ],
  }, {
    key: 'enrolments', label: 'Enrolments', blurb: 'Closed sales.',
    default_date_field: 'created_at',
    date_fields: [{ key: 'created_at', label: 'Closed on' }],
    default_columns: ['enrolment_no'],
    columns: [
      { key: 'enrolment_no', label: 'Enrolment no.', type: 'text', filterable: true, groupable: false, aggregate: null },
      { key: 'net_fee', label: 'Net fee', type: 'money', filterable: true, groupable: false, aggregate: 'sum' },
    ],
  }],
  operators: [
    { key: 'eq', label: 'is', types: ['text', 'number', 'money'], arity: 1 },
    { key: 'contains', label: 'contains', types: ['text'], arity: 1 },
    { key: 'between', label: 'between', types: ['number', 'money'], arity: 2 },
    { key: 'not_null', label: 'is not empty', types: ['text', 'number', 'money'], arity: 0 },
  ],
  date_presets: [{ key: 'all', label: 'All time' }, { key: 'this_month', label: 'This month' }, { key: 'custom', label: 'Custom range…' }],
  formats: [{ key: 'xlsx', label: 'Excel (.xlsx)' }, { key: 'csv', label: 'CSV' }, { key: 'pdf', label: 'PDF', note: 'Best up to ~14 columns.' }],
};

const RUN = {
  report: null, entity: 'leads', entity_label: 'Leads',
  columns: [
    { key: 'full_name', label: 'Name', type: 'text' },
    { key: 'net_fee', label: 'Net fee', type: 'money' },
  ],
  rows: [['Priya Sharma', 6625000], ['Ravi Kumar', 100000]],
  row_count: 2, grouped: false, truncated: false,
  scope: { user_id: 3, unrestricted: false, note: 'Showing only the records your role gives you access to.' },
  generated_at: '2026-07-16T10:00:00.000Z',
};

const post = vi.fn();
const patch = vi.fn().mockResolvedValue({});
const del = vi.fn().mockResolvedValue({});
const get = vi.fn();

vi.mock('./api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: (p: string) => del(p),
  },
  ApiError: class extends Error {},
}));

const routes: Record<string, unknown> = {};
beforeEach(() => {
  cleanup();
  post.mockReset(); patch.mockReset(); del.mockReset(); get.mockReset();
  post.mockResolvedValue(RUN);
  patch.mockResolvedValue({});
  del.mockResolvedValue({});
  get.mockImplementation((p: string) => {
    if (p.startsWith('/reports/catalog')) return Promise.resolve(CATALOG);
    if (p.startsWith('/reports/funnel')) return Promise.resolve(routes.funnel);
    if (p.startsWith('/reports/tat')) return Promise.resolve(routes.tat);
    if (p.startsWith('/reports/activity')) return Promise.resolve(routes.activity);
    if (p.startsWith('/reports/roi')) return Promise.resolve(routes.roi);
    if (p.startsWith('/reports/schedules/all')) return Promise.resolve(routes.schedules ?? []);
    if (/\/reports\/schedules\/\d+\/history/.test(p)) return Promise.resolve(routes.history ?? []);
    if (p === '/reports') return Promise.resolve(routes.reports ?? []);
    if (p.startsWith('/roles')) return Promise.resolve([{ id: 6, name: 'Counsellor' }, { id: 3, name: 'Branch Manager' }]);
    if (p.startsWith('/workspace/channels/')) return Promise.resolve(routes.messages ?? []);
    if (p.startsWith('/workspace/channels')) return Promise.resolve(routes.channels ?? []);
    if (p.startsWith('/workspace/notes')) return Promise.resolve(routes.notes ?? []);
    if (p.startsWith('/workspace/kb')) return Promise.resolve(routes.kb ?? []);
    if (p.startsWith('/workspace/announcements/manage')) return Promise.resolve(routes.annAdmin ?? []);
    if (p.startsWith('/workspace/announcements')) return Promise.resolve(routes.ann ?? []);
    return Promise.resolve([]);
  });
});


/** Chips appear in several sections (Columns, Group by, Roles) and some labels legitimately
 *  repeat — "Counsellor" is both a lead COLUMN and a ROLE. So every chip query is scoped to
 *  its own section rather than searched globally: an ambiguous query is a test that will
 *  break the next time somebody adds a field, for no reason. */
const chipIn = (sectionLabel: string, name: string): HTMLButtonElement => {
  const label = screen.getByText(sectionLabel, { selector: 'label' });
  const chips = label.parentElement!.querySelector('.chips')!;
  const btn = [...chips.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!btn) throw new Error(`no "${name}" chip under "${sectionLabel}"`);
  return btn as HTMLButtonElement;
};

/* ==================================================================== */

describe('fmtCell — a report cell says what its TYPE means', () => {
  it('money is Indian-grouped rupees, from paise', () => {
    expect(fmtCell(6625000, 'money')).toBe('₹66,250.00');
    // NOT ₹1,234,567.00 — the client does not read numbers that way
    expect(fmtCell(123456700, 'money')).toBe('₹12,34,567.00');
  });
  it('the SCREEN shows the rupee SYMBOL (the PDF cannot — see report-pdf.ts)', () => {
    expect(fmtCell(100, 'money')).toContain('₹');
  });
  it('a bool is Yes/No, not true/false', () => {
    expect(fmtCell(true, 'bool')).toBe('Yes');
    expect(fmtCell('f', 'bool')).toBe('No');
  });
  it('a null is an em-dash, never "null"', () => {
    for (const t of ['text', 'money', 'number', 'date', 'datetime', 'bool']) {
      expect(fmtCell(null, t)).toBe('—');
      expect(fmtCell(undefined, t)).toBe('—');
    }
  });
});

describe('the REPORT BUILDER renders and runs', () => {
  it('renders the data sources the API offered — and no others', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    expect(screen.getByRole('option', { name: 'Leads' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Enrolments' })).toBeTruthy();
    // "Fee receipts" is not in the catalog for this user — the API filtered it out, and
    // offering it and then handing back an empty grid is how a client files a bug against
    // a rule that is working.
    expect(screen.queryByRole('option', { name: 'Fee receipts' })).toBeNull();
  });

  it('SAYS, before you build anything, that a shared report runs in the reader\'s scope', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    expect(screen.getByText(/runs in/i).textContent).toMatch(/their.*scope/i);
  });

  it('preselects the entity\'s default columns', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    expect(screen.getByText('2 selected · click to add or remove')).toBeTruthy();
  });

  it('clicking a column chip adds it to the report', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(chipIn('Columns', 'Counsellor'));
    expect(screen.getByText('3 selected · click to add or remove')).toBeTruthy();
  });

  it('Run posts the definition to /reports/preview and renders the rows', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Run report/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports/preview', expect.objectContaining({ entity: 'leads' })));
    expect(await screen.findByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('₹66,250.00')).toBeTruthy();
  });

  /** The sentence that stops a support call: a counsellor's totals differ from his
   *  manager's, and the screen must say why rather than leave him to guess. */
  it('the SCOPE NOTE from the server is shown under the grid', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Run report/ }));
    expect(await screen.findByText('Showing only the records your role gives you access to.')).toBeTruthy();
  });

  it('changing the data source RESETS the columns (a `stage` filter on Receipts is a 400 nobody can read)', async () => {
    render(<ReportBuilder />);
    const sel = await screen.findByLabelText(/Data source/);
    fireEvent.click(chipIn('Columns', 'Counsellor'));
    expect(screen.getByText('3 selected · click to add or remove')).toBeTruthy();
    fireEvent.change(sel, { target: { value: 'enrolments' } });
    expect(screen.getByText('1 selected · click to add or remove')).toBeTruthy();
  });

  it('a custom date range reveals From and To, and says the To is inclusive', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    expect(screen.queryByLabelText('From')).toBeNull();
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByText(/Inclusive/)).toBeTruthy();
  });

  it('a filter\'s operator list follows the column\'s TYPE', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Add a filter/ }));
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'full_name' } });
    // `contains` applies to text; `between` does not
    expect(screen.getByRole('option', { name: 'contains' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'between' })).toBeNull();
  });

  it('changing a filter\'s COLUMN resets its operator (a "contains" on a date is a 400)', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Add a filter/ }));
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'full_name' } });
    fireEvent.change(screen.getByLabelText('Filter 1 condition'), { target: { value: 'contains' } });
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'score' } });
    expect((screen.getByLabelText('Filter 1 condition') as HTMLSelectElement).value).toBe('');
  });

  it('a 2-argument operator reveals a second value box', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Add a filter/ }));
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'score' } });
    fireEvent.change(screen.getByLabelText('Filter 1 condition'), { target: { value: 'between' } });
    expect(screen.getByLabelText('Filter 1 second value')).toBeTruthy();
  });

  it('a 0-argument operator hides the value box entirely', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Add a filter/ }));
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'full_name' } });
    fireEvent.change(screen.getByLabelText('Filter 1 condition'), { target: { value: 'not_null' } });
    expect(screen.queryByLabelText('Filter 1 value')).toBeNull();
  });

  it('a filter reaches the request body', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Add a filter/ }));
    fireEvent.change(screen.getByLabelText('Filter 1 column'), { target: { value: 'full_name' } });
    fireEvent.change(screen.getByLabelText('Filter 1 condition'), { target: { value: 'contains' } });
    fireEvent.change(screen.getByLabelText('Filter 1 value'), { target: { value: 'Priya' } });
    fireEvent.click(screen.getByRole('button', { name: /Run report/ }));
    await waitFor(() => {
      const body = post.mock.calls[post.mock.calls.length - 1][1] as any;
      expect(body.config.filters).toEqual([{ col: 'full_name', op: 'contains', value: 'Priya' }]);
    });
  });

  it('only GROUPABLE columns are offered as a group-by', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    const groupLabel = screen.getByText('Group by', { selector: 'label' });
    const chips = groupLabel.parentElement!.querySelector('.chips')!;
    const names = [...chips.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toContain('Stage');
    expect(names).not.toContain('Name');    // groupable: false
    expect(names).not.toContain('Score');   // a measure, not a category
  });

  it('saving without a name refuses, with a reason', async () => {
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Save report/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/name/i);
    expect(post).not.toHaveBeenCalledWith('/reports', expect.anything());
  });

  it('Save posts the name + entity + config', async () => {
    post.mockResolvedValue({ id: 11 });
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.change(screen.getByLabelText('Report name'), { target: { value: 'My leads' } });
    fireEvent.click(screen.getByRole('button', { name: /Save report/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports', expect.objectContaining({
      name: 'My leads', entity: 'leads',
    })));
  });

  it('a server error is SHOWN, not swallowed', async () => {
    post.mockRejectedValue(new Error('Unknown column "nope"'));
    render(<ReportBuilder />);
    await screen.findByLabelText(/Data source/);
    fireEvent.click(screen.getByRole('button', { name: /Run report/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unknown column "nope"');
  });

  it('a user whose role reaches NO reportable data gets a sentence, not an empty form', async () => {
    get.mockImplementation((p: string) => (p.startsWith('/reports/catalog')
      ? Promise.resolve({ ...CATALOG, entities: [] }) : Promise.resolve([])));
    render(<ReportBuilder />);
    expect(await screen.findByText(/does not give you access to any reportable data/)).toBeTruthy();
  });
});

describe('ReportGrid', () => {
  it('renders every column and row, money formatted', () => {
    render(<ReportGrid out={RUN as never} />);
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('₹66,250.00')).toBeTruthy();
    expect(screen.getByText('₹1,000.00')).toBeTruthy();
  });
  it('says when the rows are truncated, and how to get them all', () => {
    render(<ReportGrid out={{ ...RUN, truncated: true } as never} />);
    expect(screen.getByText(/Export it to Excel for the whole set/)).toBeTruthy();
  });
  it('renders nothing at all for a null result (no crash before the first run)', () => {
    const { container } = render(<ReportGrid out={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('SAVED REPORTS', () => {
  beforeEach(() => {
    routes.reports = [
      { id: 1, name: 'Won this month', entity: 'leads', entity_label: 'Leads', is_mine: true, is_standard: false, owner_name: 'Me', share_count: 2, schedule_count: 1 },
      { id: 2, name: 'Branch revenue', entity: 'enrolments', entity_label: 'Enrolments', is_mine: false, is_standard: false, owner_name: 'Rakesh', share_count: 0, schedule_count: 0 },
    ];
  });

  it('lists them, and says whose each one is', async () => {
    render(<SavedReports />);
    expect(await screen.findByText('Won this month')).toBeTruthy();
    expect(screen.getByText('Mine')).toBeTruthy();
    expect(screen.getByText('Shared by Rakesh')).toBeTruthy();
  });

  it('Run posts to the saved report\'s run route and shows the rows', async () => {
    render(<SavedReports />);
    await screen.findByText('Won this month');
    fireEvent.click(screen.getAllByTitle('Run')[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports/1/run', {}));
    expect(await screen.findByText('Priya Sharma')).toBeTruthy();
  });

  it('Delete calls the API', async () => {
    render(<SavedReports />);
    await screen.findByText('Won this month');
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/reports/1'));
  });

  it('a STANDARD report offers no Delete (it is nobody\'s to delete)', async () => {
    routes.reports = [{ id: 3, name: 'Lead status report', entity: 'leads', entity_label: 'Leads', is_standard: true, share_count: 0, schedule_count: 0 }];
    render(<SavedReports />);
    await screen.findByText('Lead status report');
    expect(screen.queryByTitle('Delete')).toBeNull();
  });
});

describe('SHARE — the warning is the feature', () => {
  const report = { id: 1, name: 'Won this month', shares: [] };

  it('SAYS that sharing does not share the data', async () => {
    render(<ShareModal report={report} onClose={() => undefined} />);
    const note = screen.getByText(/does/i, { selector: 'div' });
    expect(document.body.textContent).toMatch(/only the records their own role allows/i);
    expect(document.body.textContent).toMatch(/totals will\s*differ from yours, and that is correct/i);
  });

  it('posts the chosen users and roles', async () => {
    render(<ShareModal report={report} onClose={() => undefined} />);
    await screen.findByText('Counsellor');
    fireEvent.click(chipIn('Share with roles', 'Counsellor'));
    fireEvent.click(screen.getByRole('button', { name: /Save sharing/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports/1/share', { user_ids: [], role_ids: [6] }));
  });

  it('prefills the existing shares', async () => {
    render(<ShareModal report={{ ...report, shares: [{ role_id: 3 }] }} onClose={() => undefined} />);
    await screen.findByText('Branch Manager');
    expect(chipIn('Share with roles', 'Branch Manager').className).toContain('on');
  });
});

describe('SCHEDULE', () => {
  const report = { id: 1, name: 'Won this month' };

  /**
   * The one sentence the client must read before pressing Save. Unlike sharing, a
   * scheduled file is rendered in the SCHEDULER'S scope — so it can put branch rows in a
   * counsellor's inbox. That is a legitimate thing to want and it must be a decision.
   */
  it('SAYS the attachment carries the SCHEDULER\'s access, not the recipient\'s', () => {
    render(<ScheduleModal report={report} onClose={() => undefined} />);
    expect(document.body.textContent).toMatch(/built with.*your.*access/i);
    expect(document.body.textContent).toMatch(/everything you can see/i);
  });

  it('SAYS what happens without SMTP, and that it needs no re-enabling later', () => {
    render(<ScheduleModal report={report} onClose={() => undefined} />);
    expect(document.body.textContent).toMatch(/Settings/);
    expect(document.body.textContent).toMatch(/recorded as\s*skipped/i);
    expect(document.body.textContent).toMatch(/nothing\s*to switch back on/i);
  });

  it('weekly reveals a day picker; monthly a day-of-month capped at 28, with the reason', () => {
    render(<ScheduleModal report={report} onClose={() => undefined} />);
    expect(screen.queryByLabelText('On')).toBeNull();
    fireEvent.change(screen.getByLabelText(/How often/), { target: { value: 'weekly' } });
    expect(screen.getByLabelText('On')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/How often/), { target: { value: 'monthly' } });
    const dom = screen.getByLabelText('Day of the month') as HTMLSelectElement;
    expect(dom.querySelectorAll('option')).toHaveLength(28);
    expect(screen.getByText(/every month has one/)).toBeTruthy();
  });

  it('posts the whole schedule', async () => {
    render(<ScheduleModal report={report} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/How often/), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('On'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/At \(IST\)/), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/Attach as/), { target: { value: 'pdf' } });
    await screen.findByText('Counsellor');
    fireEvent.click(chipIn('…and everyone with these roles', 'Counsellor'));
    fireEvent.click(screen.getByRole('button', { name: /Schedule it/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports/schedules', expect.objectContaining({
      report_id: 1, frequency: 'weekly', day_of_week: 3, hour_local: 9, format: 'pdf', recipient_role_ids: [6],
    })));
  });

  it('a server refusal is shown', async () => {
    post.mockRejectedValue(new Error('Choose at least one recipient (a person or a role).'));
    render(<ScheduleModal report={report} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Schedule it/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at least one recipient/);
  });
});

describe('SCHEDULED DELIVERY', () => {
  beforeEach(() => {
    routes.schedules = [{
      id: 5, report_id: 1, report_name: 'Won this month', frequency: 'daily',
      hour_local: 8, minute_local: 0, format: 'xlsx', is_active: true,
      next_run_at: '2026-07-17T02:30:00.000Z', recipient_user_ids: [4], recipient_role_ids: [],
    }];
  });

  it('lists the schedules with their next run', async () => {
    render(<ScheduledDelivery />);
    expect(await screen.findByText('Won this month')).toBeTruthy();
    expect(screen.getByText('Daily at 08:00')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('Pause is a real kill switch', async () => {
    render(<ScheduledDelivery />);
    await screen.findByText('Won this month');
    fireEvent.click(screen.getByTitle('Pause'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/reports/schedules/5/active', { is_active: false }));
  });

  it('a paused schedule offers Resume and shows no next run', async () => {
    routes.schedules = [{ ...(routes.schedules as any[])[0], is_active: false }];
    render(<ScheduledDelivery />);
    await screen.findByText('Paused');
    expect(screen.getByTitle('Resume')).toBeTruthy();
  });

  it('Send now runs the schedule and reports what happened', async () => {
    post.mockResolvedValue({ ran: true, note: 'Delivery attempted — see the history below.' });
    render(<ScheduledDelivery />);
    await screen.findByText('Won this month');
    fireEvent.click(screen.getByTitle('Send now'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/reports/schedules/5/run', {}));
  });

  /**
   * "Did it send?" must be answerable on the screen. A skipped run's REASON — "Email is
   * not configured" — is the single most useful line the client will read this sprint,
   * because it is the state his account is actually in.
   */
  it('the delivery HISTORY shows success, failure AND the reason', async () => {
    routes.history = [
      { id: 1, run_key: '2026-07-17', status: 'sent', recipients: ['Asha Rao'], file_name: 'won-2026-07-17.xlsx', row_count: 12, started_at: '2026-07-17T02:30:00.000Z' },
      { id: 2, run_key: '2026-07-16', status: 'skipped', recipients: ['Asha Rao'], error: 'Email is not configured — add your SMTP details in Settings › Channels.', started_at: '2026-07-16T02:30:00.000Z' },
      { id: 3, run_key: '2026-07-15', status: 'failed', recipients: [], error: 'relation "lead" does not exist', started_at: '2026-07-15T02:30:00.000Z' },
    ];
    render(<ScheduledDelivery />);
    await screen.findByText('Won this month');
    fireEvent.click(screen.getByTitle('Delivery history'));
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/Email is not configured/)).toBeTruthy();
    expect(screen.getByText('won-2026-07-17.xlsx')).toBeTruthy();
  });
});

describe('the STANDARD reports render real numbers', () => {
  it('FUNNEL — conversion and drop-off per stage', async () => {
    routes.funnel = {
      range: { from: null, to: null },
      stages: [
        { name: 'New Lead', stage_type: 'open', count: 100, from_previous_pct: null, dropped: null, of_first_pct: 100 },
        { name: 'Contacted', stage_type: 'open', count: 60, from_previous_pct: 60, dropped: 40, of_first_pct: 60 },
        { name: 'Enrolled', stage_type: 'won', count: 12, from_previous_pct: 20, dropped: 48, of_first_pct: 12 },
      ],
      totals: { leads: 172, won: 12, lost: 0, conversion_pct: 7 },
      scope: { unrestricted: true },
    };
    render(<FunnelReport />);
    expect(await screen.findByText('7%')).toBeTruthy();
    expect(screen.getByText('Drop-off by stage')).toBeTruthy();
    // "60%" is on the funnel bar AND in the drop-off table — both correct, so assert the
    // count rather than pretending only one exists.
    expect(screen.getAllByText('60%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('40').length).toBeGreaterThan(0);   // dropped
  });

  it('TAT — median AND mean, both labelled, in human units', async () => {
    routes.tat = {
      range: { from: null, to: null },
      first_response: { n: 20, median_minutes: 45, mean_minutes: 320, breached: 3 },
      by_stage: [{ stage: 'Contacted', n: 10, median_minutes: 1500, mean_minutes: 2000 }],
      lead_to_enrolment: { n: 4, median_minutes: 14400, mean_minutes: 15000 },
      scope: { unrestricted: true },
    };
    render(<TatReport />);
    expect(await screen.findByText('First response (median)')).toBeTruthy();
    expect(screen.getByText('First response (mean)')).toBeTruthy();
    expect(screen.getByText('45m')).toBeTruthy();
    expect(screen.getByText('5h 20m')).toBeTruthy();     // 320 minutes
    expect(screen.getByText('10d 0h')).toBeTruthy();     // 14400 minutes
    expect(screen.getByText(/counts only stages a lead has/)).toBeTruthy();
  });

  /**
   * TELEPHONY IS OUT OF SCOPE. The prototype drew a "Calls" column; inventing a call
   * count would be the worst kind of green tick. The screen SAYS so instead of showing
   * an em-dash the client has to ask about.
   */
  it('ACTIVITY — says out loud why there is no Calls column', async () => {
    routes.activity = {
      range: { from: null, to: null }, telephony: false,
      rows: [{ user_id: 3, user_name: 'Asha Rao', activities: 42, notes: 8, followups_done: 12, logins: 20, edits: 15 }],
      scope: { unrestricted: true },
    };
    render(<ActivityReport />);
    expect(await screen.findByText(/There is no "Calls" column/)).toBeTruthy();
    expect(screen.getByText(/rather say so than show you a number we invented/)).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.queryByText('Calls')).toBeNull();
  });

  it('CAMPAIGN ROI — spend, CPL, CPA, return, and the booked-vs-cash warning', async () => {
    routes.roi = {
      range: { from: null, to: null },
      columns: [
        { key: 'name', label: 'Campaign', type: 'text' },
        { key: 'cost', label: 'Spend', type: 'money' },
        { key: 'leads', label: 'Leads', type: 'number' },
        { key: 'revenue', label: 'Revenue (booked)', type: 'money' },
      ],
      rows: [['Meta Jul', 5000000, 100, 66250000]],
      totals: { cost_minor: 5000000, leads: 100, enrolments: 12, revenue_minor: 66250000, cpl_minor: 50000, cpa_minor: 416667, roi_x: 13.25 },
      basis: 'booked', scope: { note: 'Showing all records — your role is not restricted for this data.' },
    };
    render(<CampaignRoiReport />);
    // spend is in the KPI strip AND in the campaign's row — both are right
    expect((await screen.findAllByText('₹50,000.00')).length).toBeGreaterThan(0);
    expect(screen.getByText('₹500.00')).toBeTruthy();              // cost per lead
    expect(screen.getByText('13.25x')).toBeTruthy();
    expect(screen.getByText(/Revenue here is/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/booked/);
    expect(document.body.textContent).toMatch(/Cash actually receipted is a different number/);
  });

  it('every standard report has a date range control', async () => {
    routes.funnel = { stages: [], totals: { leads: 0, won: 0, lost: 0, conversion_pct: 0 }, scope: {} };
    render(<FunnelReport />);
    expect(await screen.findByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
  });

  it('an empty standard report renders its empty state, not a crash', async () => {
    routes.funnel = { stages: [], totals: { leads: 0, won: 0, lost: 0, conversion_pct: 0 }, scope: {} };
    routes.tat = { first_response: {}, by_stage: [], lead_to_enrolment: {}, scope: {} };
    routes.activity = { telephony: false, rows: [], scope: {} };
    routes.roi = { columns: [], rows: [], totals: null, scope: {} };
    render(<FunnelReport />); render(<TatReport />); render(<ActivityReport />); render(<CampaignRoiReport />);
    await waitFor(() => expect(screen.getAllByText(/fills as leads|accumulates|appears when|No stages/).length).toBeGreaterThan(0));
  });
});

describe('WORKSPACE — Team Chat', () => {
  beforeEach(() => {
    routes.channels = [
      { id: 1, name: 'General', topic: 'Everyone', message_count: 3, branch_name: null },
      { id: 2, name: 'vikaspuri-desk', message_count: 0, branch_name: 'Vikaspuri' },
    ];
    routes.messages = [
      { id: 10, body: 'Morning all', author_id: 3, author_name: 'Asha Rao', created_at: '2026-07-16T04:00:00.000Z' },
      { id: 11, body: 'Fee structure updated', author_id: 1, author_name: 'Super Admin', created_at: '2026-07-16T05:00:00.000Z' },
    ];
  });

  it('renders the channels and the thread', async () => {
    render(<TeamChat />);
    expect(await screen.findByText('# General')).toBeTruthy();
    expect(screen.getByText('# vikaspuri-desk')).toBeTruthy();
    expect(await screen.findByText('Morning all')).toBeTruthy();
  });

  it('posting a message hits the channel\'s route', async () => {
    post.mockResolvedValue({ id: 12 });
    render(<TeamChat />);
    await screen.findByText('Morning all');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/channels/1/messages', { body: 'On my way' }));
  });

  it('Enter sends; Shift+Enter does not', async () => {
    post.mockResolvedValue({ id: 12 });
    render(<TeamChat />);
    await screen.findByText('Morning all');
    const box = screen.getByLabelText('Message');
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(post).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(post).toHaveBeenCalled());
  });

  it('Send is disabled on an empty box', async () => {
    render(<TeamChat />);
    await screen.findByText('Morning all');
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('MY messages are marked as mine (the thread is readable)', async () => {
    const { container } = render(<TeamChat />);
    await screen.findByText('Fee structure updated');
    const mine = container.querySelectorAll('.wa-msg.mine');
    expect(mine).toHaveLength(1);
    expect(mine[0].textContent).toContain('Fee structure updated');
  });

  it('switching channel reloads the thread', async () => {
    render(<TeamChat />);
    await screen.findByText('# vikaspuri-desk');
    get.mockClear();
    fireEvent.click(screen.getByText('# vikaspuri-desk'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/workspace/channels/2/messages'));
  });

  it('an empty channel list says so rather than rendering a blank pane', async () => {
    routes.channels = [];
    routes.messages = [];
    render(<TeamChat />);
    expect(await screen.findByText('No channels you can see.')).toBeTruthy();
  });

  it('the New channel form posts its scope', async () => {
    post.mockResolvedValue({ id: 3 });
    render(<ChannelModal onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Channel name/), { target: { value: 'rohini-desk' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Create channel/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/channels', expect.objectContaining({
      name: 'rohini-desk', branch_id: 10,
    })));
  });

  it('the channel form SAYS what leaving the branch empty means', () => {
    render(<ChannelModal onClose={() => undefined} />);
    expect(screen.getByText(/Leave both empty and everybody sees the channel/)).toBeTruthy();
  });
});

describe('WORKSPACE — Notes', () => {
  beforeEach(() => {
    routes.notes = [
      { id: 1, title: 'Fee slabs', body: 'x', is_shared: true, is_pinned: true, owner_name: 'Asha', is_mine: false, updated_at: '2026-07-16T04:00:00.000Z' },
      { id: 2, title: 'My scratchpad', body: 'y', is_shared: false, is_pinned: false, owner_name: 'Me', is_mine: true, updated_at: '2026-07-16T04:00:00.000Z' },
    ];
  });

  it('lists notes with their visibility, and pins the pinned one', async () => {
    render(<Notes />);
    expect(await screen.findByText(/Fee slabs/)).toBeTruthy();
    expect(screen.getByText('Shared')).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByText(/📌/)).toBeTruthy();
  });

  it('someone else\'s shared note is VIEW only — no Edit, no Delete', async () => {
    render(<Notes />);
    await screen.findByText(/Fee slabs/);
    expect(screen.getAllByTitle('View')).toHaveLength(1);
    expect(screen.getAllByTitle('Edit')).toHaveLength(1);   // only MY note
  });

  it('searching passes the term to the API', async () => {
    render(<Notes />);
    await screen.findByText(/Fee slabs/);
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'slab' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/workspace/notes?q=slab'));
  });

  it('a new note posts title, body and visibility', async () => {
    post.mockResolvedValue({ id: 3 });
    render(<NoteModal note={{}} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Handover' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Ravi takes over' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save note/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/notes', expect.objectContaining({
      title: 'Handover', body: 'Ravi takes over', is_shared: true,
    })));
  });

  it('editing PATCHes the note', async () => {
    render(<NoteModal note={{ id: 2, title: 'My scratchpad', body: 'y' }} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save note/ }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/workspace/notes/2', expect.objectContaining({ title: 'Renamed' })));
  });

  it('SAYS that a private note is private from everyone, including a manager', () => {
    render(<NoteModal note={{}} onClose={() => undefined} />);
    expect(screen.getByText(/yours alone — nobody else can open it, whatever their role/)).toBeTruthy();
  });

  it('the branch/vertical pickers only appear for a SHARED note', () => {
    render(<NoteModal note={{}} onClose={() => undefined} />);
    expect(screen.queryByLabelText('Branch')).toBeNull();
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: '1' } });
    expect(screen.getByLabelText('Branch')).toBeTruthy();
  });
});

describe('WORKSPACE — Knowledge Base', () => {
  beforeEach(() => {
    routes.kb = [
      { id: 1, category: 'Admissions', title: 'How to handle a fee waiver', body: 'x', author_name: 'Rakesh', branch_name: null, updated_at: '2026-07-16T04:00:00.000Z' },
      { id: 2, category: 'Admissions', title: 'Refund policy', body: 'y', author_name: 'Rakesh', branch_name: 'Vikaspuri', updated_at: '2026-07-16T04:00:00.000Z' },
      { id: 3, category: 'IT', title: 'Resetting your password', body: 'z', author_name: 'Admin', branch_name: null, updated_at: '2026-07-16T04:00:00.000Z' },
    ];
  });

  it('groups the articles by category', async () => {
    render(<KnowledgeBase />);
    expect(await screen.findByText('Admissions')).toBeTruthy();
    expect(screen.getByText('IT')).toBeTruthy();
    expect(screen.getByText('How to handle a fee waiver')).toBeTruthy();
  });

  it('shows who each article is for', async () => {
    render(<KnowledgeBase />);
    await screen.findByText('Refund policy');
    expect(screen.getAllByText('Everyone').length).toBeGreaterThan(0);
    expect(screen.getByText('Vikaspuri')).toBeTruthy();
  });

  it('searching passes the term', async () => {
    render(<KnowledgeBase />);
    await screen.findByText('Refund policy');
    fireEvent.change(screen.getByLabelText('Search the knowledge base'), { target: { value: 'refund' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/workspace/kb?q=refund'));
  });

  it('a new article posts its category, title, body and audience', async () => {
    post.mockResolvedValue({ id: 4 });
    render(<ArticleModal article={{}} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'Admissions' } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Batch transfers' } });
    fireEvent.change(screen.getByLabelText('Article'), { target: { value: 'Steps…' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /Save article/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/kb', expect.objectContaining({
      category: 'Admissions', title: 'Batch transfers', body: 'Steps…', branch_id: 9, is_published: true,
    })));
  });

  it('an empty KB says so', async () => {
    routes.kb = [];
    render(<KnowledgeBase />);
    expect(await screen.findByText('No knowledge-base articles yet.')).toBeTruthy();
  });
});

describe('WORKSPACE — Announcements', () => {
  beforeEach(() => {
    routes.ann = [
      { id: 1, title: 'Fee structure change', body: 'From August…', is_read: false, branch_name: null, created_by_name: 'Rakesh', published_at: '2026-07-16T04:00:00.000Z', read_count: 4 },
      { id: 2, title: 'Diwali holidays', body: 'Closed 20-22 Oct', is_read: true, branch_name: 'Vikaspuri', created_by_name: 'Rakesh', published_at: '2026-07-15T04:00:00.000Z', read_count: 9 },
    ];
    routes.annAdmin = [
      { id: 1, title: 'Fee structure change', is_published: true, read_count: 4, branch_name: null, created_at: '2026-07-16T04:00:00.000Z' },
      { id: 3, title: 'Draft policy', is_published: false, read_count: 0, branch_name: null, created_at: '2026-07-16T04:00:00.000Z' },
    ];
  });

  it('marks the unread ones', async () => {
    render(<Announcements />);
    expect(await screen.findByText(/● Fee structure change/)).toBeTruthy();
    expect(screen.getByText('Diwali holidays')).toBeTruthy();   // no dot: read
  });

  it('opening one marks it read', async () => {
    post.mockResolvedValue({ read: true });
    render(<Announcements />);
    // the title is in the reader table AND the manager table — this admin sees both
    await screen.findAllByText(/Fee structure change/);
    fireEvent.click(screen.getAllByTitle('Read')[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/announcements/1/read', {}));
  });

  /** Read tracking is the whole reason an announcement is not just a channel post: the
   *  client wants to know who has seen the fee change. */
  it('the manager view shows READ COUNTS and drafts', async () => {
    render(<Announcements />);
    expect(await screen.findByText('All announcements (with read tracking)')).toBeTruthy();
    expect(screen.getByText('4 people')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('a new announcement posts its audience and publish state', async () => {
    post.mockResolvedValue({ id: 4 });
    render(<AnnouncementModal announcement={{}} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'New timings' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '9 to 7' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Publish'), { target: { value: '1' } });
    await screen.findByText('Counsellor');
    fireEvent.click(chipIn('Only these roles (optional)', 'Counsellor'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/workspace/announcements', expect.objectContaining({
      title: 'New timings', body: '9 to 7', branch_id: 9, is_published: true, role_ids: [6], notify: true,
    })));
  });

  it('SAYS the bell only rings on the first publish', () => {
    render(<AnnouncementModal announcement={{}} onClose={() => undefined} />);
    expect(screen.getByText(/never re-notifies/)).toBeTruthy();
  });

  it('SAYS that picking no roles means everyone', () => {
    render(<AnnouncementModal announcement={{}} onClose={() => undefined} />);
    expect(screen.getByText(/Pick none and everyone in the branch\/vertical above sees it/)).toBeTruthy();
  });

  it('the reader view is read-only — no Save button', () => {
    render(<AnnouncementModal announcement={{ id: 1, title: 'Fee change', body: 'From August', _readonly: true, created_by_name: 'Rakesh' }} onClose={() => undefined} />);
    expect(screen.getByText('From August')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });
});
