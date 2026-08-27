/**
 * dev/142 — ContactQuickActions renders Phone / Copy / WhatsApp / Note for a lead with a
 * phone, copies to the clipboard with a "Copied" toast, and renders safely when the phone
 * is missing (no Call/WhatsApp links, Copy disabled, Note still available).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const toastFn = vi.fn((_t: string, _e?: boolean) => undefined);
vi.mock('./refdata', () => ({ toast: (t: string, e?: boolean) => toastFn(t, e) }));

import { ContactQuickActions } from './contactactions';

describe('ContactQuickActions', () => {
  beforeEach(() => { cleanup(); toastFn.mockClear(); });

  it('renders Call, Copy, WhatsApp and Note for a lead with a phone', () => {
    const onNote = vi.fn();
    render(<ContactQuickActions phone="+91 98765 43210" whatsapp="+91 90000 11111" onNote={onNote} />);
    expect(screen.getByRole('link', { name: 'Call' }).getAttribute('href')).toBe('tel:+919876543210');
    expect(screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toBe('https://wa.me/919000011111');
    expect((screen.getByRole('button', { name: 'Copy number' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(onNote).toHaveBeenCalledTimes(1);
  });

  it('copies the raw phone number to the clipboard and toasts "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ContactQuickActions phone="98765 43210" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy number' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('98765 43210'));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith('Copied', false));
  });

  it('renders safely when the phone is missing (no Call/WhatsApp, Copy disabled, Note safe)', () => {
    render(<ContactQuickActions phone={null} onNote={() => undefined} />);
    expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy number' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add note' })).toBeTruthy();
  });
});
