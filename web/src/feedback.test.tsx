import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { draft } from './feedbackrec';
import { FeedbackPage, FeedbackWidget, browserOf } from './feedback';

/** 22 Nov 2026 — the Feedback button on every page and Help & Support › Feedback. */
const can = vi.fn((_k: string) => false);
let meId = 2;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: meId } } }) }));
vi.mock('./refdata', async (importOriginal) => ({ ...(await importOriginal<typeof import('./refdata')>()), toast: vi.fn() }));

const NOTE = (over: any = {}) => ({
  id: 10, reference: 'FB-2026-010', page_path: '/m/leads/all', page_title: 'Marketing › Leads', message: 'The deadline column is empty',
  kind: 'ISSUE', status: 'OPEN', created_by: 2, viewport: '1440x900', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537',
  resolution: null, resolved_at: null, created_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
  author: { id: 2, name: 'ZZTEST Asha', role: 'Counsellor', branch: 'Vikaspuri' }, resolver: null,
  messages: [], screenshots: [{ id: 5, kind: 'image', file_name: 'shot.png', mime: 'image/png', size_bytes: 1000 }], recordings: [],
  ...over,
});
let notes: any[] = [];
let scopeItems: any[] = [];
const post = vi.fn(async (p: string, _b?: unknown) => (p === '/feedback' ? { id: 77, reference: 'FB-2026-077' } : NOTE()));
const patch = vi.fn(async (_p: string, _b?: unknown) => NOTE());
const gets: string[] = [];
vi.mock('./api', () => ({
  getToken: () => 't',
  ApiError: class ApiError extends Error { constructor(public status: number, m: string) { super(m); } },
  api: {
    get: (p: string) => {
      gets.push(p);
      if (p === '/feedback/summary') return Promise.resolve({ pending: notes.filter((n) => n.status === 'OPEN').length, answered: notes.filter((n) => n.status === 'ANSWERED').length, resolved: 0, wont_fix: 0 });
      if (p === '/feedback/scope') return Promise.resolve(scopeItems);
      if (/^\/feedback\/files\/\d+$/.test(p)) return Promise.resolve({ url: 'https://r2.example/signed' });
      if (/^\/feedback\/\d+$/.test(p)) return Promise.resolve(notes.find((n) => `/feedback/${n.id}` === p));
      if (p.startsWith('/feedback')) return Promise.resolve(notes);
      return Promise.resolve([]);
    },
    post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b),
  },
}));
const fetchMock = vi.fn(async (_u: string, _i?: any) => ({ ok: true, text: async () => JSON.stringify({ id: 1, kind: 'image' }) }));
(globalThis as any).fetch = fetchMock;
(globalThis as any).URL.createObjectURL = () => 'blob:x';
(globalThis as any).URL.revokeObjectURL = () => {};

beforeEach(() => { cleanup(); draft.message = ''; draft.kind = 'ISSUE'; draft.shots = []; post.mockClear(); patch.mockClear(); fetchMock.mockClear(); gets.length = 0; can.mockImplementation(() => false); meId = 2; notes = [NOTE()]; });

