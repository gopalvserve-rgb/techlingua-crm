import { CaptureService } from './capture.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';

/**
 * WALK-INS & REFERRALS — real capture, not shells.
 *
 * The two properties that matter:
 *   1. ONE INGESTION PATH — a walk-in / referral creates its lead through the SAME
 *      LeadIngestionService as CSV, Meta, Google, the form and the Sheet. If this ever
 *      regressed to a direct INSERT, dedupe / distribution / audit / idempotency would
 *      silently stop applying to two whole channels.
 *   2. ASSIGN ON ADD — the walk-in's counsellor OWNS the lead immediately (ctx.owner_id
 *      beats campaign distribution). The visitor at the desk is not queued for round-robin.
 */

const scope = (over: Partial<ResolvedScope> = {}): ResolvedScope => ({
  permissionKey: 'walkin.create', allowed: true, all: true, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});

function build(opts: { ingestOutcome?: any; activeUser?: boolean; walkInRow?: any } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const ingested: Array<{ payload: any; ctx: any }> = [];
  const rescored: number[] = [];

  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM "user" WHERE id/.test(sql)) return opts.activeUser === false ? null : { id: '3' };
      if (/INSERT INTO walk_in/.test(sql)) return { id: 55, visitor_name: params[4], counsellor_id: params[10] };
      if (/INSERT INTO referral/.test(sql)) return { id: 66, referrer_name: params[5] };
      if (/UPDATE walk_in/.test(sql)) return { id: 55 };
      if (/FROM walk_in WHERE id/.test(sql)) {
        return opts.walkInRow ?? { id: 55, counsellor_id: 3, lead_id: 100, campaign_id: 5, source_id: 7 };
      }
      // DEF-S34-02 — "How did you hear about us?" resolves against the Lead Source master
      if (/FROM m_source WHERE id/.test(sql)) return { id: String(params[0]) };
      if (/FROM referral WHERE id/.test(sql)) return { id: 66, lead_id: 101 };
      if (/UPDATE referral SET/.test(sql)) return { id: 66 };
      return {};
    },
  } as unknown as DatabaseService;

  const ingestion = {
    ingest: async (payload: any, ctx: any) => {
      ingested.push({ payload, ctx });
      return opts.ingestOutcome ?? { status: 'created', lead_id: 100, owner_id: ctx.owner_id ?? null };
    },
  } as unknown as LeadIngestionService;

  const enforcer = { assertRefInScope: async () => undefined } as any;
  const scoring = { safeRescore: async (id: number) => { if (id) rescored.push(id); } } as any;
  const sla = { safe: async (fn: () => Promise<void>) => fn(), onLeadTouched: async () => undefined } as any;

  const svc = new CaptureService(db, ingestion, new ScopeResolverService(), enforcer, scoring, sla);
  return { svc, calls, ingested, rescored };
}

const WALKIN = {
  visitor_name: 'Priya Sharma', phone: '9810000011',
  branch_id: 9, vertical_id: 1, campaign_id: 5, source_id: 7,
  counsellor_id: 3, purpose: 'Admission enquiry',
};
const REFERRAL = {
  referrer_type: 'Existing Student', referrer_name: 'Asha Rao', referrer_phone: '9810000001',
  referred_name: 'Ravi Kumar', referred_phone: '9810000022',
  branch_id: 9, vertical_id: 1, campaign_id: 5, source_id: 7,
};

