/**
 * GLOBAL SCOPE (Aug 2026, client) — a top-bar Branch › Vertical › Pipeline › Campaign selector
 * that filters the WHOLE app to the chosen units.
 *
 * MULTI-SELECT (client, Aug 2026). Each level is now a CHECKBOX multi-select: pick several
 * Branches, several Verticals, etc. The strict cascade holds across the multiple selections —
 * the Vertical picker shows verticals under ANY selected Branch, Pipeline under ANY selected
 * Vertical, and so on; changing a parent prunes any now-orphaned child.
 *
 * HOW IT FOLDS IN. The selection is nothing more than the same *_ids arrays the list screens
 * already honour (branch_ids / vertical_ids / pipeline_ids / campaign_ids). The Shell folds them
 * into every `go()` URL as a BASELINE, and the data screens seed their existing multi-select
 * hierarchy filters from it — so we reuse the tested filtering + RBAC path instead of inventing a
 * parallel one. A screen's own in-panel filter then NARROWS FURTHER within the global scope.
 * For back-compat, when EXACTLY ONE unit is picked at a level we also emit the singular *_id.
 *
 * RBAC. The options come from RefData, which the API already limits to the user's scope. A stored
 * selection is re-validated against RefData on every load, so a scope that is no longer in reach is
 * dropped. The backend ANDs these ids on top of its own ScopeResolver, so the selector can only
 * ever narrow within what the caller may see — it can NEVER widen it.
 */
import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useRef_, Named } from './refdata';
import { Ic } from './icons';
import { UserPicker } from './userpicker';

export type ScopeLevel = 'branch' | 'vertical' | 'pipeline' | 'campaign';

export interface GlobalScope {
  /** Multi-select arrays (client, Aug 2026) — the source of truth. */
  branches: number[]; verticals: number[]; pipelines: number[]; campaigns: number[];
  /** Back-compat single ids: defined ONLY when exactly one unit is picked at that level, so the
   *  many screens that seed a single value keep working unchanged in the common single case. */
  branch?: number; vertical?: number; pipeline?: number; campaign?: number;
}

interface ScopeCtx {
  scope: GlobalScope;
  /** Set one level to an array of ids; prunes every descendant that loses its parent. */
  set: (level: ScopeLevel, ids: number[]) => void;
  clear: () => void;
  /** { branch_ids, vertical_ids, ... } (CSV) + singular *_id when exactly one — folded into URLs / API queries. */
  params: Record<string, string>;
  /** stable string identity of the current scope (drives remount + fetch deps). */
  key: string;
  active: boolean;
}

const EMPTY: ScopeCtx = {
  scope: { branches: [], verticals: [], pipelines: [], campaigns: [] },
  set: () => undefined, clear: () => undefined, params: {}, key: '', active: false,
};
const Ctx = createContext<ScopeCtx>(EMPTY);
export const useScope = () => useContext(Ctx);

const LS_KEY = 'tl_global_scope';

type Raw = { branches: number[]; verticals: number[]; pipelines: number[]; campaigns: number[] };

const posInts = (v: unknown): number[] => {
  const arr = Array.isArray(v) ? v : (v != null ? [v] : []);
  return [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
};

const readLS = (): Raw => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { branches: [], verticals: [], pipelines: [], campaigns: [] };
    const o = JSON.parse(raw);
    // Accept the new arrays AND migrate the old single-value shape ({ branch, vertical, ... }).
    return {
      branches: posInts(o.branches ?? o.branch),
      verticals: posInts(o.verticals ?? o.vertical),
      pipelines: posInts(o.pipelines ?? o.pipeline),
      campaigns: posInts(o.campaigns ?? o.campaign),
    };
  } catch { return { branches: [], verticals: [], pipelines: [], campaigns: [] }; }
};

/** Strict cascade prune: keep only children under a SELECTED parent (an empty parent set means
 *  "not narrowed at that level", so all otherwise-valid children survive). No-op until RefData
 *  has loaded (so we never wipe a stored scope before the option lists exist). */
function normalize(sc: Raw, ref: ReturnType<typeof useRef_>): Raw {
  if (!ref.loaded) return sc;
  const vById = new Map(ref.verticals.map((v) => [Number(v.id), v] as const));
  const pById = new Map(ref.pipelines.map((p) => [Number(p.id), p] as const));
  const cById = new Map(ref.campaigns.map((c) => [Number(c.id), c] as const));
  // Resolve a child's ancestor id at each level (branch/vertical/pipeline) from RefData.
  const vBranch = (id: number) => Number((vById.get(id) as any)?.branch_id);
  const pVert = (id: number) => Number((pById.get(id) as any)?.vertical_id);
  const pBranch = (id: number) => vBranch(pVert(id));
  const cPipe = (id: number) => Number((cById.get(id) as any)?.pipeline_id);
  const cVert = (id: number) => pVert(cPipe(id));
  const cBranch = (id: number) => pBranch(cPipe(id));
  const branches = sc.branches.filter((id) => ref.branches.some((b) => Number(b.id) === id));
  // A child survives only if, at the NEAREST non-empty ancestor level, its ancestor is selected.
  // (An empty ancestor level that was PRUNED to empty still gates via the next level up — so
  //  narrowing Branch drops Verticals AND the Pipelines/Campaigns underneath them.)
  const verticals = sc.verticals.filter((id) => vById.has(id) && (!branches.length || branches.includes(vBranch(id))));
  const pipelines = sc.pipelines.filter((id) => pById.has(id)
    && (verticals.length ? verticals.includes(pVert(id)) : (!branches.length || branches.includes(pBranch(id)))));
  const campaigns = sc.campaigns.filter((id) => cById.has(id)
    && (pipelines.length ? pipelines.includes(cPipe(id))
      : verticals.length ? verticals.includes(cVert(id))
        : (!branches.length || branches.includes(cBranch(id)))));
  return { branches, verticals, pipelines, campaigns };
}

