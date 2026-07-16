/**
 * International phone input (client update #2) — country-code selector + national
 * number, composing one E.164-ish value "+<dial><national>". Default India +91.
 * Used by lead add/edit, quick contact, the lead sheet and user forms.
 */
import { useMemo } from 'react';

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
 * That is invisible on a wide field but ruinous on a narrow one: the lead sheet lays
 * Phone and WhatsApp out in a 2-column `.kv` grid inside a 486px sheet, so the field
 * is only 219px — the 108px select ate 49% of it and left the number input 105px
 * (81px of usable text width). A 10-digit Indian number renders at ~77px, so it sat
 * flush against both edges, and any 11-12 digit international number overflowed and
 * scrolled. That is the bug the client reported.
 *
 * The budget, measured in Chrome/Windows (the client's own browser) at the app's 13px
 * Inter: the widest of the 18 options (a flag + a 3-digit dial, e.g. Oman +968) is
 * 53.2px; + padding (9 + 4) + the native dropdown arrow (~22px) = 88.2px. 90px leaves
 * ~2px of headroom so no dial code can truncate, and hands the ~18px the selector was
 * wasting back to the number input — which is the flex:1 one, so it absorbs the freed
 * space automatically in every container the field is used in.
 *
 * Keep in sync with phonefield.test.tsx, which pins this layout intent.
 */
export const CC_WIDTH = 90;

export function PhoneInput({ value, onChange, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const { dial, national } = useMemo(() => splitPhone(value), [value]);
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <select className="ainp" style={{ width: CC_WIDTH, flex: '0 0 auto', paddingLeft: 9, paddingRight: 4 }}
        value={dial} disabled={disabled}
        aria-label="Country code"
        onChange={(e) => onChange(national ? joinPhone(e.target.value, national) : `+${e.target.value}`)}>
        {COUNTRIES.map((c) => <option key={c.iso} value={c.dial}>{c.flag} +{c.dial}</option>)}
      </select>
      <input className="ainp" type="tel" style={{ flex: 1, minWidth: 0 }} disabled={disabled}
        placeholder={placeholder ?? 'Mobile number'} value={national}
        onChange={(e) => {
          const nat = e.target.value.replace(/[^\d\s-]/g, '');
          onChange(nat.trim() ? joinPhone(dial, nat) : '');
        }} />
    </div>
  );
}
