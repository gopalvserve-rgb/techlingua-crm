import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SmsTemplateModal } from './sprint4';

/** 23 Nov 2026 — SMS Templates made dynamic: the event a template is sent for, and a field per DLT marker. */
vi.mock('./refdata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./refdata')>()),
  useRef_: () => ({ branches: [{ id: 40, name: 'Vikaspuri' }], verticals: [{ id: 39, name: 'INSTA VKP', branch_id: 40 }], users: [] }),
  toast: vi.fn(),
}));
const post = vi.fn(async (_p: string, _b?: unknown) => ({ url: '', resolved_text: '', missing: [], configured: false, note: '', unicode: false }));
const patch = vi.fn(async (_p: string, _b?: unknown) => ({}));
vi.mock('./api', () => ({
  getToken: () => 't',
  api: {
    get: (p: string) => Promise.resolve(p === '/sms-templates/meta' ? {
      triggers: [
        { key: 'new_lead_created', name: 'New Lead Created', category: 'Leads', wired: true },
        { key: 'lead_assigned', name: 'Lead Assigned', category: 'Leads', wired: true },
        { key: 'demo_scheduled', name: 'Demo/Class Scheduled', category: 'Leads', wired: false },
      ],
      variables: [{ key: 'name', label: 'Lead / student name' }, { key: 'course', label: 'Course' }, { key: 'counsellor', label: 'Assigned counsellor' }, { key: 'callback', label: 'Call-back number (vertical phone)' }],
    } : []),
    post: (p: string, b?: unknown) => post(p, b), patch: (p: string, b?: unknown) => patch(p, b), del: vi.fn(),
  },
}));

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

const LEAD_ASSIGNED = 'Dear {#var#}, Your enquiry for {#var#} Course has been assigned to our Admission Counsellor {#var#}. For assistance, call {#cbn#} or visit www.instainfotech.in.';

describe('SMS template — event and marker fields', () => {
  it('one field per marker ({#var#} and {#cbn#}), the call-back number by default for {#cbn#}; the event is saved', async () => {
    render(<SmsTemplateModal onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/Header/), { target: { value: 'lNSTAI' } });
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: 'Insta Lead Assigned' } });
    fireEvent.change(screen.getByLabelText(/Template body/), { target: { value: LEAD_ASSIGNED } });
    expect(screen.getAllByLabelText(/^Marker \d$/)).toHaveLength(4);
    expect((screen.getByTestId('sms-var-3') as HTMLSelectElement).value).toBe('callback');
    fireEvent.change(screen.getByTestId('sms-var-2'), { target: { value: 'counsellor' } });
    await waitFor(() => expect((screen.getByTestId('sms-trigger') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    fireEvent.change(screen.getByTestId('sms-trigger'), { target: { value: 'lead_assigned' } });
    fireEvent.click(screen.getByText('Create template'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/sms-templates', expect.objectContaining({
      header: 'lNSTAI', trigger_event: 'lead_assigned', var_mapping: ['name', 'course', 'counsellor', 'callback'],
    })));
  });

  it('an older template saved as "lead_created" opens as New Lead Created, keeping its field order', async () => {
    render(<SmsTemplateModal initial={{ id: 1, header: 'BCLDEL', name: 'BCL New Lead', body: 'Dear {#var#}, enquiry for {#var#} Course.', branch_id: null, vertical_id: null,
      dlt_template_id: '1', entity_id: null, var_mapping: ['name', 'course'], unicode: null, trigger_event: 'lead_created', is_active: true }} onClose={() => undefined} onSaved={() => undefined} />);
    expect((screen.getByTestId('sms-trigger') as HTMLSelectElement).value).toBe('new_lead_created');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/sms-templates/1', expect.objectContaining({ trigger_event: 'new_lead_created', var_mapping: ['name', 'course'] })));
  });
});
