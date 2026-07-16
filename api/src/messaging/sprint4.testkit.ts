/**
 * An in-memory Postgres double for the Sprint-4 outbound pipeline and journeys.
 *
 * Like the Sprint-3 kit, it does NOT parse SQL generically — it matches the handful of
 * statements these services issue, and it MODELS THE SEMANTICS THE TESTS EXIST TO PROVE:
 *
 *   · `INSERT ... ON CONFLICT (journey_id, lead_id, trigger_key) DO NOTHING RETURNING id`
 *     returns a row ONLY the first time. A stub that always returned an id would make the
 *     "no double-send" test a lie.
 *   · `message_log` really holds the queue state, so retry/backoff and the failure reason
 *     are observable exactly as they are in Postgres.
 */
import { DatabaseService } from '../database/database.service';

export interface MsgRow {
  id: number; channel: string; provider: string | null; status: string;
  lead_id: number | null; user_id: number | null; template_id: number | null;
  journey_id: number | null; journey_run_id: number | null;
  vertical_id: number | null; branch_id: number | null; campaign_id: number | null;
  to_addr: string; subject: string | null; body: string;
  attempts: number; run_after: Date; error: string | null; not_configured: boolean;
  provider_message_id: string | null; provider_response: Record<string, unknown>;
  created_at: Date; sent_at: Date | null;
}
export interface RunRow {
  id: number; journey_id: number; lead_id: number; trigger_key: string;
  status: string; step_index: number; next_run_at: Date; steps: unknown[];
  reason: string | null; attempts: number;
}

export interface S4State {
  messages: MsgRow[];
  optOuts: Array<{ id: number; channel: string; identifier: string; lead_id: number | null }>;
  channelConfigs: Array<{
    id: number; channel: string; provider: string; vertical_id: number | null;
    config: Record<string, unknown>; secrets: Record<string, string>; is_active: boolean;
  }>;
  journeys: Array<Record<string, unknown>>;
  runs: RunRow[];
  leads: Record<number, Record<string, unknown>>;
  followUps: Array<Record<string, unknown>>;
  activities: Array<{ lead_id: number; type: string; note: string }>;
  stages: Record<number, { id: number; name: string; pipeline_id: number }>;
  templates: Record<number, Record<string, unknown>>;
  settings: Record<string, Record<string, unknown>>;
  notifications: Array<{ user_id: number; title: string }>;
}

