import { CrossSellService } from './crosssell.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * CROSS-SELL — unit coverage for candidate scoping, rule-vs-fallback suggestion, the three
 * acts (follow-up / new lead through ingestion / dismiss) and the re-suggest guard. The
 * candidate SQL itself (CTEs + meta->>'vertical_id') is proven by the live smoke; here we
 * assert the SERVICE behaviour around it — scope fragment reaches the query, an act writes
 * an attempt + a cross_sell timeline row, and 'lead' routes through LeadIngestionService.
 */

const scopeAll: ResolvedScope = { permissionKey: 'crosssell.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeOwn = (u: number): ResolvedScope => ({ permissionKey: 'crosssell.read', allowed: true, all: false, filters: [{ kind: 'own', userId: u }], allowedFields: null, deniedFields: [] });

// A resolver double that mirrors the real buildScopeWhere for the two shapes we use.
const resolver = {
  buildScopeWhere: (scope: ResolvedScope, cols: any, params: unknown[]) => {
    if (scope.all) return '1=1';
    const f = scope.filters[0];
    if (f?.kind === 'own') { params.push(f.userId); return `${cols.owner} = $${params.length}`; }
    return '1=0';
  },
};

function make(opts: {
  lead?: any; course?: any; existingAttempt?: any; campaign?: any; ingestOutcome?: any;
} = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/INSERT INTO cross_sell_rule/.test(sql)) return { id: 900 };
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM cross_sell_attempt WHERE lead_id/.test(sql)) return opts.existingAttempt ?? null;
      if (/FROM lead l WHERE l.id/.test(sql)) return opts.lead ?? null;
      if (/FROM m_course WHERE id/.test(sql)) return opts.course ?? null;
      if (/FROM campaign c/.test(sql)) return opts.campaign ?? null;
      if (/status = 'active'/.test(sql)) return { id: (params as any)[0] };  // assertActiveUser
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/RETURNING id/.test(sql)) return { rows: [{ id: 900 }] };
        return { rows: [] };
      },
    }),
  };
  const ingestion = {
    ingestAndReturn: async (_p: any, _c: any) => ({ outcome: opts.ingestOutcome ?? { status: 'created', lead_id: 777 }, lead: null }),
  };
  const svc = new CrossSellService(db as never, resolver as never, ingestion as never);
  return { svc, issued, ingestion };
}

const LEAD = (over: any = {}) => ({
  id: 10, org_id: 1, full_name: 'Asha', phone: '+919812345678', email: 'a@x.io',
  branch_id: 9, vertical_id: 3, owner_id: 5, course_id: 100, ...over,
});
const COURSE = (over: any = {}) => ({ id: 200, name: 'PTE', vertical_id: '3', branch_id: '9', ...over });

describe('CrossSellService — candidates scoping', () => {
  it('passes the RBAC scope fragment into the candidate query (own -> owner_id)', async () => {
    const { svc, issued } = make();
    await svc.candidates(scopeOwn(5), {});
    const q = issued.find((i) => /WITH cand AS/.test(i.sql))!;
    expect(q).toBeTruthy();
    expect(q.sql).toContain('l.owner_id = $1');   // scope fragment landed INSIDE the SQL
    expect(q.params).toContain(5);
  });

  it('applies branch / owner / current-course filters', async () => {
    const { svc, issued } = make();
    await svc.candidates(scopeAll, { branch_id: 9, owner_id: 5, course_id: 100 });
    const q = issued.find((i) => /WITH cand AS/.test(i.sql))!;
    expect(q.sql).toContain('l.branch_id = $');
    expect(q.sql).toContain('l.owner_id = $');
    expect(q.sql).toContain('l.course_id = $');
    // the candidate set is only won/enrolled contacts
    expect(q.sql).toContain("st.stage_type = 'won'");
    expect(q.sql).toContain('FROM enrolment e');
  });

  it('the SQL prefers a rule and only falls back to same-vertical courses when none applies', async () => {
    const { svc, issued } = make();
    await svc.candidates(scopeAll, {});
    const q = issued.find((i) => /WITH cand AS/.test(i.sql))!;
    expect(q.sql).toContain('cross_sell_rule r');                    // rule-based branch
    expect(q.sql).toContain("(oc.meta->>'vertical_id')::bigint");    // vertical fallback
    expect(q.sql).toContain('NOT IN (SELECT lead_id FROM ruled)');   // fallback skipped when a rule applies
    // never re-suggest an already-acted pair, nor a held course
    expect(q.sql).toContain('FROM cross_sell_attempt a');
    expect(q.sql).toContain('NOT IN (SELECT h.course_id FROM held h');
  });
});

