import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { draft } from './feedbackrec';
import { FeedbackPage, FeedbackWidget } from './feedback';
import { matchScope } from './feedbackscope';

/**
 * 23 Nov 2026 — "while adding a feedback, if it's new or out of scope, show the message: we can't
 * take this because it's out of scope — refer the document, this task is not available".
 */
const can = vi.fn((_k: string) => false);
let meId = 2;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: meId } } }) }));
vi.mock('./refdata', async (importOriginal) => ({ ...(await importOriginal<typeof import('./refdata')>()), toast: vi.fn() }));

const CALLS = {
  id: 1, title: 'Call transfer, conference calling and call routing', is_active: true, sort_order: 10,
  reference: 'Client Requirements Discovery Document, §7 Calls (Telephony) › Transfer / Conference / Routing',
  doc_says: 'answered "Not required"', phrases: ['call transfer', 'conference call', 'call routing'], page_paths: ['/m/calls/transfer'],
  notice: 'Out of scope — we can\'t take this. "Call transfer, conference calling and call routing" is not available in this project. Please refer to the scope document: Client Requirements Discovery Document, §7 Calls (Telephony) › Transfer / Conference / Routing — answered "Not required".',
};
const HIRING = { ...CALLS, id: 6, title: 'Staff hiring and recruitment', phrases: ['staff hiring'], page_paths: ['/m/hr/hiring'], notice: 'Out of scope — hiring …' };

const NOTE = (over: any = {}) => ({
  id: 10, reference: 'FB-2026-010', page_path: '/m/calls/dialer', page_title: 'Calls › Dialer', message: 'Please add call transfer',
  kind: 'SUGGESTION', status: 'OPEN', created_by: 2, viewport: '1440x900', user_agent: 'Chrome/130', scope_item_id: null, scope_auto: false,
  resolution: null, resolved_at: null, created_at: new Date(Date.now() - 3600e3).toISOString(),
  author: { id: 2, name: 'ZZTEST Asha', role: 'Counsellor', branch: 'Vikaspuri' }, resolver: null,
  messages: [], screenshots: [], recordings: [], ...over,
});
let notes: any[] = [];
const post = vi.fn(async (p: string, _b?: unknown): Promise<any> => (p === '/feedback' ? { id: 77, reference: 'FB-2026-077', status: 'OPEN', resolution: null } : NOTE()));
const patch = vi.fn(async (_p: string, _b?: unknown): Promise<any> => NOTE());
vi.mock('./api', () => ({
  getToken: () => 't',
  ApiError: class ApiError extends Error { constructor(public status: number, m: string) { super(m); } },
  api: {
    get: (p: string) => {
      if (p === '/feedback/scope') return Promise.resolve([CALLS, HIRING]);
      if (p === '/feedback/summary') return Promise.resolve({ pending: 0, answered: 0, resolved: 0, wont_fix: 0, out_of_scope: notes.filter((n) => n.status === 'OUT_OF_SCOPE').length });
      if (/^\/feedback\/\d+$/.test(p)) return Promise.resolve(notes.find((n) => `/feedback/${n.id}` === p));
      if (p.startsWith('/feedback')) return Promise.resolve(notes);
      return Promise.resolve([]);
    },
    post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b),
  },
}));
(globalThis as any).fetch = vi.fn(async () => ({ ok: true, text: async () => '{}' }));

beforeEach(() => { cleanup(); draft.message = ''; draft.kind = 'ISSUE'; draft.shots = []; post.mockClear(); patch.mockClear(); can.mockImplementation(() => false); meId = 2; notes = [NOTE()]; });

const openPanel = (path = '/m/calls/dialer') => {
  render(<MemoryRouter initialEntries={[path]}><FeedbackWidget pageTitle="Calls › Dialer" /></MemoryRouter>);
  fireEvent.click(screen.getByTestId('fb-launch'));
};

describe('while the note is written', () => {
  it('a request on the scope list shows "Out of scope — we can\'t take this", what is not available and the document to refer to', async () => {
    openPanel();
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'Please add Call Transfer to another counsellor' } });
    const box = await screen.findByTestId('fb-scope');
    expect(box.textContent).toContain("Out of scope — we can't take this.");
    expect(box.textContent).toContain('“Call transfer, conference calling and call routing” is not available in this project');
    expect(box.textContent).toContain('Please refer to the scope document: Client Requirements Discovery Document, §7 Calls (Telephony) › Transfer / Conference / Routing — answered "Not required".');
    expect(screen.getByTestId('fb-send').textContent).toContain('Send anyway');
  });

  it('a problem on a screen the client has is not turned away (no loose matches)', async () => {
    openPanel();
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'The batch transfer screen does not save, and course transfer shows the old fee' } });
    await waitFor(() => expect(screen.getByTestId('fb-send').textContent).toContain('Send to the team'));
    expect(screen.queryByTestId('fb-scope')).toBeNull();
  });

  it('a note left on a screen of an out-of-scope item says so, whatever it says', async () => {
    openPanel('/m/hr/hiring');
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'this page is empty' } });
    expect((await screen.findByTestId('fb-scope')).textContent).toContain('(this screen belongs to it)');
  });

  it('asking for something new says only what the agreed documents cover can be taken', () => {
    openPanel();
    expect(screen.queryByTestId('fb-new-hint')).toBeNull();
    fireEvent.click(screen.getByText('Could be better'));
    expect(screen.getByTestId('fb-new-hint').textContent).toMatch(/Only what the agreed scope documents cover can be taken/);
  });

  it('sent anyway: the panel says it was recorded as out of scope, with the scope document\'s words', async () => {
    post.mockImplementationOnce(async () => ({ id: 78, reference: 'FB-2026-078', status: 'OUT_OF_SCOPE', resolution: CALLS.notice }));
    openPanel();
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'we need conference calls' } });
    await screen.findByTestId('fb-scope');
    fireEvent.click(screen.getByTestId('fb-send'));
    expect((await screen.findByTestId('fb-sent-scope')).textContent).toBe(CALLS.notice);
    expect(screen.getByTestId('fb-sent').textContent).toContain('FB-2026-078');
    expect(screen.getByTestId('fb-sent').textContent).toContain('Out of scope');
  });
});

