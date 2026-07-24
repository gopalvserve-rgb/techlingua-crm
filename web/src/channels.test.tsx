/**
 * UI test for the Lead Capture Channels screen (jsdom).
 *
 * The DEF-2 lesson, applied: an API-only suite cannot see a broken screen. These
 * tests assert what Gopal will actually look at and click when he wires Meta up —
 * the status badges, the webhook URL and verify token he must copy, the "not
 * configured" state of the Google Sheet, the website snippet, the event log with
 * its rejection reasons, and the RBAC gating of the Configure/Pause buttons.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Channels from './channels';

let CAN: (p: string) => boolean = () => true;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (p: string) => CAN(p), me: { user: { id: 1 } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 2, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 3, name: 'Meta Jul', pipeline_id: 2 }],
  sources: [{ id: 4, name: 'Meta Lead Ads', campaign_id: 3 }],
  users: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  states: [], cities: [], loaded: true, reload: () => undefined,
};

const toastFn = vi.fn((_t: string, _e?: boolean) => undefined);
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: (t: string, e?: boolean) => toastFn(t, e) };
});

const PROVIDERS = [
  { key: 'meta', label: 'Meta Lead Ads (Facebook / Instagram)', blurb: 'Real-time lead-gen forms.',
    kind: 'webhook', endpoint: 'meta',
    config: [{ key: 'graph_version', label: 'Graph API version', type: 'text' }],
    secrets: [
      { key: 'verify_token', label: 'Verify token', type: 'password', required: true, generated: true },
      { key: 'app_secret', label: 'App secret', type: 'password', required: true },
      { key: 'page_access_token', label: 'Page access token', type: 'password', required: true },
    ],
    setup: ['Meta App Dashboard › Webhooks › Page › subscribe to leadgen.'] },
  { key: 'google_ads', label: 'Google Ads lead form extension', blurb: 'Google lead form assets.',
    kind: 'webhook', endpoint: 'google',
    config: [{ key: 'ingest_test_leads', label: "Import Google's test leads too", type: 'bool' }],
    secrets: [{ key: 'google_key', label: 'Webhook key', type: 'password', required: true, generated: true }],
    setup: ['Google Ads › lead form asset › Webhook integration.'] },
  { key: 'website', label: 'Website form', blurb: 'A public endpoint your website posts to.',
    kind: 'webhook', endpoint: 'form',
    config: [{ key: 'allowed_origins', label: 'Allowed website origins', type: 'list', required: true }],
    secrets: [], setup: ['Paste the snippet into your site.'] },
  { key: 'google_sheet', label: 'Google Sheet pull', blurb: 'We poll a sheet on a schedule.',
    kind: 'poll', endpoint: null,
    config: [{ key: 'sheet_id', label: 'Spreadsheet ID', type: 'text', required: true }],
    secrets: [{ key: 'service_account_json', label: 'Service-account JSON', type: 'textarea' }],
    setup: ['Share the sheet with the service account.'] },
];

const CHANNELS = [
  {
    id: 1, provider: 'meta', provider_label: 'Meta Lead Ads (Facebook / Instagram)', kind: 'webhook',
    name: 'Meta — Vikaspuri IELTS',
    branch_id: 9, vertical_id: 1, pipeline_id: 2, campaign_id: 3, source_id: 4,
    branch_name: 'Vikaspuri', vertical_name: 'BCL', pipeline_name: 'Admissions',
    campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads',
    public_key: 'META-KEY-1', webhook_path: '/api/webhooks/meta/META-KEY-1',
    config: { graph_version: 'v21.0' }, secrets_masked: { app_secret: '••••••cret', page_access_token: '••••••oken' },
    is_active: true, status: 'connected', missing: [],
    last_event_at: '2026-07-14T09:00:00Z', last_lead_at: '2026-07-14T09:00:00Z',
    last_lead_id: 501, last_lead_name: 'Priya Sharma', last_error: null,
    events_24h: 4, failures_24h: 1, leads_30d: 12,
  },
  {
    id: 4, provider: 'google_sheet', provider_label: 'Google Sheet pull', kind: 'poll',
    name: 'Walk-in sheet',
    branch_id: 9, vertical_id: 1, pipeline_id: 2, campaign_id: 3, source_id: 4,
    branch_name: 'Vikaspuri', vertical_name: 'BCL', campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads',
    public_key: 'SHEET-KEY', webhook_path: null,
    config: {}, secrets_masked: {},
    is_active: true, status: 'not_configured',
    missing: ['Spreadsheet ID', 'Google credentials (service-account JSON or API key)'],
    last_event_at: null, last_lead_at: null, last_lead_id: null, last_error: null,
    events_24h: 0, failures_24h: 0, leads_30d: 0,
  },
  {
    id: 3, provider: 'website', provider_label: 'Website form', kind: 'webhook',
    name: 'techlingua.in contact form',
    branch_id: 9, vertical_id: 1, pipeline_id: 2, campaign_id: 3, source_id: 4,
    branch_name: 'Vikaspuri', vertical_name: 'BCL', campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads',
    public_key: 'FORM-KEY', webhook_path: '/api/webhooks/form/FORM-KEY',
    config: { allowed_origins: 'https://techlingua.in', honeypot_field: 'company_website' },
    secrets_masked: {}, is_active: true, status: 'connected', missing: [],
    last_event_at: null, last_lead_at: null, last_lead_id: null, last_error: null,
    events_24h: 0, failures_24h: 0, leads_30d: 3,
  },
];

const EVENTS = [
  { id: 91, provider: 'meta', channel_id: 1, channel_name: 'Meta — Vikaspuri IELTS', status: 'ingested',
    reason: 'LG-100: lead #501 created and assigned to user #11', external_key: 'LG-100',
    lead_id: 501, lead_name: 'Priya Sharma', created_at: '2026-07-14T09:00:00Z' },
  { id: 92, provider: 'meta', channel_id: 1, channel_name: 'Meta — Vikaspuri IELTS', status: 'rejected',
    reason: 'X-Hub-Signature-256 does not match (wrong app secret, or the body was altered)',
    external_key: null, lead_id: null, created_at: '2026-07-14T08:55:00Z' },
  { id: 93, provider: 'meta', channel_id: 1, channel_name: 'Meta — Vikaspuri IELTS', status: 'skipped',
    reason: 'LG-100: Already imported (created) — idempotent replay', external_key: 'LG-100',
    lead_id: 501, created_at: '2026-07-14T08:50:00Z' },
];

const get = vi.fn(async (path: string) => {
  if (path === '/channels/providers') return PROVIDERS;
  if (path === '/channels') return CHANNELS;
  if (path.startsWith('/channels/events')) return EVENTS;
  if (path === '/channels/1/credentials') return { id: 1, provider: 'meta', verify_token: 'VERIFY-TOKEN-abc123' };
  if (path === '/channels/4/credentials') return { id: 4, provider: 'google_sheet' };
  if (path === '/channels/3/credentials') return { id: 3, provider: 'website' };
  throw new Error(`unexpected GET ${path}`);
});
const post = vi.fn(async (path: string, _b?: unknown) => {
  if (path === '/channels/4/poll') throw new Error('Not configured — still needed: Spreadsheet ID, Google credentials (service-account JSON or API key)');
  return {};
});
const patch = vi.fn(async (_p: string, _b?: unknown) => ({}));

vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), del: vi.fn(), put: vi.fn() },
  getToken: () => 'test-token',
}));

const writeText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText } });

describe('Lead Capture Channels screen', () => {
  beforeEach(() => {
    cleanup();
    CAN = () => true;
    get.mockClear(); post.mockClear(); patch.mockClear(); toastFn.mockClear(); writeText.mockClear();
  });

  it('renders the channel list with status, target path and the last lead received', async () => {
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));

    expect(screen.getByText('Walk-in sheet')).toBeTruthy();
    expect(screen.getByText('techlingua.in contact form')).toBeTruthy();
    // status badges
    expect(screen.getAllByText('Connected').length).toBe(2);
    expect(screen.getByText('Not configured')).toBeTruthy();
    // the full hierarchy path the leads land in
    expect(screen.getAllByText(/Vikaspuri › BCL › Meta Jul › Meta Lead Ads/).length).toBeGreaterThan(0);
    // last lead received
    expect(screen.getAllByText('Priya Sharma').length).toBeGreaterThan(0);
  });

  it('a NOT-CONFIGURED Sheet says exactly what is still missing', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('Walk-in sheet'));
    expect(screen.getByText(/Needs: Spreadsheet ID, Google credentials/)).toBeTruthy();
  });

  it('"Pull now" on an unconfigured Sheet surfaces the 503 reason instead of failing silently', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('Walk-in sheet'));
    fireEvent.click(screen.getByText('Pull now'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/4/poll', {}));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith(
      expect.stringContaining('Not configured — still needed: Spreadsheet ID'), true,
    ));
  });

  it('copies the webhook URL from the list', async () => {
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTitle('Copy the webhook URL')[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('/api/webhooks/meta/META-KEY-1'),
    ));
  });

  it('the KPI strip totals the channels, leads and failures', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('Channels connected'));
    expect(screen.getByText('2/3')).toBeTruthy();          // connected / total
    expect(screen.getByText('15')).toBeTruthy();           // 12 + 0 + 3 leads (30d)
    expect(screen.getByText('Rejected / failed (24h)')).toBeTruthy();
  });

  it('the event log shows every inbound request with its result and reason', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('Recent inbound events'));
    expect(screen.getByText('Lead created')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.getByText(/X-Hub-Signature-256 does not match/)).toBeTruthy();
    expect(screen.getByText(/idempotent replay/)).toBeTruthy();
    expect(screen.getAllByText('LG-100').length).toBe(2);
  });

  // ------------------------------------------------------ the Configure drawer

  it('Configure on the Meta channel shows the webhook URL and the VERIFY TOKEN to paste into Meta', async () => {
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Edit')[0]);

    await waitFor(() => screen.getByLabelText('Webhook URL'));
    expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).value)
      .toContain('/api/webhooks/meta/META-KEY-1');

    await waitFor(() => screen.getByLabelText('Verify token'));
    const vt = screen.getByLabelText('Verify token') as HTMLInputElement;
    expect(vt.value).toBe('VERIFY-TOKEN-abc123');
    expect(vt.readOnly).toBe(true);                    // generated server-side, copy-only
    expect(get).toHaveBeenCalledWith('/channels/1/credentials');

    // an already-set secret is shown MASKED, never in plaintext, and is optional
    const appSecret = screen.getByLabelText('App secret') as HTMLInputElement;
    expect(appSecret.value).toBe('');
    expect(appSecret.placeholder).toContain('••••••cret');
    expect(appSecret.placeholder).toContain('leave blank to keep');

    // the setup steps are on screen — this is what Gopal follows
    expect(screen.getByText(/subscribe to leadgen/i)).toBeTruthy();
  });

  it('saving the Configure drawer PATCHes only what changed (a blank secret is never sent as empty)', async () => {
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Edit')[0]);
    await waitFor(() => screen.getByLabelText('App secret'));

    fireEvent.change(screen.getByLabelText('App secret'), { target: { value: 'NEW-APP-SECRET' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [path, body] = patch.mock.calls[0] as unknown as [string, any];
    expect(path).toBe('/channels/1');
    expect(body.secrets).toEqual({ app_secret: 'NEW-APP-SECRET' });
    expect(body.config).toEqual({ graph_version: 'v21.0' });
  });

  it('the website channel renders a copy-pasteable snippet pointing at its own endpoint', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('techlingua.in contact form'));
    fireEvent.click(screen.getAllByText('Edit')[2]);

    await waitFor(() => screen.getByTestId('form-snippet'));
    const code = screen.getByTestId('form-snippet').textContent ?? '';
    expect(code).toContain('/api/webhooks/form/FORM-KEY');
    expect(code).toContain('name="company_website"');          // the honeypot input
    expect(code).toContain('display:none');
    expect(code).toContain("name=\"phone\"");

    fireEvent.click(screen.getByText('Copy snippet'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/api/webhooks/form/FORM-KEY')));
  });

  it('connecting a NEW channel posts the provider + the chosen campaign & source', async () => {
    render(<Channels />);
    await waitFor(() => screen.getByText('Available Tools'));
    fireEvent.click(screen.getByText('Google Ads lead form extension'));

    await waitFor(() => screen.getByLabelText('Branch'));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Vertical'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: '4' } });
    fireEvent.click(screen.getByText('Connect channel'));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels', expect.objectContaining({
      provider: 'google_ads', campaign_id: 3, source_id: 4,
    })));
  });

  it('pausing a channel PATCHes is_active', async () => {
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Pause')[0]);
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/channels/1', { is_active: false }));
  });

  // -------------------------------------------------------------------- RBAC

  it('RBAC: a channel.read user sees the channels and the log but NO Configure / Pause / Connect', async () => {
    CAN = (p: string) => p === 'channel.read';
    render(<Channels />);
    await waitFor(() => expect(screen.getAllByText('Meta — Vikaspuri IELTS').length).toBeGreaterThan(0));

    expect(screen.queryByText('Connect a channel')).toBeNull();
    expect(screen.queryByText('Configure')).toBeNull();
    expect(screen.queryByText('Pause')).toBeNull();
    expect(screen.queryByText('Pull now')).toBeNull();
    // ...but the diagnostics they need are still there
    expect(screen.getByText('Recent inbound events')).toBeTruthy();
    expect(screen.getByText(/X-Hub-Signature-256 does not match/)).toBeTruthy();
  });

  it('RBAC: a user with neither permission is refused the screen entirely', async () => {
    CAN = () => false;
    render(<Channels />);
    expect(screen.getByText(/do not have permission to view lead capture channels/)).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
