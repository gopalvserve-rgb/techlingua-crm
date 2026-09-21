/**
 * UI test for Engagement › WhatsApp Account (jsdom).
 *
 * Same discipline as channels.test.tsx: assert what the admin will LOOK AT and CLICK —
 * the numbers table with its labels / default / status, the connected card, webhook
 * health, the copyable callback URL + verify token, that destructive actions ask first
 * and name the number, the not-connected empty state, and the RBAC gating.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import WhatsAppAccount, { ago, statusBadge, WaAccountPayload } from './whatsappaccount';

const navFn = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navFn }));

let CAN: (p: string) => boolean = () => true;
vi.mock('./auth', () => ({ useAuth: () => ({ can: (p: string) => CAN(p), me: { user: { id: 1, name: 'Admin' } } }) }));

const toastFn = vi.fn((_t: string, _e?: boolean) => undefined);
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, toast: (t: string, e?: boolean) => toastFn(t, e) };
});

// the Meta SDK must never load in a test
vi.mock('./whatsappsignup', () => ({
  ensureFbSdk: vi.fn(async () => undefined),
  launchEmbeddedSignup: vi.fn(async () => ({ code: 'CODE', phone_number_id: '557', waba_id: '777' })),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock('./api', () => ({ api: { get: (...a: unknown[]) => (get as any)(...a), post: (...a: unknown[]) => (post as any)(...a) } }));

const PAYLOAD = (): WaAccountPayload => ({
  connected: true,
  accounts: [{
    config_id: 1, vertical_id: null, vertical_name: null, waba_id: '777', phone_number_id: '555',
    display_phone_number: '+91 98100 00001', verify_token: 'verify-me-123', is_active: true,
  }],
  numbers: [
    { phone_number_id: '555', display_phone_number: '+91 98100 00001', verified_name: 'Tech Lingua', waba_id: '777',
      status: 'CONNECTED', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', label: 'Sales line', is_default: true, config_id: 1 },
    { phone_number_id: '556', display_phone_number: '+91 98100 00002', verified_name: 'Tech Lingua Support', waba_id: '777',
      status: 'PENDING', quality_rating: '', code_verification_status: 'NOT_VERIFIED', label: '', is_default: false, config_id: 1 },
  ],
  webhook: { callback_path: '/api/webhooks/whatsapp', last_inbound_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), events_24h: 702, healthy: true },
});
const SIGNUP = () => ({ app_id: '99887766', config_id: 'cfg-1', ready: true, missing: [], connected: true, connected_via: 'embedded_signup', display_phone_number: '+91 98100 00001' });

function mockApi(payload: any = PAYLOAD(), signup: any = SIGNUP()) {
  get.mockImplementation(async (path: string) => {
    if (path === '/settings/whatsapp/account') return payload;
    if (path === '/settings/whatsapp/embedded-signup') return signup;
    throw new Error(`unexpected GET ${path}`);
  });
  post.mockImplementation(async (path: string) => {
    if (path.startsWith('/settings/whatsapp/account/')) return { ...PAYLOAD(), warning: null, mode: 'disconnected' };
    throw new Error(`unexpected POST ${path}`);
  });
}

beforeEach(() => { CAN = () => true; get.mockReset(); post.mockReset(); toastFn.mockClear(); navFn.mockClear(); });
afterEach(() => cleanup());

/* ============================================================ pure helpers */

describe('ago() — the reference screen\'s "2m ago"', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0);
  it.each([
    [null, 'never'], ['garbage', 'never'],
    [new Date(now - 10_000).toISOString(), 'just now'],
    [new Date(now - 2 * 60_000).toISOString(), '2m ago'],
    [new Date(now - 3 * 3600_000).toISOString(), '3h ago'],
    [new Date(now - 5 * 86400_000).toISOString(), '5d ago'],
  ])('%s -> %s', (iso, want) => expect(ago(iso as any, now)).toBe(want));
});

describe('statusBadge() — Meta\'s word, our tone', () => {
  it('maps the statuses the table shows', () => {
    expect(statusBadge('CONNECTED')).toEqual(['CONNECTED', 'b-green']);
    expect(statusBadge('PENDING')).toEqual(['PENDING', 'b-amber']);
    expect(statusBadge('FLAGGED')).toEqual(['FLAGGED', 'b-red']);
    expect(statusBadge('')).toEqual(['Not synced', 'b-gray']);
  });
});

/* ============================================================== the screen */

