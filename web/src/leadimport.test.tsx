/**
 * UI test for the CSV import screen (jsdom).
 *
 * The Tester's DEF-2 lesson: an API-only suite cannot see a broken screen. These
 * tests assert what the USER sees and clicks — the mapping step must render a
 * real <select> per CSV column with the auto-mapping applied, and the preview
 * step must show the per-row verdict (valid / duplicate / error) with reasons.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import LeadImport from './leadimport';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 2, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 3, name: 'Meta Jul', pipeline_id: 2 }],
  sources: [{ id: 4, name: 'Meta Lead Ads', campaign_id: 3 }],
  users: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  states: [], cities: [], loaded: true, reload: () => undefined,
};

vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn(), useFetch: () => ({ data: [], loading: false, reload: vi.fn() }) };
});

const PARSE = {
  headers: ['Name', 'Mobile', 'Email', 'Junk'],
  total_rows: 3,
  sample: [{ Name: 'Sharma, Priya', Mobile: '9811100001', Email: 'p@x.com', Junk: 'zzz' }],
  mapping: { Name: 'full_name', Mobile: 'phone', Email: 'email', Junk: '' },
  fields: [
    { key: 'full_name', label: 'Name', required: true },
    { key: 'phone', label: 'Mobile Number', required: true },
    { key: 'email', label: 'Email' },
    { key: 'course', label: 'Course' },
  ],
  custom_fields: [{ key: 'cf:batch', label: 'Preferred Batch' }],
};

const PREVIEW = {
  total: 3, valid: 1, duplicates: 1, errors: 1,
  duplicate_action: 'merge_and_reopen', duplicate_scope: 'this_campaign', distribution_mode: 'equal',
  truncated: false,
  rows: [
    { row_num: 1, status: 'valid', action: null, name: 'Sharma, Priya', phone: '+919811100001' },
    { row_num: 2, status: 'duplicate', action: 'merge_and_reopen', name: 'Ravi', phone: '+919811100002', duplicate_of: 900, reason: 'Phone matches existing lead #900 — campaign rule: MERGE & REOPEN — folded into the existing lead, and a closed lead is re-opened' },
    { row_num: 3, status: 'error', name: 'Bad', phone: '12', reason: 'Invalid mobile number: "12"' },
  ],
};

const post = vi.fn(async (path: string, _body?: unknown) => {
  if (path === '/lead-imports/parse') return PARSE;
  if (path === '/lead-imports/preview') return PREVIEW;
  if (path === '/lead-imports') return { id: 1, file_name: 'leads.csv', status: 'queued', total_rows: 3, created_count: 0, duplicate_count: 0, skipped_count: 0, failed_count: 0, pending: 3, created_at: new Date().toISOString() };
  throw new Error(`unexpected POST ${path}`);
});

vi.mock('./api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: (p: string, b?: unknown) => post(p, b), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
  getToken: () => 'test-token',
}));

/** Drive the wizard: upload a file, choose the target, land on the mapping step. */
async function uploadAndTarget() {
  render(<LeadImport />);
  const file = new File(['Name,Mobile\n"Sharma, Priya",9811100001\n'], 'leads.csv', { type: 'text/csv' });
  const input = screen.getByLabelText('CSV file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => screen.getByLabelText('Branch'));
  fireEvent.change(screen.getByLabelText('Branch'), { target: { value: '9' } });
  fireEvent.change(screen.getByLabelText('Vertical'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Pipeline'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: '4' } });
  fireEvent.click(screen.getByText(/Next: map columns/));
  await waitFor(() => screen.getByLabelText('Map Name'));
}

describe('Import Leads screen', () => {
  beforeEach(() => { cleanup(); post.mockClear(); });

  it('step 1: uploads the CSV and calls parse', async () => {
    render(<LeadImport />);
    const file = new File(['Name,Mobile\nAsha,9811100001\n'], 'leads.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
    await waitFor(() => expect(post).toHaveBeenCalledWith('/lead-imports/parse', expect.objectContaining({ csv: expect.stringContaining('Name,Mobile') })));
    // step 2 = the target picker
    await waitFor(() => screen.getByText(/Where do these leads land/));
  });

  it('step 3: renders an editable mapping select per CSV column, pre-filled by auto-map', async () => {
    await uploadAndTarget();
    for (const h of PARSE.headers) {
      const s = screen.getByLabelText(`Map ${h}`) as HTMLSelectElement;
      expect(s.tagName).toBe('SELECT');            // a real control, not a read-only div
    }
    expect((screen.getByLabelText('Map Name') as HTMLSelectElement).value).toBe('full_name');
    expect((screen.getByLabelText('Map Mobile') as HTMLSelectElement).value).toBe('phone');
    expect((screen.getByLabelText('Map Junk') as HTMLSelectElement).value).toBe('');  // unknown -> ignored
    // the quoted CSV value is shown as ONE value, commas intact
    expect(screen.getByText('Sharma, Priya')).toBeTruthy();
    // custom fields are offered as mapping targets
    expect(screen.getAllByText('Preferred Batch (custom)').length).toBeGreaterThan(0);
  });

  it('step 3: the user can remap a column, and a mapping without Mobile blocks the preview', async () => {
    await uploadAndTarget();
    const mobile = screen.getByLabelText('Map Mobile') as HTMLSelectElement;
    fireEvent.change(mobile, { target: { value: '' } });          // un-map the mandatory phone
    expect(screen.getByText(/Map a column to Mobile Number/)).toBeTruthy();
    expect((screen.getByText(/Validate & preview/).closest('button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(mobile, { target: { value: 'phone' } });      // remap it
    expect((screen.getByText(/Validate & preview/).closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('step 4: the preview shows counts and a per-row verdict with reasons', async () => {
    await uploadAndTarget();
    fireEvent.click(screen.getByText(/Validate & preview/));
    await waitFor(() => screen.getByText('Row-by-row validation'));

    expect(post).toHaveBeenCalledWith('/lead-imports/preview', expect.objectContaining({ campaign_id: 3, source_id: 4 }));
    expect(screen.getByText('Will be created')).toBeTruthy();
    expect(screen.getByText('Rows with errors')).toBeTruthy();
    expect(screen.getByText('Valid')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText(/Invalid mobile number: "12"/)).toBeTruthy();
    expect(screen.getByText(/Phone matches existing lead #900/)).toBeTruthy();
    // WS2: the duplicate row shows WHICH ACTION will be applied, not merely "duplicate"
    expect(screen.getByText('Duplicate → Merge & re-open')).toBeTruthy();
    // the campaign's own rules are shown before the user commits
    expect(screen.getByText(/Merge & re-open closed leads/)).toBeTruthy();
    expect(screen.getByText(/Equal \(round-robin\)/)).toBeTruthy();
    // errored rows are excluded from the import button's count
    expect(screen.getByText(/Import 2 rows/)).toBeTruthy();
  });

  it('step 5: importing posts the batch and shows the result report', async () => {
    await uploadAndTarget();
    fireEvent.click(screen.getByText(/Validate & preview/));
    await waitFor(() => screen.getByText('Row-by-row validation'));
    fireEvent.click(screen.getByText(/Import 2 rows/));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/lead-imports', expect.objectContaining({ campaign_id: 3, source_id: 4, file_name: 'leads.csv' })));
    await waitFor(() => screen.getByText('Skipped (already imported)'));
    expect(screen.getAllByText('Created').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
  });

  it('has an auditable Import History tab with the required columns', async () => {
    render(<LeadImport />);
    fireEvent.click(screen.getByText('History'));           // switch to the History view
    expect(screen.getByText('Import History')).toBeTruthy();
    // the columns the client asked for
    for (const col of ['File', 'Branch', 'Vertical', 'Campaign', 'Rows', 'Created', 'Duplicate', 'Failed', 'Uploaded by', 'When', 'Status']) {
      expect(screen.getAllByText(col).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/No imports in this range/)).toBeTruthy();
  });
});
