/**
 * On-demand "Start Calling" hand-out (PROJECT_DOCUMENTATION §4.1, Sprint 2 / WS4).
 *
 * The contract under test:
 *   · a pull assigns EXACTLY the campaign's batch_size (default 10) leads,
 *   · two agents clicking at the same instant NEVER receive the same lead,
 *   · an empty pool is a clean empty state, not an error,
 *   · order = priority band, then oldest-first,
 *   · only on_demand campaigns · only agents in the campaign's pool · RBAC scope,
 *   · every assignment lands on the lead timeline AND in audit_log,
 *   · the anti-hoarding guardrail is OFF by default and blocks when switched on.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ALL_SCOPE, CAMPAIGN_ID, OWN_SCOPE, makeHandout, makeHandoutDb, ownResolver, poolLeads,
} from './handout.testkit';
import { FollowUpsService } from './followups.service';

const AGENT_A = 11;
const AGENT_B = 12;
const OUTSIDER = 13;

/** let the event loop run so a "concurrent" transaction reaches its claim */
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('HandoutService — the hand-out itself', () => {
  it('hands out EXACTLY the campaign batch size (10 by default) and assigns them to the agent', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);

    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);

    expect(out.status).toBe('ok');
    expect(out.leads).toHaveLength(10);
    expect(out.handout!.size).toBe(10);
    expect(out.handout!.actioned_count).toBe(0);
    expect(out.handout!.status).toBe('open');
    // exactly those 10 leads now belong to the agent; the other 15 still wait
    expect(st.leads.filter((l) => l.owner_id === AGENT_A)).toHaveLength(10);
    expect(st.leads.filter((l) => l.owner_id == null)).toHaveLength(15);
    expect(out.waiting).toBe(15);
  });

  it('drains the pool across successive pulls and hands out the remainder (25 = 10 + 10 + 5)', async () => {
    const { db } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);

    const a = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    const b = await svc.pull(CAMPAIGN_ID, AGENT_B, ALL_SCOPE);
    const c = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    const d = await svc.pull(CAMPAIGN_ID, AGENT_B, ALL_SCOPE);

    expect([a.leads.length, b.leads.length, c.leads.length]).toEqual([10, 10, 5]);
    expect(d.status).toBe('empty');          // pool exhausted -> empty state, NOT an error
    expect(d.leads).toEqual([]);
    expect(d.message).toContain('No leads are waiting');
  });

  it('CONCURRENCY: two agents clicking Start Calling at the same instant get DISJOINT batches', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(15) });
    const svc = makeHandout(db);

    // freeze agent A's transaction AFTER it has claimed (locked) its rows but BEFORE
    // it commits — exactly the window in which agent B's claim must skip those rows.
    let release!: () => void;
    st.holdAfterClaim = new Promise<void>((res) => { release = res; });

    const pa = svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    await tick();                       // A claims, then holds its locks
    const pb = svc.pull(CAMPAIGN_ID, AGENT_B, ALL_SCOPE);
    await tick();                       // B claims WHILE A still holds them (SKIP LOCKED)
    release();
    const [a, b] = await Promise.all([pa, pb]);

    const idsA = a.leads.map((l: any) => Number(l.id));
    const idsB = b.leads.map((l: any) => Number(l.id));
    expect(idsA).toHaveLength(10);
    expect(idsB).toHaveLength(5);                                   // took what was left
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);     // ZERO overlap
    expect(new Set([...idsA, ...idsB]).size).toBe(15);              // every lead handed once
    // and the ownership in the DB agrees with what each agent was told
    expect(st.leads.filter((l) => l.owner_id === AGENT_A).map((l) => l.id).sort()).toEqual(idsA.sort());
    expect(st.leads.filter((l) => l.owner_id === AGENT_B).map((l) => l.id).sort()).toEqual(idsB.sort());
    expect(st.items).toHaveLength(15);                              // one item per lead, UNIQUE(lead_id)
  });

  it('an empty pool returns a clean empty state, not an error', async () => {
    const { db } = makeHandoutDb({ leads: [] });
    const out = await makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    expect(out.status).toBe('empty');
    expect(out.handout).toBeNull();
    expect(out.leads).toEqual([]);
  });

  it('ORDER: high priority first, then oldest-first inside a band', async () => {
    // 4 leads created oldest..newest; the NEWEST one is High priority
    const leads = poolLeads(4, [{}, {}, {}, { priority: 'high' }]);
    const { db } = makeHandoutDb({ leads });
    const svc = makeHandout(db);

    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 3);
    expect(out.leads.map((l: any) => Number(l.id))).toEqual([1003, 1000, 1001]);  // high, then FIFO
  });

  it('skips leads that are closed (won/lost), deleted, inactive or already owned', async () => {
    const leads = poolLeads(6, [
      { stage_id: 58 },                 // won   -> closed, not in the pool
      { stage_id: 59 },                 // lost  -> closed
      { deleted_at: '2026-07-01T00:00:00Z' },
      { is_active: false },
      { owner_id: 99 },                 // already assigned
      {},                               // the only genuinely poolable lead
    ]);
    const { db } = makeHandoutDb({ leads });
    const out = await makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    expect(out.leads.map((l: any) => Number(l.id))).toEqual([1005]);
  });

  it('a pull may ask for FEWER than the batch size, never more', async () => {
    const { db } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);
    expect((await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 3)).leads).toHaveLength(3);
    expect((await svc.pull(CAMPAIGN_ID, AGENT_B, ALL_SCOPE, 500)).leads).toHaveLength(10);  // capped at batch_size
    await expect(svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 0)).rejects.toThrow(BadRequestException);
  });

  it('honours a campaign batch_size other than 10', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(25) });
    st.campaign.distribution_config = { mode: 'on_demand', batch_size: 4, agent_user_ids: [AGENT_A] };
    const out = await makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    expect(out.leads).toHaveLength(4);
  });
});

