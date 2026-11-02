/** Auto filters: search, column dropdowns and the date range narrow a TableCard's rows. */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { TableCard, Cell } from './renderer';
import { cellDay } from './autofilter';

const COLS = ['Name', 'Status', 'Date', 'Amount', 'Actions'];
const ROWS: Cell[][] = [
  ['ZZ Alpha', { b: ['Draft', 'b-gray'] }, '01 Nov 2026', '₹100', ''],
  ['ZZ Beta', { b: ['Sent', 'b-green'] }, '10 Nov 2026', '₹200', ''],
  ['Gamma', { b: ['Sent', 'b-green'] }, '20 Nov 2026', '₹300', ''],
];
const names = () => [...document.querySelectorAll('tbody tr td:first-child')].map((t) => t.textContent);
const at = (path: string) => window.history.pushState({}, '', path);

beforeEach(() => { cleanup(); at('/m/perf/quotes'); });

describe('auto filters', () => {
  it('search matches any column', () => {
    render(<TableCard title="Q" cols={COLS} rows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'gamma' } });
    expect(names()).toEqual(['Gamma']);
  });

  it('builds a Status dropdown from the column, with none for amounts', () => {
    render(<TableCard title="Q" cols={COLS} rows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Filter by Status'), { target: { value: 'Draft' } });
    expect(names()).toEqual(['ZZ Alpha']);
    expect(screen.queryByLabelText('Filter by Amount')).toBeNull();
  });

  it('date range uses the date column; Clear restores everything', () => {
    render(<TableCard title="Q" cols={COLS} rows={ROWS} />);
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-05' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-11-15' } });
    expect(names()).toEqual(['ZZ Beta']);
    fireEvent.click(screen.getByText('Clear'));
    expect(names().length).toBe(3);
  });

  it('shows a clear message when nothing matches', () => {
    render(<TableCard title="Q" cols={COLS} rows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: 'nothing' } });
    expect(screen.getByText('No records match these filters')).toBeTruthy();
  });

  it('stays off on screens with their own filters', () => {
    at('/m/leads/all');
    render(<TableCard title="Q" cols={COLS} rows={ROWS} />);
    expect(document.querySelector('[data-testid="auto-filters"]')).toBeNull();
  });

  it('reads both date formats', () => {
    expect(cellDay('03 Nov 2026')).toBe('2026-11-03');
    expect(cellDay('2026-11-03T10:00')).toBe('2026-11-03');
    expect(cellDay('Draft')).toBe('');
  });
});
