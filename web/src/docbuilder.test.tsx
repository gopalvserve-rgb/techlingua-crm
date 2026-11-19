import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PublicDocVerify, TemplateManagement } from './docbuilder';

/**
 * TEMPLATE MANAGEMENT (client 12 Nov 2026): documents grouped by module, templates per document
 * with scope / status / version, a builder per document (live preview, groups & fields, approval),
 * and the public QR verification page.
 */
const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 1, name: 'Admin' } } }) }));
vi.mock('./dyn', () => ({ TemplateEditModal: () => <div data-testid="legacy-modal" /> }));
vi.mock('./refdata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./refdata')>()),
  useRef_: () => ({ branches: [{ id: 40, name: 'Vikaspuri' }], verticals: [{ id: 38, name: 'BCL', branch_id: 40 }], courses: [{ id: 55, name: 'French', meta: { vertical_id: 38 } }] }),
  toast: vi.fn(),
}));
vi.mock('./askdialog', () => ({ askConfirm: vi.fn().mockResolvedValue(true), askText: vi.fn().mockResolvedValue('BCL receipt') }));

const DEF_CFG = {
  v: 1, page: { size: 'A4', orientation: 'portrait', margin: 36 },
  branding: { institute_name: '', tagline: '', title: 'FEE RECEIPT', show_logo: true, logo: '', address: '', phone: '', email: '', website: '', header_bg: '#4f46e5', header_text: '#ffffff', accent: '#4f46e5', title_align: 'right' },
  groups: [{ key: 'receipt', title: 'Receipt', visible: true, fields: [{ key: 'receipt_no', label: 'Receipt No.', visible: true }] }],
  tables: [], body: '', custom_fields: [], partner: { show: false, name: '', text: '' },
  footer: { terms: '', note: '', disclaimer: '', show_qr: false, show_barcode: false, show_generated_at: true, signatories: [], stamp_img: '' },
  design: { font_size: 9.5, columns: 2, borders: true, group_titles: true },
};
const CATALOG = { modules: ['Finance', 'Students', 'Academics', 'HR', 'Certificates'], types: [
  { type: 'fee_receipt', label: 'Fee Receipt', module: 'Finance', source: 'a fee receipt', page: 'A4', orientation: 'portrait', groups: [], default_config: DEF_CFG },
  { type: 'student_id', label: 'Student ID Card', module: 'Students', source: 'a student', page: 'CARD', orientation: 'portrait', groups: [], default_config: DEF_CFG },
  { type: 'certificate', label: 'Course / Completion Certificate', module: 'Certificates', source: 'an issued certificate', page: 'A4', orientation: 'landscape', groups: [], default_config: DEF_CFG },
] };
const TPL = { id: 7, doc_type: 'fee_receipt', name: 'BCL receipt', branch_id: 40, vertical_id: 38, course_id: null, branch_name: 'Vikaspuri', vertical_name: 'BCL',
  is_default: true, status: 'pending', effective_from: '2026-12-01', version_no: 2, updated_at: '2026-11-19T10:00:00Z', submitted_by_name: 'Asha' };

const post = vi.fn().mockResolvedValue({ id: 7 });
const patch = vi.fn().mockResolvedValue({});
vi.mock('./api', () => ({
  getToken: () => 't',
  api: {
    get: (p: string) => {
      if (p.startsWith('/doc-builder/catalog')) return Promise.resolve(CATALOG);
      if (p.startsWith('/doc-builder/templates/7')) return Promise.resolve({ ...TPL, config: DEF_CFG, versions: [{ id: 3, version_no: 1, published_at: '2026-11-18T10:00:00Z' }], audit: [{ action: 'submitted', created_at: '2026-11-19T10:00:00Z', actor_name: 'Asha' }] });
      if (p.startsWith('/doc-builder/templates')) return Promise.resolve([TPL]);
      if (p.startsWith('/document-templates')) return Promise.resolve([{ type: 'fee_receipt', name: 'Fee Receipt', settings: {} }]);
      if (p.startsWith('/doc-builder/samples')) return Promise.resolve([{ id: 99, label: 'RCPT-1 · Riya' }]);
      return Promise.resolve([]);
    },
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: vi.fn().mockResolvedValue({}),
  },
}));