describe('walk-in — ASSIGN ON ADD, through the ONE ingestion path', () => {
  it('creates the lead via LeadIngestionService (not a direct INSERT INTO lead)', async () => {
    const { svc, calls, ingested } = build();
    await svc.createWalkIn(WALKIN as any, 1, scope());
    expect(ingested).toHaveLength(1);
    expect(ingested[0].payload).toMatchObject({ full_name: 'Priya Sharma', phone: '9810000011' });
    // the ONLY lead-creating statement is the ingestion service's — none here
    expect(calls.some((c) => /INSERT INTO lead\b/.test(c.sql))).toBe(false);
  });

  it('the COUNSELLOR owns the lead immediately (ctx.owner_id beats round-robin)', async () => {
    const { svc, ingested } = build();
    await svc.createWalkIn(WALKIN as any, 1, scope());
    expect(ingested[0].ctx.owner_id).toBe(3);
    expect(ingested[0].ctx.channel).toBe('manual');
  });

  it('a human at the desk is NEVER swallowed by an `ignore` duplicate rule', async () => {
    const { svc, ingested } = build();
    await svc.createWalkIn(WALKIN as any, 1, scope());
    expect(ingested[0].ctx.duplicate_policy).toBe('always_create');
  });

  it('re-scores the lead AFTER the walk_in row exists (so the +25 walk-in rule can see it)', async () => {
    const { svc, rescored, calls } = build();
    await svc.createWalkIn(WALKIN as any, 1, scope());
    expect(rescored).toEqual([100]);
    const insertIdx = calls.findIndex((c) => /INSERT INTO walk_in/.test(c.sql));
    expect(insertIdx).toBeGreaterThanOrEqual(0);   // the row was written before the rescore
  });

  it('the counsellor is MANDATORY', async () => {
    const { svc } = build();
    await expect(svc.createWalkIn({ ...WALKIN, counsellor_id: undefined } as any, 1, scope()))
      .rejects.toThrow(/counsellor_id is required/);
  });

  it('the counsellor must be an ACTIVE user', async () => {
    const { svc } = build({ activeUser: false });
    await expect(svc.createWalkIn(WALKIN as any, 1, scope())).rejects.toThrow(/active user/);
  });

  it('rejects an unknown status instead of writing garbage', async () => {
    const { svc } = build();
    await expect(svc.createWalkIn({ ...WALKIN, status: 'loitering' } as any, 1, scope()))
      .rejects.toThrow(/status must be one of/);
  });

  it('a failed ingest is a 400 — never a walk_in row with no lead', async () => {
    const { svc, calls } = build({ ingestOutcome: { status: 'failed', reason: 'bad phone' } });
    await expect(svc.createWalkIn(WALKIN as any, 1, scope())).rejects.toThrow(/bad phone/);
    expect(calls.some((c) => /INSERT INTO walk_in/.test(c.sql))).toBe(false);
  });

  it('reassigning the walk-in reassigns the LEAD too (assign-on-add stays true after an edit)', async () => {
    const { svc, calls } = build();
    await svc.updateWalkIn(55, { counsellor_id: 8 }, 1, scope());
    const leadUpd = calls.find((c) => /UPDATE lead SET owner_id/.test(c.sql));
    expect(leadUpd!.params).toEqual([100, 8]);
  });

  it('deleting a walk-in re-scores the lead (the +25 must stop applying)', async () => {
    const { svc, rescored } = build();
    (svc as any).db.one = async (sql: string) =>
      /UPDATE walk_in SET deleted_at/.test(sql) ? { id: 55, visitor_name: 'x', lead_id: 100 } : {};
    await svc.removeWalkIn(55, 1);
    expect(rescored).toEqual([100]);
  });
});

describe('walk-in list + summary are SCOPED through the lead', () => {
  it('a counsellor only sees walk-ins whose lead they own', async () => {
    const { svc, calls } = build();
    await svc.listWalkIns(scope({ all: false, filters: [{ kind: 'own', userId: 3 }] }), {});
    // DEF-S34-02: a walk-in with `convert_to_lead = false` has NO lead, so `wl.owner_id`
    // is NULL and the row would vanish from its own counsellor's list. The owner falls
    // back to the counsellor who attended the visit — who is, after all, the owner.
    expect(calls[0].sql).toContain('COALESCE(wl.owner_id, w.counsellor_id) = $1');
    expect(calls[0].params[0]).toBe(3);
  });
  it('a branch manager sees the whole branch', async () => {
    const { svc, calls } = build();
    await svc.walkInSummary(scope({ all: false, filters: [{ kind: 'branch', branchId: 9 }] }));
    expect(calls[0].sql).toContain('w.branch_id = $1');
  });
});