describe('WhatsApp Account — the numbers table', () => {
  it('renders every stored number with label, default marker, WABA id and Meta status from ONE read', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    const table = (await screen.findByText('Connected numbers')).closest('.card') as HTMLElement;

    // both numbers, their verified names and the WABA id — inside the TABLE (the
    // connected card repeats the default number, which is fine but not what this asserts)
    expect(within(table).getByText('+91 98100 00001')).toBeTruthy();
    expect(within(table).getByText('+91 98100 00002')).toBeTruthy();
    expect(within(table).getByText('Tech Lingua')).toBeTruthy();
    expect(within(table).getByText('Tech Lingua Support')).toBeTruthy();
    expect(within(table).getAllByText('777')).toHaveLength(2);

    // the label is an EDITABLE input carrying the stored text
    const label = screen.getByLabelText('Label for +91 98100 00001') as HTMLInputElement;
    expect(label.value).toBe('Sales line');
    expect((screen.getByLabelText('Label for +91 98100 00002') as HTMLInputElement).value).toBe('');

    // exactly one Default badge, on the sender's number; Set default only on the other
    expect(screen.getAllByTestId('default-badge')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Set default/ })).toHaveLength(1);

    // Meta's status, verbatim
    expect(within(table).getByText('CONNECTED')).toBeTruthy();
    expect(within(table).getByText('PENDING')).toBeTruthy();

    // the page read the account ONCE and the signup info once — no Graph call, no writes
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(['/settings/whatsapp/account', '/settings/whatsapp/embedded-signup']);
    expect(post).not.toHaveBeenCalled();
  });

  it('header buttons: Sync from Meta + Connect another number', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');
    expect(screen.getByRole('button', { name: /Sync from Meta/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect another number/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sync from Meta/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/sync', { config_id: 1 }));
  });

  it('Set default posts is_default for THAT number; editing a label saves on blur', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');

    fireEvent.click(screen.getByRole('button', { name: /Set default/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/number', { config_id: 1, phone_number_id: '556', is_default: true }));

    const label = screen.getByLabelText('Label for +91 98100 00002');
    fireEvent.change(label, { target: { value: 'Support desk' } });
    fireEvent.blur(label);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/number', { config_id: 1, phone_number_id: '556', label: 'Support desk' }));
  });

  it('the connected card shows WABA id + Phone ID; webhook health says "2m ago · 702 events"; URL + token are copyable', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');

    const card = screen.getByTestId('wa-connected-card');
    expect(within(card).getByText('777')).toBeTruthy();
    expect(within(card).getByText('555')).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Verify/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Register phone/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Disconnect/ })).toBeTruthy();

    const health = screen.getByTestId('webhook-health');
    expect(health.textContent).toMatch(/Webhook is receiving events from Meta/);
    expect(health.textContent).toMatch(/Last inbound: 2m ago · 702 events in last 24 h/);

    const list = screen.getByTestId('webhook-checklist');
    expect((within(list).getByLabelText('Callback URL') as HTMLInputElement).value).toBe(`${location.origin}/api/webhooks/whatsapp`);
    expect((within(list).getByLabelText('Verify Token') as HTMLInputElement).value).toBe('verify-me-123');
    expect(list.textContent).toMatch(/messages/);
    expect(list.textContent).toMatch(/message_template_status_update/);
    expect(within(list).getAllByRole('button', { name: /Copy/ })).toHaveLength(2);
  });

  it('Register phone opens the inline PIN form and posts a 6-digit PIN', async () => {
    mockApi();
    post.mockImplementation(async (path: string) => path.endsWith('/register') ? { ok: true, message: 'Registered' } : PAYLOAD());
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');

    fireEvent.click(screen.getByRole('button', { name: /Register phone/ }));
    const form = screen.getByTestId('register-form');
    const pinInput = within(form).getByLabelText('6-digit PIN') as HTMLInputElement;
    const submit = within(form).getByRole('button', { name: /^Register$/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);                                 // no PIN yet
    fireEvent.change(pinInput, { target: { value: '12ab34' } });
    expect(pinInput.value).toBe('1234');                                // digits only
    fireEvent.change(pinInput, { target: { value: '000000' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/register', { config_id: 1, phone_number_id: '555', pin: '000000' }));
  });
});

describe('WhatsApp Account — destructive actions ask first, and name the number', () => {
  it('Disconnect opens a confirmation naming the current number; nothing is posted until Confirm', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');

    fireEvent.click(within(screen.getByTestId('wa-connected-card')).getByRole('button', { name: /Disconnect/ }));
    const dialog = await screen.findByText('Disconnect WhatsApp?');
    const modal = dialog.closest('.add-modal')!;
    expect(modal.textContent).toMatch(/\+91 98100 00001/);
    expect(modal.textContent).toMatch(/stop sending immediately/);
    expect(post).not.toHaveBeenCalled();

    // Cancel is a real cancel
    fireEvent.click(within(modal as HTMLElement).getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByText('Disconnect WhatsApp?')).toBeNull();
    expect(post).not.toHaveBeenCalled();

    // …and Confirm posts the FULL disconnect (no remove_number)
    fireEvent.click(within(screen.getByTestId('wa-connected-card')).getByRole('button', { name: /Disconnect/ }));
    fireEvent.click(within((await screen.findByText('Disconnect WhatsApp?')).closest('.add-modal') as HTMLElement).getByRole('button', { name: /^Disconnect$/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/disconnect', { config_id: 1 }));
  });

  it('Remove on a row asks about THAT number and posts remove_number', async () => {
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');

    const removes = screen.getAllByRole('button', { name: /Remove/ });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[1]);                                        // the second row: +91 98100 00002
    const title = await screen.findByText('Remove this number?');
    const modal = title.closest('.add-modal') as HTMLElement;
    expect(modal.textContent).toMatch(/\+91 98100 00002/);
    expect(modal.textContent).not.toMatch(/\+91 98100 00001/);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole('button', { name: /^Remove$/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/settings/whatsapp/account/disconnect', { config_id: 1, remove_number: '556' }));
  });

  it('removing the ONLY number is presented as a full disconnect', async () => {
    const p = PAYLOAD(); p.numbers = [p.numbers[0]];
    mockApi(p);
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    const title = await screen.findByText('Disconnect WhatsApp?');
    expect((title.closest('.add-modal') as HTMLElement).textContent).toMatch(/is the only number/);
  });
});

describe('WhatsApp Account — not connected', () => {
  it('shows the empty state with a Connect button when the Meta app is ready', async () => {
    mockApi({ connected: false, accounts: [], numbers: [], webhook: { callback_path: '/api/webhooks/whatsapp', last_inbound_at: null, events_24h: 0, healthy: false } },
      { ...SIGNUP(), connected: false });
    render(<WhatsAppAccount />);
    await screen.findByTestId('wa-not-connected');
    expect(screen.getByText('WhatsApp is not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect WhatsApp/ })).toBeTruthy();
    expect(screen.queryByText('Connected numbers')).toBeNull();
    expect(screen.queryByTestId('wa-connected-card')).toBeNull();
  });

  it('when the Meta app is not saved yet: "save your Meta app in Settings first" + a link to Settings, Connect disabled', async () => {
    mockApi({ connected: false, accounts: [], numbers: [], webhook: { callback_path: '/api/webhooks/whatsapp', last_inbound_at: null, events_24h: 0, healthy: false } },
      { app_id: '', config_id: '', ready: false, missing: ['Meta App ID', 'App secret'], connected: false, connected_via: '', display_phone_number: '' });
    render(<WhatsAppAccount />);
    const empty = await screen.findByTestId('wa-not-connected');
    expect(empty.textContent).toMatch(/Save your Meta app in Settings first/);
    expect(empty.textContent).toMatch(/Meta App ID, App secret/);
    expect((screen.getByRole('button', { name: /Connect WhatsApp/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText(/Open Administration › Settings/));
    expect(navFn).toHaveBeenCalledWith('/m/admin/settings');
  });

  it('webhook health with no events is an explicit "No events received yet"', async () => {
    const p = PAYLOAD(); p.webhook = { callback_path: '/api/webhooks/whatsapp', last_inbound_at: null, events_24h: 0, healthy: false };
    mockApi(p);
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');
    expect(screen.getByTestId('webhook-health').textContent).toMatch(/No events received yet/);
    expect(screen.getByText('NO EVENTS YET')).toBeTruthy();
  });
});

describe('WhatsApp Account — RBAC', () => {
  it('without settings.update every write button is hidden and the label is plain text', async () => {
    CAN = (p) => p === 'settings.read';
    mockApi();
    render(<WhatsAppAccount />);
    await screen.findByText('Connected numbers');
    expect(screen.queryByRole('button', { name: /Set default/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sync from Meta/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect another number/ })).toBeNull();
    expect(screen.queryByLabelText('Label for +91 98100 00001')).toBeNull();
    expect(screen.getByText('Sales line')).toBeTruthy();
  });

  it('without settings.read: a friendly empty state, and NO api call', async () => {
    CAN = () => false;
    mockApi();
    render(<WhatsAppAccount />);
    expect(await screen.findByText(/You do not have permission to view the WhatsApp account/)).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});
