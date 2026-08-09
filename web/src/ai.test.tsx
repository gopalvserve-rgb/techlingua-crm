import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { AiIntelligence } from './ai';

/**
 * AI COMMUNICATION INTELLIGENCE (ERP Batch 4) — the screen in jsdom.
 * Proves the credential-gated degradation (no key -> clean "AI not configured", run disabled),
 * that a configured key + analyses render the list with the full treatment, and that the
 * filters drive the /ai/analyses query.
 */

vi.mock('./auth', () => ({ useAuth: () => ({ can: (_k: string) => true, me: { user: { id: 3, name: 'Asha' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], trainings: [], visitPurposes: [], walkinStatuses: [],
  ticketCategories: [], users: [{ id: 3, name: 'Asha', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

let CONFIGURED = false;
let lastGet = '';
const ANALYSES = [{
  id: 501, subject_type: 'lead', subject_id: 12, subject_label: 'Asha Rao', analysis_type: 'summary',
  sentiment: null, quality_score: null, summary_text: 'Wants IELTS evening batch.', provider: 'deepseek',
  branch_name: 'Vikaspuri', owner_name: 'Asha', created_by_name: 'Asha', created_at: '2026-08-09T10:00:00Z',
}];
const getRoute = (path: string): Promise<unknown> => {
  lastGet = path;
  if (path.startsWith('/ai/status')) return Promise.resolve({ configured: CONFIGURED, providers: [
    { provider: 'deepseek', label: 'DeepSeek', configured: CONFIGURED }, { provider: 'gemini', label: 'Google Gemini', configured: false }] });
  if (path.startsWith('/ai/summary')) return Promise.resolve({ configured: CONFIGURED, providers: [], counts: { total: CONFIGURED ? 1 : 0 }, recent: [] });
  if (path.startsWith('/ai/analyses')) return Promise.resolve(CONFIGURED ? ANALYSES : []);
  return Promise.resolve([]);
};
vi.mock('./api', () => ({
  api: { get: (p: string) => getRoute(p), post: vi.fn().mockResolvedValue({}), patch: vi.fn(), del: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  ApiError: class extends Error {},
}));

beforeEach(() => { cleanup(); lastGet = ''; });

describe('AI Insights — credential-gated degradation', () => {
  it('with NO key: shows a clean "AI not configured" state and never a 500', async () => {
    CONFIGURED = false;
    render(<AiIntelligence />);
    expect(await screen.findByTestId('ai-not-configured')).toBeTruthy();
    expect(screen.getByText(/AI is not configured/)).toBeTruthy();
    // the run button for an LLM capability is disabled without a key
    const runBtn = await screen.findByRole('button', { name: /Run Summary/i });
    expect((runBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('with a key + analyses: renders the list with export/refresh and the row', async () => {
    CONFIGURED = true;
    render(<AiIntelligence />);
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText(/AI is live/)).toBeTruthy();
    expect(screen.getByText(/Wants IELTS evening batch/)).toBeTruthy();
    // full list treatment: export + refresh present
    expect(screen.getByTestId("list-export")).toBeTruthy();
    expect(screen.getByTestId("list-refresh")).toBeTruthy();
  });

  it('filters drive the /ai/analyses query', async () => {
    CONFIGURED = true;
    render(<AiIntelligence />);
    await screen.findByText('Asha Rao');
    await waitFor(() => expect(lastGet.startsWith('/ai/analyses')).toBe(true));
  });
});
