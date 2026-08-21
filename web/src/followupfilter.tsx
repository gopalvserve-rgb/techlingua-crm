/**
 * FOLLOW-UP FILTER (client #3, Aug 2026) — presented as a single clean DROPDOWN, consistent
 * with the other Leads filter controls (the Sort / Status selects live in the same `.fchip`
 * shell). The client asked for "all dropdown like follow up related filter": ONE dropdown
 * that lists every follow-up option, with an **All Follow-up** default that applies no
 * follow-up filtering (shows all).
 *
 *   All Follow-up (default) · No Followup · Missed · Today · Tomorrow · Next 7 Days ·
 *   Next 30 Days · Custom Range
 *
 * It emits the API params the follow-ups list and the Leads list already understand
 * (unchanged from the original preset control — see api docs/dev/27):
 *   { followup?: preset, fu_from?: 'YYYY-MM-DD', fu_to?: 'YYYY-MM-DD' }
 * Window semantics are computed SERVER-SIDE in IST (api/src/common/date.util.ts
 * followupWindowSql), so a preset means exactly the same IST window on every screen.
 *
 *   - All Follow-up — no follow-up filtering at all (clears followup/fu_from/fu_to).
 *   - No Followup   — no pending follow-up (a lead attribute; hidden on task lists that are,
 *                     by definition, lists of follow-ups — pass allowNoFollowup={false}).
 *   - Missed        — a pending follow-up now in the PAST (overdue / not completed).
 *   - Today / Tomorrow / Next 7 Days / Next 30 Days — the due-date windows (IST).
 *   - Custom Range  — reveals from/to date pickers.
 */
import { Ic } from './icons';

export interface FollowupValue { followup?: string; fu_from?: string; fu_to?: string }

export type FollowupKey =
  | 'no_followup' | 'missed' | 'today' | 'tomorrow' | 'next7' | 'next30' | 'custom';

/** The presets, in the exact order (and with the exact labels) the client specified. Custom
 *  is offered by the dropdown below; these six are the fixed windows. */
export const FU_PRESETS: Array<{ key: FollowupKey; label: string }> = [
  { key: 'no_followup', label: 'No Followup' },
  { key: 'missed', label: 'Missed' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'next7', label: 'Next 7 Days' },
  { key: 'next30', label: 'Next 30 Days' },
];

/** The label the "no filter" default shows in the dropdown. */
export const FU_ALL_LABEL = 'All Follow-up';

/**
 * Controlled dropdown. Same `.fchip` shell + `<select>` as the other Leads filters, so it sits
 * consistently in the filter bar. Selecting **All Follow-up** clears the follow-up filter
 * entirely; **Custom Range** reveals the from/to inputs. `allowNoFollowup=false` drops the
 * "No Followup" option on the task lists (My Tasks / Today's Follow-ups) where it is not
 * meaningful — All Follow-up + the rest remain.
 */
export function FollowupFilter({
  value, onChange, allowNoFollowup = true, idPrefix = 'fu', style, variant = 'dropdown',
}: {
  value: FollowupValue;
  onChange: (v: FollowupValue) => void;
  allowNoFollowup?: boolean;
  idPrefix?: string;
  style?: React.CSSProperties;
  /** Client Aug 2026 — the Follow-ups module shows these presets as a single ROW OF BUTTONS
   *  (a segmented toggle group) instead of a dropdown. Same emitted params either way. */
  variant?: 'dropdown' | 'buttons';
}) {
  const active = value.followup || '';
  const presets = FU_PRESETS.filter((p) => allowNoFollowup || p.key !== 'no_followup');
  const select = (key: string) => {
    if (!key) return onChange({});                         // All Follow-up -> clear the filter
    if (key === 'custom') return onChange({ followup: 'custom', fu_from: value.fu_from, fu_to: value.fu_to });
    onChange({ followup: key as FollowupKey });
  };
  const setCustom = (k: 'fu_from' | 'fu_to', val: string) =>
    onChange({ followup: 'custom', fu_from: value.fu_from, fu_to: value.fu_to, [k]: val || undefined });

  // BUTTONS variant — a segmented `.seltabs` group, one button per option in a single row.
  if (variant === 'buttons') {
    return (
      <div className="fchip fu-btns" style={style} data-testid="followup-filter">
        <Ic k="cal" />
        <span className="dr-lbl">Follow-up</span>
        <div className="seltabs fu-seltabs" role="group" aria-label="Follow-up filter" style={{ margin: 0 }}>
          <button type="button" className={!active ? 'on' : ''} aria-pressed={!active} onClick={() => select('')}>{FU_ALL_LABEL}</button>
          {presets.map((p) => (
            <button type="button" key={p.key} className={active === p.key ? 'on' : ''}
              aria-pressed={active === p.key} onClick={() => select(p.key)}>{p.label}</button>
          ))}
          <button type="button" className={active === 'custom' ? 'on' : ''}
            aria-pressed={active === 'custom'} onClick={() => select('custom')}>Custom</button>
        </div>
        {active === 'custom' && (
          <span className="fu-custom">
            <label htmlFor={`${idPrefix}-from`} className="dr-lbl">From</label>
            <input id={`${idPrefix}-from`} type="date" className="ainp dr-inp"
              value={value.fu_from ?? ''} onChange={(e) => setCustom('fu_from', e.target.value)} />
            <label htmlFor={`${idPrefix}-to`} className="dr-lbl">To</label>
            <input id={`${idPrefix}-to`} type="date" className="ainp dr-inp"
              value={value.fu_to ?? ''} onChange={(e) => setCustom('fu_to', e.target.value)} />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="fchip fu-drop" style={style} data-testid="followup-filter">
      <Ic k="cal" />
      <label htmlFor={`${idPrefix}-sel`} className="dr-lbl">Follow-up</label>
      <select
        id={`${idPrefix}-sel`} aria-label="Follow-up filter"
        value={active} onChange={(e) => select(e.target.value)}
      >
        <option value="">{FU_ALL_LABEL}</option>
        {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom Range</option>
      </select>
      {active === 'custom' && (
        <span className="fu-custom">
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
      )}
    </div>
  );
}
