import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CallInsights, CallRatings, CallTranscription, QualityMonitoring } from './callintel';

/** Client 12 Nov 2026 — Communication Intelligence screens over the call pipeline. */
const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 1 } } }) }));
vi.mock('./refdata', async (importOriginal) => ({ ...(await importOriginal<typeof import('./refdata')>()), useRef_: () => ({ users: [{ id: 3, name: 'Asha', status: 'active' }], branches: [], verticals: [] }), toast: vi.fn() }));
vi.mock('./calls', async (importOriginal) => ({ ...(await importOriginal<typeof import('./calls')>()), RecordingPlayer: () => <div data-testid="player" /> }));
vi.mock('./ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ai')>()), AiIntelligence: () => <div /> }));
vi.mock('./forms', async (importOriginal) => ({ ...(await importOriginal<typeof import('./forms')>()), LeadLookup: ({ onPick }: any) => <button onClick={() => onPick(10, 'Riya')}>pick lead</button> }));

const STATUS = { stt: { configured: false, provider: null }, llm: { configured: true }, settings: { auto_transcribe: true, auto_analyse: true, language: 'auto', min_duration_s: 15, monthly_minutes_limit: 0, flag_quality_below: 50 },
  recordings: 0, recordings_30d: 0, calls_30d: 227, transcripts: { pending: 0, processing: 0, done: 1, failed: 0, skipped: 0 }, minutes_this_month: 0, insights: 1, open_flags: 1 };
const INS = { id: 5, transcript_id: 9, lead_name: 'Riya', user_name: 'Asha', call_at: '2026-11-19T10:00:00Z', summary: 'Asked about fees.', sentiment: 'negative', quality_score: 40,
  intent: 'price_shopping', flagged: true, flag_reasons: ['Quality 40/100 is below 50'], reviewed_at: null, objections: ['fees too high'], duration_s: 120 };
const post = vi.fn().mockResolvedValue({ transcript_id: 9, insight: { id: 5 } });
const put = vi.fn().mockResolvedValue({});
const gets: string[] = [];
vi.mock('./api', () => ({ api: {
  get: (p: string) => {
    gets.push(p);
    if (p.startsWith('/call-intel/status')) return Promise.resolve(STATUS);
    if (p.startsWith('/call-intel/insights/5')) return Promise.resolve({ ...INS, key_points: ['fees'], next_steps: ['send plan'], criteria: { greeting: 10 }, transcript: 'Lead: fees?', coaching: 'Explain the instalments.' });
    if (p.startsWith('/call-intel/insights')) return Promise.resolve([INS]);
    if (p.startsWith('/call-intel/ratings')) return Promise.resolve([{ user_id: 3, user_name: 'Asha', calls: 4, avg_quality: 72, positive: 2, negative: 1, flagged: 1, positive_pct: 50, greeting: 15 }]);
    if (p.startsWith('/call-intel/overview')) return Promise.resolve({ kpis: { calls: 1 }, trend: [], objections: [], intents: [] });
    if (p.startsWith('/call-intel/queue')) return Promise.resolve([{ id: 9, status: 'failed', recording_id: 2, error: 'OpenAI HTTP 401', lead_name: 'Riya', user_name: 'Asha' }]);
    if (p.startsWith('/call-intel/recordings/untranscribed')) return Promise.resolve([{ id: 2, file_name: 'call.m4a', duration_s: 90 }]);
    return Promise.resolve([]);
  },
  post: (p: string, b?: unknown) => post(p, b), put: (p: string, b?: unknown) => put(p, b), patch: vi.fn(), del: vi.fn(),
} }));

beforeEach(() => { cleanup(); post.mockClear(); put.mockClear(); gets.length = 0; can.mockReturnValue(true); });

describe('Communication Intelligence', () => {
  it('the banner says exactly what is missing (provider key, phone app)', async () => {
    render(<CallInsights />);
    const b = await screen.findByTestId('ci-banner');
    expect(b.textContent).toMatch(/speech-to-text provider/);
    expect(b.textContent).toMatch(/Android app/);
    expect(b.textContent).toMatch(/227 calls logged/);
  });

  it('Call Insights lists calls; opening one shows the read and a manager can mark it reviewed', async () => {
    render(<CallInsights />);
    fireEvent.click(await screen.findByTestId('ci-open-5'));
    expect(await screen.findByTestId('ci-insight')).toBeTruthy();
    expect(screen.getByText('Explain the instalments.', { exact: false })).toBeTruthy();
    fireEvent.change(screen.getByTestId('ci-review-note'), { target: { value: 'Coached on fees' } });
    fireEvent.click(screen.getByTestId('ci-review'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/call-intel/insights/5/review', { note: 'Coached on fees' }));
  });

  it('Call Ratings shows each counsellor with the rubric', async () => {
    render(<CallRatings />);
    expect((await screen.findAllByText('Asha')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('72/100').length).toBeGreaterThan(0);   // chart label + table
    expect(screen.getByText('15/20')).toBeTruthy();
  });

  it('Quality Monitoring opens on the calls waiting for review', async () => {
    render(<QualityMonitoring />);
    await screen.findByText('Quality 40/100 is below 50');
    expect(gets.some((g) => g.startsWith('/call-intel/insights') && g.includes('flagged=open'))).toBe(true);
  });

  it('Call Transcription: paste a transcript for a lead, retry a failed one, queue a recording, save settings', async () => {
    render(<CallTranscription />);
    fireEvent.click(await screen.findByText('pick lead'));
    fireEvent.change(screen.getByTestId('ci-paste-text'), { target: { value: 'Counsellor: Hello Riya, this is Asha from BCL. Lead: what are the fees?' } });
    fireEvent.click(screen.getByTestId('ci-paste'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/call-intel/paste', expect.objectContaining({ lead_id: 10 })));
    fireEvent.click(await screen.findByText('Retry'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/call-intel/transcripts/9/retry', {}));
    fireEvent.click(screen.getByText('Transcribe'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/call-intel/recordings/2/transcribe', {}));
  });
});
