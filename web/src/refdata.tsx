/**
 * Shared reference data (hierarchy, users, masters) loaded once per session,
 * permission-aware so scoped roles (e.g. Counsellor without branch.read) never
 * trigger 403s. Also hosts the tiny global toast used across the app.
 */
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';

export interface Named { id: number; name: string; code?: string; [k: string]: any }

export interface RefData {
  branches: Named[];
  verticals: Named[];
  pipelines: Named[];
  campaigns: Named[];
  /** campaign-scoped `source` rows — the "Lead Source" field on every form */
  sources: Named[];
  /** ALL in-scope pipeline stages (id, name, pipeline_id) — feeds the Leads STAGE filter. */
  stages: Named[];
  /** the LEAD SOURCE MASTER (m_source) — "How did you hear about us?" on the walk-in
   *  form maps here, the same master `source.master_source_id` points at. */
  masterSources: Named[];
  users: Named[];
  statuses: Named[];
  courses: Named[];
  followupTypes: Named[];
  dispositions: Named[];
  budgets: Named[];
  /** UAT-R2 Batch A — masters that used to be hard-coded inline selects. */
  trainings: Named[];      // #5  Training mode
  visitPurposes: Named[];  // #18 Purpose of visit
  walkinStatuses: Named[]; // #19 Walk-in status
  /** Support & Tickets — Ticket Category master (m_ticket_category). */
  ticketCategories: Named[];
  /** Course catalogs (client feedback #13) — seeded dropdown sets for Course Type / Level /
   *  Delivery Mode (GET /courses/*-catalog). id == code == label (human-readable). */
  courseTypes: Named[];
  courseLevels: Named[];
  deliveryModes: Named[];
  /** DEF-2 — Branch City/State are real masters, so the Branch form can select them. */
  states: Named[];
  cities: Named[];
  loaded: boolean;
  reload: () => void;
}

const EMPTY: RefData = {
  branches: [], verticals: [], pipelines: [], campaigns: [], sources: [], masterSources: [], stages: [],
  users: [], statuses: [], courses: [], followupTypes: [], dispositions: [], budgets: [],
  trainings: [], visitPurposes: [], walkinStatuses: [], ticketCategories: [],
  courseTypes: [], courseLevels: [], deliveryModes: [],
  states: [], cities: [],
  loaded: false, reload: () => undefined,
};

/**
 * DEF-1 — deactivated users (status = 'disabled') must never be OFFERED in a picker:
 * the API rejects them as task owner / Report To (400), so they cannot be selectable.
 * A user already stored on the record being edited stays in the list (pass `keep`) so an
 * existing task still renders the name of a since-disabled user instead of going blank.
 */
export const selectableUsers = (users: Named[], keep?: number | string | null): Named[] =>
  users.filter((u) => u.status !== 'disabled' || (keep != null && Number(u.id) === Number(keep)));

const Ctx = createContext<RefData>(EMPTY);
export const useRef_ = () => useContext(Ctx);

export function RefDataProvider({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const [data, setData] = useState<RefData>(EMPTY);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!me) return;
    let dead = false;
    const safe = async <T,>(cond: boolean, p: () => Promise<T>, fallback: T): Promise<T> => {
      if (!cond) return fallback;
      try { return await p(); } catch { return fallback; }
    };
    (async () => {
      const [branches, verticals, pipelines, campaigns, sources, masterSources, users,
        statuses, courses, followupTypes, dispositions, budgets,
        trainings, visitPurposes, walkinStatuses, states, cities, ticketCategories, stages,
        courseTypes, courseLevels, deliveryModes] = await Promise.all([
        safe(can('branch.read'), () => api.get<Named[]>('/branches'), []),
        safe(can('vertical.read'), () => api.get<Named[]>('/verticals'), []),
        safe(can('pipeline.read'), () => api.get<Named[]>('/pipelines'), []),
        safe(can('campaign.read'), () => api.get<Named[]>('/campaigns'), []),
        safe(can('source.read'), () => api.get<Named[]>('/sources'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/source'), []),
        safe(can('user.read'), () => api.get<Named[]>('/users'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/status'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/course'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/followup_type'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/disposition'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/budget'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/training'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/visit_purpose'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/walkin_status'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/state'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/city'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/ticket_category'), []),
        safe(can('pipeline.read'), () => api.get<Named[]>('/stages'), []),
        // Course catalogs (client feedback #13) — Course Type / Level / Delivery Mode dropdowns.
        safe(can('master.read'), async () => (await api.get<any[]>('/courses/type-catalog')).map((r) => ({ id: r.code, name: r.label })), []),
        safe(can('master.read'), async () => (await api.get<any[]>('/courses/level-catalog')).map((r) => ({ id: r.code, name: r.label })), []),
        safe(can('master.read'), async () => (await api.get<any[]>('/courses/delivery-catalog')).map((r) => ({ id: r.code, name: r.label })), []),
      ]);
      if (dead) return;
      setData({
        branches, verticals, pipelines, campaigns, sources, masterSources, users,
        statuses, courses, followupTypes, dispositions, budgets,
        trainings, visitPurposes, walkinStatuses, states, cities, ticketCategories, stages,
        courseTypes, courseLevels, deliveryModes,
        loaded: true, reload: () => setTick((t) => t + 1),
      });
    })();
    return () => { dead = true; };
  }, [me, tick]);

  return <Ctx.Provider value={{ ...data, reload: () => setTick((t) => t + 1) }}>{children}</Ctx.Provider>;
}

/* ------------------------------- toast ------------------------------- */
type ToastMsg = { id: number; text: string; err?: boolean };
let pushToast: (t: ToastMsg) => void = () => undefined;
let seq = 1;

export function toast(text: string, err = false) {
  pushToast({ id: seq++, text, err });
}

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 2600);
    };
    return () => { pushToast = () => undefined; };
  }, []);
  return (
    <div className="global-toast">
      {items.map((t) => (
        <div className={`toast ${t.err ? 'err' : ''}`} key={t.id} style={{ marginTop: 8 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round">
            {t.err ? <path d="M18 6L6 18M6 6l12 12" /> : <path d="M20 6L9 17l-5-5" />}
          </svg>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* Small fetch hook */
export function useFetch<T>(path: string | null, deps: unknown[] = []): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    let dead = false;
    setLoading(true);
    api.get<T>(path)
      .then((d) => { if (!dead) setData(d); })
      .catch(() => { if (!dead) setData(null); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, loading, reload: () => setTick((t) => t + 1) };
}