describe('Help & Support › Feedback', () => {
  it('out-of-scope notes have their own tab, and the note shows the scope document\'s words', async () => {
    notes = [NOTE({ status: 'OUT_OF_SCOPE', scope_item_id: 1, scope_auto: true, resolution: CALLS.notice })];
    render(<FeedbackPage />);
    expect((await screen.findByTestId('fb-tab-OUT_OF_SCOPE')).textContent).toContain('1');
    fireEvent.click(screen.getByTestId('fb-tab-OUT_OF_SCOPE'));
    fireEvent.click(await screen.findByTestId('fb-row-10'));
    expect((await screen.findByTestId('fb-scope-outcome')).textContent).toContain(CALLS.notice);
    expect(screen.getByTestId('fb-detail').textContent).toContain('set by itself when it was sent');
    expect(screen.getByTestId('fb-detail').textContent).toContain('reply and the team will look again');
  });

  it('the team marks a note out of scope — against a scope-list item, with its own note', async () => {
    can.mockImplementation((k: string) => k === 'feedback.manage');
    meId = 1;
    render(<FeedbackPage />);
    fireEvent.click(await screen.findByTestId('fb-row-10'));
    fireEvent.click(await screen.findByTestId('fb-scope'));
    const sel = await screen.findByTestId('fb-scope-item') as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBe(3));     // New request + the two items
    expect(screen.getByTestId('fb-scopepick').textContent).toContain('new request that is not in the agreed scope documents');
    fireEvent.change(sel, { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('fb-resolution'), { target: { value: 'Raise it as a change request.' } });
    expect(screen.getByTestId('fb-scopepick').textContent).toContain(`${CALLS.notice} Note from the team: Raise it as a change request.`);
    fireEvent.click(screen.getByTestId('fb-scope-confirm'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/feedback/10', { status: 'OUT_OF_SCOPE', scope_item_id: 1, resolution: 'Raise it as a change request.' }));
  });

  it('the scope list: everyone reads it; the team adds an item (words one per line) and switches one off', async () => {
    render(<FeedbackPage />);
    fireEvent.click(await screen.findByTestId('fb-scope-list'));
    const modal = await screen.findByTestId('fb-scope-modal');
    expect(await screen.findByText('Call transfer, conference calling and call routing')).toBeTruthy();
    expect(modal.textContent).toContain('answered "Not required"');
    expect(screen.queryByTestId('fb-scope-add')).toBeNull();          // a reporter only reads it
    cleanup();

    can.mockImplementation((k: string) => k === 'feedback.manage');
    render(<FeedbackPage />);
    fireEvent.click(await screen.findByTestId('fb-scope-list'));
    fireEvent.click(await screen.findByTestId('fb-scope-toggle-6'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/feedback/scope/6', { is_active: false }));
    fireEvent.click(screen.getByTestId('fb-scope-add'));
    fireEvent.change(screen.getByLabelText('What is out of scope'), { target: { value: 'Tally export' } });
    fireEvent.change(screen.getByLabelText('Where the scope document says so'), { target: { value: 'Client Requirements Discovery Document, §6 › Collection reports' } });
    fireEvent.change(screen.getByLabelText(/Words in a note that mean it/), { target: { value: 'tally export\ntally sync' } });
    expect(screen.getByTestId('fb-scope-form').textContent).toContain('“Tally export” is not available in this project');
    fireEvent.click(screen.getByTestId('fb-scope-save'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/feedback/scope', expect.objectContaining({
      title: 'Tally export', phrases: ['tally export', 'tally sync'], page_paths: [], is_active: true,
    })));
  });
});

describe('the same test as the API', () => {
  it('whole words, plurals, screens, switched-off items', () => {
    expect(matchScope([CALLS], 'conference calls please')?.item.id).toBe(1);
    expect(matchScope([CALLS], 'call transferred count')).toBeNull();
    expect(matchScope([CALLS], 'x', '/m/calls/transfer')?.by).toBe('page');
    expect(matchScope([CALLS], 'x', '/m/calls/transferlist')).toBeNull();
    expect(matchScope([{ ...CALLS, is_active: false }], 'call transfer')).toBeNull();
  });
});
