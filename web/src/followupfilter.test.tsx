/**
 * FOLLOW-UP DATE FILTER (client #3) — the reusable preset control. Pins that it renders the
 * exact presets the client asked for and emits the right { followup, fu_from, fu_to } params.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FollowupFilter, FU_PRESETS } from './followupfilter';

beforeEach(() => cleanup());

describe('FollowupFilter — presets + emitted params', () => {
  it('renders the exact preset labels the client specified', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} />);
    for (const lbl of ['No Followup', 'Missed', 'Today', 'Tomorrow', 'Next 7 Days', 'Next 30 Days']) {
      expect(screen.getByRole('button', { name: lbl })).toBeTruthy();
    }
  });

  it('the No Followup chip is hidden on task lists (allowNoFollowup=false)', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} allowNoFollowup={false} />);
    expect(screen.queryByRole('button', { name: 'No Followup' })).toBeNull();
    // the other five remain
    expect(screen.getByRole('button', { name: 'Missed' })).toBeTruthy();
  });

  it('clicking a preset emits { followup: key }', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next 7 Days' }));
    expect(onChange).toHaveBeenCalledWith({ followup: 'next7' });
    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Missed' }));
    expect(onChange).toHaveBeenCalledWith({ followup: 'missed' });
  });

  it('clicking the ACTIVE preset again clears the filter', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{ followup: 'today' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('the active preset is marked aria-pressed', () => {
    render(<FollowupFilter value={{ followup: 'tomorrow' }} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Tomorrow' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('the custom From/To inputs emit followup=custom with the bound date', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    expect(onChange).toHaveBeenCalledWith({ followup: 'custom', fu_from: '2026-08-01', fu_to: undefined });
  });

  it('exposes exactly six preset chips (custom is the date inputs)', () => {
    expect(FU_PRESETS.map((p) => p.key)).toEqual(['no_followup', 'missed', 'today', 'tomorrow', 'next7', 'next30']);
  });
});
