/**
 * A small in-memory Postgres double for the Sprint-3 sweeps.
 *
 * It does NOT parse SQL generically (the ingestion suite already has that). It matches
 * the worker's handful of statements and, crucially, MODELS THE CLAIM SEMANTICS:
 * `UPDATE ... WHERE reminded_at IS NULL RETURNING id` returns a row only the FIRST time.
 * That is the property the exactly-once tests exist to prove, so the double must be
 * honest about it — a stub that always returns a row would make the test meaningless.
 */
import { DatabaseService } from '../database/database.service';

export interface FollowUpRow {
  id: number; lead_id: number; owner_id: number; scheduled_at: string; notes?: string | null;
  lead_name: string; type_name?: string | null;
  reminded_at: string | null; escalated_at: string | null; escalation_level: number;
  status: string;
}
export interface SlaRow {
  id: number; lead_id: number; metric: string; due_at: string; policy_name: string;
  notify_manager: boolean; escalate_after_minutes: number; lead_name: string; owner_id: number | null;
  breached_at: string | null; notified_at: string | null; satisfied_at: string | null;
}
export interface Notification {
  user_id: number; type: string; severity: string; title: string; body: string | null;
  link_type: string | null; link_id: number | null;
}

export interface State {
  followUps: FollowUpRow[];
  slas: SlaRow[];
  notifications: Notification[];
  audit: Array<{ action: string; entity_id: number }>;
  leads: Record<number, { is_flagged: boolean; flag_reason: string | null; owner_id: number | null }>;
  rollbacks: number;
}

