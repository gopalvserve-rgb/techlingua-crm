import { EnrolmentService } from './enrolment.service';

/**
 * DEF-S5-01 — "APPROVING AN ENROLMENT UPDATED THE WRONG LEAD".
 *
 * =============================================================================
 * THE BUG, AND WHY ONLY THE LIVE SMOKE COULD FIND IT
 * =============================================================================
 * `settleApproval()` selected `e.*` from `enrolment` and handed THAT ROW to
 * `winLead()`, which reads `lead.id` and `lead.stage_id`. So on approval it ran:
 *
 *     UPDATE lead SET stage_id = <the won stage> WHERE id = <the ENROLMENT's id>
 *
 * The lead that was actually enrolled was never marked Won, and a completely
 * unrelated customer — whichever lead happened to share an id with the enrolment —
 * would have been. On the live smoke it was a silent no-op only by luck: enrolment 3
 * existed, lead 3 did not. On the client's data, with thousands of leads and a lead-id
 * range that overlaps the enrolment-id range, it corrupts a real record.
 *
 * 1031 unit tests and `tsc` both passed. `winLead(c, lead: any, ...)` took `any`, so
 * the compiler could not object; and no spec asserted WHICH row the UPDATE targets.
 * The approvals-on path only exists end-to-end on a running system.
 *
 * The fix is two-part: select the lead explicitly and alias its columns, AND give
 * `winLead` a REAL TYPE so a caller cannot hand it the wrong row again. These tests
 * pin the behaviour; the type pins the shape.
 */

const wonStage = { id: 60, name: 'Enrolled' };

/** Captures every SQL statement + params the service issues inside its transaction. */
function svcFor(enrolmentRow: Record<string, unknown>) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async () => enrolmentRow,
    query: async () => [],
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/FROM pipeline_stage/.test(sql)) return { rows: [wonStage] };
        return { rows: [] };
      },
    }),
  };
  const approvals = { allCleared: async () => true };
  const svc = new EnrolmentService(db as never, {} as never, {} as never, approvals as never);
  return { svc, issued };
}

const ENR_ROW = {
  id: 3,                    // the ENROLMENT's id — the value the bug wrongly used
  enrolment_no: 'ENR-2026/0002',
  status: 'pending_approval',
  lead_id: 31,              // the LEAD that must actually be won
  l_id: 31, l_pipeline_id: 10, l_stage_id: 56,
  full_name: 'ALAM',
};

describe('DEF-S5-01 — approving an enrolment wins the RIGHT lead', () => {
  it('updates lead 31, NOT lead 3 (the enrolment\'s id)', async () => {
    const { svc, issued } = svcFor(ENR_ROW);
    await svc.settleApproval(3, true, 7);

    const leadUpdate = issued.find((q) => /UPDATE lead SET stage_id/.test(q.sql));
    // jest's expect() takes ONE argument (vitest's takes a message) — assert on a
    // labelled value so a failure still says what went wrong.
    expect({ leadWasMovedToWon: !!leadUpdate }).toEqual({ leadWasMovedToWon: true });
    // THE ASSERTION THAT WOULD HAVE CAUGHT IT: the id in the WHERE clause.
    expect(leadUpdate!.params[0]).toBe(31);
    expect(leadUpdate!.params[0]).not.toBe(3);
    expect(leadUpdate!.params[1]).toBe(60);          // the won stage
  });

  it('looks up the won stage on the LEAD\'s pipeline, not the enrolment\'s id', async () => {
    const { svc, issued } = svcFor(ENR_ROW);
    await svc.settleApproval(3, true, 7);
    const stageQ = issued.find((q) => /FROM pipeline_stage/.test(q.sql))!;
    expect(stageQ.params[0]).toBe(10);               // lead.pipeline_id
  });

  it('the enrolment itself goes active, and the lead\'s timeline records it', async () => {
    const { svc, issued } = svcFor(ENR_ROW);
    const r = await svc.settleApproval(3, true, 7);
    expect(r).toEqual({ id: 3, status: 'active' });
    const enrUpdate = issued.find((q) => /UPDATE enrolment SET status = 'active'/.test(q.sql))!;
    expect(enrUpdate.params[0]).toBe(3);             // …and THIS one IS the enrolment
    const activity = issued.find((q) => /INSERT INTO lead_activity/.test(q.sql) && /'note'/.test(q.sql))!;
    expect(activity.params[0]).toBe(31);             // on the LEAD
  });

  it('winLead REFUSES a row with no lead id rather than updating something at random', async () => {
    const { svc } = svcFor({ ...ENR_ROW, l_id: null });
    await expect(svc.settleApproval(3, true, 7)).rejects.toThrow(/refusing to update an unknown row/);
  });

  it('a lead already on the won stage is not re-stamped', async () => {
    const { svc, issued } = svcFor({ ...ENR_ROW, l_stage_id: 60 });
    await svc.settleApproval(3, true, 7);
    expect(issued.find((q) => /UPDATE lead SET stage_id/.test(q.sql))).toBeUndefined();
  });

  it('a pipeline with NO won stage does not block the sale (a taxonomy must not stop revenue)', async () => {
    const issued: Array<{ sql: string }> = [];
    const db = {
      one: async () => ENR_ROW,
      query: async () => [],
      tx: async (fn: any) => fn({
        query: async (sql: string) => { issued.push({ sql }); return { rows: [] }; },   // no stage found
      }),
    };
    const svc = new EnrolmentService(db as never, {} as never, {} as never, { allCleared: async () => true } as never);
    await expect(svc.settleApproval(3, true, 7)).resolves.toEqual({ id: 3, status: 'active' });
    expect(issued.some((q) => /UPDATE lead SET stage_id/.test(q.sql))).toBe(false);
  });
});

describe('rejection', () => {
  it('sets rejected, does NOT win the lead, and says so on the timeline', async () => {
    const { svc, issued } = svcFor(ENR_ROW);
    const r = await svc.settleApproval(3, false, 7);
    expect(r).toEqual({ id: 3, status: 'rejected' });
    expect(issued.some((q) => /UPDATE lead SET stage_id/.test(q.sql))).toBe(false);
    expect(issued.some((q) => /rejected/.test(String(q.params?.[1] ?? '')))).toBe(true);
  });

  it('a multi-step policy keeps it pending until every step clears', async () => {
    const db = { one: async () => ENR_ROW, query: async () => [], tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }) };
    const svc = new EnrolmentService(db as never, {} as never, {} as never, { allCleared: async () => false } as never);
    await expect(svc.settleApproval(3, true, 7)).resolves.toEqual({
      id: 3, status: 'pending_approval', still_pending: true,
    });
  });
});

describe('the money is normalised, never trusted', () => {
  const svc = new EnrolmentService({} as never, {} as never, {} as never, {} as never);

  it('RE-DERIVES the net fee — a client-sent net is ignored', () => {
    const m = svc.normaliseMoney({ fee: '45000', discount: '5000', net_fee_minor: 999_999_999 });
    expect(m.net_fee_minor).toBe(4_000_000);
  });

  it('refuses a discount larger than the fee', () => {
    expect(() => svc.normaliseMoney({ fee: '1000', discount: '5000' })).toThrow(/cannot be more than the total fee/);
  });

  it('refuses junk rather than enrolling at ₹0', () => {
    expect(() => svc.normaliseMoney({ fee: 'lots' })).toThrow(/not an amount/);
  });

  it('takes rupees and stores exact paise', () => {
    expect(svc.normaliseMoney({ fee: '45,000.50', discount: '0.50' }).net_fee_minor).toBe(4_500_000);
  });
});
