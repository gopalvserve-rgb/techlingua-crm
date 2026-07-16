/**
 * client update #6 regression — client UAT bug (Gopal): "the phone and WhatsApp number
 * fields are too small, while the country code field is unnecessarily large … the number
 * is overflowing outside the input box."
 *
 * Root cause: the country <select> was a fixed, non-shrinkable 108px. The number <input>
 * is flex:1, so it only ever gets what is LEFT OVER — and in the narrowest container the
 * field is used in (the lead sheet's 2-column `.kv` grid inside a 486px sheet = a 219px
 * field) there was almost nothing left over: the select took 49% and the input was left
 * 105px, i.e. 81px of usable text width against a ~77px 10-digit number. Measured live.
 *
 * jsdom does no layout, so these tests cannot measure pixels. What they CAN do — and what
 * actually protects the fix — is pin the layout *intent* and the width budget, so that a
 * future change which re-inflates the selector, or which makes the country code the
 * flexible element instead of the number, fails here instead of in the client's UAT.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PhoneInput, CC_WIDTH, COUNTRIES } from './phonefield';

const renderField = () => {
  cleanup();
  render(<PhoneInput value="+919876543210" onChange={() => {}} />);
  const select = screen.getByLabelText('Country code') as HTMLSelectElement;
  const input = document.querySelector('input[type="tel"]') as HTMLInputElement;
  return { select, input, row: select.parentElement as HTMLElement };
};

describe('PhoneInput layout — the number input must own the space, not the country code', () => {
  it('the country selector is fixed-width and does NOT flex', () => {
    const { select } = renderField();
    // flex:0 0 auto — it must not grow into space the number needs, and must not shrink
    // below its content (a truncated dial code is unusable).
    expect(select.style.flex).toBe('0 0 auto');
    expect(select.style.width).toBe(`${CC_WIDTH}px`);
  });

  it('the NUMBER input is the flexible one — it absorbs all remaining width', () => {
    const { input } = renderField();
    // flex:1, which the CSSOM expands to `1 1 0%`: grow into all free space, and a
    // flex-basis of 0 so `.ainp { width:100% }` cannot claim an intrinsic size first.
    expect(input.style.flex).toBe('1 1 0%');
    expect(input.style.minWidth).toBe('0');   // ...and may shrink below its intrinsic size
    expect(input.style.width).toBe('');       // never pinned to a fixed width
  });

  it('the country code stays inside its width budget (this is the client-reported bug)', () => {
    // Measured in Chrome/Windows at the app's 13px Inter: the widest of the 18 options is
    // a flag + a 3-digit dial = 53.2px; + padding (9+4) + the native arrow (~22px) = 88.2px.
    // Anything above ~96px is space taken from the number for nothing — 108px was the bug.
    expect(CC_WIDTH).toBeLessThanOrEqual(96);
    // ...and it must not be starved either, or a dial code truncates.
    expect(CC_WIDTH).toBeGreaterThanOrEqual(88);
  });

  it('the widest dial code is 3 digits — the width budget above assumes it', () => {
    // If someone adds a 4-digit dial code, the 88.2px measurement above no longer holds
    // and CC_WIDTH must be re-measured. Fail loudly rather than truncate silently.
    const widest = Math.max(...COUNTRIES.map((c) => c.dial.length));
    expect(widest).toBe(3);
  });

  it('both controls stay on the design system (.ainp) inside one flex row', () => {
    const { select, input, row } = renderField();
    expect(select.className).toContain('ainp');
    expect(input.className).toContain('ainp');
    expect(row.style.display).toBe('flex');
  });
});