describe('CrossSellService — rules', () => {
  it('refuses a rule that suggests the same course', async () => {
    const { svc } = make();
    await expect(svc.createRule({ source_course_id: 5, target_course_id: 5 }, { id: 1 })).rejects.toThrow(/same course/i);
  });
  it('creates a rule when both courses are valid', async () => {
    const { svc } = make({ course: { id: 1 } });
    const out = await svc.createRule({ source_course_id: 5, target_course_id: 6 }, { id: 1 });
    expect(out.id).toBe(900);
  });
});

describe('CrossSellService — act', () => {
  it('rejects an unknown action', async () => {
    const { svc } = make({ lead: LEAD(), course: COURSE() });
    await expect(svc.act({ lead_id: 10, suggested_course_id: 200, action: 'nope' }, { id: 5 }, scopeAll))
      .rejects.toThrow(/Unknown action/i);
  });

  it('404s when the contact is outside the caller scope', async () => {
    const { svc } = make({ lead: null });
    await expect(svc.act({ lead_id: 10, suggested_course_id: 200, action: 'dismissed' }, { id: 5 }, scopeOwn(999)))
      .rejects.toThrow(/not found/i);
  });

  it('409s when the pair has already been actioned (never re-suggested)', async () => {
    const { svc } = make({ lead: LEAD(), course: COURSE(), existingAttempt: { id: 1 } });
    await expect(svc.act({ lead_id: 10, suggested_course_id: 200, action: 'dismissed' }, { id: 5 }, scopeAll))
      .rejects.toThrow(/already been actioned/i);
  });

  it('followup — creates a follow_up assigned to the owner and logs a cross_sell attempt + timeline row', async () => {
    const { svc, issued } = make({ lead: LEAD({ owner_id: 5 }), course: COURSE() });
    const out = await svc.act({ lead_id: 10, suggested_course_id: 200, action: 'followup' }, { id: 7 }, scopeAll);
    expect(out.action).toBe('followup');
    expect((out as any).follow_up_id).toBe(900);
    expect(issued.some((i) => /INSERT INTO follow_up/.test(i.sql) && (i.params as any)[1] === 5)).toBe(true);
    expect(issued.some((i) => /INSERT INTO cross_sell_attempt/.test(i.sql))).toBe(true);
    expect(issued.some((i) => /INSERT INTO lead_activity/.test(i.sql) && /'cross_sell'/.test(i.sql))).toBe(true);
  });

  it('lead — routes through LeadIngestionService (dedup/distribution) and records the new lead id', async () => {
    const { svc, issued, ingestion } = make({
      lead: LEAD(), course: COURSE(), campaign: { campaign_id: 50, source_id: 60 },
      ingestOutcome: { status: 'created', lead_id: 777 },
    });
    const spy = jest.spyOn(ingestion, 'ingestAndReturn');
    const out = await svc.act({ lead_id: 10, suggested_course_id: 200, action: 'lead' }, { id: 7 }, scopeAll);
    expect(spy).toHaveBeenCalled();
    expect((out as any).new_lead_id).toBe(777);
    const att = issued.find((i) => /INSERT INTO cross_sell_attempt/.test(i.sql))!;
    expect((att.params as any).includes(777)).toBe(true);   // new_lead_id recorded
  });

  it('lead — refuses when no campaign exists in the suggested course vertical', async () => {
    const { svc } = make({ lead: LEAD(), course: COURSE(), campaign: null });
    await expect(svc.act({ lead_id: 10, suggested_course_id: 200, action: 'lead' }, { id: 7 }, scopeAll))
      .rejects.toThrow(/No active campaign/i);
  });

  it('dismiss — records a dismissed attempt so the pair drops off the candidate list', async () => {
    const { svc, issued } = make({ lead: LEAD(), course: COURSE() });
    const out = await svc.act({ lead_id: 10, suggested_course_id: 200, action: 'dismissed' }, { id: 7 }, scopeAll);
    expect(out.action).toBe('dismissed');
    const att = issued.find((i) => /INSERT INTO cross_sell_attempt/.test(i.sql))!;
    expect((att.params as any).includes('dismissed')).toBe(true);
  });
});
