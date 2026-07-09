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
  sources: Named[];
  users: Named[];
  statuses: Named[];
  courses: Named[];
  followupTypes: Named[];
  dispositions: Named[];
  budgets: Named[];
  loaded: boolean;
  reload: () => void;
}

const EMPTY: RefData = {
  branches: [], verticals: [], pipelines: [], campaigns: [], sources: [], users: [],
  statuses: [], courses: [], followupTypes: [], dispositions: [], budgets: [],
  loaded: false, reload: () => undefined,
};

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
      const [branches, verticals, pipelines, campaigns, sources, users,
        statuses, courses, followupTypes, dispositions, budgets] = await Promise.all([
        safe(can('branch.read'), () => api.get<Named[]>('/branches'), []),
        safe(can('vertical.read'), () => api.get<Named[]>('/verticals'), []),
        safe(can('pipeline.read'), () => api.get<Named[]>('/pipelines'), []),
        safe(can('campaign.read'), () => api.get<Named[]>('/campaigns'), []),
        safe(can('source.read'), () => api.get<Named[]>('/sources'), []),
        safe(can('user.read'), () => api.get<Named[]>('/users'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/status'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/course'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/followup_type'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/disposition'), []),
        safe(can('master.read'), () => api.get<Named[]>('/masters/budget'), []),
      ]);
      if (dead) return;
      setData({
        branches, verticals, pipelines, campaigns, sources, users,
        statuses, courses, followupTypes, dispositions, budgets,
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
