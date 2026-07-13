/**
 * UI test for the duplicate / merge screens (jsdom).
 *
 * The DEF-2 lesson, again: an API-only suite cannot see a broken screen. These
 * tests assert what the USER sees and clicks — the duplicate panel on the lead
 * sheet, the merge preview diff (filled vs kept-on-conflict), the reopen
 * checkbox for a closed lead, the POST that is actually sent, and that the
 * Merge buttons DISAPPEAR for a user without lead.merge.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DuplicatePanel, DiffView } from './mergemodal';

let PERMS = ['lead.read', 'lead.update', 'lead.merge'];
vi.mock('./auth', () => ({
  useAuth: () => ({ can: (p: string) => PERMS.includes(p), me: { user: { id: 1, name: 'Super Admin' } } }),
}));
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, toast: vi.fn() };
});

const DIFF = {
  filled: { course_id: 21, alt_phone: '+919812300000' },
  conflicts: { email: { kept: 'asha@real.com', incoming: 'typo@x.com' } },
  custom_filled: { ref: 'RJ-9' },
  custom_conflicts: {},
  tags_added: [42],
  note: 'came back via Meta',
};

const REPORT = {
  lead_id: 201, is_duplicate: false, merged_into_id: null,
  duplicate_of: null,
  duplicates: [{
    id: 202, full_name: 'Asha R', phone: '+919811100001', email: 'typo@x.com',
    owner_name: 'Neha', stage_name: 'New', stage_type: 'open',
    campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads',
    created_at: new Date().toISOString(), deleted_at: null, merged_into_id: null,
  }],
  merged: [],
  merges: [{
    id: 501, action: 'merge_and_reopen', reopened: true, channel: 'csv',
    diff: DIFF, created_at: new Date().toISOString(), source_lead_id: null, actor_name: 'Import',
  }],
  counts: { open: 1, merged: 0 },
};

const PREVIEW = {
  target: { id: 201, full_name: 'Asha Rao', phone: '+919811100001', email: 'asha@real.com', owner_name: 'Neha', stage_name: 'Lost', stage_type: 'lost', campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads', created_at: '', deleted_at: null, merged_into_id: null },
  source: { id: 202, full_name: 'Asha R', phone: '+919811100001', email: 'typo@x.com', owner_name: 'Ravi', stage_name: 'New', stage_type: 'open', campaign_name: 'Meta Jul', source_name: 'Meta Lead Ads', created_at: '', deleted_at: null, merged_into_id: null },
  diff: DIFF, target_closed: true, can_reopen: true, summary: 'filled Course',
};

const get = vi.fn(async (path: string): Promise<any> => {
  if (path === '/leads/201/duplicates') return REPORT;
  if (path.startsWith('/leads/201/merge-preview')) return PREVIEW;
  throw new Error(`unexpected GET ${path}`);
});
const post = vi.fn(async (_path: string, _body?: unknown): Promise<any> => ({ ok: true }));

vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b?: unknown) => post(p, b), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
  getToken: () => 'test-token',
}));

describe('Lead sheet — Duplicates panel', () => {
  beforeEach(() => { cleanup(); get.mockClear(); post.mockClear(); PERMS = ['lead.read', 'lead.update', 'lead.merge']; });

  it('shows the duplicates of this lead, with counts', async () => {
    render(<DuplicatePanel leadId={201} />);
    await waitFor(() => screen.getByTestId('duplicate-panel'));
    expect(screen.getByText('Duplicates')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByTestId('duplicate-row-202')).toBeTruthy();
    expect(screen.getByText('#202 Asha R')).toBeTruthy();
    expect(screen.getByText(/Merge into this lead/)).toBeTruthy();
  });

  it('shows "this lead is a duplicate of X" when the lead is the duplicate', async () => {
    get.mockImplementationOnce(async (): Promise<any> => ({
      ...REPORT, lead_id: 202, is_duplicate: true, duplicates: [], merges: [],
      duplicate_of: { ...REPORT.duplicates[0], id: 201, full_name: 'Asha Rao' },
      counts: { open: 0, merged: 0 },
    }));
    render(<DuplicatePanel leadId={202} />);
    await waitFor(() => screen.getByTestId('duplicate-of'));
    expect(screen.getByText(/This lead is a duplicate of/)).toBeTruthy();
    expect(screen.getByText('#201 Asha Rao')).toBeTruthy();
    expect(screen.getByText(/Merge into #201/)).toBeTruthy();
  });

  it('RBAC: without lead.merge the panel is read-only — no merge buttons', async () => {
    PERMS = ['lead.read'];
    render(<DuplicatePanel leadId={201} />);
    await waitFor(() => screen.getByTestId('duplicate-panel'));
    expect(screen.getByTestId('duplicate-row-202')).toBeTruthy();   // still VISIBLE
    expect(screen.queryByText(/Merge into this lead/)).toBeNull();  // but NOT actionable
  });

  it('renders a past merge and expands its diff on demand', async () => {
    render(<DuplicatePanel leadId={201} />);
    await waitFor(() => screen.getByTestId('merge-row-501'));
    expect(screen.getByText('Merged & re-opened')).toBeTruthy();
    expect(screen.getByText(/from csv/)).toBeTruthy();
    expect(screen.queryByTestId('merge-diff-501')).toBeNull();      // collapsed by default
    fireEvent.click(screen.getByText('View diff'));
    expect(screen.getByTestId('merge-diff-501')).toBeTruthy();
    expect(screen.getByTestId('filled-course_id')).toBeTruthy();
    expect(screen.getByTestId('conflict-email')).toBeTruthy();
  });
});

describe('Merge modal', () => {
  beforeEach(() => { cleanup(); get.mockClear(); post.mockClear(); PERMS = ['lead.read', 'lead.update', 'lead.merge']; });

  const openModal = async () => {
    render(<DuplicatePanel leadId={201} />);
    await waitFor(() => screen.getByTestId('duplicate-row-202'));
    fireEvent.click(screen.getByText(/Merge into this lead/));
    await waitFor(() => screen.getByText('Merge duplicate leads'));
  };

  it('previews the merge BEFORE anything is written', async () => {
    await openModal();
    expect(get).toHaveBeenCalledWith('/leads/201/merge-preview?from=202');
    expect(post).not.toHaveBeenCalled();                            // nothing written yet
    // both leads are shown, and which one survives
    expect(screen.getByText('Survives (target)')).toBeTruthy();
    expect(screen.getByText('Merged away (duplicate)')).toBeTruthy();
  });

  it('shows the non-destructive diff: blanks filled, conflicts KEPT', async () => {
    await openModal();
    expect(screen.getByTestId('merge-diff')).toBeTruthy();
    // filled
    expect(screen.getByTestId('filled-course_id')).toBeTruthy();
    expect(screen.getByTestId('filled-alt_phone')).toBeTruthy();
    expect(screen.getByTestId('filled-ref')).toBeTruthy();          // a custom field
    // conflict: the existing value wins and the incoming one is shown as recorded
    const conflict = screen.getByTestId('conflict-email');
    expect(conflict.textContent).toContain('asha@real.com');
    expect(conflict.textContent).toContain('typo@x.com');
    expect(conflict.textContent).toMatch(/recorded, not applied/);
    // tags + note are appends
    expect(screen.getByTestId('tags-added')).toBeTruthy();
    expect(screen.getByTestId('note-added')).toBeTruthy();
  });

  it('offers re-open for a CLOSED target and posts reopen=true', async () => {
    await openModal();
    const cb = screen.getByLabelText('Re-open the closed lead') as HTMLInputElement;
    expect(cb.checked).toBe(true);                                  // pre-ticked: target is Lost
    expect(screen.getByText(/Merge & re-open/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Merge & re-open/));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/201/merge', { from_lead_id: 202, reopen: true }));
  });

  it('does not offer re-open when the target is open, and posts reopen=false', async () => {
    get.mockImplementation(async (path: string): Promise<any> => {
      if (path === '/leads/201/duplicates') return REPORT;
      return { ...PREVIEW, target: { ...PREVIEW.target, stage_name: 'New', stage_type: 'open' }, target_closed: false, can_reopen: false };
    });
    await openModal();
    expect(screen.queryByLabelText('Re-open the closed lead')).toBeNull();
    fireEvent.click(screen.getByText('Merge leads'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/201/merge', { from_lead_id: 202, reopen: false }));
  });

  it('states plainly that nothing is overwritten and the owner is kept', async () => {
    await openModal();
    expect(screen.getByText(/existing value is kept/)).toBeTruthy();
    expect(screen.getByText(/keeps its owner/)).toBeTruthy();
  });
});

describe('DiffView', () => {
  beforeEach(cleanup);
  it('says so when the duplicate adds nothing', () => {
    render(<DiffView diff={{ filled: {}, conflicts: {}, custom_filled: {}, custom_conflicts: {}, tags_added: [] }} />);
    expect(screen.getByTestId('diff-empty')).toBeTruthy();
  });
});
