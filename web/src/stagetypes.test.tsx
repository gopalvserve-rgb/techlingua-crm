/**
 * Stage Type master (client, Oct 2026): a named stage type ("Enrolled") is picked from the master
 * and carries its BEHAVIOUR (won) so reports keep working; every stage shows its type label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { StageTypeSelect, StageTypeBadge, stageTypeLabel } from './stagetypes';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true }) }));
const REF = {
  stageTypes: [
    { id: 1, name: 'Open', meta: { behaviour: 'open' } },
    { id: 2, name: 'Won', meta: { behaviour: 'won' } },
    { id: 3, name: 'Lost', meta: { behaviour: 'lost' } },
    { id: 4, name: 'Enrolled', meta: { behaviour: 'won' } },
  ],
  reload: () => undefined,
};
vi.mock('./refdata', async (orig) => ({ ...(await orig<typeof import('./refdata')>()), useRef_: () => REF, toast: vi.fn() }));
vi.mock('./api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn() } }));

beforeEach(() => cleanup());

describe('Stage Type master', () => {
  it('lists the master types, marking a custom type with the behaviour it counts as', () => {
    const { getByTestId } = render(<StageTypeSelect name="Open" behaviour="open" onChange={() => {}} />);
    const opts = [...(getByTestId('stage-type-select') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts).toEqual(['Open', 'Won', 'Lost', 'Enrolled (Won)']);
    expect(getByTestId('stage-type-add')).toBeTruthy();   // ＋ Master to create more
  });

  it('picking a custom type reports its name AND its behaviour', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<StageTypeSelect name="Open" behaviour="open" onChange={onChange} />);
    fireEvent.change(getByTestId('stage-type-select'), { target: { value: 'Enrolled' } });
    expect(onChange).toHaveBeenCalledWith('Enrolled', 'won');
  });

  it('every stage shows a type label — the named type, else its behaviour', () => {
    expect(stageTypeLabel({ stage_type: 'won', stage_type_name: 'Enrolled' })).toBe('Enrolled');
    expect(stageTypeLabel({ stage_type: 'lost' })).toBe('Lost');
    expect(stageTypeLabel({ stage_type: 'open', stage_type_name: '' })).toBe('Open');
    const { getByTestId } = render(<StageTypeBadge stage={{ stage_type: 'won', stage_type_name: 'Enrolled' }} />);
    expect(getByTestId('stage-type-badge').className).toContain('b-green');
  });
});
