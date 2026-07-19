/**
 * UAT-R2 #1 — the country-code selector must sit INSIDE the same bordered textbox as
 * the number (a segmented left-side selector within one input shell), not as a separate
 * box beside it. These tests pin that unified layout AND the client-update-6 width intent.
 *
 * jsdom does no layout, so these tests cannot measure pixels. What they CAN do — and what
 * actually protects the design — is pin (a) that both controls live inside ONE `.phone-shell`
 * wrapper (the single bordered box), and (b) the layout *intent* and width budget, so that a
 * future change which splits the control back into two boxes, re-inflates the selector, or
 * makes the country code the flexible element instead of the number, fails here instead of
 * in the client's UAT.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PhoneInput, CC_WIDTH, COUNTRIES } from './phonefield';

const renderField = () => {
  cleanup();
  render(<PhoneInput value="+919876543210" onChange={() => {}} />);
  const select = screen.getByLabelText('Country code') as HTMLSelectElement;
  const input = document.querySelector('input[type="tel"]') as HTMLInputElement;
  return { select, input, shell: select.parentElement as HTMLElement };
};

describe('PhoneInput layout — one unified box, number owns the space', () => {
  it('the selector and the number live INSIDE ONE bordered shell (not two boxes)', () => {
    const { select, input, shell } = renderField();
    // the whole point of #1: a single container holds both controls.
    expect(shell.className).toContain('phone-shell');
    expect(input.parentElement).toBe(shell);   // same parent => same box
    expect(select.parentElement).toBe(shell);
    // exactly one shell, one select, one number input rendered
    expect(document.querySelectorAll('.phone-shell').length).toBe(1);
    expect(shell.querySelectorAll('select').length).toBe(1);
    expect(shell.querySelectorAll('input[type="tel"]').length).toBe(1);
  });

  it('the country selector is the FIXED-width segment on the left', () => {
    const { select } = renderField();
    // flex:0 0 auto — it must not grow into space the number needs, and must not shrink
    // below its content (a truncated dial code is unusable).
    expect(select.style.flex).toBe('0 0 auto');
    expect(select.style.width).toBe(`${CC_WIDTH}px`);
    expect(select.className).toContain('phone-cc');
  });

  it('the NUMBER input is the flexible one — it absorbs all remaining width and cannot overflow', () => {
    const { input } = renderField();
    // flex:1, which the CSSOM expands to `1 1 0%`: grow into all free space, and a
    // flex-basis of 0 so the number can shrink below its intrinsic size rather than spill.
    expect(input.style.flex).toBe('1 1 0%');
    expect(input.style.minWidth).toBe('0');   // ...and may shrink below its intrinsic size
    expect(input.style.width).toBe('');       // never pinned to a fixed width
    expect(input.className).toContain('phone-num');
  });

  it('the country code stays inside its width budget (this is the client-reported bug)', () => {
    // Measured in Chrome/Windows at the app's 13px Inter: the widest of the 18 options is
    // a flag + a 3-digit dial = 53.2px; + padding + the native arrow (~22px) ≈ 88px.
    // Anything above ~96px is space taken from the number for nothing — 108px was the bug.
    expect(CC_WIDTH).toBeLessThanOrEqual(96);
    // ...and it must not be starved either, or a dial code truncates.
    expect(CC_WIDTH).toBeGreaterThanOrEqual(88);
  });

  it('the widest dial code is 3 digits — the width budget above assumes it', () => {
    // If someone adds a 4-digit dial code, the 88px measurement above no longer holds
    // and CC_WIDTH must be re-measured. Fail loudly rather than truncate silently.
    const widest = Math.max(...COUNTRIES.map((c) => c.dial.length));
    expect(widest).toBe(3);
  });

  it('both controls stay on the design system (.ainp) inside the shell', () => {
    const { select, input } = renderField();
    expect(select.className).toContain('ainp');
    expect(input.className).toContain('ainp');
  });
});
