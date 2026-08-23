/**
 * dev/131 — Campaign module (task #213) + Course/Level (task #214) client-feedback batches.
 *
 * Covers:
 *  - item 4: the Create Campaign form's Campaign Type is a master-backed select (m_campaign_type)
 *            with a ＋ Master quick-add, reading RefData.campaignTypes;
 *  - item 8: the Level master admin form (AddMasterModal type="level") surfaces Branch / Vertical /
 *            Fee / Duration and persists them into the master's meta;
 *  - item 11: the convert modal HIDES the Level selector when the chosen course has zero levels,
 *            and SHOWS it only for a course that actually has levels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CampaignModal } from './forms';
import { AddMasterModal } from './mastermodal';
import { ConvertStudentModal } from './convertstudent';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF: any = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [{ id: 1, name: 'IELTS', branch_id: 9 }, { id: 2, name: 'PTE', branch_id: 10 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [],
  courses: [{ id: 1, name: 'No-Level Course', meta: { vertical_id: 1, fee: 20000 } },
            { id: 2, name: 'Levelled Course', meta: { vertical_id: 1, fee: 0 } }],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [],
  trainings: [], visitPurposes: [], walkinStatuses: [], states: [], cities: [], ticketCategories: [], stages: [],
  courseTypes: [], deliveryModes: [],
  courseLevels: [{ id: 'A1', name: 'A1' }],
  campaignTypes: [{ id: 1, name: 'Digital' }, { id: 2, name: 'Print' }, { id: 3, name: 'Event' }],
  loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ id: 77, name: 'ZZTEST Level' });
const patch = vi.fn().mockResolvedValue({ id: 77 });
const put = vi.fn().mockResolvedValue({});
const get = vi.fn(async (url: string) => {
  if (url === '/masters') return [{ type: 'level', parent: null }];
  if (url === '/branches') return REF.branches;
  if (url === '/verticals') return REF.verticals;
  if (url.startsWith('/students/by-lead/')) return { student: null };
  if (url === '/leads/5') return { branch_id: 9, vertical_id: 1, course_id: 1 };   // no-level course
  if (url === '/leads/6') return { branch_id: 9, vertical_id: 1, course_id: 2 };   // levelled course
  if (url === '/courses/1/levels') return [];
  if (url === '/courses/2/levels') return [{ id: 51, code: 'A1', label: 'A1', fee_minor: 1500000 }];
  return [];
});
vi.mock('./api', () => ({ api: {
  get: (...a: any[]) => (get as any)(...a), post: (...a: any[]) => post(...a),
  patch: (...a: any[]) => patch(...a), put: (...a: any[]) => put(...a), del: vi.fn(),
}, ApiError: class extends Error { status = 0; } }));

const tid = (id: string) => document.querySelector(`[data-testid="${id}"]`);
beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); get.mockClear(); });

describe('item 4 — Campaign Type is a master-backed select', () => {
  it('reads RefData.campaignTypes and offers a ＋ Master quick-add', () => {
    render(<CampaignModal onClose={() => undefined} />);
    const sel = tid('campaign-type-select') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    const opts = [...sel.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('Digital');
    expect(opts).toContain('Event');
    // ＋ Master link is present (add mode + master.create)
    expect([...document.querySelectorAll('a.mlink')].some((a) => a.textContent?.includes('Master'))).toBe(true);
  });
});

describe('item 8 — Level master form has Branch / Vertical / Fee / Duration', () => {
  it('renders the four fields and persists Fee + Duration into meta on save', async () => {
    render(<AddMasterModal type="level" onClose={() => undefined} onCreated={() => undefined} />);
    await waitFor(() => expect(tid('level-branch')).toBeTruthy());
    expect(tid('level-vertical')).toBeTruthy();
    expect(tid('level-fee')).toBeTruthy();
    expect(tid('level-duration')).toBeTruthy();
    fireEvent.change(document.querySelector('.add-modal input.ainp') as HTMLInputElement, { target: { value: 'ZZTEST Level' } });
    fireEvent.change(tid('level-fee') as HTMLInputElement, { target: { value: '15000' } });
    fireEvent.change(tid('level-duration') as HTMLInputElement, { target: { value: '3 Months' } });
    fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/masters/level');
    expect((body as any).meta.fee).toBe(15000);
    expect((body as any).meta.duration).toBe('3 Months');
  });
});

describe('item 11 — convert modal hides the Level selector when the course has no levels', () => {
  it('hides levels for a no-level course', async () => {
    render(<ConvertStudentModal leadId={5} onClose={() => undefined} />);
    await waitFor(() => expect(tid('conv-course-0')).toBeTruthy());
    await waitFor(() => expect(get).toHaveBeenCalledWith('/courses/1/levels'));
    expect(tid('conv-levels-0')).toBeNull();
  });
  it('shows levels for a course that has them', async () => {
    render(<ConvertStudentModal leadId={6} onClose={() => undefined} />);
    await waitFor(() => expect(tid('conv-course-0')).toBeTruthy());
    await waitFor(() => expect(tid('conv-levels-0')).toBeTruthy());
  });
});
