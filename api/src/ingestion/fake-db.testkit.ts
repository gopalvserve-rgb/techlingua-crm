/**
 * In-memory Postgres double for the ingestion + merge suites.
 *
 * Not a mock of our code — a tiny SQL interpreter. INSERT/UPDATE are parsed
 * generically (column list -> $n / literal / now()), so the tests exercise the
 * REAL service SQL, and a service change that forgets a column shows up as a
 * failing assertion rather than a silently-passing mock.
 *
 * Excluded from the production build (tsconfig.build.json: *.testkit.ts).
 */
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from './lead-ingestion.service';
import { LeadMergeService } from './merge.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';

export interface FakeStage { id: number; name: string; stage_type: 'open' | 'won' | 'lost'; is_default: boolean; sort_order: number }

export interface FakeState {
  leads: any[];
  ledger: any[];
  activities: any[];
  audit: any[];
  tags: Array<{ lead_id: number; tag_id: number }>;
  merges: any[];
  followups: any[];
  cursor: number;
  users: number[];
  distribution: any;
  duplicacy: any;
  stages: FakeStage[];
  pausedAgents: Array<{ campaign_id: number; user_id: number }>;
}

const DEFAULT_STAGES: FakeStage[] = [
  { id: 51, name: 'New', stage_type: 'open', is_default: true, sort_order: 1 },
  { id: 52, name: 'Contacted', stage_type: 'open', is_default: false, sort_order: 2 },
  { id: 58, name: 'Won', stage_type: 'won', is_default: false, sort_order: 8 },
  { id: 59, name: 'Lost', stage_type: 'lost', is_default: false, sort_order: 9 },
];