describe('HandoutService — eligibility', () => {
  it('rejects an agent who is not in the campaign agent pool', async () => {
    const { db } = makeHandoutDb({ users: [AGENT_A, AGENT_B, OUTSIDER] });
    await expect(makeHandout(db).pull(CAMPAIGN_ID, OUTSIDER, ALL_SCOPE))
      .rejects.toThrow(ForbiddenException);
  });

  it('an EMPTY agent pool means anyone in scope may self-assign (the campaign form says so)', async () => {
    const { db, st } = makeHandoutDb({ users: [AGENT_A, OUTSIDER] });
    st.campaign.distribution_config = { mode: 'on_demand', batch_size: 10, agent_user_ids: [] };
    const out = await makeHandout(db).pull(CAMPAIGN_ID, OUTSIDER, ALL_SCOPE);
    expect(out.leads).toHaveLength(10);
  });

  it('rejects a campaign that is not On Demand (equal / conditional distribute automatically)', async () => {
    const { db, st } = makeHandoutDb();
    st.campaign.distribution_config = { mode: 'equal', batch_size: 10, agent_user_ids: [AGENT_A, AGENT_B] };
    await expect(makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).rejects.toThrow(BadRequestException);
  });

  it('rejects a deactivated agent', async () => {
    const { db } = makeHandoutDb({ users: [AGENT_B] });      // AGENT_A no longer active
    await expect(makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).rejects.toThrow(ForbiddenException);
  });

  it('RBAC: a campaign outside the caller record scope 404s (no existence oracle)', async () => {
    const { db } = makeHandoutDb();
    const svc = makeHandout(db, { denyScope: true });
    await expect(svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).rejects.toThrow(NotFoundException);
  });

  it("an own-scoped counsellor sees the campaigns they are POOLED in (their scope cannot narrow campaigns)", async () => {
    // record_scope 'own' + campaigns have no owner column -> buildScopeWhere = '1=0'.
    // A naive filter would show the agent NOTHING to call; pool membership is what
    // authorises them, so the picker must fall back to it.
    const { db } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db, { resolver: ownResolver });

    const mine = await svc.campaigns(AGENT_A, OWN_SCOPE);          // AGENT_A is in agent_user_ids
    expect(mine.map((c) => c.id)).toEqual([CAMPAIGN_ID]);
    expect(mine[0].waiting).toBe(25);

    expect(await svc.campaigns(OUTSIDER, OWN_SCOPE)).toHaveLength(0);  // not in the pool -> nothing
  });

  it('an EMPTY agent pool is NOT a scope hole: an own-scoped agent still needs the campaign in scope', async () => {
    const { db, st } = makeHandoutDb({ users: [AGENT_A, OUTSIDER] });
    st.campaign.distribution_config = { mode: 'on_demand', batch_size: 10, agent_user_ids: [] };
    // strict check fails = the caller's grant does not map onto campaigns (own scope)
    const svc = makeHandout(db, { denyStrictScope: true, resolver: ownResolver });
    await expect(svc.pull(CAMPAIGN_ID, OUTSIDER, OWN_SCOPE)).rejects.toThrow(NotFoundException);
    // ...and such an agent is not offered the campaign either
    expect(await svc.campaigns(OUTSIDER, OWN_SCOPE)).toHaveLength(0);
  });

  it('another agent cannot open my batch', async () => {
    const { db } = makeHandoutDb();
    const svc = makeHandout(db);
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    await expect(svc.batch(out.handout!.id, AGENT_B)).rejects.toThrow(NotFoundException);
  });
});