beforeEach(() => {
  cleanup(); post.mockClear(); patch.mockClear(); can.mockReturnValue(true);
  (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['%PDF']), json: async () => ({}) });
  (URL as any).createObjectURL = vi.fn(() => 'blob:x'); (URL as any).revokeObjectURL = vi.fn();
});

describe('Template Management', () => {
  it('groups documents by module and lists each template with scope, status, default and version', async () => {
    render(<TemplateManagement />);
    expect(await screen.findByTestId('tm-doc-fee_receipt')).toBeTruthy();
    expect(screen.getByText('Fee Invoice')).toBeTruthy();                       // its own builder, in Finance
    expect(screen.getByTestId('tm-doc-student_id')).toBeTruthy();
    expect(screen.getByTestId('tm-doc-certificate')).toBeTruthy();
    expect(await screen.findByText('Vikaspuri › BCL')).toBeTruthy();
    expect(screen.getByText('Waiting for approval')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
  });

  it('New template posts the document type and opens the builder', async () => {
    render(<TemplateManagement />);
    fireEvent.click(await screen.findByTestId('tm-new-fee_receipt'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/doc-builder/templates', { doc_type: 'fee_receipt', name: 'BCL receipt' }));
    expect(await screen.findByTestId('doc-builder')).toBeTruthy();
  });

  it('the builder previews live, saves the draft with its scope, and an approver approves a pending template', async () => {
    render(<TemplateManagement />);
    fireEvent.click(await screen.findByTestId('tm-open-7'));
    expect(await screen.findByTestId('doc-builder')).toBeTruthy();
    await waitFor(() => expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/doc-builder/preview', expect.objectContaining({ method: 'POST' })), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('db-step-branding'));
    fireEvent.change(screen.getByTestId('db-title'), { target: { value: 'RECEIPT' } });
    fireEvent.click(screen.getByTestId('db-save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/doc-builder/templates/7', expect.objectContaining({
      branch_id: '40', vertical_id: '38', effective_from: '2026-12-01', config: expect.objectContaining({ branding: expect.objectContaining({ title: 'RECEIPT' }) }),
    })));
    fireEvent.click(screen.getByTestId('db-step-apply'));
    fireEvent.click(screen.getByTestId('db-publish'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/doc-builder/templates/7/publish', expect.anything()));
  });

  it('without approve rights the builder offers Submit for approval instead of Publish', async () => {
    can.mockImplementation((k: string) => k !== 'doctemplate.approve');
    render(<TemplateManagement />);
    fireEvent.click(await screen.findByTestId('tm-open-7'));
    await screen.findByTestId('doc-builder');
    fireEvent.click(screen.getByTestId('db-step-apply'));
    expect(screen.queryByTestId('db-publish')).toBeNull();
  });
});

describe('public verification page', () => {
  it('shows a verified document', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ valid: true, code: 'AB12', document: 'Course / Completion Certificate',
      title: 'CERTIFICATE OF COMPLETION', holder: 'Riya Sharma', doc_no: 'CERT-1', institute: 'BCL', details: { course_name: 'German A1' } }) });
    render(<PublicDocVerify code="AB12" />);
    expect(await screen.findByText('Verified ✓')).toBeTruthy();
    expect(screen.getByText('Riya Sharma')).toBeTruthy();
    expect(screen.getByText('German A1')).toBeTruthy();
  });
  it('says so when revoked', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ valid: false, revoked: true, code: 'AB12', document: 'Certificate', holder: 'X' }) });
    render(<PublicDocVerify code="AB12" />);
    expect(await screen.findByText('Revoked')).toBeTruthy();
  });
});
