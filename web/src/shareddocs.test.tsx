import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SharedDocs } from './completion';

/** Client 12 Nov 2026 — Workspace › Shared Documents completed: sub-folders, versions, edit / move. */
const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 1 } } }) }));
vi.mock('./refdata', async (importOriginal) => ({ ...(await importOriginal<typeof import('./refdata')>()), useRef_: () => ({ branches: [], verticals: [], users: [] }), toast: vi.fn() }));
vi.mock('./askdialog', () => ({ askConfirm: vi.fn().mockResolvedValue(true), askText: vi.fn().mockResolvedValue('Brochures') }));

const FOLDERS = [{ id: 1, name: 'Marketing', parent_id: null, files: 1, subfolders: 1 }, { id: 2, name: 'Brochures', parent_id: 1, files: 0, subfolders: 0 }];
const DOC = { id: 7, folder_id: 1, title: 'Fee chart', file_name: 'fees.pdf', mime: 'application/pdf', size_bytes: 1200, share_scope: 'all', version_no: 2, downloads: 3, created_at: '2026-11-19T10:00:00Z' };
const post = vi.fn().mockResolvedValue({});
const patch = vi.fn().mockResolvedValue({});
const gets: string[] = [];
vi.mock('./api', () => ({
  getToken: () => 't',
  api: {
    get: (p: string) => {
      gets.push(p);
      if (p.startsWith('/shared-docs/7/versions')) return Promise.resolve([{ id: 3, version_no: 1, file_name: 'fees-old.pdf', created_at: '2026-11-01T00:00:00Z', replaced_at: '2026-11-19T00:00:00Z' }]);
      if (p.startsWith('/shared-docs')) return Promise.resolve({ rows: [DOC], folders: FOLDERS, admin: true });
      return Promise.resolve([]);
    },
    post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), del: vi.fn().mockResolvedValue({}),
  },
}));

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); gets.length = 0; });

describe('Shared Documents', () => {
  it('shows top-level folders; opening one shows its breadcrumb and its sub-folders, and a new folder goes inside it', async () => {
    render(<SharedDocs />);
    fireEvent.click(await screen.findByTestId('doc-folder-1'));
    await waitFor(() => expect(gets.some((g) => g.includes('folder_id=1'))).toBe(true));
    expect((await screen.findByTestId('doc-crumbs')).textContent).toContain('Marketing');
    expect(screen.getByTestId('doc-folder-2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('doc-new-folder'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/shared-docs/folders', { name: 'Brochures', parent_id: 1 }));
  });

  it('lists the version and opens the version history', async () => {
    render(<SharedDocs />);
    expect(await screen.findByText('v2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('doc-versions-7'));
    expect(await screen.findByText('fees-old.pdf')).toBeTruthy();
  });

  it('edit saves title and folder through PATCH', async () => {
    render(<SharedDocs />);
    fireEvent.click(await screen.findByTestId('doc-edit-7'));
    fireEvent.change(await screen.findByTestId('doc-title'), { target: { value: 'Fee chart 2027' } });
    fireEvent.change(screen.getByTestId('doc-folder'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('doc-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/shared-docs/7', expect.objectContaining({ title: 'Fee chart 2027', folder_id: '2' })));
  });
});