describe('the Feedback button', () => {
  it('files a note pinned to the page — kind, words, window size, browser — then uploads the screenshot as raw bytes', async () => {
    render(<MemoryRouter initialEntries={['/m/leads/all?lead=12']}><FeedbackWidget pageTitle="Marketing › Leads" /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('fb-launch'));
    expect(screen.getByTestId('fb-panel').textContent).toContain('/m/leads/all');
    fireEvent.click(screen.getByText('Could be better'));
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'Show the deadline here' } });
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('fb-file'), { target: { files: [png] } });
    fireEvent.click(screen.getByTestId('fb-send'));
    await waitFor(() => expect(screen.getByTestId('fb-sent').textContent).toContain('FB-2026-077'));
    const body = post.mock.calls.find((c) => c[0] === '/feedback')![1] as any;
    expect(body).toMatchObject({ page_path: '/m/leads/all', page_title: 'Marketing › Leads', message: 'Show the deadline here', kind: 'SUGGESTION' });
    expect(body.viewport).toMatch(/^\d+x\d+$/);
    expect(body.user_agent).toBeTruthy();
    const up = fetchMock.mock.calls.find((c) => String(c[0]).includes('/feedback/77/screenshots'))!;
    expect(String(up[0])).toContain('name=shot.png');
    expect(up[1].headers['Content-Type']).toBe('application/octet-stream');
    expect(up[1].body).toBe(png);
  });

  it('pasting a screenshot adds it; Send waits for a few words; earlier notes on this page are listed', async () => {
    render(<MemoryRouter initialEntries={['/m/leads/all']}><FeedbackWidget /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('fb-launch'));
    expect((screen.getByTestId('fb-send') as HTMLButtonElement).disabled).toBe(true);
    const png = new File([new Uint8Array([1])], 'pasted.png', { type: 'image/png' });
    const ev = new Event('paste') as any; ev.clipboardData = { files: [png] };
    act(() => { window.dispatchEvent(ev); });
    expect(await screen.findByAltText('Screenshot 1')).toBeTruthy();
    expect(await screen.findByText('Already reported here')).toBeTruthy();
    expect(gets).toContain('/feedback?page_path=%2Fm%2Fleads%2Fall');
  });

  it('an unsent note survives a page change — words and screenshots — and the button says it is not sent yet (23 Nov 2026)', async () => {
    function GoElsewhere() { const nav = useNavigate(); return <button onClick={() => nav('/m/dash/overview')}>elsewhere</button>; }
    render(<MemoryRouter initialEntries={['/m/leads/all']}><GoElsewhere /><FeedbackWidget pageTitle="Marketing › Leads" /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('fb-launch'));
    fireEvent.change(screen.getByTestId('fb-message'), { target: { value: 'Half-written note' } });
    const png = new File([new Uint8Array([1])], 'keep.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('fb-file'), { target: { files: [png] } });
    fireEvent.click(screen.getByText('elsewhere'));
    expect(screen.queryByTestId('fb-panel')).toBeNull();
    expect(screen.getByTestId('fb-launch').textContent).toContain('not sent yet');
    fireEvent.click(screen.getByTestId('fb-launch'));
    expect((screen.getByTestId('fb-message') as HTMLTextAreaElement).value).toBe('Half-written note');
    expect(screen.getByAltText('Screenshot 1')).toBeTruthy();
    expect(screen.getByTestId('fb-send')).toBeTruthy();
  });

  it('says who the browser is, briefly', () => {
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBe('Chrome on Windows');
    expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone / iPad');
  });
});

describe('Help & Support › Feedback', () => {
  it('shows Pending / Answered / Resolved with counts; a reporter replies and accepts their own note', async () => {
    notes = [NOTE({ status: 'ANSWERED', messages: [{ id: 1, body: 'Fixed — please check', is_answer: true, created_at: new Date().toISOString(), author: { id: 1, name: 'Team', role: 'Super Admin' } }] }),
      NOTE({ id: 11, reference: 'FB-2026-011', status: 'OPEN' })];
    render(<FeedbackPage />);
    expect((await screen.findByTestId('fb-tab-PENDING')).textContent).toContain('1');
    expect(screen.getByTestId('fb-tab-ANSWERED').textContent).toContain('1');
    fireEvent.click(screen.getByTestId('fb-tab-ANSWERED'));
    fireEvent.click(await screen.findByTestId('fb-row-10'));
    expect((await screen.findByTestId('fb-detail')).textContent).toContain('Fixed — please check');
    expect(screen.queryByTestId('fb-resolve')).toBeNull();     // not the team
    fireEvent.change(screen.getByTestId('fb-reply'), { target: { value: 'Still empty on page 2' } });
    fireEvent.click(screen.getByTestId('fb-reply-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/feedback/10/replies', { body: 'Still empty on page 2', answer: false }));
    fireEvent.click(screen.getByTestId('fb-accept'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/feedback/10/accept', {}));
  });

  it('a note sent from the button shows on the open Feedback page at once', async () => {
    notes = [];
    render(<FeedbackPage />);
    expect(await screen.findByText(/Nothing reported yet/)).toBeTruthy();
    notes = [NOTE()];
    act(() => { window.dispatchEvent(new CustomEvent('tl:feedback-sent', { detail: { id: 10 } })); });
    expect(await screen.findByTestId('fb-row-10')).toBeTruthy();
  });

  it('the team answers, acknowledges, resolves with an outcome note — and opens a note from ?fb=', async () => {
    can.mockImplementation((k: string) => k === 'feedback.manage');
    meId = 1;
    render(<FeedbackPage />);
    fireEvent.click(await screen.findByTestId('fb-row-10'));
    expect(await screen.findByTestId('fb-shot-5')).toBeTruthy();       // the screenshot, by a signed link
    expect(screen.queryByTestId('fb-accept')).toBeNull();               // only the reporter accepts
    fireEvent.change(screen.getByTestId('fb-reply'), { target: { value: 'Fixed and tested.' } });
    fireEvent.click(screen.getByTestId('fb-reply-send'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/feedback/10/replies', { body: 'Fixed and tested.', answer: false }));
    fireEvent.click(screen.getByTestId('fb-ack'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/feedback/10', { status: 'ACKNOWLEDGED', resolution: undefined }));
    fireEvent.change(screen.getByTestId('fb-resolution'), { target: { value: 'Deadline column fixed' } });
    fireEvent.click(screen.getByTestId('fb-resolve'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/feedback/10', { status: 'RESOLVED', resolution: 'Deadline column fixed' }));
  });
});
