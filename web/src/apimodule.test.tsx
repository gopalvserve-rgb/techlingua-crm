/**
 * UI test for Administration › API (the Developer / API module, jsdom).
 *
 * Asserts what the admin actually sees and clicks: the key list with masked
 * values and status, the one-time reveal of a freshly generated key, the
 * enable/disable toggle calling the endpoint, the docs page, and the log view.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ApiModule from './apimodule';

let CAN: (p: string) => boolean = () => true;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (p: string) => CAN(p), me: { user: { id: 1 } } }) }));

const REF = {
  campaigns: [{ id: 3, name: 'Partner Web', pipeline_id: 2 }],
  sources: [{ id: 7, name: 'Website', campaign_id: 3 }],
  branches: [], verticals: [], pipelines: [], users: [], courses: [], statuses: [],
  followupTypes: [], dispositions: [], budgets: [], states: [], cities: [], masterSources: [],
  trainings: [], visitPurposes: [], walkinStatuses: [], loaded: true, reload: () => undefined,
};
const toastFn = vi.fn();
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: (t: string, e?: boolean) => toastFn(t, e) };
});

const KEYS = [
  { id: 1, name: 'Partner integration', key_masked: 'tlk_live_ab12…9xyz', key_prefix: 'tlk_live_ab12',
    scopes: ['lead:create', 'lead:read'], record_scope: 'all',
    default_campaign_id: 3, default_source_id: 7, default_campaign_name: 'Partner Web', default_source_name: 'Website',
    is_active: true, revoked: false, status: 'active', last_used_at: '2026-07-24T09:00:00Z',
    created_at: '2026-07-20T09:00:00Z', calls_total: 12, calls_failed: 1 },
];
const DOCS = {
  base_url: '/api/public-api',
  auth: 'Send your key as Authorization: Bearer <key> or X-API-Key.',
  rate_limit: '60 requests per minute per key.',
  endpoints: [
    { method: 'POST', path: '/api/public-api/leads', summary: 'Create a lead', description: 'Push a new lead.',
      headers: ['Authorization: Bearer tlk_live_xxx'], params: [{ name: 'name', required: true, note: 'Full name.' }],
      exampleRequest: { name: 'Asha', phone: '+91' }, exampleResponse: { ok: true, lead_id: 1 } },
    { method: 'GET', path: '/api/public-api/leads', summary: 'List leads', description: 'Recent leads.',
      headers: ['Authorization: Bearer tlk_live_xxx'], exampleResponse: { count: 0, leads: [] } },
  ],
};
const LOGS = [
  { id: 5, method: 'POST', endpoint: '/api/public-api/leads', status_code: 201, outcome: 'ok',
    reason: 'Lead created.', ip: '1.2.3.4', lead_id: 99, created_at: '2026-07-24T09:00:00Z',
    key_prefix: 'tlk_live_ab12', key_name: 'Partner integration' },
  { id: 6, method: 'POST', endpoint: '/api/public-api/leads', status_code: 401, outcome: 'rejected',
    reason: 'This API key is disabled.', ip: '9.9.9.9', created_at: '2026-07-24T08:00:00Z', key_prefix: 'tlk_live_zz00' },
];

const get = vi.fn(async (path: string) => {
  if (path === '/api-keys') return KEYS;
  if (path === '/api-keys/docs') return DOCS;
  if (path.startsWith('/api-keys/logs')) return LOGS;
  throw new Error(`unexpected GET ${path}`);
});
const post = vi.fn(async (_p: string, _b?: unknown) => ({
  id: 2, name: 'New key', key_masked: 'tlk_live_cd34…', plaintext: 'tlk_live_SUPERSECRETVALUE1234567890abcdefghij',
  scopes: ['lead:create', 'lead:read'], status: 'active', is_active: true, revoked: false,
  created_at: 'now', last_used_at: null, default_campaign_id: null, default_source_id: null,
}));
const patch = vi.fn(async (_p: string, _b?: unknown) => ({}));
const del = vi.fn(async (_p: string) => ({}));
vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), del: (p: string) => del(p), put: vi.fn() },
  getToken: () => 'test-token',
}));
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

describe('Administration › API module', () => {
  beforeEach(() => { cleanup(); CAN = () => true; get.mockClear(); post.mockClear(); patch.mockClear(); del.mockClear(); toastFn.mockClear(); });

  it('renders the keys tab with the masked key and its status', async () => {
    render(<ApiModule />);
    expect(await screen.findByText('Partner integration')).toBeTruthy();
    expect(screen.getByText('tlk_live_ab12…9xyz')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
  });

  it('generate shows the full key ONCE', async () => {
    render(<ApiModule />);
    fireEvent.click(await screen.findByText('Generate API key'));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'New key' } });
    fireEvent.click(screen.getByText('Generate key'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api-keys', expect.objectContaining({ name: 'New key' })));
    const field = await screen.findByTestId('new-api-key');
    expect((field as HTMLInputElement).value).toContain('tlk_live_SUPERSECRET');
  });

  it('the enable/disable toggle calls the endpoint', async () => {
    render(<ApiModule />);
    fireEvent.click(await screen.findByText('Disable'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api-keys/1', { is_active: false }));
  });

  it('the documentation tab renders the endpoints', async () => {
    render(<ApiModule />);
    fireEvent.click(await screen.findByText('Documentation'));
    expect(await screen.findByText('Create a lead')).toBeTruthy();
    expect(screen.getAllByText('/api/public-api/leads').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('60 requests per minute per key.')).toBeTruthy();
  });

  it('the request log tab renders accepted AND rejected calls', async () => {
    render(<ApiModule />);
    fireEvent.click(await screen.findByText('Request Log'));
    expect(await screen.findByText(/Lead created/)).toBeTruthy();
    expect(screen.getByText('This API key is disabled.')).toBeTruthy();
    expect(screen.getByText('201')).toBeTruthy();
    expect(screen.getByText('401')).toBeTruthy();
  });

  it('a non-admin (no api.read) sees a permission notice, not the keys', async () => {
    CAN = () => false;
    render(<ApiModule />);
    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();
  });
});
