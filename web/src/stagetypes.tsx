/**
 * STAGE TYPE MASTER (client, Oct 2026) — shared picker + badge for pipeline stages.
 *
 * A stage keeps its BEHAVIOUR in `stage_type` (open | won | lost — what reports, won/lost
 * filters and re-open logic rely on) and the NAMED type the client picked from the Stage Type
 * master in `stage_type_name` (e.g. "Enrolled" behaving as Won). Every stage shows its type
 * badge right after its name.
 */
import { useState } from 'react';
import { useAuth } from './auth';
import { AddMasterModal } from './mastermodal';
import { Named, useRef_ } from './refdata';

export type StageBehaviour = 'open' | 'won' | 'lost';
const BEHAVIOURS: StageBehaviour[] = ['open', 'won', 'lost'];
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The master's stage types; the three built-in behaviours when the master is unavailable. */
export function useStageTypes(): Array<{ name: string; behaviour: StageBehaviour }> {
  const ref = useRef_();
  const rows: Named[] = ref.stageTypes ?? [];
  const list = rows.map((r) => ({ name: String(r.name), behaviour: normBehaviour((r.meta as any)?.behaviour) }));
  return list.length ? list : BEHAVIOURS.map((b) => ({ name: title(b), behaviour: b }));
}

export const normBehaviour = (v: unknown): StageBehaviour =>
  (BEHAVIOURS.includes(String(v) as StageBehaviour) ? String(v) : 'open') as StageBehaviour;

/** The type label shown for a stage: its named type, else its behaviour's label. */
export const stageTypeLabel = (s: { stage_type?: string | null; stage_type_name?: string | null }) =>
  (s.stage_type_name && String(s.stage_type_name).trim()) || title(normBehaviour(s.stage_type));

export const stageTypeClass = (behaviour?: string | null) =>
  (behaviour === 'won' ? 'b-green' : behaviour === 'lost' ? 'b-rose' : 'b-cyan');

/** Small coloured badge: "Enrolled" (green = won), "Lost" (red), "Open" (blue). */
export function StageTypeBadge({ stage }: { stage: { stage_type?: string | null; stage_type_name?: string | null } }) {
  return <span className={`bdg ${stageTypeClass(stage.stage_type)}`} data-testid="stage-type-badge">{stageTypeLabel(stage)}</span>;
}

/**
 * Stage Type select bound to the master. `name` is the picked type; onChange reports the name
 * AND its behaviour, so the caller stores both. A stage whose saved name is no longer in the
 * master still shows it. ＋ Master adds a new type (with its behaviour) inline.
 */
export function StageTypeSelect({ name, behaviour, onChange, disabled, className = 'ainp', withAdd = true }: {
  name?: string | null; behaviour?: string | null; disabled?: boolean; className?: string; withAdd?: boolean;
  onChange: (name: string, behaviour: StageBehaviour) => void;
}) {
  const types = useStageTypes();
  const ref = useRef_();
  const auth = useAuth();
  const can = auth?.can ?? (() => false);
  const [adding, setAdding] = useState(false);
  const current = (name && String(name).trim()) || title(normBehaviour(behaviour));
  const opts = types.some((t) => t.name.toLowerCase() === current.toLowerCase())
    ? types : [...types, { name: current, behaviour: normBehaviour(behaviour) }];
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
      <select className={className} value={current} disabled={disabled} data-testid="stage-type-select"
        title="Stage type — Won / Lost types close the lead"
        onChange={(e) => {
          const t = opts.find((o) => o.name === e.target.value);
          if (t) onChange(t.name, t.behaviour);
        }}>
        {opts.map((t) => <option key={t.name} value={t.name}>{t.name}{t.name.toLowerCase() !== t.behaviour ? ` (${title(t.behaviour)})` : ''}</option>)}
      </select>
      {withAdd && !disabled && can('master.create') && (
        <a className="mlink" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.preventDefault(); setAdding(true); }} data-testid="stage-type-add">＋ Master</a>
      )}
      {adding && (
        <AddMasterModal type="stage_type" onClose={() => setAdding(false)}
          onCreated={(row) => { onChange(String(row.name), normBehaviour((row as any).meta?.behaviour)); ref.reload(); }} />
      )}
    </span>
  );
}
