/**
 * International phone input (client update #2) — country-code selector + national
 * number, composing one E.164-ish value "+<dial><national>". Default India +91.
 * Used by lead add/edit, quick contact, the lead sheet, login and user forms.
 *
 * UAT-R2 #1 — the country-code selector now sits INSIDE the same bordered textbox as
 * the number (a segmented left-side selector within one input shell), like modern intl
 * phone inputs — not a separate box beside it. The visual border/background lives on the
 * `.phone-shell` wrapper; the <select> and <input> are borderless and transparent. The
 * client-update-6 width budget is preserved: the selector is fixed-width (CC_WIDTH) and
 * the number input is the flexible element (flex:1, min-width:0) so it can never overflow.
 *
 * UAT-R2 #1 DEFECT FIX (client re-report, with screenshot) — THE SELECTED COUNTRY IS
 * COMPONENT STATE, not something derived from the text value. It used to be derived:
 * choosing a country while the number box was empty emitted the bare string "+971", which
 * `splitPhone` could not resolve (its match rule required digits BEYOND the dial code), so
 * it fell back to +91 and returned "971" as the NATIONAL number — the selector snapped back
 * to +91 and the dial digits appeared in the number box. A country choice cannot survive a
 * round-trip through a value that has no room to carry it, so the dial now lives in state
 * and is re-synced only when a value carrying a real number arrives from outside (edit
 * prefill). A country code on its own is NOT a phone number: the field emits ''.
 */
import { useEffect, useRef, useState } from 'react';

export interface Country { iso: string; name: string; dial: string; flag: string }

export const COUNTRIES: Country[] = [
  { iso: 'IN', name: 'India', dial: '91', flag: '🇮🇳' },
  { iso: 'AE', name: 'UAE', dial: '971', flag: '🇦🇪' },
  { iso: 'US', name: 'USA / Canada', dial: '1', flag: '🇺🇸' },
  { iso: 'GB', name: 'UK', dial: '44', flag: '🇬🇧' },
  { iso: 'AU', name: 'Australia', dial: '61', flag: '🇦🇺' },
  { iso: 'SG', name: 'Singapore', dial: '65', flag: '🇸🇬' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966', flag: '🇸🇦' },
  { iso: 'QA', name: 'Qatar', dial: '974', flag: '🇶🇦' },
  { iso: 'KW', name: 'Kuwait', dial: '965', flag: '🇰🇼' },
  { iso: 'OM', name: 'Oman', dial: '968', flag: '🇴🇲' },
  { iso: 'BH', name: 'Bahrain', dial: '973', flag: '🇧🇭' },
  { iso: 'NP', name: 'Nepal', dial: '977', flag: '🇳🇵' },
  { iso: 'BD', name: 'Bangladesh', dial: '880', flag: '🇧🇩' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94', flag: '🇱🇰' },
  { iso: 'DE', name: 'Germany', dial: '49', flag: '🇩🇪' },
  { iso: 'FR', name: 'France', dial: '33', flag: '🇫🇷' },
  { iso: 'NZ', name: 'New Zealand', dial: '64', flag: '🇳🇿' },
  { iso: 'IE', name: 'Ireland', dial: '353', flag: '🇮🇪' },
];

/** Split a stored value into {dial, national}. Unknown/plain values default to +91. */
export function splitPhone(value: string | null | undefined): { dial: string; national: string } {
  const v = String(value ?? '').trim();
  if (!v) return { dial: '91', national: '' };
  const digits = v.replace(/\D/g, '');
  if (v.startsWith('+') || digits.length > 10) {
    // longest dial-code match wins (dial codes here are prefix-free enough)
    const sorted = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
    // A BARE dial code ("+971") resolves to that country with an EMPTY national part.
    // Without this it matched nothing (the rule below needs digits BEYOND the dial code)
    // and fell through to +91 / national "971" — the UAT-R2 #1 defect. Belt and braces:
    // the real fix is that PhoneInput holds the dial in state, but no other caller of
    // splitPhone should be able to walk into the same trap.
    const exact = sorted.find((c) => digits === c.dial);
    if (exact) return { dial: exact.dial, national: '' };
    const hit = sorted.find((c) => digits.startsWith(c.dial) && digits.length > c.dial.length);
    if (hit) return { dial: hit.dial, national: digits.slice(hit.dial.length) };
    if (v.startsWith('+')) return { dial: '91', national: digits };
  }
  return { dial: '91', national: digits };
}

export const joinPhone = (dial: string, national: string) =>
  (national.trim() ? `+${dial}${national.replace(/\D/g, '')}` : '');

/**
 * client update #6 — width of the country-code selector.
 *
 * It used to be a flat 108px, which is ~20px more than the control can ever need.
 * That is invisible on a wide field but ruinous on a narrow one. The budget, measured
 * in Chrome/Windows (the client's own browser) at the app's 13px Inter: the widest of
 * the 18 options (a flag + a 3-digit dial, e.g. Oman +968) is 53.2px; + padding + the
 * native dropdown arrow (~22px) ≈ 88px. 90px leaves ~2px of headroom so no dial code can
 * truncate. Now that the selector lives INSIDE the shell (UAT-R2 #1) it still owns a
 * FIXED slice on the left; the number input is the flex:1 element, so it absorbs all the
 * remaining width in every container the field is used in and never overflows.
 *
 * Keep in sync with phonefield.test.tsx, which pins this layout intent.
 */
export const CC_WIDTH = 90;

export function PhoneInput({ value, onChange, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const parsed = splitPhone(value);
  // The chosen country is STATE. The national number stays derived from `value` (it is the
  // only thing the value can carry losslessly), but the dial cannot be — an empty number
  // has nowhere to keep it. See the header note.
  const [dial, setDial] = useState(parsed.dial);
  const seen = useRef(value);
  useEffect(() => {
    if (value === seen.current) return;
    seen.current = value;
    // Only a value that actually CARRIES a number can tell us its country (edit prefill,
    // or a parent resetting the form). An emptied field keeps the country the user picked.
    const p = splitPhone(value);
    if (p.national) setDial(p.dial);
  }, [value]);
  const national = parsed.national;
  return (
    // One bordered shell holds both controls — the selector is segmented on the left,
    // the number fills the rest. The wrapper carries the border (.phone-shell); the
    // inner controls are borderless so it reads as a single input.
    <div className={`phone-shell${disabled ? ' disabled' : ''}`}>
      <select className="phone-cc ainp" style={{ width: CC_WIDTH, flex: '0 0 auto' }}
        value={dial} disabled={disabled}
        aria-label="Country code"
        onChange={(e) => {
          const next = e.target.value;
          setDial(next);
          seen.current = joinPhone(next, national);
          // Re-join whatever is typed; with an EMPTY number this emits '' — a country code
          // on its own is not a phone number and must never be stored (or typed into the box).
          onChange(joinPhone(next, national));
        }}>
        {COUNTRIES.map((c) => <option key={c.iso} value={c.dial}>{c.flag} +{c.dial}</option>)}
      </select>
      <input className="phone-num ainp" type="tel" style={{ flex: 1, minWidth: 0 }} disabled={disabled}
        placeholder={placeholder ?? 'Mobile number'} value={national}
        onChange={(e) => {
          const nat = e.target.value.replace(/[^\d\s-]/g, '');
          const next = nat.trim() ? joinPhone(dial, nat) : '';
          seen.current = next;   // our own emission must not re-sync (and reset) the dial
          onChange(next);
        }} />
    </div>
  );
}