const sameRaw = (a: Raw, b: Raw) => (['branches', 'verticals', 'pipelines', 'campaigns'] as const)
  .every((k) => a[k].length === b[k].length && a[k].every((v, i) => v === b[k][i]));

export function GlobalScopeProvider({ children }: { children: ReactNode }) {
  const ref = useRef_();
  const [raw, setRaw] = useState<Raw>(() => readLS());

  // Re-validate the persisted scope against the RBAC-limited RefData once it has loaded.
  useEffect(() => {
    if (!ref.loaded) return;
    setRaw((prev) => { const next = normalize(prev, ref); return sameRaw(prev, next) ? prev : next; });
  }, [ref.loaded, ref.branches, ref.verticals, ref.pipelines, ref.campaigns]);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(raw)); } catch { /* jsdom */ }
  }, [raw]);

  const value = useMemo<ScopeCtx>(() => {
    const set = (level: ScopeLevel, ids: number[]) => setRaw((prev) => {
      const key = ({ branch: 'branches', vertical: 'verticals', pipeline: 'pipelines', campaign: 'campaigns' } as const)[level];
      return normalize({ ...prev, [key]: posInts(ids) }, ref);
    });
    const one = (a: number[]) => (a.length === 1 ? a[0] : undefined);
    const scope: GlobalScope = {
      branches: raw.branches, verticals: raw.verticals, pipelines: raw.pipelines, campaigns: raw.campaigns,
      branch: one(raw.branches), vertical: one(raw.verticals), pipeline: one(raw.pipelines), campaign: one(raw.campaigns),
    };
    const params: Record<string, string> = {};
    const put = (idsKey: string, oneKey: string, arr: number[]) => {
      if (!arr.length) return;
      params[idsKey] = arr.join(',');
      if (arr.length === 1) params[oneKey] = String(arr[0]); // back-compat singular
    };
    put('branch_ids', 'branch_id', raw.branches);
    put('vertical_ids', 'vertical_id', raw.verticals);
    put('pipeline_ids', 'pipeline_id', raw.pipelines);
    put('campaign_ids', 'campaign_id', raw.campaigns);
    const key = ['branches', 'verticals', 'pipelines', 'campaigns']
      .map((k) => (raw as any)[k].join('.')).join('-');
    return { scope, set, clear: () => setRaw({ branches: [], verticals: [], pipelines: [], campaigns: [] }), params, key, active: Object.keys(params).length > 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, ref.loaded]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* --------------------------- the top-bar selector UI --------------------------- */

/** One cascading level, a scope chip wrapping a searchable checkbox multi-select (UserPicker in
 *  generic-options mode — the same control the list filter bars use). */
function Level({ lv, value, list, onChange }: {
  lv: string; value: number[]; list: Named[]; onChange: (ids: number[]) => void;
}) {
  const opts = useMemo(() => list.map((o) => ({ id: Number(o.id), name: o.name })), [list]);
  return (
    <label className={`scope-chip scope-pick${value.length ? ' on' : ''}`} title={`Filter by ${lv}`}>
      <span className="lv">{lv}</span>
      <span className="vl scope-multi">
        <UserPicker multiple value={value} onChange={onChange} options={opts} hideBranch
          placeholder={value.length ? `${value.length} selected` : 'All'} />
      </span>
    </label>
  );
}

/**
 * The BRANCH › VERTICAL › PIPELINE › CAMPAIGN multi-select selector shown in the top bar. Each
 * level is limited to its parents' choices (under ANY selected parent); every child list is
 * filtered live from RefData, so new branches / verticals appear the moment they are created.
 */
export function ScopeSelector() {
  const ref = useRef_();
  const { scope, set, clear, active } = useScope();

  const verticals = ref.verticals.filter((v) => !scope.branches.length || scope.branches.includes(Number((v as any).branch_id)));
  const pipelines = ref.pipelines.filter((p) => !scope.verticals.length || scope.verticals.includes(Number((p as any).vertical_id)));
  const campaigns = ref.campaigns.filter((c) => !scope.pipelines.length || scope.pipelines.includes(Number((c as any).pipeline_id)));

  return (
    <div className="scope" role="group" aria-label="Global scope">
      <span className="scope-chip org"><span className="lv">Org</span><span className="vl">Tech Lingua LLP</span></span>
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Branch" value={scope.branches} list={ref.branches} onChange={(ids) => set('branch', ids)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Vertical" value={scope.verticals} list={verticals} onChange={(ids) => set('vertical', ids)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Pipeline" value={scope.pipelines} list={pipelines} onChange={(ids) => set('pipeline', ids)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Campaign" value={scope.campaigns} list={campaigns} onChange={(ids) => set('campaign', ids)} />
      {active && (
        <button className="scope-clear" title="Clear scope — show everything I can see" aria-label="Clear scope" onClick={clear}>
          <Ic k="x" /> Clear
        </button>
      )}
    </div>
  );
}
