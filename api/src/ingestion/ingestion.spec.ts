import { LeadIngestionService } from './lead-ingestion.service';
import { IngestValidationError } from './ingestion.types';
import { DatabaseService } from '../database/database.service';

/**
 * The shared ingestion pipeline, driven against an in-memory Postgres double.
 * Covers exactly what the client cares about: nothing is lost, nothing is
 * duplicated, and leads land on the right agent.
 */

interface State {
  leads: any[];
  ledger: any[];
  activities: any[];
  audit: any[];
  tags: any[];
  cursor: number;
  users: number[];              // active user ids
  distribution: any;
  duplicacy: any;
}

function makeDb(init: Partial<State> = {}) {
  const st: State = {
    leads: [], ledger: [], activities: [], audit: [], tags: [], cursor: -1,
    users: [11, 12, 13],
    distribution: { mode: 'equal', agent_user_ids: [11, 12, 13] },
    duplicacy: { check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'ignore', open_reassign_same_user: true },
    ...init,
  };
  let seq = 100;

  const exec = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT id, org_id, branch_id, vertical_id, pipeline_id, distribution_config')) {
      return [{ id: 5, org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4, distribution_config: st.distribution, duplicacy_config: st.duplicacy }];
    }
    if (s.startsWith('SELECT id FROM source WHERE id')) return [{ id: 7 }];
    if (/^SELECT id, name FROM (state|city|m_course|m_qualification|m_budget|m_status|m_tag)/.test(s)) {
      if (s.includes('m_course')) return [{ id: 21, name: 'IELTS' }, { id: 22, name: 'Spoken English' }];
      if (s.includes('m_status')) return [{ id: 31, name: 'New' }];
      if (s.includes('m_tag')) return [{ id: 41, name: 'Priority' }];
      return [];
    }
    if (s.startsWith('SELECT id, name, is_default, sort_order FROM pipeline_stage')) {
      return [{ id: 51, name: 'New', is_default: true, sort_order: 1 }, { id: 52, name: 'Won', is_default: false, sort_order: 9 }];
    }
    if (s.includes("FROM m_status WHERE org_id") && s.includes("'NEW'")) return [{ id: 31 }];
    if (s.startsWith('SELECT field_key FROM custom_field_def')) return [];

    if (s.startsWith('SELECT lead_id, outcome FROM lead_ingest_record')) {
      const hit = st.ledger.find((l) => l.source_id === Number(params[0]) && l.dedupe_key === params[1]);
      return hit ? [hit] : [];
    }
    if (s.includes('FROM lead l LEFT JOIN pipeline_stage st')) {
      const phone = params[0];
      const campaign = s.includes('l.campaign_id =') ? Number(params[1]) : null;
      const hit = st.leads.find((l) => l.phone === phone && (campaign == null || l.campaign_id === campaign));
      return hit ? [{ id: hit.id, owner_id: hit.owner_id, stage_type: hit.stage_type ?? 'open' }] : [];
    }
    if (s.startsWith('SELECT id FROM "user" WHERE id = ANY')) {
      return (params[0] as number[]).filter((id) => st.users.includes(id)).map((id) => ({ id }));
    }
    if (s.startsWith('INSERT INTO campaign_distribution_state')) {
      st.cursor += 1;
      return [{ last_agent_idx: st.cursor }];
    }
    if (s.startsWith('INSERT INTO lead (')) {
      const row = {
        id: ++seq, org_id: params[0], branch_id: params[1], campaign_id: params[4], source_id: params[5],
        full_name: params[6], phone: params[7], email: params[8], status_id: params[10], stage_id: params[11],
        priority: params[12], temperature: params[13], score: params[14], owner_id: params[15],
        is_duplicate: params[17], course_id: params[20], custom_fields: params[23],
        ingest_batch_id: params[25], external_id: params[26], stage_type: 'open',
      };
      st.leads.push(row);
      return [row];
    }
    if (s.startsWith('INSERT INTO lead_tag')) { st.tags.push({ lead_id: params[0], tag_id: params[1] }); return []; }
    if (s.startsWith('INSERT INTO lead_ingest_record')) {
      const [org, source, key, channel, outcome, leadId, batch, pending, dupOf] = params as any[];
      if (st.ledger.some((l) => l.source_id === Number(source) && l.dedupe_key === key)) return []; // ON CONFLICT DO NOTHING
      st.ledger.push({ org_id: org, source_id: Number(source), dedupe_key: key, channel, outcome, lead_id: leadId, batch_id: batch, pending_action: pending, duplicate_of_id: dupOf });
      return [{ id: st.ledger.length }];
    }
    if (s.startsWith('INSERT INTO lead_activity')) { st.activities.push({ lead_id: params[0], type: params[4], note: params[7] }); return []; }
    if (s.startsWith('INSERT INTO audit_log')) { st.audit.push({ entity_id: params[2] }); return []; }
    if (s.startsWith('SELECT * FROM lead WHERE id')) return st.leads.filter((l) => l.id === Number(params[0]));
    throw new Error(`unhandled SQL: ${s.slice(0, 90)}`);
  };

  const db = {
    query: (sql: string, params?: unknown[]) => exec(sql, params),
    one: async (sql: string, params?: unknown[]) => (await exec(sql, params))[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => {
      const snapshot = JSON.parse(JSON.stringify({ leads: st.leads, ledger: st.ledger, activities: st.activities, audit: st.audit, tags: st.tags, cursor: st.cursor }));
      try {
        return await fn({
          query: async (sql: string, params?: unknown[]) => {
            const rows = await exec(sql, params);   // executed ONCE per statement
            return { rows, rowCount: rows.length };
          },
        });
      } catch (e) {
        Object.assign(st, snapshot); // ROLLBACK
        throw e;
      }
    },
  } as unknown as DatabaseService;
  return { db, st };
}