export function makeSprint3Db(over: Partial<State> = {}) {
  const st: State = {
    followUps: [], slas: [], notifications: [], audit: [],
    leads: {}, rollbacks: 0, ...over,
  };

  const exec = (sql: string, params: unknown[] = []): { rows: any[]; rowCount: number } => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ---------- reminder sweep: the DUE query ----------
    if (/FROM follow_up f JOIN lead l/.test(s) && /reminded_at IS NULL/.test(s) && /SELECT/.test(s)) {
      const leadMin = Number(params[0]);
      const rows = st.followUps.filter((f) => {
        if (f.status !== 'pending' || f.reminded_at) return false;
        const remindAt = new Date(f.scheduled_at).getTime() - leadMin * 60_000;
        return remindAt <= Date.now();
      });
      return { rows, rowCount: rows.length };
    }

    // ---------- reminder CLAIM ----------
    if (/UPDATE follow_up SET reminded_at = now\(\)/.test(s)) {
      const f = st.followUps.find((x) => x.id === Number(params[0]) && x.reminded_at === null);
      if (!f) return { rows: [], rowCount: 0 };              // already claimed elsewhere
      f.reminded_at = new Date().toISOString();
      return { rows: [{ id: f.id }], rowCount: 1 };
    }

    // ---------- escalation sweep: the OVERDUE query ----------
    if (/FROM follow_up f JOIN lead l/.test(s) && /escalation_level < /.test(s)) {
      const overdueMin = Number(params[0]);
      const maxLevels = Number(params[1]);
      const repeat = Number(params[2]);
      const rows = st.followUps.filter((f) => {
        if (f.status !== 'pending') return false;
        if (new Date(f.scheduled_at).getTime() > Date.now() - overdueMin * 60_000) return false;
        if (f.escalation_level >= maxLevels) return false;
        if (f.escalated_at && !(repeat > 0 && new Date(f.escalated_at).getTime() <= Date.now() - repeat * 60_000)) return false;
        return true;
      }).map((f) => ({ ...f, lead_owner_id: f.owner_id }));
      return { rows, rowCount: rows.length };
    }

    // ---------- escalation CLAIM (level must still match — optimistic lock) ----------
    if (/UPDATE follow_up SET escalated_at = now\(\), escalation_level = escalation_level \+ 1/.test(s)) {
      const f = st.followUps.find((x) => x.id === Number(params[0])
        && x.escalation_level === Number(params[1]) && x.status === 'pending');
      if (!f) return { rows: [], rowCount: 0 };
      f.escalated_at = new Date().toISOString();
      f.escalation_level += 1;
      return { rows: [{ id: f.id, escalation_level: f.escalation_level }], rowCount: 1 };
    }

    // ---------- SLA breach sweep: the DUE query ----------
    if (/FROM lead_sla s JOIN sla_policy p/.test(s) && /notified_at IS NULL/.test(s) && /SELECT/.test(s)) {
      const rows = st.slas.filter((x) => !x.satisfied_at && !x.notified_at
        && new Date(x.due_at).getTime() + x.escalate_after_minutes * 60_000 <= Date.now());
      return { rows, rowCount: rows.length };
    }

    // ---------- SLA breach CLAIM ----------
    if (/UPDATE lead_sla SET breached_at = COALESCE/.test(s)) {
      const x = st.slas.find((r) => r.id === Number(params[0]) && r.notified_at === null);
      if (!x) return { rows: [], rowCount: 0 };
      x.breached_at = x.breached_at ?? new Date().toISOString();
      x.notified_at = new Date().toISOString();
      return { rows: [{ id: x.id }], rowCount: 1 };
    }

    if (/INSERT INTO notification/.test(s)) {
      st.notifications.push({
        user_id: Number(params[1]), type: String(params[2]), severity: String(params[3]),
        title: String(params[4]), body: (params[5] as string) ?? null,
        link_type: (params[6] as string) ?? null, link_id: params[7] ? Number(params[7]) : null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO audit_log/.test(s)) {
      const action = /'escalate'/.test(s) ? 'escalate' : /'sla_breach'/.test(s) ? 'sla_breach' : 'other';
      st.audit.push({ action, entity_id: Number(params[0]) });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE lead SET is_flagged = TRUE/.test(s)) {
      const id = Number(params[0]);
      st.leads[id] = { ...(st.leads[id] ?? { owner_id: null }), is_flagged: true, flag_reason: String(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE follow_up SET owner_id/.test(s)) {
      const f = st.followUps.find((x) => x.id === Number(params[0]));
      if (f) f.owner_id = Number(params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE lead SET owner_id/.test(s)) {
      const id = Number(params[0]);
      st.leads[id] = { ...(st.leads[id] ?? { is_flagged: false, flag_reason: null }), owner_id: Number(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT org_id, branch_id FROM lead/.test(s)) return { rows: [{ org_id: '1', branch_id: '1' }], rowCount: 1 };
    if (/INSERT INTO lead_activity/.test(s)) return { rows: [], rowCount: 1 };
    if (/SELECT id FROM organisation/.test(s)) return { rows: [{ id: '1' }], rowCount: 1 };
    if (/FROM app_setting/.test(s)) return { rows: [], rowCount: 0 };

    return { rows: [], rowCount: 0 };
  };

  const client = { query: async (sql: string, params?: unknown[]) => exec(sql, params ?? []) };

  const db = {
    query: async (sql: string, params?: unknown[]) => exec(sql, params ?? []).rows,
    one: async (sql: string, params?: unknown[]) => exec(sql, params ?? []).rows[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => {
      // a REAL transaction: if the body throws, everything it wrote is discarded.
      const snapshot = JSON.stringify({ n: st.notifications, f: st.followUps, s: st.slas, a: st.audit, l: st.leads });
      try {
        return await fn(client);
      } catch (e) {
        const prev = JSON.parse(snapshot);
        st.notifications = prev.n; st.followUps = prev.f; st.slas = prev.s; st.audit = prev.a; st.leads = prev.l;
        st.rollbacks++;
        throw e;
      }
    },
  } as unknown as DatabaseService;

  return { db, st };
}

/** settings double: returns whatever policy the test wants, merged over the default. */
export const settingsWith = (policy: Record<string, unknown> = {}) => ({
  get: async (_key: string, fallback: Record<string, unknown>) => ({ ...fallback, ...policy }),
  set: async () => undefined,
}) as any;

export const managersReturning = (ids: number[]) => ({ managersFor: async () => ids }) as any;
export const noScoring = () => ({ ageingSweep: async () => 0, safeRescore: async () => undefined }) as any;
