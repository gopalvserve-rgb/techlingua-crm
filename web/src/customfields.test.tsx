/**
 * CUSTOM FIELDS (client, Aug 2026) — a defined custom field must render on the Add Lead form
 * and its value must map into lead.custom_fields (keyed by field_key), prefill on edit, and show
 * on the detail. Proves the definition → input → custom_fields JSONB mapping (qa/09).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { coerceCf, collectCf, displayCf, CfDef } from './customfields';

/* ------------------------------ mocks (for the AddModal render) ------------- */
const post = vi.fn().mockResolvedValue({ id: 99, name: 'x' });
const CF_DEFS: CfDef[] = [
  { id: 1, entity: 'lead', field_key: 'preferred_batch', label: 'Preferred Batch', data_type: 'text', options: null, required: false, sort_order: 0 },
  { id: 2, entity: 'lead', field_key: 'seats', label: 'Seats', data_type: 'number', options: null, required: false, sort_order: 1 },
];
const getRoute = (path: string): Promise<unknown> => {
  if (path.startsWith('/custom-fields')) return Promise.resolve(CF_DEFS);
  return Promise.resolve([]);
};
vi.mock('./api', () => ({
  api: { get: (p: string) => getRoute(p), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Admin' } } }) }));
const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }], campaigns: [{ id: 5, name: 'Meta', pipeline_id: 4 }],
  sources: [{ id: 7, name: 'Meta Ads', campaign_id: 5 }], masterSources: [], courses: [], statuses: [{ id: 31, name: 'New' }],
  followupTypes: [], dispositions: [], budgets: [], trainings: [{ id: 71, name: 'Online' }], visitPurposes: [],
  walkinStatuses: [], ticketCategories: [], users: [{ id: 3, name: 'Asha', status: 'active' }], states: [], cities: [],
  loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

beforeEach(() => post.mockClear());

/* ------------------------------ the mapping ------------------------------ */
describe('custom-field value mapping', () => {
  it('coerces by type', () => {
    expect(coerceCf('number', '1200')).toBe(1200);
    expect(coerceCf('bool', '1')).toBe(true);
    expect(coerceCf('bool', '')).toBeUndefined();
    expect(coerceCf('text', 'Morning')).toBe('Morning');
    expect(coerceCf('multiselect', 'A, B')).toEqual(['A', 'B']);
    expect(coerceCf('text', '')).toBeUndefined();
  });

  it('collectCf keys the JSON by field_key (not label) and drops blanks', () => {
    const out = collectCf(CF_DEFS, (key) => (key === 'preferred_batch' ? 'Morning' : ''));
    expect(out).toEqual({ preferred_batch: 'Morning' }); // seats blank -> omitted
  });

  it('displayCf presents a stored value for the detail view', () => {
    const boolDef = { ...CF_DEFS[0], data_type: 'bool' as const };
    expect(displayCf(boolDef, true)).toBe('Yes');
    expect(displayCf(CF_DEFS[0], undefined)).toBe('—');
    expect(displayCf(CF_DEFS[0], 'Evening')).toBe('Evening');
  });
});

/* ------------- the SAVER round-trip: value → lead.custom_fields ------------- */
describe('leads.all saver merges custom fields into custom_fields JSONB', () => {
  it('sends admin-defined custom fields (by key) alongside the legacy slots', async () => {
    const { SAVERS } = await import('./forms');
    await SAVERS['leads.all'](
      { Name: 'Priya', 'Mobile Number': '9810000000', 'Training Mode': 'Online' },
      { Campaign: 5, 'Lead Source': 7 },
      { customFields: { preferred_batch: 'Morning', seats: 2 } },
    );
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as [string, any];
    expect(path).toBe('/leads');
    expect(body.custom_fields).toMatchObject({ training_mode: 'Online', preferred_batch: 'Morning', seats: 2 });
  });
});

/* ------------- the definition renders on the Add Lead form ------------- */
describe('Add Lead form renders defined custom fields', () => {
  it('shows an input for every active lead custom-field definition', async () => {
    const { AddModal } = await import('./forms');
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    // definitions arrive async then render as labelled inputs
    await waitFor(() => expect(screen.getByText('Preferred Batch')).toBeTruthy());
    expect(screen.getByText('Seats')).toBeTruthy();
  });
});