describe('referral — the referred person becomes a lead, through the same path', () => {
  it('creates the referred lead via the ingestion service and notes the referrer', async () => {
    const { svc, ingested } = build();
    await svc.createReferral(REFERRAL as any, 1, scope());
    expect(ingested[0].payload).toMatchObject({ full_name: 'Ravi Kumar', phone: '9810000022' });
    expect(ingested[0].payload.note).toContain('Referred by Asha Rao');
    expect(ingested[0].ctx.duplicate_policy).toBe('always_create');
  });

  it('with no explicit owner the CAMPAIGN DISTRIBUTION decides (unlike a walk-in)', async () => {
    const { svc, ingested } = build();
    await svc.createReferral(REFERRAL as any, 1, scope());
    expect(ingested[0].ctx.owner_id).toBeNull();
  });

  it('re-scores so the +20 referral rule applies', async () => {
    const { svc, rescored } = build();
    await svc.createReferral(REFERRAL as any, 1, scope());
    expect(rescored).toEqual([100]);
  });

  it('validates the referrer type and the status', async () => {
    const { svc } = build();
    await expect(svc.createReferral({ ...REFERRAL, referrer_type: 'Random Bloke' } as any, 1, scope()))
      .rejects.toThrow(/referrer_type must be one of/);
    await expect(svc.createReferral({ ...REFERRAL, status: 'maybe' } as any, 1, scope()))
      .rejects.toThrow(/status must be one of/);
  });

  it('requires the referred person\'s name and phone', async () => {
    const { svc } = build();
    await expect(svc.createReferral({ ...REFERRAL, referred_phone: '' } as any, 1, scope()))
      .rejects.toThrow(/referred_phone is required/);
  });

  it('the referral list is scoped through the referred lead', async () => {
    const { svc, calls } = build();
    await svc.listReferrals(scope({ all: false, filters: [{ kind: 'own', userId: 3 }] }), {});
    expect(calls[0].sql).toContain('rl.owner_id = $1');
  });
});

/* ========================================================================== */
/*  DEF-S34-02 / DEF-S34-03 — the phantom fields, and the Edit path.           */
/*                                                                             */
/*  This is the THIRD instance of the class the client caught himself (Edit    */
/*  Branch, then the campaign dates). The web-side guard is the generic        */
/*  qa10 matrix; this is the server-side half — the whitelists that the form   */
/*  posts into. If a column is dropped from one of these lists, a field the    */
/*  user filled in is silently discarded again.                                */
/* ========================================================================== */

const FULL_WALKIN = {
  ...WALKIN,
  alt_phone: '9810000012', whatsapp_phone: '9810000013', email: 'priya@x.com',
  visited_at: '2026-07-14T10:30', course_id: 21,
  course_fee: '45000', heard_about_source_id: 81, convert_to_lead: true,
  remarks: 'Wants weekend batch',
};

describe('DEF-S34-02 — every field the walk-in form renders is STORED', () => {
  const insertOf = (calls: Array<{ sql: string; params: unknown[] }>) =>
    calls.find((c) => /INSERT INTO walk_in/.test(c.sql))!;

  it('the INSERT carries course_fee, heard_about_source_id and convert_to_lead', async () => {
    const { svc, calls } = build();
    await svc.createWalkIn(FULL_WALKIN as any, 1, scope());
    const ins = insertOf(calls);
    for (const col of ['course_fee', 'heard_about_source_id', 'convert_to_lead',
      'alt_phone', 'whatsapp_phone', 'campaign_id', 'source_id']) {
      expect(ins.sql).toContain(col);
    }
    expect(ins.params).toContain(45000);      // the fee is a NUMBER by the time it lands
    expect(ins.params).toContain(81);         // the m_source id
    expect(ins.params).toContain(true);       // convert_to_lead
  });

  it('the quoted Course Fee travels to the LEAD too (same custom_fields slot as Add Lead)', async () => {
    const { svc, ingested } = build();
    await svc.createWalkIn(FULL_WALKIN as any, 1, scope());
    expect(ingested[0].payload.custom_fields).toEqual({ course_fee: 45000 });
  });

  it('a negative Course Fee is rejected, not stored', async () => {
    const { svc } = build();
    await expect(svc.createWalkIn({ ...FULL_WALKIN, course_fee: '-5' } as any, 1, scope()))
      .rejects.toThrow(/course_fee/);
  });

  it('"Convert to Lead" DEFAULTS to true — the walk-in still becomes an assigned lead', async () => {
    const { svc, ingested, calls } = build();
    await svc.createWalkIn(WALKIN as any, 1, scope());       // no convert_to_lead in the DTO
    expect(ingested).toHaveLength(1);
    expect(insertOf(calls).params).toContain(true);
  });

  it('UNTICKED, it logs the visit and creates NO lead (the checkbox is not a no-op)', async () => {
    const { svc, ingested, calls, rescored } = build();
    await svc.createWalkIn({ ...FULL_WALKIN, convert_to_lead: false } as any, 1, scope());
    expect(ingested).toHaveLength(0);                        // nothing ingested
    expect(calls.some((c) => /INSERT INTO lead\b/.test(c.sql))).toBe(false);
    expect(insertOf(calls).params).toContain(false);
    expect(rescored).toEqual([]);                            // no lead to score
  });
});

