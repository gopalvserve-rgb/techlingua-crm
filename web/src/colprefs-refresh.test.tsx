/**
 * Client 10 Nov 2026 (point 1) — "after refreshing the page all column check boxes are selected".
 * Cause: the user id the column chooser keys off (tlc.uid) was written in an AuthProvider effect,
 * which React runs AFTER the child table's effect — so on a fresh page load the table looked under
 * "anon", found nothing and showed every column. This test reproduces a page refresh: empty uid,
 * a saved preference for user 7, /auth/me resolving to user 7, then the Leads table mounting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('./api', () => ({
  getToken: () => 'tok',
  setToken: () => {},
  clearToken: () => {},
  api: { get: vi.fn(async () => ({ user: { id: 7, name: 'U', email: null }, permissionKeys: [], assignments: [] })) },
}));

import { AuthProvider, useAuth } from './auth';
import { TableCard } from './renderer';

const COLS = ['Name', 'Email', 'Phone', 'Actions'];
const ROWS = [['Asha', 'a@x.com', '111', 'act']] as any;

function App() {
  const { me } = useAuth();
  return me ? <TableCard fill title="Leads" cols={COLS} rows={ROWS} /> : <div>loading</div>;
}

beforeEach(() => { cleanup(); localStorage.clear(); });

describe('column choice survives a page refresh', () => {
  it('hidden columns stay hidden on the first render after login resolves', async () => {
    localStorage.setItem('tlc.cols.v1.7.Leads', JSON.stringify(['Email'])); // saved earlier by user 7
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('columnheader', { name: 'Phone' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();
    expect(localStorage.getItem('tlc.uid')).toBe('7');
  });
});
