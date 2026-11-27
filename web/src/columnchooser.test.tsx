/**
 * COLUMN VISIBILITY CHOOSER (client, Aug 2026) — every listing lets each user pick which
 * columns show, remembered per user + per list. Proves: the "Columns" control hides/shows a
 * column immediately AND the choice persists (localStorage keyed by userId + listKey).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TableCard } from './renderer';
import { colIds, mergeColumnOrder } from './colprefs';

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

/** FB-2026-006 / 15 Nov document point 7 — "rearrange option for column from any table". */
describe('column chooser — arrange columns', () => {
  const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/[▲▼↕]/g, '').trim()).filter((t) => t && t !== '#');
  it('▲ / ▼ move a column; the table and its cells follow; the order is remembered per user + list', () => {
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);
    fireEvent.click(screen.getByTestId('col-chooser'));
    fireEvent.click(screen.getByLabelText('Move Phone up'));
    expect(headers()).toEqual(['Name', 'Phone', 'Email', 'Actions']);
    // the cells moved with their header (row 1: Asha, 111, a@x.com)
    const firstRow = screen.getAllByRole('row')[1];
    const cells = Array.from(firstRow.querySelectorAll('td')).slice(2).map((td) => td.textContent);   // skip the checkbox and # cells
    expect(cells.slice(0, 3)).toEqual(['Asha', '111', 'a@x.com']);
    // the checkbox of that row did not toggle
    expect((screen.getByLabelText('Toggle column Phone') as HTMLInputElement).checked).toBe(true);
    expect(JSON.parse(localStorage.getItem('tlc.colorder.v1.7.Leads')!)).toEqual(['Name', 'Phone', 'Email', 'Actions']);
    cleanup();
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);   // remount: still arranged
    expect(headers()).toEqual(['Name', 'Phone', 'Email', 'Actions']);
  });

  it('Reset restores the original order and shows every column', () => {
    localStorage.setItem('tlc.colorder.v1.7.Leads', JSON.stringify(['Actions', 'Name', 'Phone', 'Email']));
    localStorage.setItem('tlc.cols.v1.7.Leads', JSON.stringify(['Email']));
    render(<TableCard fill title="Leads" cols={COLS} rows={ROWS} />);
    expect(headers()).toEqual(['Actions', 'Name', 'Phone']);
    fireEvent.click(screen.getByTestId('col-chooser'));
    fireEvent.click(screen.getByText('Reset (show all, original order)'));
    expect(headers()).toEqual(['Name', 'Email', 'Phone', 'Actions']);
    expect(localStorage.getItem('tlc.colorder.v1.7.Leads')).toBeNull();
  });

  it('a saved order survives columns being added to or removed from the screen', () => {
    expect(mergeColumnOrder(['Name', 'Email', 'Phone', 'City'], ['Phone', 'Name', 'Email'])).toEqual(['Phone', 'Name', 'Email', 'City']);
    expect(mergeColumnOrder(['Name', 'Phone'], ['Phone', 'Gone', 'Name'])).toEqual(['Phone', 'Name']);
    expect(mergeColumnOrder(['A', 'B', 'C'], [])).toEqual(['A', 'B', 'C']);
  });
});
