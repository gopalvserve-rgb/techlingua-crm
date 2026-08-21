/**
 * FOLLOW-UP FILTER (client #3 → dropdown, Aug 2026) — pins that it renders as a single
 * dropdown with an "All Follow-up" default that CLEARS the filter, offers every preset the
 * client asked for, and still emits the same { followup, fu_from, fu_to } API params.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FollowupFilter, FU_PRESETS, FU_ALL_LABEL } from './followupfilter';

beforeEach(() => cleanup());

const sel = () => screen.getByLabelText('Follow-up filter') as HTMLSelectElement;
const optLabels = () => Array.from(sel().options).map((o) => o.textContent);

describe('FollowupFilter — dropdown with All Follow-up', () => {
  it('is a single dropdown listing All Follow-up + every preset + Custom Range', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} />);
    expect(optLabels()).toEqual([
      FU_ALL_LABEL, 'No Followup', 'Missed', 'Today', 'Tomorrow', 'Next 7 Days', 'Next 30 Days', 'Custom Range',
    ]);
  });

  it('defaults to All Follow-up when no filter is applied', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} />);
    expect(sel().value).toBe('');
    expect(sel().selectedOptions[0].textContent).toBe(FU_ALL_LABEL);
  });

  it('selecting a preset emits { followup: key }', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{}} onChange={onChange} />);
    fireEvent.change(sel(), { target: { value: 'next7' } });
    expect(onChange).toHaveBeenCalledWith({ followup: 'next7' });
    onChange.mockClear();
    fireEvent.change(sel(), { target: { value: 'missed' } });
    expect(onChange).toHaveBeenCalledWith({ followup: 'missed' });
  });

  it('selecting All Follow-up clears the follow-up filter', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{ followup: 'today' }} onChange={onChange} />);
    fireEvent.change(sel(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('reflects the active preset as the selected option', () => {
    render(<FollowupFilter value={{ followup: 'tomorrow' }} onChange={() => {}} />);
    expect(sel().value).toBe('tomorrow');
  });

  it('hides "No Followup" on task lists (allowNoFollowup=false) but keeps All Follow-up', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} allowNoFollowup={false} />);
    expect(optLabels()).not.toContain('No Followup');
    expect(optLabels()).toContain(FU_ALL_LABEL);
    expect(optLabels()).toContain('Missed');
  });

  it('Custom Range reveals From/To inputs that emit followup=custom with the bound date', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{ followup: 'custom' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    expect(onChange).toHaveBeenCalledWith({ followup: 'custom', fu_from: '2026-08-01', fu_to: undefined });
  });

  it('exposes exactly six presets (custom is offered by the dropdown)', () => {
    expect(FU_PRESETS.map((p) => p.key)).toEqual(['no_followup', 'missed', 'today', 'tomorrow', 'next7', 'next30']);
  });
});

/**
 * BUTTONS variant (client Aug 2026) — the Follow-ups module renders the same presets as a
 * single ROW OF BUTTONS (segmented toggle group) instead of a dropdown, emitting identical params.
 */
describe('FollowupFilter — buttons variant', () => {
  const btns = () => screen.getAllByRole('button').map((b) => b.textContent);

  it('renders a button per option (no <select>) in a single row', () => {
    render(<FollowupFilter value={{}} onChange={() => {}} allowNoFollowup={false} variant="buttons" />);
    expect(screen.queryByRole('combobox')).toBeNull();   // no <select> in the buttons variant
    expect(btns()).toEqual([FU_ALL_LABEL, 'Missed', 'Today', 'Tomorrow', 'Next 7 Days', 'Next 30 Days', 'Custom']);
  });

  it('the active preset button is pressed and clicking one emits { followup: key }', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{ followup: 'today' }} onChange={onChange} allowNoFollowup={false} variant="buttons" />);
    const today = screen.getByRole('button', { name: 'Today' });
    expect(today.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Next 7 Days' }));
    expect(onChange).toHaveBeenCalledWith({ followup: 'next7' });
  });

  it('All Follow-up button clears the filter', () => {
    const onChange = vi.fn();
    render(<FollowupFilter value={{ followup: 'missed' }} onChange={onChange} allowNoFollowup={false} variant="buttons" />);
    fireEvent.click(screen.getByRole('button', { name: FU_ALL_LABEL }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('Custom button reveals the From/To date inputs', () => {
    render(<FollowupFilter value={{ followup: 'custom' }} onChange={() => {}} allowNoFollowup={false} variant="buttons" />);
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
  });
});