describe('DEF-S34-03 — the walk-in EDIT path', () => {
  it('PATCH updates every walk-in field the Edit form renders', async () => {
    const { svc, calls } = build();
    await svc.updateWalkIn(55, {
      visitor_name: 'Priya S', phone: '9810000099', alt_phone: '9810000098',
      whatsapp_phone: '9810000097', email: 'new@x.com', purpose: 'Fee query',
      course_id: 22, course_fee: '52000', remarks: 'corrected', visited_at: '2026-07-14T11:00',
    } as any, 1, scope());
    const upd = calls.find((c) => /UPDATE walk_in SET/.test(c.sql))!;
    for (const col of ['visitor_name', 'phone', 'alt_phone', 'whatsapp_phone', 'email',
      'purpose', 'course_id', 'course_fee', 'remarks', 'visited_at']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
  });

  it('a corrected name/phone is pushed onto the LEAD too (no stale typo on the lead sheet)', async () => {
    const { svc, calls } = build();
    await svc.updateWalkIn(55, { visitor_name: 'Priya S', phone: '9810000099' } as any, 1, scope());
    const lead = calls.find((c) => /UPDATE lead SET/.test(c.sql) && /full_name/.test(c.sql))!;
    expect(lead).toBeTruthy();
    expect(lead.params).toContain('+919810000099');   // E.164 — the same normaliser ingestion uses
  });

  it('ticking Convert to Lead on an UNCONVERTED walk-in converts it through LeadIngestionService', async () => {
    const { svc, ingested, calls } = build({ walkInRow: { id: 55, counsellor_id: 3, lead_id: null,
      campaign_id: 5, source_id: 7, visitor_name: 'Priya', phone: '9810000011' } });
    await svc.updateWalkIn(55, { convert_to_lead: true } as any, 1, scope());
    expect(ingested).toHaveLength(1);                                   // the ONE path
    expect(ingested[0].ctx.owner_id).toBe(3);                           // still assign-on-add
    expect(calls.some((c) => /INSERT INTO lead\b/.test(c.sql))).toBe(false);  // no second path
    const upd = calls.find((c) => /UPDATE walk_in SET/.test(c.sql))!;
    expect(upd.sql).toContain('lead_id = $');
  });

  it('an already-converted walk-in is NOT converted a second time', async () => {
    const { svc, ingested } = build();                                  // mock row has lead_id 100
    await svc.updateWalkIn(55, { convert_to_lead: true } as any, 1, scope());
    expect(ingested).toHaveLength(0);
  });
});

describe('DEF-S34-03 — the referral EDIT path', () => {
  it('PATCH updates referred_whatsapp / referred_email / relationship / incentive', async () => {
    const { svc, calls } = build();
    await svc.updateReferral(66, {
      referrer_name: 'Asha R', referred_whatsapp: '9810000023', referred_email: 'ravi@x.com',
      relationship: 'Cousin', incentive: '20% off', status: 'converted',
    } as any, 1, scope());
    const upd = calls.find((c) => /UPDATE referral SET/.test(c.sql))!;
    for (const col of ['referrer_name', 'referred_whatsapp', 'referred_email',
      'relationship', 'incentive', 'status']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
  });

  it('a corrected referred person is pushed onto the LEAD too', async () => {
    const { svc, calls } = build();
    await svc.updateReferral(66, { referred_name: 'Ravi K', referred_email: 'ravi@x.com' } as any, 1, scope());
    const lead = calls.find((c) => /UPDATE lead SET/.test(c.sql))!;
    expect(lead).toBeTruthy();
    expect(lead.params).toContain('Ravi K');
  });

  it('the create INSERT stores the referred WhatsApp/Email and the path', async () => {
    const { svc, calls } = build();
    await svc.createReferral({ ...REFERRAL, referred_whatsapp: '9810000023',
      referred_email: 'ravi@x.com' } as any, 1, scope());
    const ins = calls.find((c) => /INSERT INTO referral/.test(c.sql))!;
    for (const col of ['referred_whatsapp', 'referred_email', 'campaign_id', 'source_id']) {
      expect(ins.sql).toContain(col);
    }
  });
});
