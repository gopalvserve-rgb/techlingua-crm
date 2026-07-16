import { PerformanceService } from './performance.service';

/**
 * DEF-S5-03 — COUNSELLOR PERFORMANCE SILENTLY LOST CASH.
 *
 * Live, at the same moment, against the same three receipts:
 *
 *     GET /api/fees/summary        -> { mtd_minor: 5000000 }   Rs 50,000
 *     GET /api/performance/summary -> { collected_minor: 0 }    Rs 0
 *
 * Two causes, and BOTH are fixed here, because either one alone still loses money:
 *
 *   1) `collected` was keyed on `fee_receipt.received_by` — who physically keyed the
 *      payment in. An Accountant (role 10 — the natural person to take a fee) is neither
 *      a lead owner nor an enrolment counsellor, so his receipts matched no person.
 *   2) `summary()` ADDED UP THE LEADERBOARD ROWS. A receipt that matched no person was
 *      therefore not merely mis-attributed, it was DELETED from the org-wide total.
 *
 * The rule (decision log #45): revenue and cash attribute to the ENROLMENT'S COUNSELLOR;
 * `received_by` is the audit record of who took the money, never an attribution key.
 */

/** A db double that answers the leaderboard and the collected-total query separately. */
function perfSvc(opts: { rows?: any[]; collected?: number } = {}) {
  const sql: string[] = [];
  const db = {
    query: async (q: string) => { sql.push(q); return opts.rows ?? []; },
    one: async (q: string) => {
      sql.push(q);
      return /sum\(fr\.amount_minor\)/.test(q) ? { collected_minor: opts.collected ?? 0 } : null;
    },
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  return { svc: new PerformanceService(db as never, resolver as never), sql };
}

describe('the leaderboard attributes cash by the ENROLMENT COUNSELLOR, not received_by', () => {
  it('collected_minor is keyed on se.counsellor_id', async () => {
    const { svc, sql } = perfSvc();
    await svc.leaderboard({} as never);
    const q = sql.join('\n');
    const collected = /\(SELECT COALESCE\(sum\(fr\.amount_minor\), 0\)[\s\S]*?AS collected_minor/.exec(q);
    expect(collected).toBeTruthy();
    expect(collected![0]).toMatch(/se\.counsellor_id\s*=\s*p\.user_id/);
  });

  it('THE REGRESSION: it must NOT be keyed on received_by — that is what lost the money', async () => {
    const { svc, sql } = perfSvc();
    await svc.leaderboard({} as never);
    const q = sql.join('\n');
    const collected = /\(SELECT COALESCE\(sum\(fr\.amount_minor\), 0\)[\s\S]*?AS collected_minor/.exec(q);
    expect(collected![0]).not.toMatch(/fr\.received_by\s*=\s*p\.user_id/);
  });

});

describe('summary() derives cash from the MONEY, not by summing the rows', () => {
  it('an Accountant-receipted fee appears in the total even though no row claims it', async () => {
    // The exact live shape: a counsellor with an enrolment but the cash taken by Super
    // Admin, who owns no leads and counsels nobody. Before the fix: 0.
    const { svc } = perfSvc({
      rows: [{ user_id: 63, user_name: 'Counsellor', leads: 2, enrolments: 1, revenue_minor: 5_000_000, collected_minor: 0 }],
      collected: 5_000_000,
    });
    const out = await svc.summary({} as never);
    expect(out.collected_minor).toBe(5_000_000);       // was 0 — Rs 50,000 vanished
    expect(out.revenue_minor).toBe(5_000_000);         // booked was always right
  });

  it('the org-wide total does not depend on there being ANY leaderboard row', async () => {
    const { svc } = perfSvc({ rows: [], collected: 5_000_000 });
    const out = await svc.summary({} as never);
    expect(out.counsellors).toBe(0);
    expect(out.collected_minor).toBe(5_000_000);       // the cash is real whoever took it
  });

  it('the collected total is scoped on the enrolment and windowed like the leaderboard', async () => {
    const { svc, sql } = perfSvc({ collected: 1 });
    await svc.summary({} as never, { from: '2026-07-01', to: '2026-07-31' });
    const q = sql.find((x) => /AS collected_minor/.test(x) && !/people AS \(|FROM people p/.test(x))!;
    expect(q).toMatch(/JOIN enrolment e ON e\.id = fr\.enrolment_id/);
    expect(q).toMatch(/fr\.deleted_at IS NULL/);        // a cancelled receipt is not money
    expect(q).toMatch(/e\.deleted_at IS NULL/);
    expect(q).toMatch(/fr\.received_at >= w\.d_from AND fr\.received_at < w\.d_to/);
    expect(q).toMatch(/\$1::date/);                     // the Sprint-3 cast lesson
    expect(q).toMatch(/\$2::date/);
  });

  it('summary() no longer sums collected_minor off the rows', async () => {
    // Rows claim 999; the money says 5,000,000. The money wins.
    const { svc } = perfSvc({
      rows: [{ user_id: 1, user_name: 'X', leads: 0, enrolments: 0, revenue_minor: 0, collected_minor: 999 }],
      collected: 5_000_000,
    });
    const out = await svc.summary({} as never);
    expect(out.collected_minor).toBe(5_000_000);
    expect(out.collected_minor).not.toBe(999);
  });
});

describe('/fees/summary and /performance/summary cannot disagree about cash', () => {
  it('both count every LIVE receipt in the window, with no per-person filter', async () => {
    // fee.service's mtd_minor sums fr.amount_minor over scoped receipts with no
    // attribution filter at all. performance's collected total must have the same shape,
    // or the two screens report different cash — which is the defect.
    const { svc, sql } = perfSvc({ collected: 5_000_000 });
    await svc.summary({} as never);
    const q = sql.find((x) => /AS collected_minor/.test(x) && !/people AS \(|FROM people p/.test(x))!;
    expect(q).not.toMatch(/counsellor_id\s*=\s*p\.user_id/);
    expect(q).not.toMatch(/received_by/);
    expect(q).toMatch(/COALESCE\(sum\(fr\.amount_minor\), 0\)/);
  });
});