describe('HandoutService — audit trail', () => {
  it('writes an assign activity per lead AND one audit_log row carrying the claimed ids', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(12) });
    const out = await makeHandout(db).pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);

    const assigns = st.activities.filter((a) => a.type === 'assign');
    expect(assigns).toHaveLength(10);
    expect(assigns.every((a) => Number(a.actor_id) === AGENT_A)).toBe(true);
    expect(String(assigns[0].note)).toContain('Start Calling');

    expect(st.audit).toHaveLength(1);
    expect(st.audit[0].action).toBe('handout');
    expect(st.audit[0].entity_type).toBe('lead_handout');
    expect(st.audit[0].after.lead_ids).toHaveLength(10);
    expect(st.audit[0].after.user_id).toBe(AGENT_A);
    expect(st.audit[0].after.lead_ids).toEqual(out.leads.map((l: any) => Number(l.id)));
  });
});

describe('HandoutService — audit constraint', () => {
  it("the fake DB enforces audit_log's action CHECK (the WS4 live-smoke bug, now a unit test)", async () => {
    // 'handout' is allowed by migration 021; anything else must blow up exactly as
    // Postgres does — so a future audit verb cannot ship without widening the CHECK.
    const { AUDIT_ACTIONS } = await import('./handout.testkit');
    expect(AUDIT_ACTIONS).toContain('handout');
    const { db } = makeHandoutDb({ leads: poolLeads(3) });
    const svc = makeHandout(db);
    await expect(svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 2)).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('HandoutService — the working queue', () => {
  it('a disposition marks the lead actioned and advances the progress; the batch completes at N of N', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(3) });
    const svc = makeHandout(db);
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 3);
    const id = out.handout!.id;

    let cur = await svc.action(id, { lead_id: out.leads[0].id, disposition_id: 81, note: 'Not picking up' }, AGENT_A, ALL_SCOPE);
    expect(cur.handout.actioned_count).toBe(1);      // "1 of 3"
    expect(cur.handout.status).toBe('open');
    expect(st.activities.some((a) => a.type === 'disposition')).toBe(true);

    // re-dispositioning the same lead must NOT double-count
    cur = await svc.action(id, { lead_id: out.leads[0].id, disposition_id: 82 }, AGENT_A, ALL_SCOPE);
    expect(cur.handout.actioned_count).toBe(1);

    await svc.action(id, { lead_id: out.leads[1].id, disposition_id: 81 }, AGENT_A, ALL_SCOPE);
    cur = await svc.action(id, { lead_id: out.leads[2].id, disposition_id: 81, stage_id: 52 }, AGENT_A, ALL_SCOPE);

    expect(cur.handout.actioned_count).toBe(3);
    expect(cur.handout.status).toBe('completed');    // 3 of 3 -> ready for the next batch
    expect(st.leads.find((l) => l.id === out.leads[2].id)!.stage_id).toBe(52);
    expect(st.activities.some((a) => a.type === 'stage_change')).toBe(true);
  });

  it('schedules the next follow-up through the existing follow-up service', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const { db } = makeHandoutDb({ leads: poolLeads(2) });
    const svc = makeHandout(db, { followups: { create } as unknown as FollowUpsService });
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 2);

    await svc.action(out.handout!.id, {
      lead_id: out.leads[0].id, disposition_id: 81, note: 'Call back tomorrow',
      next_follow_up_at: '2026-07-15T10:00:00Z',
    }, AGENT_A, ALL_SCOPE);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      lead_id: out.leads[0].id, scheduled_at: '2026-07-15T10:00:00Z', owner_id: AGENT_A,
    });
  });

  // DEF-S2-07 (QA-10) — re-actioning the same lead must RESCHEDULE its follow-up
  it('DEF-S2-07: re-actioning a lead reschedules its follow-up instead of creating a second one', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(2) });
    let fSeq = 0;
    const create = jest.fn(async (dto: any) => {
      const row = { id: ++fSeq, lead_id: dto.lead_id, status: 'pending', scheduled_at: dto.scheduled_at, deleted_at: null };
      st.followups.push(row);
      return row;
    });
    const update = jest.fn(async (id: number, dto: any) => {
      const row = st.followups.find((f: any) => Number(f.id) === Number(id));
      if (row) Object.assign(row, dto);
      return row;
    });
    const svc = makeHandout(db, { followups: { create, update } as unknown as FollowUpsService });
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 2);
    const leadId = out.leads[0].id;

    await svc.action(out.handout!.id, {
      lead_id: leadId, disposition_id: 81, note: 'Call back tomorrow',
      next_follow_up_at: '2026-07-15T10:00:00Z',
    }, AGENT_A, ALL_SCOPE);
    // the agent re-opens the same lead in the batch and changes the date
    const cur = await svc.action(out.handout!.id, {
      lead_id: leadId, disposition_id: 82, note: 'Actually next week',
      next_follow_up_at: '2026-07-20T10:00:00Z',
    }, AGENT_A, ALL_SCOPE);

    expect(create).toHaveBeenCalledTimes(1);              // exactly ONE follow-up ever created
    expect(update).toHaveBeenCalledTimes(1);              // the second action rescheduled it
    expect(update.mock.calls[0][1]).toMatchObject({ scheduled_at: '2026-07-20T10:00:00Z' });
    expect(st.followups).toHaveLength(1);
    expect(st.followups[0].scheduled_at).toBe('2026-07-20T10:00:00Z');
    expect(cur.handout.actioned_count).toBe(1);          // still not double-counted
  });

  it('DEF-S2-07: if the agent COMPLETED the follow-up, a re-action creates a fresh one', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(2) });
    let fSeq = 0;
    const create = jest.fn(async (dto: any) => {
      const row = { id: ++fSeq, lead_id: dto.lead_id, status: 'pending', scheduled_at: dto.scheduled_at, deleted_at: null };
      st.followups.push(row);
      return row;
    });
    const svc = makeHandout(db, { followups: { create, update: jest.fn() } as unknown as FollowUpsService });
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE, 2);
    const leadId = out.leads[0].id;

    await svc.action(out.handout!.id, { lead_id: leadId, next_follow_up_at: '2026-07-15T10:00:00Z' }, AGENT_A, ALL_SCOPE);
    st.followups[0].status = 'done';                     // the agent ticked it off
    await svc.action(out.handout!.id, { lead_id: leadId, next_follow_up_at: '2026-07-22T10:00:00Z' }, AGENT_A, ALL_SCOPE);

    expect(create).toHaveBeenCalledTimes(2);
    expect(st.followups).toHaveLength(2);
  });

  it('rejects a lead that is not in the batch, and one that was reassigned away', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(12) });
    const svc = makeHandout(db);
    const out = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    const id = out.handout!.id;

    await expect(svc.action(id, { lead_id: 1011 }, AGENT_A, ALL_SCOPE)).rejects.toThrow(NotFoundException);

    // a manager reassigns one of the batch's leads to someone else
    st.leads.find((l) => l.id === out.leads[0].id)!.owner_id = 99;
    await expect(svc.action(id, { lead_id: out.leads[0].id }, AGENT_A, ALL_SCOPE)).rejects.toThrow(ForbiddenException);
  });

  it('current() returns the agent live queue (and nothing for an agent with no batch)', async () => {
    const { db } = makeHandoutDb({ leads: poolLeads(12) });
    const svc = makeHandout(db);
    expect((await svc.current(AGENT_A)).handout).toBeNull();

    await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    const cur = await svc.current(AGENT_A);
    expect(cur.handout!.size).toBe(10);
    expect(cur.leads).toHaveLength(10);
    expect(cur.waiting).toBe(2);
  });
});

