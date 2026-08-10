import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/**
 * ADMISSION DOCUMENT ATTACHMENTS (education + KYC).
 *  · PublicAdmissionForm renders file inputs (Photo / Aadhaar / PAN / Qualification / Other)
 *    and includes a base64 `documents` array in the public submit.
 *  · DocumentList lists the uploaded docs and downloads each via an authenticated fetch.
 */

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Admin' } } }) }));

const post = vi.fn().mockResolvedValue({ ok: true, reference: 501, documents: 1 });
const getRoute = vi.fn((path: string): Promise<unknown> => {
  if (path.startsWith('/public/admission/')) {
    return Promise.resolve({ title: 'Admission Form', fixed: { branch_id: 1, vertical_id: 2, course_id: 3 }, options: { branches: [], verticals: [], courses: [] } });
  }
  if (/\/documents$/.test(path)) {
    return Promise.resolve([{ id: 77, doc_type: 'photo', file_name: 'me.png', mime: 'image/png', size_bytes: 2048 }]);
  }
  return Promise.resolve([]);
});
vi.mock('./api', () => ({
  api: { get: (p: string) => getRoute(p), post: (p: string, b?: unknown) => post(p, b), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
  getToken: () => 'tok',
}));
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => ({ branches: [], verticals: [], courses: [], loaded: true, reload: () => undefined }), toast: vi.fn() };
});

import { PublicAdmissionForm } from './admissions';
import { DocumentList } from './documents';

beforeEach(() => { cleanup(); post.mockClear(); });

const file = (name: string, type: string, bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type });

describe('PublicAdmissionForm — document uploads', () => {
  it('renders the education + KYC file inputs', async () => {
    render(<PublicAdmissionForm formKey="k" />);
    await screen.findByText('Documents');
    for (const id of ['doc-photo', 'doc-aadhaar', 'doc-pan', 'doc-qualification', 'doc-other']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('includes a base64 documents array in the submit body', async () => {
    render(<PublicAdmissionForm formKey="k" />);
    await screen.findByText('Documents');
    fireEvent.change(screen.getByTestId('doc-photo'), { target: { files: [file('me.png', 'image/png')] } });
    fireEvent.click(screen.getByText('Submit application'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/public/admission/k');
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents[0].doc_type).toBe('photo');
    expect(String(body.documents[0].content)).toContain('base64,');
  });

  it('rejects a disallowed file type before upload (no submit)', async () => {
    render(<PublicAdmissionForm formKey="k" />);
    await screen.findByText('Documents');
    fireEvent.change(screen.getByTestId('doc-other'), { target: { files: [file('x.exe', 'application/x-msdownload')] } });
    fireEvent.click(screen.getByText('Submit application'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1];
    expect(body.documents).toBeUndefined();   // the bad file was refused, none attached
  });
});

describe('DocumentList — review / profile download', () => {
  it('lists an uploaded document with a download control', async () => {
    render(<DocumentList basePath="/admissions/99" />);
    expect(await screen.findByText('me.png', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('doc-dl-77')).toBeTruthy();
  });
});
