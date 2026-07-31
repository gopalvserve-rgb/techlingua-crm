/**
 * GLOBAL SCOPE (Aug 2026, client) — a top-bar Branch › Vertical › Pipeline › Campaign selector
 * that filters the WHOLE app to the chosen unit.
 *
 * HOW IT FOLDS IN. The selection is nothing more than the same four filter ids the list
 * screens already honour (branch_id / vertical_id / pipeline_id / campaign_id). The Shell folds
 * them into every `go()` URL as a BASELINE, and the data screens seed their existing hierarchy
 * filters from it — so we reuse the tested filtering + RBAC path instead of inventing a parallel
 * one. A screen's own in-panel filter then NARROWS FURTHER within the global scope.
 *
 * RBAC. The options come from RefData, which the API already limits to the user's scope (a user
 * who can only see Branch X never receives another branch). A stored selection is re-validated
 * against RefData on every load, so a scope that is no longer in reach is dropped. And the
 * backend ANDs these ids on top of its own ScopeResolver, so the selector can only ever narrow
 * within what the caller may see — it can NEVER widen it (a hand-crafted out-of-scope id simply
 * returns nothing).
 */
import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useRef_, Named } from './refdata';
import { Ic } from './icons';

export type ScopeLevel = 'branch' | 'vertical' | 'pipeline' | 'campaign';

export interface GlobalScope {
  branch?: number; vertical?: number; pipeline?: number; campaign?: number;
}

interface ScopeCtx {
  scope: GlobalScope;
  /** Set one level; RESETS every descendant so a stale child can never survive. */
  set: (level: ScopeLevel, id?: number) => void;
  clear: () => void;
  /** { branch_id, vertical_id, ... } as strings — folded into list URLs / API queries. */
  params: Record<string, string>;
  /** stable string identity of the current scope (drives remount + fetch deps). */
  key: string;
  active: boolean;
}

const EMPTY: ScopeCtx = { scope: {}, set: () => undefined, clear: () => undefined, params: {}, key: '', active: false };
const Ctx = createContext<ScopeCtx>(EMPTY);
export const useScope = () => useContext(Ctx);

const LS_KEY = 'tl_global_scope';

const readLS = (): GlobalScope => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : undefined; };
    return { branch: n(o.branch), vertical: n(o.vertical), pipeline: n(o.pipeline), campaign: n(o.campaign) };
  } catch { return {}; }
};

export function GlobalScopeProvider({ children }: { children: ReactNode }) {
  const ref = useRef_();
  const [scope, setScope] = useState<GlobalScope>(() => readLS());

  // Re-validate the persisted scope against the RBAC-limited RefData once it has loaded.
  // Any level pointing at a unit the user cannot see (or whose parent no longer matches) is
  // pruned, cascading downward — the selector never claims a scope the user isn't allowed.
  useEffect(() => {
    if (!ref.loaded) return;
    setScope((prev) => {
      const next: GlobalScope = { ...prev };
      const inList = (list: Named[], id?: number) => id != null && list.some((o) => Number(o.id) === Number(id));
      const childOk = (list: Named[], id: number | undefined, fk: string, parent?: number) =>
        id != null && list.some((o) => Number(o.id) === Number(id) && (parent == null || Number((o as any)[fk]) === Number(parent)));
      if (!inList(ref.branches, next.branch)) next.branch = undefined;
      if (!childOk(ref.verticals, next.vertical, 'branch_id', next.branch)) next.vertical = undefined;
      if (!childOk(ref.pipelines, next.pipeline, 'vertical_id', next.vertical)) next.pipeline = undefined;
      if (!childOk(ref.campaigns, next.campaign, 'pipeline_id', next.pipeline)) next.campaign = undefined;
      // avoid a needless state churn if nothing changed
      if (next.branch === prev.branch && next.vertical === prev.vertical
        && next.pipeline === prev.pipeline && next.campaign === prev.campaign) return prev;
      return next;
    });
  }, [ref.loaded, ref.branches, ref.verticals, ref.pipelines, ref.campaigns]);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(scope)); } catch { /* jsdom */ }
  }, [scope]);

  const value = useMemo<ScopeCtx>(() => {
    const set = (level: ScopeLevel, id?: number) => setScope((prev) => {
      // strict cascade: setting a level clears every level below it
      const order: ScopeLevel[] = ['branch', 'vertical', 'pipeline', 'campaign'];
      const i = order.indexOf(level);
      const next: GlobalScope = { ...prev, [level]: id };
      for (const lower of order.slice(i + 1)) (next as any)[lower] = undefined;
      return next;
    });
    const params: Record<string, string> = {};
    if (scope.branch) params.branch_id = String(scope.branch);
    if (scope.vertical) params.vertical_id = String(scope.vertical);
    if (scope.pipeline) params.pipeline_id = String(scope.pipeline);
    if (scope.campaign) params.campaign_id = String(scope.campaign);
    const key = `${scope.branch ?? ''}-${scope.vertical ?? ''}-${scope.pipeline ?? ''}-${scope.campaign ?? ''}`;
    return { scope, set, clear: () => setScope({}), params, key, active: Object.keys(params).length > 0 };
  }, [scope]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* --------------------------- the top-bar selector UI --------------------------- */

/** One cascading level, rendered as a scope chip whose value is a native <select>. */
function Level({ lv, value, list, onChange }: {
  lv: string; value?: number; list: Named[]; onChange: (id?: number) => void;
}) {
  return (
    <label className={`scope-chip scope-pick${value ? ' on' : ''}`} title={`Filter by ${lv}`}>
      <span className="lv">{lv}</span>
      <span className="vl">
        <select aria-label={lv} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">All</option>
          {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <Ic k="chevd" />
      </span>
    </label>
  );
}

/**
 * The BRANCH › VERTICAL › PIPELINE › CAMPAIGN selector shown in the top bar. Each level is
 * limited to its parent's choice; every child list is filtered live from RefData, so new
 * branches / verticals appear the moment they are created.
 */
export function ScopeSelector() {
  const ref = useRef_();
  const { scope, set, clear, active } = useScope();

  const verticals = ref.verticals.filter((v) => !scope.branch || Number(v.branch_id) === scope.branch);
  const pipelines = ref.pipelines.filter((p) => !scope.vertical || Number(p.vertical_id) === scope.vertical);
  const campaigns = ref.campaigns.filter((c) => !scope.pipeline || Number(c.pipeline_id) === scope.pipeline);

  return (
    <div className="scope" role="group" aria-label="Global scope">
      <span className="scope-chip org"><span className="lv">Org</span><span className="vl">Tech Lingua LLP</span></span>
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Branch" value={scope.branch} list={ref.branches} onChange={(id) => set('branch', id)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Vertical" value={scope.vertical} list={verticals} onChange={(id) => set('vertical', id)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Pipeline" value={scope.pipeline} list={pipelines} onChange={(id) => set('pipeline', id)} />
      <span className="scope-sep"><Ic k="chev" /></span>
      <Level lv="Campaign" value={scope.campaign} list={campaigns} onChange={(id) => set('campaign', id)} />
      {active && (
        <button className="scope-clear" title="Clear scope — show everything I can see" aria-label="Clear scope" onClick={clear}>
          <Ic k="x" /> Clear
        </button>
      )}
    </div>
  );
}