describe('HandoutService — the anti-hoarding guardrail', () => {
  it('is OFF by default: an agent may pull again, and the unworked leads STAY assigned to them', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);

    const first = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    const second = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);   // nothing actioned in between

    expect(second.leads).toHaveLength(10);
    expect(st.handouts.find((h) => h.id === first.handout!.id)!.status).toBe('closed');
    expect(st.handouts.find((h) => h.id === second.handout!.id)!.status).toBe('open');
    // 20 leads assigned to the agent — none was silently returned to the pool
    expect(st.leads.filter((l) => l.owner_id === AGENT_A)).toHaveLength(20);
    expect(st.leads.filter((l) => l.owner_id == null)).toHaveLength(5);
  });

  it('switched ON: a second pull is refused (409) until the open batch is actioned', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(25) });
    st.guard = { enabled: true, min_actioned_pct: 100 };
    const svc = makeHandout(db);

    const first = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    await expect(svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).rejects.toThrow(ConflictException);

    // work the whole batch...
    for (const l of first.leads) {
      await svc.action(first.handout!.id, { lead_id: Number(l.id), disposition_id: 81 }, AGENT_A, ALL_SCOPE);
    }
    // ...and the next batch is allowed
    const second = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    expect(second.leads).toHaveLength(10);
  });

  it('switched ON with a partial threshold: 50% actioned is enough', async () => {
    const { db, st } = makeHandoutDb({ leads: poolLeads(25) });
    st.guard = { enabled: true, min_actioned_pct: 50 };
    const svc = makeHandout(db);

    const first = await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    for (const l of first.leads.slice(0, 4)) {
      await svc.action(first.handout!.id, { lead_id: Number(l.id), disposition_id: 81 }, AGENT_A, ALL_SCOPE);
    }
    await expect(svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).rejects.toThrow(ConflictException);  // 40%
    await svc.action(first.handout!.id, { lead_id: Number(first.leads[4].id), disposition_id: 81 }, AGENT_A, ALL_SCOPE);
    expect((await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).leads).toHaveLength(10);            // 50%
  });

  it('a malformed / missing setting row can never block an agent (fails OPEN)', async () => {
    const { db } = makeHandoutDb({ guard: null, leads: poolLeads(25) });
    const svc = makeHandout(db);
    await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    expect((await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE)).leads).toHaveLength(10);
  });
});

