/**
 * COLUMN VISIBILITY CHOOSER (client, Aug 2026) — every listing lets each user pick which
 * columns show, remembered per user + per list. Proves: the "Columns" control hides/shows a
 * column immediately AND the choice persists (localStorage keyed by userId + listKey).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TableCard } from './renderer';
import { colIds } from './colprefs';

const COLS = ['Name', 'Email', 'Phone', 'Actions'];
const ROWS = [['Asha', 'a@x.com', '111', 'act'], ['Ravi', 'r@x.com', '222', 'act']] as any;

beforeEach(() => { localStorage.clear(); cleanup(); localStorage.setItem('tlc.uid', '7'); });

describe('column chooser', () => {
  it('a fill listing auto-shows the Columns control and can hide/show a column', () => {
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);
    // all columns visible to start
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeTruthy();
    // open the chooser and hide "Email"
    fireEvent.click(screen.getByTestId('col-chooser'));
    fireEvent.click(screen.getByLabelText('Toggle column Email'));
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();     // hidden immediately
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();       // others stay
    // persisted under the per-user, per-list key
    const raw = localStorage.getItem('tlc.cols.v1.7.Leads');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toContain('Email');
  });

  it('remembers the choice across a remount (persistence)', () => {
    // seed a saved preference (Email hidden) for user 7 on the Leads list
    localStorage.setItem('tlc.cols.v1.7.Leads', JSON.stringify(['Email']));
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Phone' })).toBeTruthy();
  });

  it('is per-user: another user does not inherit the hidden set', () => {
    localStorage.setItem('tlc.cols.v1.7.Leads', JSON.stringify(['Email']));
    localStorage.setItem('tlc.uid', '8'); // different user
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeTruthy(); // visible for user 8
  });

  it('never hides the last visible column (disabled checkbox)', () => {
    render(<TableCard fill title="Tiny" cols={['A', 'B']} rows={[['1', '2']] as any} />);
    fireEvent.click(screen.getByTestId('col-chooser'));
    fireEvent.click(screen.getByLabelText('Toggle column A')); // hide A -> only B left
    // now try to hide B — it must be disabled
    expect((screen.getByLabelText('Toggle column B') as HTMLInputElement).disabled).toBe(true);
  });

  it('a plain (non-fill, no listKey) table shows NO chooser', () => {
    render(<TableCard title="Static" cols={COLS} rows={ROWS} />);
    expect(screen.queryByTestId('col-chooser')).toBeNull();
  });

  it('colIds are blank/duplicate safe', () => {
    expect(colIds(['A', '', 'A'])).toEqual(['A', 'col1', 'A#1']);
  });
});
