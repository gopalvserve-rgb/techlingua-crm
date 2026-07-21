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
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PhoneInput, CC_WIDTH, COUNTRIES, splitPhone } from './phonefield';

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


/**
 * UAT-R2 #1 — THE DEFECT THE LAYOUT TESTS ABOVE MISSED (client re-reported it with a
 * screenshot: "IN +91 | 971", "IN +91 | 44", "IN +91 | 966").
 *
 * Everything above asserts how the control LOOKS. Nothing above ever CHANGES a country,
 * which is the whole interaction the client was reporting — so a control that put the dial
 * digits into the number box and snapped the selector back to +91 shipped with 381 green
 * tests. These tests exercise the interaction instead of the markup.
 */
function Harness({ initial = '', onEmit }: { initial?: string; onEmit?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return <PhoneInput value={v} onChange={(nv) => { onEmit?.(nv); setV(nv); }} />;
}

const mount = (initial = '') => {
  cleanup();
  const emitted: string[] = [];
  render(<Harness initial={initial} onEmit={(v) => emitted.push(v)} />);
  const select = screen.getByLabelText('Country code') as HTMLSelectElement;
  const input = document.querySelector('input[type="tel"]') as HTMLInputElement;
  return { select, input, emitted, last: () => emitted[emitted.length - 1] };
};

describe('PhoneInput interaction — choosing a country must never type into the number box', () => {
  it('picking UAE on an EMPTY field leaves the number box empty and the selector on UAE', () => {
    const { select, input, emitted } = mount('');
    fireEvent.change(select, { target: { value: '971' } });
    expect(select.value).toBe('971');           // selector must NOT snap back to +91
    expect(input.value).toBe('');               // and "971" must NOT land in the number box
    // a country code on its own is not a phone number — nothing to store yet
    expect(emitted[emitted.length - 1]).toBe('');
  });

  it('EVERY one of the 18 countries: empty box stays empty, selector holds the choice', () => {
    for (const c of COUNTRIES) {
      const { select, input, last } = mount('');
      fireEvent.change(select, { target: { value: c.dial } });
      expect(`${c.iso}:${select.value}`).toBe(`${c.iso}:${c.dial}`);
      expect(`${c.iso}:${input.value}`).toBe(`${c.iso}:`);
      expect(`${c.iso}:${last() ?? ''}`).toBe(`${c.iso}:`);
    }
  });

  it('country first, then the number → emits +<dial><national>', () => {
    const { select, input, last } = mount('');
    fireEvent.change(select, { target: { value: '971' } });
    fireEvent.change(input, { target: { value: '501234567' } });
    expect(last()).toBe('+971501234567');
    expect(select.value).toBe('971');
    expect(input.value).toBe('501234567');
  });

  it('number first, then a country change → the typed number survives, only the dial swaps', () => {
    const { select, input, last } = mount('');
    fireEvent.change(input, { target: { value: '9876543210' } });
    expect(last()).toBe('+919876543210');
    fireEvent.change(select, { target: { value: '44' } });
    expect(last()).toBe('+449876543210');
    expect(select.value).toBe('44');
    expect(input.value).toBe('9876543210');
  });

  it('clearing the number keeps the chosen country (it does not snap back to +91)', () => {
    const { select, input, last } = mount('');
    fireEvent.change(select, { target: { value: '966' } });
    fireEvent.change(input, { target: { value: '512345678' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(last()).toBe('');
    expect(select.value).toBe('966');
    expect(input.value).toBe('');
  });

  it('edit prefill of a stored international number shows the right country and national part', () => {
    const { select, input } = mount('+971501234567');
    expect(select.value).toBe('971');
    expect(input.value).toBe('501234567');
  });

  it('edit prefill of a stored Indian number still shows +91', () => {
    const { select, input } = mount('+919876543210');
    expect(select.value).toBe('91');
    expect(input.value).toBe('9876543210');
  });
});

describe('splitPhone is robust to a bare dial code (so no other caller can hit the trap)', () => {
  it('a bare "+971" resolves to UAE with an EMPTY national part, not +91 / "971"', () => {
    expect(splitPhone('+971')).toEqual({ dial: '971', national: '' });
    expect(splitPhone('+44')).toEqual({ dial: '44', national: '' });
    expect(splitPhone('+966')).toEqual({ dial: '966', national: '' });
    expect(splitPhone('+91')).toEqual({ dial: '91', national: '' });
  });

  it('real numbers still split as before', () => {
    expect(splitPhone('+971501234567')).toEqual({ dial: '971', national: '501234567' });
    expect(splitPhone('+919876543210')).toEqual({ dial: '91', national: '9876543210' });
    expect(splitPhone('9876543210')).toEqual({ dial: '91', national: '9876543210' });
    expect(splitPhone('')).toEqual({ dial: '91', national: '' });
  });
});
