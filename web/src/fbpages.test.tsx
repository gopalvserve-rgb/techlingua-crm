/**
 * Facebook Page Monitor + Form Mapping drawers (jsdom).
 *
 * What the client will look at: every granted Page in one table with its Monitored switch,
 * the status badge, leads received; the switch calling subscribe / unsubscribe; Disconnect
 * asking first; the mapping editor's per-question dropdowns, Auto-map, and the PUT it saves.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { FbFormMappingModal, FbPagesModal, ago } from './fbpages';
import type { Channel } from './channels';

const toastFn = vi.fn((_t: string, _e?: boolean) => undefined);
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, toast: (t: string, e?: boolean) => toastFn(t, e) };
});

const CHANNEL = {
  id: 1, provider: 'meta', provider_label: 'Meta Lead Ads (Facebook / Instagram)', kind: 'webhook',
  name: 'Meta — Vikaspuri IELTS',
  branch_id: 9, vertical_id: 1, pipeline_id: 2, campaign_id: 3, source_id: 4,
  campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads',
  public_key: 'META-KEY-1', webhook_path: '/api/webhooks/meta/META-KEY-1',
  config: {}, secrets_masked: {}, is_active: true, status: 'connected', missing: [],
} as unknown as Channel;

const PAGES = {
  connected: true,
  pages: [
    { page_id: 'P1', page_name: 'School A', monitored: true, subscribed: true, subscribed_at: '2026-09-01T10:00:00Z',
      checked_at: '2026-09-20T10:00:00Z', last_error: null, has_token: true, is_primary: true, leads: 12, last_lead_at: new Date(Date.now() - 5 * 60_000).toISOString() },
    { page_id: 'P2', page_name: 'School B', monitored: false, subscribed: null, subscribed_at: null,
      checked_at: null, last_error: null, has_token: true, is_primary: false, leads: 0, last_lead_at: null },
    { page_id: 'P3', page_name: 'School C', monitored: true, subscribed: null, subscribed_at: null,
      checked_at: '2026-09-20T10:00:00Z', last_error: 'Error validating access token', has_token: true, is_primary: false, leads: 3, last_lead_at: '2026-09-10T10:00:00Z' },
  ],
};

const FORMS = {
  page_id: 'P1', page_name: 'School A', truncated: false,
  forms: [
    { form_id: 'F1', form_name: 'IELTS enquiry', status: 'ACTIVE', locale: 'en_GB', total_fields: 3, mapped_fields: 2, has_custom_mapping: false, is_enabled: true },
    { form_id: 'F2', form_name: 'Old campaign', status: 'ARCHIVED', locale: 'en_GB', total_fields: 1, mapped_fields: 1, has_custom_mapping: true, is_enabled: false },
  ],
};

const MAPPING = {
  form: { form_id: 'F1', form_name: 'IELTS enquiry', page_id: 'P1' },
  questions: [
    { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
    { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
    { key: 'which_course', label: 'Which course?', type: 'CUSTOM' },
  ],
  field_map: {}, saved: false, is_enabled: true,
  crm_fields: [
    { key: 'full_name', label: 'Full name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'course', label: 'Course' }, { key: 'note', label: 'Remarks / note' }, { key: 'cf:batch', label: 'Batch (custom)' },
  ],
  suggested: { full_name: 'full_name', phone_number: 'phone' },
  channel_field_map: {},
};

const get = vi.fn(async (path: string) => {
  if (path === '/channels/1/fb/pages') return PAGES;
  if (path === '/channels/1/fb/pages/P1/forms') return FORMS;
  if (path === '/channels/1/fb/pages/P2/forms') return { ...FORMS, page_id: 'P2', forms: [] };
  if (path.startsWith('/channels/1/fb/forms/F1/mapping')) return MAPPING;
  throw new Error(`unexpected GET ${path}`);
});
const post = vi.fn(async (path: string, _body?: unknown) => {
  if (path === '/channels/1/fb/pages/P2/subscribe') {
    return { ...PAGES, pages: PAGES.pages.map((p) => (p.page_id === 'P2' ? { ...p, monitored: true, subscribed: true } : p)) };
  }
  if (path === '/channels/1/fb/pages/P1/unsubscribe') {
    return { ...PAGES, warning: null, pages: PAGES.pages.map((p) => (p.page_id === 'P1' ? { ...p, monitored: false, subscribed: false } : p)) };
  }
  if (path === '/channels/1/fb/pages/refresh') return PAGES;
  if (path === '/channels/1/fb/disconnect') return { disconnected: true, pages_removed: 3, unsubscribe_failures: [] };
  throw new Error(`unexpected POST ${path}`);
});
const put = vi.fn(async (_path: string, body: any) => ({
  ...MAPPING, saved: true, field_map: { ...body.field_map }, is_enabled: body.is_enabled ?? true,
}));

vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), put: (p: string, b?: unknown) => put(p, b), patch: vi.fn(), del: vi.fn() },
  getToken: () => 'test-token',
}));

const confirmSpy = vi.fn((_msg?: string) => true);
Object.assign(window, { confirm: confirmSpy });

beforeEach(() => {
  cleanup();
  get.mockClear(); post.mockClear(); put.mockClear(); toastFn.mockClear(); confirmSpy.mockClear();
  confirmSpy.mockReturnValue(true);
});

describe('ago()', () => {
  it('renders relative times', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    expect(ago(null, now)).toBe('—');
    expect(ago('2026-09-21T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-09-21T11:30:00Z', now)).toBe('30 min ago');
    expect(ago('2026-09-21T06:00:00Z', now)).toBe('6 h ago');
    expect(ago('2026-09-15T12:00:00Z', now)).toBe('6 d ago');
  });
});

describe('Facebook Page Monitor', () => {
  it('renders every granted Page with id, monitored switch, status badge, leads and last lead', async () => {
    render(<FbPagesModal channel={CHANNEL} canManage onClose={() => undefined} onConnect={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-pages-table'));
    expect(get).toHaveBeenCalledWith('/channels/1/fb/pages');

    const rows = within(screen.getByTestId('fb-pages-table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('School A')).toBeTruthy();
    expect(within(rows[0]).getByText('P1')).toBeTruthy();
    expect(within(rows[0]).getByText('Primary')).toBeTruthy();
    expect(within(rows[0]).getByText('Subscribed')).toBeTruthy();
    expect(within(rows[0]).getByText('12')).toBeTruthy();
    expect(within(rows[0]).getByText('5 min ago')).toBeTruthy();
    expect((within(rows[0]).getByRole('switch') as HTMLInputElement).checked).toBe(true);

    expect(within(rows[1]).getByText('Unknown')).toBeTruthy();
    expect((within(rows[1]).getByRole('switch') as HTMLInputElement).checked).toBe(false);

    const err = within(rows[2]).getByText('Error');
    expect(err.getAttribute('title')).toBe('Error validating access token');    // the error text as tooltip
  });

  it('the Monitored switch calls subscribe for an OFF Page and unsubscribe for an ON Page', async () => {
    render(<FbPagesModal channel={CHANNEL} canManage onClose={() => undefined} onConnect={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-pages-table'));

    fireEvent.click(screen.getByLabelText('Monitor School B'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/1/fb/pages/P2/subscribe', {}));
    await waitFor(() => expect((screen.getByLabelText('Monitor School B') as HTMLInputElement).checked).toBe(true));
    expect(toastFn).toHaveBeenCalledWith('Now monitoring "School B"', false);

    fireEvent.click(screen.getByLabelText('Monitor School A'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/1/fb/pages/P1/unsubscribe', {}));
    await waitFor(() => expect((screen.getByLabelText('Monitor School A') as HTMLInputElement).checked).toBe(false));
  });

  it('Refresh status POSTs the refresh endpoint; Re-authorise uses the existing connect flow', async () => {
    const onConnect = vi.fn();
    render(<FbPagesModal channel={CHANNEL} canManage onClose={() => undefined} onConnect={onConnect} />);
    await waitFor(() => screen.getByTestId('fb-pages-table'));
    fireEvent.click(screen.getByText('Refresh status'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/1/fb/pages/refresh', {}));
    fireEvent.click(screen.getByText('Connect another / Re-authorise'));
    expect(onConnect).toHaveBeenCalled();
  });

  it('Disconnect Facebook asks for confirmation first — cancel sends nothing, OK POSTs disconnect', async () => {
    render(<FbPagesModal channel={CHANNEL} canManage onClose={() => undefined} onConnect={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-pages-table'));

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByText('Disconnect Facebook'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0] ?? '')).toMatch(/Disconnect Facebook/);
    expect(post).not.toHaveBeenCalledWith('/channels/1/fb/disconnect', {});

    fireEvent.click(screen.getByText('Disconnect Facebook'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/channels/1/fb/disconnect', {}));
  });

  it('empty state explains to press Connect Page first', async () => {
    get.mockImplementationOnce(async () => ({ connected: false, pages: [] }));
    render(<FbPagesModal channel={CHANNEL} canManage onClose={() => undefined} onConnect={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-pages-empty'));
    expect(screen.getByText(/Press Connect Page/)).toBeTruthy();
    expect(screen.queryByText('Disconnect Facebook')).toBeNull();
  });

  it('read-only (channel.read): the data shows but no switch, refresh or disconnect controls', async () => {
    render(<FbPagesModal channel={CHANNEL} canManage={false} onClose={() => undefined} onConnect={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-pages-table'));
    expect(screen.getByText('School A')).toBeTruthy();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByText('Refresh status')).toBeNull();
    expect(screen.queryByText('Disconnect Facebook')).toBeNull();
    expect(screen.queryByText(/Re-authorise/)).toBeNull();
  });
});

describe('Facebook Form Mapping', () => {
  it('lists the Page\'s forms (mapped n/m, status, enabled) and opens the question editor with suggestions', async () => {
    render(<FbFormMappingModal channel={CHANNEL} canManage onClose={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-forms-table'));
    expect(get).toHaveBeenCalledWith('/channels/1/fb/pages/P1/forms');     // the first MONITORED page is selected

    const rows = within(screen.getByTestId('fb-forms-table')).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('IELTS enquiry')).toBeTruthy();
    expect(within(rows[0]).getByText('2/3')).toBeTruthy();
    expect(within(rows[0]).getByText('ACTIVE')).toBeTruthy();
    expect((within(rows[0]).getByRole('switch') as HTMLInputElement).checked).toBe(true);
    expect((within(rows[1]).getByRole('switch') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(within(rows[0]).getByText('Map fields'));
    await waitFor(() => screen.getByTestId('fb-question-map'));
    expect(get).toHaveBeenCalledWith('/channels/1/fb/forms/F1/mapping?page_id=P1');

    // nothing saved yet -> the suggestion is pre-filled, the custom question is "ignore"
    expect((screen.getByLabelText('Map Full name') as HTMLSelectElement).value).toBe('full_name');
    expect((screen.getByLabelText('Map Phone number') as HTMLSelectElement).value).toBe('phone');
    expect((screen.getByLabelText('Map Which course?') as HTMLSelectElement).value).toBe('');
    const opts = [...(screen.getByLabelText('Map Which course?') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts[0]).toBe('— ignore —');
    expect(opts).toContain('Course');
    expect(opts).toContain('Batch (custom)');
  });

  it('choosing fields and saving PUTs the map + enabled flag for that form', async () => {
    render(<FbFormMappingModal channel={CHANNEL} canManage onClose={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-forms-table'));
    fireEvent.click(screen.getAllByText('Map fields')[0]);
    await waitFor(() => screen.getByLabelText('Map Which course?'));

    const save = () => screen.getByText('Save mapping').closest('button') as HTMLButtonElement;
    expect(save().disabled).toBe(true);                                      // nothing changed yet

    fireEvent.change(screen.getByLabelText('Map Which course?'), { target: { value: 'course' } });
    fireEvent.change(screen.getByLabelText('Map Full name'), { target: { value: '' } });   // explicit ignore
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(save());

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0] as unknown as [string, any];
    expect(path).toBe('/channels/1/fb/forms/F1/mapping');
    expect(body).toEqual({
      field_map: { full_name: '', phone_number: 'phone', which_course: 'course' },
      is_enabled: true, page_id: 'P1', form_name: 'IELTS enquiry',
    });
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith('Form mapping saved', undefined));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('Auto-map applies the API suggestion; the forms-table Enabled switch saves straight away', async () => {
    render(<FbFormMappingModal channel={CHANNEL} canManage onClose={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-forms-table'));
    fireEvent.click(screen.getAllByText('Map fields')[0]);
    await waitFor(() => screen.getByLabelText('Map Full name'));
    fireEvent.change(screen.getByLabelText('Map Full name'), { target: { value: 'note' } });
    fireEvent.click(screen.getByText('Auto-map'));
    expect((screen.getByLabelText('Map Full name') as HTMLSelectElement).value).toBe('full_name');

    fireEvent.click(screen.getByLabelText('Enable Old campaign'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/channels/1/fb/forms/F2/mapping', { is_enabled: true, page_id: 'P1', form_name: 'Old campaign' }));
  });

  it('guards unsaved changes on close', async () => {
    const onClose = vi.fn();
    render(<FbFormMappingModal channel={CHANNEL} canManage onClose={onClose} />);
    await waitFor(() => screen.getByTestId('fb-forms-table'));
    fireEvent.click(screen.getAllByText('Map fields')[0]);
    await waitFor(() => screen.getByLabelText('Map Which course?'));
    fireEvent.change(screen.getByLabelText('Map Which course?'), { target: { value: 'course' } });

    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('read-only (channel.read): dropdowns are disabled and there is no Save / Auto-map / switch', async () => {
    render(<FbFormMappingModal channel={CHANNEL} canManage={false} onClose={() => undefined} />);
    await waitFor(() => screen.getByTestId('fb-forms-table'));
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    fireEvent.click(screen.getAllByText('View mapping')[0]);
    await waitFor(() => screen.getByLabelText('Map Full name'));
    expect((screen.getByLabelText('Map Full name') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByText('Save mapping')).toBeNull();
    expect(screen.queryByText('Auto-map')).toBeNull();
  });
});