export function makeSprint4Db(over: Partial<S4State> = {}) {
  const st: S4State = {
    messages: [], optOuts: [], channelConfigs: [], journeys: [], runs: [], leads: {},
    followUps: [], activities: [], stages: {}, templates: {}, settings: {}, notifications: [],
    ...over,
  };
  let msgSeq = 100; let runSeq = 500; let fuSeq = 900; let ooSeq = 10;
  let cfgSeq = st.channelConfigs.reduce((m, c) => Math.max(m, c.id), 0);

  const exec = (sql: string, params: unknown[] = []): { rows: any[]; rowCount: number } => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const R = (rows: any[]) => ({ rows, rowCount: rows.length });

    if (/SELECT id FROM organisation/.test(s)) return R([{ id: '1' }]);

    /* ---------------------------------------------------------- app_setting */
    if (/SELECT value FROM app_setting WHERE key/.test(s)) {
      const v = st.settings[String(params[0])];
      return R(v ? [{ value: v }] : []);
    }
    if (/INSERT INTO app_setting/.test(s)) {
      st.settings[String(params[0])] = JSON.parse(String(params[1]));
      return R([]);
    }

    /* ------------------------------------------------------- channel_config */
    if (/FROM channel_config WHERE channel = \$1/.test(s)) {
      const ch = String(params[0]);
      const vid = params[1] == null ? null : Number(params[1]);
      const rows = st.channelConfigs.filter((c) => c.channel === ch && c.is_active
        && (c.vertical_id === vid || c.vertical_id === null));
      // ORDER BY vertical_id NULLS LAST -> the VERTICAL row wins over the org row
      rows.sort((a, b) => (a.vertical_id === null ? 1 : 0) - (b.vertical_id === null ? 1 : 0));
      return R(rows.slice(0, 1));
    }

    // --- the WRITE side of the credential store (Settings save + Embedded Signup) ---
    // Modelled properly, because "the token is encrypted at rest and masked on read" is
    // exactly the claim these tests exist to prove — a stub that swallowed the write
    // would make that proof worthless.
    if (/SELECT id FROM organisation ORDER BY id LIMIT 1/.test(s)) return R([{ id: 1 }]);

    if (/SELECT \* FROM channel_config WHERE org_id = \$1 AND channel = \$2/.test(s)) {
      const ch = String(params[1]);
      const vid = params[2] == null ? null : Number(params[2]);
      return R(st.channelConfigs.filter((c) => c.channel === ch && (c.vertical_id ?? null) === vid));
    }
    if (/UPDATE channel_config SET provider = \$2/.test(s)) {
      const row = st.channelConfigs.find((c) => c.id === Number(params[0]));
      if (!row) return R([]);
      row.provider = String(params[1]);
      row.config = JSON.parse(String(params[2]));
      row.secrets = JSON.parse(String(params[3]));
      if (params[4] != null) row.is_active = !!params[4];
      return R([row]);
    }
    if (/INSERT INTO channel_config/.test(s)) {
      const row = {
        id: ++cfgSeq, channel: String(params[1]), provider: String(params[2]),
        vertical_id: params[3] == null ? null : Number(params[3]),
        config: JSON.parse(String(params[4])), secrets: JSON.parse(String(params[5])),
        is_active: params[6] === false ? false : true,
      };
      st.channelConfigs.push(row);
      return R([row]);
    }
    if (/FROM channel_config c\s+LEFT JOIN vertical v/.test(s) && /WHERE c\.id = \$1/.test(s)) {
      const row = st.channelConfigs.find((c) => c.id === Number(params[0]));
      return R(row ? [{ ...row, vertical_name: null }] : []);
    }
    if (/UPDATE channel_config SET last_test_at/.test(s)) {
      const row = st.channelConfigs.find((c) => c.id === Number(params[0])) as any;
      if (row) { row.last_test_ok = params[1]; row.last_test_error = params[2]; row.last_test_at = new Date(); }
      return R([]);
    }

    /* -------------------------------------------------------------- opt_out */
    if (/SELECT id FROM opt_out WHERE identifier/.test(s)) {
      const [ident, ch] = [String(params[0]), String(params[1])];
      const hit = st.optOuts.find((o) => o.identifier === ident && (o.channel === ch || o.channel === 'all'));
      return R(hit ? [{ id: hit.id }] : []);
    }
    if (/INSERT INTO opt_out/.test(s)) {
      const [, channel, identifier, leadId] = params as [unknown, string, string, number | null];
      let row = st.optOuts.find((o) => o.channel === channel && o.identifier === identifier);
      if (!row) { row = { id: ++ooSeq, channel, identifier, lead_id: leadId ?? null }; st.optOuts.push(row); }
      return R([row]);
    }
    if (/DELETE FROM opt_out/.test(s)) {
      const i = st.optOuts.findIndex((o) => o.id === Number(params[0]));
      const row = i >= 0 ? st.optOuts.splice(i, 1)[0] : null;
      return R(row ? [row] : []);
    }

    /* ---------------------------------------------------------- message_log */
    if (/SELECT COUNT\(\*\)::int AS ct FROM message_log/.test(s)) {
      const ct = st.messages.filter((m) => m.lead_id === Number(params[0]) && m.status !== 'skipped').length;
      return R([{ ct }]);
    }
    if (/INSERT INTO message_log/.test(s)) {
      const p = params as any[];
      const row: MsgRow = {
        id: ++msgSeq, channel: p[1], lead_id: p[2] ?? null, user_id: p[3] ?? null, template_id: p[4] ?? null,
        journey_id: p[5] ?? null, journey_run_id: p[6] ?? null, vertical_id: p[7] ?? null,
        branch_id: p[8] ?? null, campaign_id: p[9] ?? null, to_addr: p[10], subject: p[11] ?? null,
        body: p[12] ?? '', status: p[13], run_after: p[14], error: p[15] ?? null,
        provider: null, attempts: 0, not_configured: false, provider_message_id: null,
        provider_response: {}, created_at: new Date(), sent_at: null,
      };
      st.messages.push(row);
      return R([{ id: String(row.id) }]);
    }
    if (/UPDATE message_log SET provider_response = provider_response \|\| \$2::jsonb WHERE id/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      if (m) m.provider_response = { ...m.provider_response, ...JSON.parse(String(params[1])) };
      return R([]);
    }
    if (/SELECT \* FROM message_log WHERE id = \$1/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      return R(m ? [m] : []);
    }
    if (/SELECT error FROM message_log WHERE id/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      return R(m ? [{ error: m.error }] : []);
    }
    if (/UPDATE message_log SET status = 'sending'/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      if (m) { m.status = 'sending'; m.attempts += 1; }
      return R([]);
    }
    if (/UPDATE message_log SET status = 'sent'/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      if (m) {
        m.status = 'sent'; m.provider = String(params[1]);
        m.provider_message_id = params[2] == null ? null : String(params[2]);
        m.provider_response = { ...m.provider_response, ...JSON.parse(String(params[3])) };
        m.error = null; m.not_configured = false; m.sent_at = new Date();
      }
      return R([]);
    }
    if (/UPDATE message_log SET status = 'queued', error = \$2/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      if (m) {
        m.status = 'queued'; m.error = String(params[1]);
        m.run_after = new Date(Date.now() + Number(params[2]) * 1000);
      }
      return R([]);
    }
    if (/UPDATE message_log SET status = 'failed'/.test(s)) {
      const m = st.messages.find((x) => x.id === Number(params[0]));
      if (m) { m.status = 'failed'; m.error = String(params[1]); m.not_configured = params[2] === true; }
      return R([]);
    }
    // the worker's claim
    if (/UPDATE message_log m SET status = 'sending'/.test(s)) {
      const ch = String(params[0]); const n = Number(params[1]);
      const due = st.messages
        .filter((m) => m.status === 'queued' && m.channel === ch && m.run_after.getTime() <= Date.now())
        .slice(0, n);
      for (const m of due) { m.status = 'sending'; m.attempts += 1; }
      return R(due.map((m) => ({ id: String(m.id) })));
    }
    if (/UPDATE message_log SET status = 'queued', run_after = now\(\)/.test(s)) return R([]);  // reclaimStuck
    if (/UPDATE message_log SET status = 'failed', error = COALESCE/.test(s)) return R([]);

    /* -------------------------------------------------------------- journey */
    if (/FROM journey WHERE trigger_type = \$1 AND status = 'active'/.test(s)) {
      return R(st.journeys.filter((j) => j.trigger_type === params[0] && j.status === 'active'));
    }
    if (/SELECT \* FROM journey WHERE id = \$1/.test(s)) {
      const j = st.journeys.find((x) => Number(x.id) === Number(params[0]));
      return R(j ? [j] : []);
    }
    if (/UPDATE journey SET run_count/.test(s)) return R([]);

    /* THE CLAIM — an id comes back ONLY the first time. This is the whole guarantee. */
    if (/INSERT INTO journey_run/.test(s)) {
      const [, journeyId, leadId, key] = params as [unknown, number, number, string];
      const seen = st.runs.find((r) => r.journey_id === Number(journeyId)
        && r.lead_id === Number(leadId) && r.trigger_key === key);
      if (seen) return R([]);                       // ON CONFLICT DO NOTHING -> no row
      const row: RunRow = {
        id: ++runSeq, journey_id: Number(journeyId), lead_id: Number(leadId), trigger_key: key,
        status: 'pending', step_index: 0, next_run_at: new Date(), steps: [], reason: null, attempts: 0,
      };
      st.runs.push(row);
      return R([{ id: String(row.id) }]);
    }
    if (/SELECT \* FROM journey_run WHERE id = \$1/.test(s)) {
      const r = st.runs.find((x) => x.id === Number(params[0]));
      return R(r ? [r] : []);
    }
    if (/UPDATE journey_run SET status = 'running'/.test(s)) {
      const r = st.runs.find((x) => x.id === Number(params[0]));
      if (r) { r.status = 'running'; r.attempts += 1; }
      return R([]);
    }
    if (/UPDATE journey_run SET steps = \$2::jsonb, step_index = \$3/.test(s)) {
      const r = st.runs.find((x) => x.id === Number(params[0]));
      if (r) { r.steps = JSON.parse(String(params[1])); r.step_index = Number(params[2]); }
      return R([]);
    }
    if (/UPDATE journey_run SET status = 'pending', step_index = \$2/.test(s)) {
      const r = st.runs.find((x) => x.id === Number(params[0]));
      if (r) {
        r.status = 'pending'; r.step_index = Number(params[1]);
        r.next_run_at = new Date(Date.now() + Number(params[2]));
        r.steps = JSON.parse(String(params[3]));
      }
      return R([]);
    }
    if (/UPDATE journey_run SET status = \$2, reason = \$3/.test(s)) {
      const r = st.runs.find((x) => x.id === Number(params[0]));
      if (r) {
        r.status = String(params[1]); r.reason = params[2] == null ? null : String(params[2]);
        if (params[3]) r.steps = JSON.parse(String(params[3]));
      }
      return R([]);
    }
    if (/UPDATE journey_run r SET locked_at/.test(s)) {
      const due = st.runs.filter((r) => r.status === 'pending' && r.next_run_at.getTime() <= Date.now());
      return R(due.map((r) => ({ id: String(r.id) })));
    }

    /* ----------------------------------------------------------------- lead */
    // TemplateService.varsForLead() — the lead JOINed to its whole path. The fixture
    // carries the names directly, so the variable bag is exactly what the real JOIN gives.
    if (/FROM lead l JOIN organisation o/.test(s)) {
      const l = st.leads[Number(params[0])];
      return R(l ? [l] : []);
    }
    if (/FROM lead WHERE id = \$1 AND deleted_at IS NULL AND is_active/.test(s)) {
      const l = st.leads[Number(params[0])];
      return R(l ? [l] : []);
    }
    if (/FROM lead WHERE id = \$1/.test(s)) {
      const l = st.leads[Number(params[0])];
      return R(l ? [l] : []);
    }
    if (/UPDATE lead SET stage_id/.test(s)) {
      const l = st.leads[Number(params[0])];
      if (l) l.stage_id = Number(params[1]);
      return R([]);
    }
    if (/UPDATE lead SET consent/.test(s) || /UPDATE lead SET updated_at/.test(s)) return R([]);

    if (/INSERT INTO lead_activity/.test(s)) {
      st.activities.push({ lead_id: Number(params[0]), type: 'note', note: String(params[3] ?? params[params.length - 1]) });
      return R([]);
    }
    if (/INSERT INTO follow_up/.test(s)) {
      const row = {
        id: ++fuSeq, lead_id: Number(params[0]), owner_id: Number(params[1]),
        scheduled_at: params[3], priority: params[4], notes: params[5],
      };
      st.followUps.push(row);
      return R([{ id: String(row.id) }]);
    }
    if (/FROM pipeline_stage WHERE id = \$1/.test(s)) {
      const stg = st.stages[Number(params[0])];
      return R(stg ? [stg] : []);
    }
    if (/FROM message_template t/.test(s) || /FROM message_template/.test(s)) {
      const t = st.templates[Number(params[0])];
      return R(t ? [t] : []);
    }

    return R([]);
  };

  const db = {
    query: async (sql: string, params: unknown[] = []) => exec(sql, params).rows,
    one: async (sql: string, params: unknown[] = []) => exec(sql, params).rows[0] ?? null,
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: async (sql: string, p: unknown[] = []) => exec(sql, p) }),
  } as unknown as DatabaseService;

  return { db, st };
}

/** SettingsService double — the app_setting rows, with the caller's default merged in. */
export const settings4 = (rows: Record<string, Record<string, unknown>> = {}) => ({
  get: async (key: string, fallback: Record<string, unknown>) => ({ ...fallback, ...(rows[key] ?? {}) }),
  set: async () => undefined,
}) as any;
