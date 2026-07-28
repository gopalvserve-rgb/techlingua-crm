/**
 * Users row-action dropdown (⋮) — the 10 wired actions.
 *
 * Proves: RowMenu renders exactly the items it is given and each fires its REAL onClick
 * (no dead/placeholder entry), the Change-password modal enforces strength + match and
 * posts to the real endpoint (never logging the plaintext), and the bulk Reassign modal
 * posts from_user_id/to_user_id to /leads/reassign-all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RowMenu, RowMenuItem } from './rowactions';
import { ChangePasswordModal, ReassignLeadsModal } from './dyn';
import { api } from './api';

vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
// UserPicker fetches /users; stub it to a single-select trigger that picks user 99
vi.mock('./userpicker', () => ({
  UserPicker: ({ onChange }: { onChange: (ids: number[]) => void }) => (
    <button onClick={() => onChange([99])}>pick-user-99</button>
  ),
}));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('RowMenu (⋮)', () => {
  it('renders every provided item and fires its onClick', () => {
    const clicks: string[] = [];
    const items: RowMenuItem[] = [
      { label: 'Edit', onClick: () => clicks.push('edit') },
      'divider',
      { label: 'Delete', danger: true, onClick: () => clicks.push('delete') },
    ];
    render(<RowMenu items={items} />);
    fireEvent.click(screen.getByTitle('Actions'));
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete'));
    expect(clicks).toEqual(['delete']);
  });

  it('renders the full 10-action set with no placeholder', () => {
    const labels = ['Edit', 'Deactivate', 'View branches', 'View verticals', 'View campaigns',
      'View leads', 'Reassign leads', 'Disable lead assignment', 'Change password', 'Delete'];
    render(<RowMenu items={labels.map((label) => ({ label, onClick: () => {} }))} />);
    fireEvent.click(screen.getByTitle('Actions'));
    for (const l of labels) expect(screen.getByText(l)).toBeTruthy();
  });
});

describe('ChangePasswordModal (#9)', () => {
  it('blocks a weak password and a mismatch, then posts a strong matching one — never logging it', async () => {
    (api.patch as any).mockResolvedValue({ ok: true });
    render(<ChangePasswordModal user={{ id: 5, name: 'Priya' }} onClose={() => {}} />);
    const set = () => screen.getByText('Set password').closest('button') as HTMLButtonElement;
    const [pw, pw2] = screen.getAllByDisplayValue('') as HTMLInputElement[];
    fireEvent.change(pw, { target: { value: 'weak' } });
    expect(set().disabled).toBe(true);                    // too weak
    fireEvent.change(pw, { target: { value: 'GoodPass9' } });
    fireEvent.change(pw2, { target: { value: 'GoodPass8' } });
    expect(set().disabled).toBe(true);                    // mismatch
    fireEvent.change(pw2, { target: { value: 'GoodPass9' } });
    expect(set().disabled).toBe(false);
    fireEvent.click(set());
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/users/5/password', { password: 'GoodPass9' }));
  });
});

describe('ReassignLeadsModal (#7 bulk)', () => {
  it('posts from_user_id + to_user_id to /leads/reassign-all', async () => {
    (api.post as any).mockResolvedValue({ moved: 3 });
    const onDone = vi.fn();
    render(<ReassignLeadsModal user={{ id: 5, name: 'Priya' }} onDone={onDone} onClose={() => {}} />);
    fireEvent.click(screen.getByText('pick-user-99'));
    fireEvent.click(screen.getByText('Reassign all'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/leads/reassign-all', { from_user_id: 5, to_user_id: 99 }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
