/**
 * Forgot-password link + reset page (client-reported gap).
 *   · Login shows a "Forgot password?" link that opens the request form and posts
 *     /auth/forgot-password, then shows the generic confirmation.
 *   · The reset page reads ?token= and posts /auth/reset-password with the new password.
 *   · Client-side guards: mismatch + weak password never reach the API.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const calls: Array<{ path: string; body: any }> = [];
const post = vi.fn(async (path: string, body: any) => { calls.push({ path, body }); return { message: 'If an account exists for that address, a password reset link has been sent.' }; });
vi.mock('./api', () => ({
  api: { post: (p: string, b: any) => post(p, b) },
  ApiError: class ApiError extends Error { constructor(public status: number, m: string) { super(m); } },
}));
vi.mock('./auth', () => ({ useAuth: () => ({ login: vi.fn(), loginWithToken: vi.fn() }) }));

import { LoginPage } from './Login';
import { ResetPasswordPage } from './resetpassword';

beforeEach(() => { calls.length = 0; post.mockClear(); });
afterEach(cleanup);

describe('Login forgot-password link', () => {
  it('opens the request form and posts /auth/forgot-password', async () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.click(screen.getByText('Forgot password?'));
    fireEvent.change(screen.getByPlaceholderText('you@techlingua.in'), { target: { value: 'admin@techlingua.in' } });
    fireEvent.click(screen.getByText('Send reset link'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(calls[0].path).toBe('/auth/forgot-password');
    expect(calls[0].body).toEqual({ email: 'admin@techlingua.in' });
    await screen.findByText(/reset link has been sent/i);
  });
});

describe('ResetPasswordPage', () => {
  const renderAt = (search: string) =>
    render(<MemoryRouter initialEntries={[`/reset-password${search}`]}><ResetPasswordPage /></MemoryRouter>);

  it('posts /auth/reset-password with the token + new password', async () => {
    renderAt('?token=TESTTOKEN');
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'NewPass123' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter the password'), { target: { value: 'NewPass123' } });
    fireEvent.click(screen.getByText('Set new password'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(calls[0].path).toBe('/auth/reset-password');
    expect(calls[0].body).toEqual({ token: 'TESTTOKEN', new_password: 'NewPass123' });
  });

  it('mismatched passwords never reach the API', async () => {
    renderAt('?token=TESTTOKEN');
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'NewPass123' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter the password'), { target: { value: 'Different123' } });
    fireEvent.click(screen.getByText('Set new password'));
    await screen.findByText(/do not match/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('weak password never reaches the API', async () => {
    renderAt('?token=TESTTOKEN');
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'short' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter the password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByText('Set new password'));
    await screen.findByText(/at least 8 characters/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('missing token disables the form and warns', () => {
    renderAt('');
    expect(screen.getByText(/missing its token/i)).toBeTruthy();
    expect((screen.getByText('Set new password') as HTMLButtonElement).disabled).toBe(true);
  });
});
