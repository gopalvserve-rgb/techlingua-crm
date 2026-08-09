/**
 * ADMINISTRATION › SETTINGS › FINANCE — discount / scholarship / capping-limit config.
 *
 * A permitted user (finance.manage) sets, BOTH by PERCENT and by AMOUNT (₹):
 *   · the allowed DISCOUNT       {percent, amount}
 *   · the allowed SCHOLARSHIP    {percent, amount}
 *   · the hard CAPPING LIMIT     {percent, amount}  — the ceiling nobody crosses without
 *     the finance.override right.
 *
 * Scope: org-wide default, or per vertical (most-specific-wins — the same rule as the
 * per-vertical SMTP / Razorpay gateway). Money is entered in ₹ and stored as paise.
 * A blank field = that cap is OFF. Everyone with finance.read can SEE the values; only
 * finance.manage can save — the inputs and the Save button are disabled otherwise.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast } from './refdata';
import { minorToInput, fmtINR } from './money';

interface CapsRow {
  id: number | null;
  vertical_id: number | null;
  vertical_name?: string | null;
  discount_max_pct: number | null;
  discount_max_minor: number | null;
  scholarship_max_pct: number | null;
  scholarship_max_minor: number | null;
  cap_max_pct: number | null;
  cap_max_minor: number | null;
  updated_at?: string | null;
}
interface Vert { id: number; name: string; branch_name: string }
interface Payload { rows: CapsRow[]; verticals: Vert[] }
interface CapPair { pct: number | null; minor: number | null }
interface EffResp { vertical_id: number | null; caps: { discount: CapPair; scholarship: CapPair; cap: CapPair } }

type Draft = {
  discount_pct: string; discount_amt: string;
  scholarship_pct: string; scholarship_amt: string;
  cap_pct: string; cap_amt: string;
};

const toDraft = (r: CapsRow | undefined): Draft => ({
  discount_pct: r?.discount_max_pct != null ? String(r.discount_max_pct) : '',
  discount_amt: minorToInput(r?.discount_max_minor ?? null),
  scholarship_pct: r?.scholarship_max_pct != null ? String(r.scholarship_max_pct) : '',
  scholarship_amt: minorToInput(r?.scholarship_max_minor ?? null),
  cap_pct: r?.cap_max_pct != null ? String(r.cap_max_pct) : '',
  cap_amt: minorToInput(r?.cap_max_minor ?? null),
});

export function FinanceSettings() {
  const { can } = useAuth();
  const mayManage = can('finance.manage');
  const [data, setData] = useState<Payload | null>(null);
  const [eff, setEff] = useState<EffResp | null>(null);
  const [scope, setScope] = useState<string>('org');   // 'org' or a vertical id string
  const [draft, setDraft] = useState<Draft>(toDraft(undefined));
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.get<Payload>('/finance/settings').then(setData).catch(() => setData({ rows: [], verticals: [] }));
  }, [tick]);

  const currentRow = useMemo(() => {
    if (!data) return undefined;
    const vid = scope === 'org' ? null : Number(scope);
    return data.rows.find((r) => (r.vertical_id ?? null) === vid);
  }, [data, scope]);

  useEffect(() => { setDraft(toDraft(currentRow)); }, [currentRow, scope]);

  // Show the EFFECTIVE caps that actually apply for this scope (org-wide merged with the
  // vertical, field by field) — so the client sees the real ceiling after resolution.
  useEffect(() => {
    const qs = scope === 'org' ? '' : `?vertical_id=${Number(scope)}`;
    api.get<EffResp>('/finance/settings/effective' + qs).then(setEff).catch(() => setEff(null));
  }, [scope, tick]);

  const effLine = (label: string, p: CapPair | undefined): string => {
    if (!p || (p.pct == null && p.minor == null)) return `${label}: no limit`;
    const parts: string[] = [];
    if (p.pct != null) parts.push(`${p.pct}%`);
    if (p.minor != null) parts.push(fmtINR(p.minor));
    return `${label}: ${parts.join(' and ')}`;
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/finance/settings', {
        vertical_id: scope === 'org' ? null : Number(scope),
        discount_max_pct: draft.discount_pct,
        discount_max: draft.discount_amt,
        scholarship_max_pct: draft.scholarship_pct,
        scholarship_max: draft.scholarship_amt,
        cap_max_pct: draft.cap_pct,
        cap_max: draft.cap_amt,
      });
      toast('Finance settings saved');
      setTick((t) => t + 1);
    } catch (e) {
      toast((e as Error).message || 'Could not save', true);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const pair = (title: string, blurb: string, pctKey: keyof Draft, amtKey: keyof Draft) => (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head"><h3>{title}</h3></div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>{blurb}</p>
        <div className="frow" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div className="fld" style={{ maxWidth: 220 }}>
            <label>By percentage (%)</label>
            <input className="ainp" type="number" min={0} max={100} step="0.001"
              placeholder="e.g. 20 (blank = off)" value={draft[pctKey]}
              disabled={!mayManage} onChange={set(pctKey)} />
          </div>
          <div className="fld" style={{ maxWidth: 220 }}>
            <label>By amount (₹)</label>
            <input className="ainp" type="text"
              placeholder="e.g. 5000 (blank = off)" value={draft[amtKey]}
              disabled={!mayManage} onChange={set(amtKey)} />
          </div>
        </div>
      </div>
    </div>
  );

  const verticals = data?.verticals ?? [];

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-pad">
          <p className="sub" style={{ marginTop: 0 }}>
            Set the maximum <b>discount</b>, <b>scholarship</b> and the hard <b>capping limit</b> —
            each configurable <b>by percentage AND by amount (₹)</b>. A discount is allowed only when
            it is within <b>both</b> the percent cap and the amount cap (the stricter binds); leave a
            box blank to switch that limit off. The cap is enforced everywhere a discount is entered —
            quotation lines and enrolment. Only a permitted user (<code>finance.manage</code>) can change
            these; a user with <code>finance.override</code> may exceed them at closure.
          </p>
          <div className="fld" style={{ maxWidth: 360 }}>
            <label>Scope</label>
            <select className="ainp" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="org">Organisation-wide (default)</option>
              {verticals.map((v) => (
                <option key={v.id} value={String(v.id)}>{v.branch_name} › {v.name}</option>
              ))}
            </select>
            <div className="fhint">Per-vertical values override the organisation-wide default, field by field.</div>
          </div>
          {!mayManage && (
            <div className="notice warn"><Ic k="bolt" /><div>
              You can view these limits but not change them. Changing the cap needs the
              <b> Finance Settings (manage)</b> permission.
            </div></div>
          )}
        </div>
      </div>

      {eff && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-pad">
            <p className="sub" style={{ marginTop: 0 }}>
              <b>Effective here</b> (organisation-wide merged with this vertical): {effLine('Discount', eff.caps.discount)} ·
              {' '}{effLine('Scholarship', eff.caps.scholarship)} · {effLine('Cap', eff.caps.cap)}.
            </p>
          </div>
        </div>
      )}
      {pair('Discount', 'The discount a counsellor may apply without an override.', 'discount_pct', 'discount_amt')}
      {pair('Scholarship', 'The scholarship limit — percentage or fixed amount.', 'scholarship_pct', 'scholarship_amt')}
      {pair('Capping limit (hard ceiling)', 'The absolute maximum for discount AND scholarship. Nobody crosses this without the override right.', 'cap_pct', 'cap_amt')}

      <div className="card">
        <div className="card-pad" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn" onClick={() => setDraft(toDraft(currentRow))} disabled={saving}>Reset</button>
          <button className="btn primary" onClick={save} disabled={!mayManage || saving}>
            {saving ? 'Saving…' : 'Save finance settings'}
          </button>
        </div>
      </div>
    </>
  );
}

export default FinanceSettings;