describe('HandoutService — manager views', () => {
  it('lists the campaigns an agent may pull from, with the pool size', async () => {
    const { db } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);
    const mine = await svc.campaigns(AGENT_A, ALL_SCOPE);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: CAMPAIGN_ID, waiting: 25, batch_size: 10 });

    // an agent outside the pool sees nothing to call
    expect(await svc.campaigns(OUTSIDER, ALL_SCOPE)).toHaveLength(0);
  });

  it('pool status shows what is waiting and who pulled what and when', async () => {
    const { db } = makeHandoutDb({ leads: poolLeads(25) });
    const svc = makeHandout(db);
    await svc.pull(CAMPAIGN_ID, AGENT_A, ALL_SCOPE);
    await svc.pull(CAMPAIGN_ID, AGENT_B, ALL_SCOPE);

    const pool = await svc.pool(ALL_SCOPE);
    expect(pool.campaigns[0]).toMatchObject({ waiting: 5, open_batches: 2, leads_handed_today: 20 });
    expect(pool.campaigns[0].oldest_waiting_at).toBeTruthy();
    expect(pool.handouts).toHaveLength(2);
    expect(pool.handouts.map((h) => h.user_id).sort()).toEqual([AGENT_A, AGENT_B]);
    expect(pool.handouts[0]).toMatchObject({ size: 10, actioned_count: 0, status: 'open' });
    expect(pool.guard.enabled).toBe(false);
  });
});
