/**
 * FOLLOW-UP DATE FILTER (client #3, Aug 2026) — the reusable preset control the client asked
 * for, built to look and behave like the shared DateRange control (daterange.tsx). Presets:
 *
 *   No Followup · Missed · Today · Tomorrow · Next 7 Days · Next 30 Days · Custom Range
 *
 * It emits the API params the follow-ups list and the Leads list already understand:
 *   { followup?: preset, fu_from?: 'YYYY-MM-DD', fu_to?: 'YYYY-MM-DD' }
 * The window semantics are computed SERVER-SIDE in the app timezone (IST) — see
 * api/src/common/date.util.ts followupWindowSql — so a preset means exactly the same IST
 * window on every screen (My Tasks, Today's Follow-ups, Leads).
 *
 *   - No Followup — no pending follow-up (a lead attribute; hidden on task lists that are,
 *                   by definition, lists of follow-ups — pass allowNoFollowup={false}).
 *   - Missed      — a pending follow-up now in the PAST (overdue / not completed).
 *   - Today       — due on IST today.       - Tomorrow  — due on IST today + 1.
 *   - Next 7 Days — due today .. today + 7.  - Next 30 Days — due today .. today + 30.
 *   - Custom Range — from/to date pickers.
 */
import { Ic } from './icons';

export interface FollowupValue { followup?: string; fu_from?: string; fu_to?: string }

export type FollowupKey =
  | 'no_followup' | 'missed' | 'today' | 'tomorrow' | 'next7' | 'next30' | 'custom';

/** The preset chips, in the exact order (and with the exact labels) the client specified. */
export const FU_PRESETS: Array<{ key: FollowupKey; label: string }> = [
  { key: 'no_followup', label: 'No Followup' },
  { key: 'missed', label: 'Missed' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'next7', label: 'Next 7 Days' },
  { key: 'next30', label: 'Next 30 Days' },
];

/**
 * Controlled component. Same markup + classes as DateRange (`.daterange` + `.fchip`), so it
 * sits consistently alongside it on every screen. `allowNoFollowup` hides the "No Followup"
 * chip on the task lists (My Tasks / Today's Follow-ups) where it is not meaningful.
 */
export function FollowupFilter({
  value, onChange, allowNoFollowup = true, idPrefix = 'fu', style,
}: {
  value: FollowupValue;
  onChange: (v: FollowupValue) => void;
  allowNoFollowup?: boolean;
  idPrefix?: string;
  style?: React.CSSProperties;
}) {
  const active = value.followup || '';
  const pick = (key: FollowupKey) => {
    // toggling the active preset clears the filter (back to "any follow-up")
    if (active === key) return onChange({});
    onChange({ followup: key });
  };
  const setCustom = (k: 'fu_from' | 'fu_to', val: string) =>
    onChange({ followup: 'custom', fu_from: value.fu_from, fu_to: value.fu_to, [k]: val || undefined });

  return (
    <div className="daterange" role="group" aria-label="Follow-up date filter" style={style}>
      {FU_PRESETS.filter((p) => allowNoFollowup || p.key !== 'no_followup').map((p) => (
        <button
          key={p.key} type="button"
          className={`fchip${active === p.key ? ' on' : ''}`}
          aria-pressed={active === p.key}
          onClick={() => pick(p.key)}
        >{p.label}</button>
      ))}
      <span className={`fchip dr-custom${active === 'custom' ? ' on' : ''}`}>
        <Ic k="cal" />
        <label htmlFor={`${idPrefix}-from`} className="dr-lbl">From</label>
        <input
          id={`${idPrefix}-from`} type="date" className="ainp dr-inp"
          value={value.fu_from ?? ''} onChange={(e) => setCustom('fu_from', e.target.value)}
        />
        <label htmlFor={`${idPrefix}-to`} className="dr-lbl">To</label>
        <input
          id={`${idPrefix}-to`} type="date" className="ainp dr-inp"
          value={value.fu_to ?? ''} onChange={(e) => setCustom('fu_to', e.target.value)}
        />
      </span>
    </div>
  );
}