/** the tx double re-runs `exec` for rowCount; make INSERTs idempotent-safe there */
const ctx = (over: Partial<any> = {}) => ({
  channel: 'csv' as const, campaign_id: 5, source_id: 7, actor_id: 9, batch_id: 1, ...over,
});

describe('LeadIngestionService', () => {
  it('normalises the phone to E.164 and creates the lead', async () => {
    const { db, st } = makeDb();
    const svc = new LeadIngestionService(db);
    const out = await svc.ingest({ full_name: 'Asha Rao', phone: '098111 00001', external_id: 'A1' }, ctx());
    expect(out.status).toBe('created');
    expect(st.leads[0].phone).toBe('+919811100001');
    expect(st.audit).toHaveLength(1);            // worker-created leads are audited
  });

  it('is IDEMPOTENT — re-ingesting the same record creates nothing new', async () => {
    const { db, st } = makeDb();
    const svc = new LeadIngestionService(db);
    const rec = { full_name: 'Asha Rao', phone: '9811100001', external_id: 'A1' };
    const first = await svc.ingest(rec, ctx());
    const second = await svc.ingest(rec, ctx());
    expect(first.status).toBe('created');
    expect(second.status).toBe('skipped');
    expect(st.leads).toHaveLength(1);
    expect(st.cursor).toBe(0);                   // the round-robin cursor moved ONCE
  });

  it('is idempotent without an external id (content hash)', async () => {
    const { db, st } = makeDb();
    const svc = new LeadIngestionService(db);
    const rec = { full_name: 'Ravi K', phone: '9811100002', email: 'r@x.com' };
    await svc.ingest(rec, ctx());
    const again = await svc.ingest({ ...rec }, ctx());
    expect(again.status).toBe('skipped');
    expect(st.leads).toHaveLength(1);
  });

  it('applies EQUAL distribution round-robin across the agent pool', async () => {
    const { db, st } = makeDb();
    const svc = new LeadIngestionService(db);
    for (let i = 1; i <= 4; i++) {
      await svc.ingest({ full_name: `L${i}`, phone: `98111000${10 + i}`, external_id: `E${i}` }, ctx());
    }
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 12, 13, 11]);
  });

  it('skips agents who were disabled after the campaign was configured', async () => {
    const { db, st } = makeDb({ users: [11, 13] });
    const svc = new LeadIngestionService(db);
    await svc.ingest({ full_name: 'A', phone: '9811100021', external_id: 'X1' }, ctx());
    await svc.ingest({ full_name: 'B', phone: '9811100022', external_id: 'X2' }, ctx());
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 13]);
  });

  it('applies CONDITIONAL distribution rules', async () => {
    const { db, st } = makeDb({
      distribution: { mode: 'conditional', conditions: [{ field: 'course', value: 'IELTS', assign_to_user_ids: [13] }] },
    });
    const svc = new LeadIngestionService(db);
    await svc.ingest({ full_name: 'A', phone: '9811100031', course: 'IELTS', external_id: 'C1' }, ctx());
    await svc.ingest({ full_name: 'B', phone: '9811100032', course: 'Spoken English', external_id: 'C2' }, ctx());
    expect(st.leads[0].owner_id).toBe(13);
    expect(st.leads[1].owner_id).toBeNull();     // no rule matched -> unassigned
  });

  it('leaves leads unassigned under ON DEMAND distribution', async () => {
    const { db, st } = makeDb({ distribution: { mode: 'on_demand', batch_size: 10 } });
    const svc = new LeadIngestionService(db);
    await svc.ingest({ full_name: 'A', phone: '9811100041', external_id: 'D1' }, ctx());
    expect(st.leads[0].owner_id).toBeNull();
  });

  describe('duplicates (NeoDove §4)', () => {
    it('on_duplicate=ignore -> no new lead', async () => {
      const { db, st } = makeDb();
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100051', external_id: 'P1' }, ctx());
      const out = await svc.ingest({ full_name: 'A again', phone: '+91 98111 00051', external_id: 'P2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.lead_id).toBeNull();
      expect(st.leads).toHaveLength(1);
    });

    it('on_duplicate=create -> new lead FLAGGED is_duplicate', async () => {
      const { db, st } = makeDb({ duplicacy: { check_scope: 'this_campaign', on_duplicate: 'create', open_reassign_same_user: false } });
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100061', external_id: 'Q1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100061', external_id: 'Q2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(st.leads).toHaveLength(2);
      expect(st.leads[1].is_duplicate).toBe(true);
    });

    it('merge / merge_and_reopen are NOT executed — flagged + pending_action recorded (seam)', async () => {
      const { db, st } = makeDb({ duplicacy: { check_scope: 'this_campaign', on_duplicate: 'merge_and_reopen', open_reassign_same_user: true } });
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100071', external_id: 'R1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100071', external_id: 'R2' }, ctx());
      expect(out.pending_action).toBe('merge_and_reopen');
      expect(st.leads[1].is_duplicate).toBe(true);
      expect(st.ledger[1].pending_action).toBe('merge_and_reopen');
      expect(st.ledger[1].duplicate_of_id).toBe(st.leads[0].id);
    });

    it('an OPEN duplicate re-assigns to the same owner (spec §4)', async () => {
      const { db, st } = makeDb({ duplicacy: { check_scope: 'this_campaign', on_duplicate: 'create', open_reassign_same_user: true } });
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100081', external_id: 'S1' }, ctx());   // -> agent 11
      const out = await svc.ingest({ full_name: 'A', phone: '9811100081', external_id: 'S2' }, ctx());
      expect(st.leads[0].owner_id).toBe(11);
      expect(out.owner_id).toBe(11);              // NOT 12 — the round-robin is bypassed
      expect(st.cursor).toBe(0);
    });

    it("the manual 'always_create' policy ignores the campaign's ignore rule", async () => {
      const { db, st } = makeDb();                // on_duplicate = ignore
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100091', external_id: 'T1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100091' }, ctx({ channel: 'manual', duplicate_policy: 'always_create' }));
      expect(st.leads).toHaveLength(2);
      expect(st.leads[1].is_duplicate).toBe(true);
      expect(out.duplicate_of).toBe(st.leads[0].id);
    });
  });

  describe('validation (rows that can never succeed -> dead-letter, never retried)', () => {
    const cases: Array<[string, any, RegExp]> = [
      ['missing name', { phone: '9811100001' }, /Name is required/],
      ['missing phone', { full_name: 'A' }, /Mobile number is required/],
      ['short phone', { full_name: 'A', phone: '123' }, /Invalid mobile/],
      ['bad email', { full_name: 'A', phone: '9811100001', email: 'not-an-email' }, /Invalid email/],
      ['bad priority', { full_name: 'A', phone: '9811100001', priority: 'urgent' }, /Invalid priority/],
      ['bad temperature', { full_name: 'A', phone: '9811100001', temperature: 'lukewarm' }, /Invalid temperature/],
      ['bad score', { full_name: 'A', phone: '9811100001', score: '999' }, /Invalid score/],
      ['bad date', { full_name: 'A', phone: '9811100001', next_follow_up_at: '31/31/2026' }, /Invalid date/],
      ['unknown course', { full_name: 'A', phone: '9811100001', course: 'Klingon' }, /Unknown Course/],
      ['unknown stage', { full_name: 'A', phone: '9811100001', stage: 'Nowhere' }, /Unknown Stage/],
    ];
    it.each(cases)('rejects %s', async (_label, payload, re) => {
      const { db, st } = makeDb();
      const svc = new LeadIngestionService(db);
      await expect(svc.ingest(payload, ctx())).rejects.toThrow(IngestValidationError);
      await expect(svc.ingest(payload, ctx())).rejects.toThrow(re);
      expect(st.leads).toHaveLength(0);
    });

    it('accepts DD/MM/YYYY and YYYY-MM-DD follow-up dates', async () => {
      const { db, st } = makeDb();
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100001', next_follow_up_at: '20/07/2026', external_id: 'U1' }, ctx());
      await svc.ingest({ full_name: 'B', phone: '9811100002', next_follow_up_at: '2026-07-20', external_id: 'U2' }, ctx());
      expect(st.leads).toHaveLength(2);
    });

    it('resolves master values by name (case-insensitive) and by id', async () => {
      const { db, st } = makeDb();
      const svc = new LeadIngestionService(db);
      await svc.ingest({ full_name: 'A', phone: '9811100001', course: 'ielts', tags: 'Priority', external_id: 'V1' }, ctx());
      expect(st.leads[0].course_id).toBe(21);
      expect(st.tags).toEqual([{ lead_id: st.leads[0].id, tag_id: 41 }]);
    });
  });
});