/** Read a parenthesised, comma-separated list starting at `open` (paren-depth aware — `now()`). */
function readList(sql: string, open: number): { items: string[]; end: number } {
  const items: string[] = [];
  let depth = 0, cur = '';
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') { depth++; if (depth === 1) continue; }
    if (ch === ')') { depth--; if (depth === 0) { items.push(cur.trim()); return { items, end: i }; } }
    if (ch === ',' && depth === 1) { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return { items, end: sql.length };
}

/** `INSERT INTO t (a,b) VALUES ($1,'x',now(),NULL) ...` -> { table, row } */
function parseInsert(sql: string, params: unknown[]): { table: string; row: Record<string, unknown> } | null {
  const m = /^INSERT INTO "?(\w+)"? \(/i.exec(sql);
  if (!m) return null;
  const colList = readList(sql, m[0].length - 1);
  const vIdx = sql.toUpperCase().indexOf('VALUES (', colList.end);
  if (vIdx < 0) return null;
  const valList = readList(sql, vIdx + 'VALUES '.length);
  const cols = colList.items;
  const vals = valList.items;
  const row: Record<string, unknown> = {};
  cols.forEach((c, i) => {
    const v = vals[i];
    if (v == null) return;
    if (/^\$\d+$/.test(v)) row[c] = params[Number(v.slice(1)) - 1];
    else if (/^'(.*)'$/.test(v)) row[c] = v.slice(1, -1);
    else if (/^now\(\)$/i.test(v)) row[c] = new Date().toISOString();
    else if (/^NULL$/i.test(v)) row[c] = null;
    else if (/^(TRUE|FALSE)$/i.test(v)) row[c] = /^TRUE$/i.test(v);
    else row[c] = v;
  });
  return { table: m[1], row };
}

/** `UPDATE t SET a = $1, b = now() WHERE id = $2` -> the assignments + the id param */
function parseUpdate(sql: string, params: unknown[]): { table: string; sets: Record<string, unknown> } | null {
  const m = /^UPDATE "?(\w+)"? (?:\w+ )?SET (.+?) WHERE /i.exec(sql);
  if (!m) return null;
  const sets: Record<string, unknown> = {};
  for (const part of m[2].split(/,\s*(?=[a-z_]+\s*=)/i)) {
    const a = /^([a-z_]+)\s*=\s*(.+)$/i.exec(part.trim());
    if (!a) continue;
    const [, col, raw] = a;
    const v = raw.trim();
    if (/^\$\d+$/.test(v)) sets[col] = params[Number(v.slice(1)) - 1];
    else if (/^'(.*)'$/.test(v)) sets[col] = v.slice(1, -1);
    else if (/^now\(\)$/i.test(v)) sets[col] = new Date().toISOString();
    else if (/^NULL$/i.test(v)) sets[col] = null;
    else if (/^(TRUE|FALSE)$/i.test(v)) sets[col] = /^TRUE$/i.test(v);
    else if (/^COALESCE\([a-z_]+,\s*\$(\d+)\)$/i.test(v)) {
      sets[col] = { __coalesce: params[Number(/\$(\d+)/.exec(v)![1]) - 1] };
    } else sets[col] = v;
  }
  return { table: m[1], sets };
}

export function makeFakeDb(init: Partial<FakeState> = {}) {
  const st: FakeState = {
    leads: [], ledger: [], activities: [], audit: [], tags: [], merges: [], followups: [], cursor: -1,
    users: [11, 12, 13],
    distribution: { mode: 'equal', agent_user_ids: [11, 12, 13] },
    duplicacy: { check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'ignore', open_reassign_same_user: true },
    stages: DEFAULT_STAGES,
    pausedAgents: [],
    ...init,
  };
  let seq = 100;
  let mergeSeq = 500;

  const stageOf = (id: unknown) => st.stages.find((s) => Number(s.id) === Number(id)) ?? null;

  const exec = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ---- loadTarget ------------------------------------------------------
    if (s.startsWith('SELECT id, org_id, branch_id, vertical_id, pipeline_id, distribution_config')) {
      return [{ id: 5, org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4, distribution_config: st.distribution, duplicacy_config: st.duplicacy }];
    }
    if (s.startsWith('SELECT id FROM source WHERE id')) return [{ id: 7 }];
    if (/^SELECT id, name FROM (state|city|m_course|m_qualification|m_budget|m_status|m_tag)/.test(s)) {
      if (s.includes('m_course')) return [{ id: 21, name: 'IELTS' }, { id: 22, name: 'Spoken English' }];
      if (s.includes('m_status')) return [{ id: 31, name: 'New' }];
      if (s.includes('m_tag')) return [{ id: 41, name: 'Priority' }, { id: 42, name: 'Referral' }];
      if (s.includes('m_budget')) return [{ id: 61, name: '1-2 Lakh' }, { id: 62, name: '2-5 Lakh' }];
      if (s.includes('city')) return [{ id: 71, name: 'Delhi' }, { id: 72, name: 'Mumbai' }];
      return [];
    }
    if (s.startsWith('SELECT id, name, is_default, sort_order FROM pipeline_stage')) {
      return st.stages.slice().sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort_order - b.sort_order);
    }
    if (s.includes('FROM m_status WHERE org_id') && s.includes("'NEW'")) return [{ id: 31 }];
    if (s.startsWith('SELECT field_key FROM custom_field_def')) return [{ field_key: 'batch' }, { field_key: 'ref' }];

    // ---- idempotency ledger ----------------------------------------------
    if (/^SELECT (id, )?lead_id, outcome FROM lead_ingest_record/.test(s)) {
      const hit = st.ledger.find((l) => Number(l.source_id) === Number(params[0]) && l.dedupe_key === params[1]);
      return hit ? [hit] : [];
    }
    // DEF-S2-01 — "is the lead this ledger row points at still alive?"
    if (s.startsWith('SELECT id FROM lead WHERE id')) {
      return st.leads.filter((l) => Number(l.id) === Number(params[0])
        && (!s.includes('deleted_at IS NULL') || !l.deleted_at)).map((l) => ({ id: l.id }));
    }
    if (s.startsWith('DELETE FROM lead_ingest_record WHERE id')) {
      const i = st.ledger.findIndex((l) => Number(l.id) === Number(params[0]));
      if (i >= 0) st.ledger.splice(i, 1);
      return [];
    }

    // ---- duplicate lookup --------------------------------------------------
    if (s.includes('FROM lead l LEFT JOIN pipeline_stage st')) {
      // #22 — the incoming numbers are an array; a lead matches when EITHER its
      // phone OR its whatsapp_phone equals ANY of them (WhatsApp cross-match).
      const nums = (Array.isArray(params[0]) ? params[0] : [params[0]]) as string[];
      const byCampaign = s.includes('l.campaign_id =');
      const byPipeline = s.includes('l.pipeline_id =');
      const scopeVal = byCampaign || byPipeline ? Number(params[1]) : null;
      const hit = st.leads.find((l) => (nums.includes(l.phone) || (l.whatsapp_phone && nums.includes(l.whatsapp_phone)))
        && !l.deleted_at && l.is_active !== false
        && (scopeVal == null
          || (byCampaign ? Number(l.campaign_id) === scopeVal : Number(l.pipeline_id) === scopeVal)));
      if (!hit) return [];
      return [{ id: hit.id, owner_id: hit.owner_id, stage_type: stageOf(hit.stage_id)?.stage_type ?? 'open' }];
    }

    if (s.startsWith('SELECT user_id FROM campaign_agent_pause')) {
      const cid = Number(params[0]);
      const ids = (params[1] as number[]) ?? [];
      return st.pausedAgents
        .filter((p) => Number(p.campaign_id) === cid && ids.includes(Number(p.user_id)))
        .map((p) => ({ user_id: p.user_id }));
    }
    if (s.startsWith('SELECT id FROM "user" WHERE id = ANY')) {
      return (params[0] as number[]).filter((id) => st.users.includes(id)).map((id) => ({ id }));
    }
    if (s.startsWith('INSERT INTO campaign_distribution_state')) {
      st.cursor += 1;
      return [{ last_agent_idx: st.cursor }];
    }

    // ---- merge reads --------------------------------------------------------
    if (s.startsWith('SELECT tag_id FROM lead_tag WHERE lead_id')) {
      return st.tags.filter((t) => Number(t.lead_id) === Number(params[0])).map((t) => ({ tag_id: t.tag_id }));
    }
    if (s.startsWith('SELECT s.id, s.name, s.stage_type FROM pipeline_stage s WHERE s.id')) {
      const st_ = stageOf(params[0]);
      return st_ ? [st_] : [];
    }
    if (s.startsWith('SELECT id, name FROM pipeline_stage WHERE pipeline_id') && s.includes("stage_type = 'open'")) {
      const open = st.stages.filter((x) => x.stage_type === 'open')
        .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort_order - b.sort_order);
      return open.length ? [{ id: open[0].id, name: open[0].name }] : [];
    }
    if (s.startsWith('SELECT * FROM lead WHERE id')) {
      return st.leads.filter((l) => Number(l.id) === Number(params[0]) && (!s.includes('deleted_at IS NULL') || !l.deleted_at));
    }
    if (s.startsWith('SELECT stage_type FROM pipeline_stage WHERE id')) {
      const st_ = stageOf(params[0]);
      return st_ ? [{ stage_type: st_.stage_type }] : [];
    }
    // lead summary + the duplicates panel (merge.service)
    if (s.includes('FROM lead l') && s.includes('LEFT JOIN "user" u ON u.id = l.owner_id')) {
      const id = Number(params[params.length - 1]);
      const deco = (l: any) => ({ ...l, stage_name: stageOf(l.stage_id)?.name, stage_type: stageOf(l.stage_id)?.stage_type });
      if (/l\.duplicate_of_id = \$\d+/.test(s)) {
        return st.leads.filter((l) => Number(l.duplicate_of_id) === id && !l.deleted_at && Number(l.id) !== id).map(deco);
      }
      if (/l\.merged_into_id = \$\d+/.test(s)) {
        return st.leads.filter((l) => Number(l.merged_into_id) === id).map(deco);
      }
      return st.leads.filter((l) => Number(l.id) === id).map(deco);
    }
    if (s.startsWith('SELECT m.id, m.action') && s.includes('FROM lead_merge m')) {
      return st.merges.filter((m) => Number(m.target_lead_id) === Number(params[0]))
        .map((m) => ({ ...m, actor_name: 'Tester' }));
    }

    // ---- generic writes -----------------------------------------------------
    const ins = parseInsert(s, params);
    if (ins) {
      const { table, row } = ins;
      switch (table) {
        case 'lead': {
          const lead = { id: ++seq, is_active: true, deleted_at: null, custom_fields: {}, ...row };
          if (typeof lead.custom_fields === 'string') lead.custom_fields = JSON.parse(lead.custom_fields as string);
          st.leads.push(lead);
          return [lead];
        }
        case 'lead_tag': {
          if (st.tags.some((t) => Number(t.lead_id) === Number(row.lead_id) && Number(t.tag_id) === Number(row.tag_id))) return [];
          st.tags.push({ lead_id: Number(row.lead_id), tag_id: Number(row.tag_id) });
          return [];
        }
        case 'lead_ingest_record': {
          if (st.ledger.some((l) => Number(l.source_id) === Number(row.source_id) && l.dedupe_key === row.dedupe_key)) {
            return []; // ON CONFLICT DO NOTHING
          }
          st.ledger.push({ id: st.ledger.length + 1, ...row });
          return [{ id: st.ledger.length }];
        }
        case 'lead_activity': st.activities.push(row); return [];
        case 'audit_log': st.audit.push(row); return [];
        case 'lead_merge': {
          const m: Record<string, unknown> = { id: ++mergeSeq, ...row };
          if (typeof m.diff === 'string') m.diff = JSON.parse(m.diff);
          st.merges.push(m);
          return [{ id: m.id }];
        }
        default: throw new Error(`fake-db: unhandled INSERT table "${table}"`);
      }
    }

    const upd = parseUpdate(s, params);
    if (upd) {
      const idParam = /WHERE id = \$(\d+)/i.exec(s);
      const applySets = (target: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(upd.sets)) {
          if (v && typeof v === 'object' && '__coalesce' in (v as any)) {
            target[k] = target[k] ?? (v as any).__coalesce;
          } else {
            target[k] = typeof v === 'string' && k === 'custom_fields' ? JSON.parse(v) : v;
          }
        }
      };
      if (upd.table === 'lead') {
        const id = Number(params[Number(idParam![1]) - 1]);
        const lead = st.leads.find((l) => Number(l.id) === id);
        if (lead) applySets(lead);
        return [];
      }
      if (upd.table === 'lead_activity') {
        // UPDATE lead_activity SET lead_id = $1 WHERE lead_id = $2
        for (const a of st.activities) if (Number(a.lead_id) === Number(params[1])) a.lead_id = Number(params[0]);
        return [];
      }
      if (upd.table === 'follow_up') {
        for (const f of st.followups) {
          if (Number(f.lead_id) === Number(params[1]) && f.status === 'pending') f.lead_id = Number(params[0]);
        }
        return [];
      }
      throw new Error(`fake-db: unhandled UPDATE table "${upd.table}"`);
    }

    throw new Error(`fake-db: unhandled SQL: ${s.slice(0, 100)}`);
  };

  const db = {
    query: (sql: string, params?: unknown[]) => exec(sql, params),
    one: async (sql: string, params?: unknown[]) => (await exec(sql, params))[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => {
      const snap = JSON.parse(JSON.stringify({
        leads: st.leads, ledger: st.ledger, activities: st.activities,
        audit: st.audit, tags: st.tags, merges: st.merges, followups: st.followups, cursor: st.cursor,
      }));
      try {
        return await fn({
          query: async (sql: string, params?: unknown[]) => {
            const rows = await exec(sql, params);
            return { rows, rowCount: rows.length };
          },
        });
      } catch (e) {
        Object.assign(st, snap);   // ROLLBACK
        throw e;
      }
    },
  } as unknown as DatabaseService;

  return { db, st };
}

/** A scope resolver stub: 'all' scope (record-scope itself is tested in the RBAC suite). */
export const allScopeResolver = {
  buildScopeWhere: () => '1=1',
} as unknown as ScopeResolverService;

/** The ingestion service wired to its real merge engine, over the fake DB. */
export function makeIngestion(db: DatabaseService, opts: { scoring?: any; sla?: any } = {}) {
  const merger = new LeadMergeService(db, allScopeResolver);
  // scoring / SLA are the Sprint-3 post-commit hooks. They are OPTIONAL on the service
  // so these tests keep asserting the ingestion contract in isolation; the hooks have
  // their own suites (scoring.spec, sla.spec) and a wiring test below.
  return { svc: new LeadIngestionService(db, merger, opts.scoring, opts.sla), merger };
}
