/**
 * UAT-R3 — fast focused web tests for the forms this round changed. The full qa10 matrix
 * also covers these, but is too slow for the CI sandbox's per-call window; this file pins
 * the specific new behaviour so it runs quickly on its own.
 *   #17 — Course "Duration" is a free-TEXT input (not number).
 *   #20 — Add Campaign walks a STRICT Branch -> Vertical -> Pipeline cascade.
 *   #21 — Add Source walks a STRICT Branch -> Vertical -> Pipeline -> Campaign cascade,
 *          and posts ONLY campaign_id (path derived server-side).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { AddModal, CampaignModal } from './forms';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [
    { id: 1, name: 'BCL', branch_id: 9 },
    { id: 3, name: 'PTE', branch_id: 10 },
  ],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1, branch_id: 9 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4, vertical_id: 1, branch_id: 9 }],
  sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [],
  trainings: [], visitPurposes: [], walkinStatuses: [],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});
const post = vi.fn().mockResolvedValue({ id: 99, name: 'X' });
vi.mock('./api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: (...a: unknown[]) => post(...a), patch: vi.fn().mockResolvedValue({ id: 1 }), del: vi.fn(), put: vi.fn() } }));

const fld = (name: string) =>
  [...document.querySelectorAll('.add-modal .fld')].find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const sel = (name: string) => fld(name).querySelector('select') as HTMLSelectElement;
const opts = (name: string) => [...sel(name).options].filter((o) => o.value).map((o) => o.value);

beforeEach(() => { cleanup(); post.mockClear(); });

describe('#17 — Course Duration accepts free text', () => {
  it('the Duration field is a text input, not a number input', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    const dur = fld('Duration').querySelector('input') as HTMLInputElement;
    expect(dur.type).toBe('text');
  });
});

describe('#21 — Add Source walks Branch -> Vertical -> Pipeline -> Campaign (strict)', () => {
  it('each child is empty+disabled until its parent is chosen', () => {
    render(<AddModal formKey="leads.sources" onClose={() => {}} />);
    expect(sel('Vertical').disabled).toBe(true);
    expect(sel('Pipeline').disabled).toBe(true);
    expect(sel('Campaign').disabled).toBe(true);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    expect(sel('Vertical').disabled).toBe(false);
    expect(opts('Vertical')).toEqual(['1']);          // branch 9 only
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    expect(opts('Pipeline')).toEqual(['4']);
    fireEvent.change(sel('Pipeline'), { target: { value: '4' } });
    expect(opts('Campaign')).toEqual(['5']);
  });

  it('posts ONLY campaign_id — the path is derived server-side (no branch/vertical/pipeline in body)', async () => {
    render(<AddModal formKey="leads.sources" onClose={() => {}} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(sel('Pipeline'), { target: { value: '4' } });
    fireEvent.change(sel('Campaign'), { target: { value: '5' } });
    const nameInput = fld('Source Name').querySelector('input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'JustDial' } });
    fireEvent.click([...document.querySelectorAll('.add-modal button')].find((b) => /save/i.test(b.textContent || ''))!);
    await Promise.resolve();
    expect(post).toHaveBeenCalledWith('/sources', expect.objectContaining({ campaign_id: 5, name: 'JustDial' }));
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.branch_id).toBeUndefined();
    expect(body.vertical_id).toBeUndefined();
    expect(body.pipeline_id).toBeUndefined();
  });

  it('changing the Branch resets the whole descendant chain', () => {
    render(<AddModal formKey="leads.sources" onClose={() => {}} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(sel('Branch'), { target: { value: '10' } });
    expect(sel('Vertical').value).toBe('');
    expect(sel('Pipeline').disabled).toBe(true);
    expect(sel('Campaign').disabled).toBe(true);
  });
});

const cfld = (name: string) =>
  [...document.querySelectorAll('.add-modal .fld')].find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const csel = (name: string) => cfld(name).querySelector('select') as HTMLSelectElement;

describe('#20 — Add Campaign walks Branch -> Vertical -> Pipeline (strict)', () => {
  it('Vertical is disabled until a Branch is chosen; Pipeline until a Vertical is chosen', () => {
    render(<CampaignModal onClose={() => {}} />);
    expect(csel('Vertical').disabled).toBe(true);
    expect(csel('Pipeline').disabled).toBe(true);
    fireEvent.change(csel('Branch'), { target: { value: '9' } });
    expect(csel('Vertical').disabled).toBe(false);
    expect([...csel('Vertical').options].filter((o) => o.value).map((o) => o.value)).toEqual(['1']);
    fireEvent.change(csel('Vertical'), { target: { value: '1' } });
    expect(csel('Pipeline').disabled).toBe(false);
    expect([...csel('Pipeline').options].filter((o) => o.value).map((o) => o.value)).toEqual(['4']);
  });
});
