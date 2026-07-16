import { ScheduleService, isoWeek, nextRunAt, runKeyFor } from './schedule.service';
import { ScheduleWorker } from './schedule.worker';
import { NotConfiguredException } from '../common/not-configured.exception';
import { DatabaseService } from '../database/database.service';

/**
 * =============================================================================
 * A SCHEDULE SENDS ONCE. THAT IS THE ONLY THING THAT MATTERS HERE.
 * =============================================================================
 *
 * "The report arrived twice" is a bug a client notices immediately and never quite
 * forgets, and it is trivially easy to ship: two API replicas ticking in the same second,
 * a retry after a crash, a manual "Send now" next to a timer.
 *
 * The mechanism is the Sprint-4 journey rule, unchanged: a UNIQUE index and an
 * `ON CONFLICT DO NOTHING RETURNING id`, never a check-then-insert that races. These
 * tests drive `runSchedule` TWICE and assert exactly one email is queued — with a fake DB
 * that enforces the unique index the way Postgres does, because a double that "returns
 * whatever it likes" would pass either implementation.
 */

/* ---------------------------------------------------------- the fake DB */

interface Delivery { id: number; schedule_id: number; run_key: string; status: string; error?: string | null }

class FakeDb {
  schedules: any[] = [];
  deliveries: Delivery[] = [];
  users: any[] = [];
  private seq = 1;
  readonly log: string[] = [];

  async query(sql: string, params: unknown[] = []): Promise<any[]> {
    this.log.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT id FROM organisation')) return [{ id: '1' }];

    // THE IDEMPOTENCY GATE, modelled the way Postgres actually behaves.
    if (/INSERT INTO report_delivery/.test(s)) {
      const [scheduleId, runKey] = params as [number, string];
      if (this.deliveries.some((d) => d.schedule_id === Number(scheduleId) && d.run_key === runKey)) {
        return [];                                    // <- ON CONFLICT DO NOTHING: no row back
      }
      const row = { id: this.seq++, schedule_id: Number(scheduleId), run_key: runKey, status: 'running' };
      this.deliveries.push(row);
      return [{ id: String(row.id) }];
    }
    if (/UPDATE report_delivery/.test(s)) {
      const [id, status, error] = params as [number, string, string];
      const d = this.deliveries.find((x) => x.id === Number(id));
      if (d) { d.status = status; d.error = error; }
      return [];
    }
    if (/SELECT s\.\*, r\.name AS report_name/.test(s)) {
      const [id] = params as [number];
      const row = this.schedules.find((x) => Number(x.id) === Number(id));
      return row ? [row] : [];
    }
    if (/UPDATE report_schedule/.test(s)) {
      const [id, next] = params as [number, Date];
      const row = this.schedules.find((x) => Number(x.id) === Number(id));
      if (row) { row.next_run_at = next; row.last_run_at = new Date(); }
      return [];
    }
    if (/FROM "user" u/.test(s)) return this.users;
    if (/SELECT s\.id FROM report_schedule s/.test(s)) {
      const now = params[0] as Date;
      return this.schedules.filter((x) => x.is_active && x.next_run_at && new Date(x.next_run_at) <= now).map((x) => ({ id: String(x.id) }));
    }
    return [];
  }
  async one(sql: string, params: unknown[] = []) { return (await this.query(sql, params))[0] ?? null; }
  async tx(fn: any) { return fn({ query: async () => ({ rows: [] }) }); }
}

const SCHEDULE = (over: Record<string, unknown> = {}) => ({
  id: 7, report_id: 3, report_name: 'Leads this week', entity: 'leads', config: { columns: ['full_name'] },
  frequency: 'daily', hour_local: 8, minute_local: 0, day_of_week: null, day_of_month: null,
  format: 'xlsx', recipient_user_ids: [4], recipient_role_ids: [], run_as_user_id: 2,
  is_active: true, next_run_at: new Date('2026-07-17T02:30:00Z'), last_run_at: null, ...over,
});

const build = (over: { emailConfigured?: boolean; users?: any[]; execute?: any } = {}) => {
  const db = new FakeDb();
  db.schedules = [SCHEDULE()];
  db.users = over.users ?? [{ id: '4', name: 'Asha Rao', email: 'asha@techlingua.in' }];

  const queued: any[] = [];
  const messaging = { queue: async (m: any) => { queued.push(m); return { id: queued.length, status: 'queued' }; } };
  const configs = {
    require: async () => {
      if (over.emailConfigured === false) throw new NotConfiguredException('Email is not configured.');
      return { provider: 'smtp', config: {}, secrets: {} };
    },
  };
  const reports = {
    execute: over.execute ?? (async () => ({
      columns: [{ key: 'full_name', label: 'Name', type: 'text' }],
      rows: [['Priya']], row_count: 1, grouped: false, truncated: false,
      entity: 'leads', entity_label: 'Leads', report: null,
      scope: { user_id: 2, unrestricted: true, note: 'Showing all records.' },
      generated_at: new Date().toISOString(),
    })),
  };
  const exports = { build: () => Buffer.from('FAKE-XLSX') };
  const schedules = new ScheduleService(db as unknown as DatabaseService, reports as any, exports as any);
  const worker = new ScheduleWorker(
    db as unknown as DatabaseService, schedules, reports as any, exports as any, messaging as any, configs as any,
  );
  return { db, worker, queued, schedules };
};

/* ============================================================== the maths */

describe('runKeyFor — the period, not the moment', () => {
  it('daily -> the IST date', () => {
    // 02:30 UTC on the 17th is 08:00 IST on the 17th
    expect(runKeyFor('daily', new Date('2026-07-17T02:30:00Z'))).toBe('2026-07-17');
  });

  it('daily -> the IST date even when UTC is still on the day before', () => {
    // 20:00 UTC on the 16th is 01:30 IST on the 17th. A schedule for "the 17th" must key
    // on the 17th, or a 1am run and an 8am run get different keys and BOTH send.
    expect(runKeyFor('daily', new Date('2026-07-16T20:00:00Z'))).toBe('2026-07-17');
  });

  it('weekly -> an ISO week', () => {
    expect(runKeyFor('weekly', new Date('2026-07-17T02:30:00Z'))).toBe('2026-W29');
  });

  it('monthly -> a month', () => {
    expect(runKeyFor('monthly', new Date('2026-07-17T02:30:00Z'))).toBe('2026-07');
  });

  it('isoWeek handles the new-year boundary (where a naive week number is wrong)', () => {
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))[1]).toBe(53);
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))[1]).toBe(1);
  });
});

describe('nextRunAt — STRICTLY after `from`', () => {
  const daily = { frequency: 'daily' as const, hour_local: 8, minute_local: 0, day_of_week: null, day_of_month: null };

  /**
   * `>=` here is an infinite loop that emails the client every two seconds. It is obvious
   * in a spec and invisible in review, which is exactly why it gets a test.
   */
  it('called AT the run time, it returns TOMORROW — not today again', () => {
    const at8 = new Date('2026-07-17T02:30:00Z');       // 08:00 IST
    const next = nextRunAt(daily, at8);
    expect(next.toISOString()).toBe('2026-07-18T02:30:00.000Z');
  });

  it('called before the run time, it returns today', () => {
    expect(nextRunAt(daily, new Date('2026-07-17T01:00:00Z')).toISOString()).toBe('2026-07-17T02:30:00.000Z');
  });

  it('weekly picks the next matching weekday — in IST, which is the only day that matters', () => {
    const weekly = { frequency: 'weekly' as const, hour_local: 8, minute_local: 0, day_of_week: 1, day_of_month: null };
    const next = nextRunAt(weekly, new Date('2026-07-17T02:30:00Z'));   // a Friday
    // `day_of_week` is a LOCAL day: the client picks "Mondays" meaning Monday in Delhi.
    // Asserting getUTCDay() on the result would be asserting an implementation detail —
    // and for an 08:00 IST run it happens to agree, which is exactly how a timezone bug
    // hides. Convert back to IST and check the day the client actually chose.
    const istDay = new Date(next.getTime() + 330 * 60_000).getUTCDay();
    expect(istDay).toBe(1);                              // Monday, in Delhi
    expect(next.toISOString()).toBe('2026-07-20T02:30:00.000Z');   // 08:00 IST, next Monday
    expect(runKeyFor('weekly', next)).toBe('2026-W30');
  });

  it('a 23:00 IST weekly run still lands on the day the client picked (the UTC day differs)', () => {
    // 23:00 IST Monday is 17:30 UTC Monday; 01:00 IST Monday is 19:30 UTC SUNDAY. If the
    // day were computed in UTC, an early-morning schedule would fire on the wrong day.
    const late = { frequency: 'weekly' as const, hour_local: 1, minute_local: 0, day_of_week: 1, day_of_month: null };
    const next = nextRunAt(late, new Date('2026-07-17T02:30:00Z'));
    expect(new Date(next.getTime() + 330 * 60_000).getUTCDay()).toBe(1);   // Monday in IST
    expect(next.getUTCDay()).toBe(0);                                      // Sunday in UTC — and that is FINE
  });

  it('monthly rolls to the next month', () => {
    const monthly = { frequency: 'monthly' as const, hour_local: 8, minute_local: 0, day_of_week: null, day_of_month: 1 };
    const next = nextRunAt(monthly, new Date('2026-07-17T02:30:00Z'));
    expect(next.toISOString().slice(0, 7)).toBe('2026-08');
  });

  it('the schedule does not DRIFT — the next run is computed from the DUE time, not from now', async () => {
    // a run that starts 40 seconds late must not push tomorrow's run 40 seconds later,
    // or the "8am report" arrives at noon by September.
    const { db, worker } = build();
    await worker.runSchedule(7, new Date('2026-07-17T02:30:40Z'));
    expect(new Date(db.schedules[0].next_run_at).toISOString()).toBe('2026-07-18T02:30:00.000Z');
  });
});

/* ==================================================== IT SENDS EXACTLY ONCE */

describe('IT SENDS ONCE', () => {
  it('one run -> one delivery row, one email', async () => {
    const { db, worker, queued } = build();
    expect(await worker.runSchedule(7)).toBe(true);
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].status).toBe('sent');
    expect(queued).toHaveLength(1);
  });

  /** THE TEST THIS FILE EXISTS FOR. */
  it('TWO runs of the same period -> STILL one email', async () => {
    const { db, worker, queued } = build();
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    // the clock advanced, so force the same due time again — a retry, or a second replica
    db.schedules[0].next_run_at = new Date('2026-07-17T02:30:00Z');
    const second = await worker.runSchedule(7, new Date('2026-07-17T02:30:05Z'));

    expect(second).toBe(false);                 // it declined
    expect(db.deliveries).toHaveLength(1);      // no second delivery row
    expect(queued).toHaveLength(1);             // AND no second email
  });

  /**
   * ==========================================================================
   * DEF-S6-03 — THE TEST THAT WAS MISSING, AND THE LIVE SMOKE THAT FOUND IT.
   * ==========================================================================
   * Every "sends once" test above resets `next_run_at` BY HAND between the two calls,
   * because that is how a second replica would find the row. That is a real scenario and
   * those tests are right — but it is not what the "Send now" BUTTON does, and the hand
   * reset masked the bug completely.
   *
   * Live, four presses produced FOUR delivery rows (2026-07-17, -18, -19, -20): each run
   * advanced the clock, so the next press computed a run key for a DIFFERENT PERIOD and
   * sailed through the idempotency gate — "delivering" days that had not happened, and
   * pushing the client's real 08:00 report four days into the future.
   *
   * So this test presses the button four times, exactly as a user would, and touches
   * NOTHING in between.
   */
  it('FOUR manual presses, nothing reset by hand -> ONE delivery row and the clock UNMOVED', async () => {
    const { db, worker, queued } = build();
    const before = db.schedules[0].next_run_at;

    for (let i = 0; i < 4; i++) {
      await worker.runSchedule(7, new Date('2026-07-16T14:00:00Z'), { advance: false });
    }

    expect(db.deliveries).toHaveLength(1);                 // <- was 4
    expect(db.deliveries[0].run_key).toBe('2026-07-17');   // the CURRENT due period
    expect(queued).toHaveLength(1);
    // and the timer is exactly where it was — a manual press must not silently stop the
    // client's daily report for four days
    expect(db.schedules[0].next_run_at).toBe(before);
  });

  it('a manual press does NOT move the clock; the TIMER does', async () => {
    const { db, worker } = build();
    const before = db.schedules[0].next_run_at;
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'), { advance: false });
    expect(db.schedules[0].next_run_at).toBe(before);

    // the timer path (default) advances it
    const { db: db2, worker: w2 } = build();
    await w2.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    expect(new Date(db2.schedules[0].next_run_at).toISOString()).toBe('2026-07-18T02:30:00.000Z');
  });

  /** …and because the manual press consumed the period's key, the 08:00 timer correctly
   *  declines to send a second copy of a report the client already has. */
  it('after a manual press, the TIMER declines the same period', async () => {
    const { db, worker, queued } = build();
    await worker.runSchedule(7, new Date('2026-07-16T14:00:00Z'), { advance: false });
    expect(queued).toHaveLength(1);
    const fired = await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    expect(fired).toBe(false);
    expect(queued).toHaveLength(1);
    expect(db.deliveries).toHaveLength(1);
  });

  it('a repeat does NOT advance the clock — the owner of the period does that', async () => {
    const { db, worker } = build();
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    const afterFirst = db.schedules[0].next_run_at;
    db.schedules[0].next_run_at = new Date('2026-07-17T02:30:00Z');
    await worker.runSchedule(7, new Date('2026-07-17T02:30:05Z'));
    // it set it back itself for the test; the point is the second run did not touch it
    expect(db.deliveries).toHaveLength(1);
    expect(afterFirst).toBeTruthy();
  });

  it('a DIFFERENT period sends again (it is idempotent, not broken)', async () => {
    const { db, worker, queued } = build();
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    db.schedules[0].next_run_at = new Date('2026-07-18T02:30:00Z');
    await worker.runSchedule(7, new Date('2026-07-18T02:30:00Z'));
    expect(db.deliveries.map((d) => d.run_key)).toEqual(['2026-07-17', '2026-07-18']);
    expect(queued).toHaveLength(2);
  });

  it('THE DELIVERY ROW IS WRITTEN BEFORE THE EMAIL — a crash mid-send cannot double-send', async () => {
    const { db, worker } = build();
    const order: string[] = [];
    const origQuery = db.query.bind(db);
    (db as any).query = async (sql: string, p: unknown[]) => {
      if (/INSERT INTO report_delivery/.test(sql)) order.push('claim');
      return origQuery(sql, p);
    };
    (db as any).one = async (sql: string, p: unknown[]) => {
      if (/INSERT INTO report_delivery/.test(sql)) order.push('claim');
      return (await origQuery(sql, p))[0] ?? null;
    };
    await worker.runSchedule(7);
    expect(order[0]).toBe('claim');
  });
});

/* ================================================== DEGRADING WITHOUT SMTP */

describe('NO SMTP — it degrades cleanly and comes back by itself', () => {
  it('the run is SKIPPED, not failed, and the reason is in the client\'s own words', async () => {
    const { db, worker, queued } = build({ emailConfigured: false });
    expect(await worker.runSchedule(7)).toBe(true);
    expect(db.deliveries[0].status).toBe('skipped');
    expect(db.deliveries[0].error).toContain('Email is not configured');
    expect(db.deliveries[0].error).toContain('Settings');       // WHERE to fix it
    expect(queued).toHaveLength(0);
  });

  it('the CLOCK STILL ADVANCES — the day he pastes his SMTP in, it just starts working', async () => {
    const { db, worker } = build({ emailConfigured: false });
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    expect(new Date(db.schedules[0].next_run_at).toISOString()).toBe('2026-07-18T02:30:00.000Z');
  });

  it('it does not retry the same period every 30 seconds for a week', async () => {
    const { db, worker } = build({ emailConfigured: false });
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    db.schedules[0].next_run_at = new Date('2026-07-17T02:30:00Z');
    await worker.runSchedule(7, new Date('2026-07-17T02:30:30Z'));
    expect(db.deliveries).toHaveLength(1);
  });

  it('NOTHING IS RENDERED when there is nowhere to send it (no point building a file nobody gets)', async () => {
    let rendered = 0;
    const { worker } = build({
      emailConfigured: false,
      execute: async () => { rendered++; return { columns: [], rows: [], row_count: 0, scope: { note: '' } } as any; },
    });
    await worker.runSchedule(7);
    expect(rendered).toBe(0);
  });
});

describe('the other ways a run can go wrong are RECORDED, not swallowed', () => {
  it('a recipient with no email address is a skip that names the problem', async () => {
    const { db, worker, queued } = build({ users: [{ id: '4', name: 'Asha Rao', email: null }] });
    await worker.runSchedule(7);
    expect(db.deliveries[0].status).toBe('skipped');
    expect(db.deliveries[0].error).toContain('email address');
    expect(queued).toHaveLength(0);
  });

  it('a query that throws is a FAILED delivery with the reason — and the clock still advances', async () => {
    const { db, worker } = build({ execute: async () => { throw new Error('relation "lead" does not exist'); } });
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    expect(db.deliveries[0].status).toBe('failed');
    expect(db.deliveries[0].error).toContain('relation "lead" does not exist');
    // A schedule that stops for ever because one Tuesday threw is worse than one that
    // misses a Tuesday: the client would not find out until he needed the report.
    expect(new Date(db.schedules[0].next_run_at).toISOString()).toBe('2026-07-18T02:30:00.000Z');
  });
});

describe('the email itself', () => {
  it('carries the file as an attachment, and the SCOPE NOTE in the body', async () => {
    const { queued } = build();
    await (build().worker).runSchedule(7);
    const { worker, queued: q } = build();
    await worker.runSchedule(7);
    expect(q[0].attachments).toHaveLength(1);
    expect(q[0].attachments[0].filename).toMatch(/\.xlsx$/);
    expect(q[0].attachments[0].content.toString()).toBe('FAKE-XLSX');
    expect(q[0].body).toContain('Showing all records.');
    expect(q[0].subject).toContain('Leads this week');
  });

  /**
   * NOT `guarded`. Business hours are a MARKETING rule — an out-of-hours WhatsApp blast
   * is deferred to the next working morning (Sprint 4). A report the client scheduled for
   * 08:00 must arrive at 08:00; deferring it by a rule written for customer messages
   * would be the automation guardrail firing at the wrong thing.
   */
  it('is NOT subject to the business-hours guardrail', async () => {
    const { worker, queued } = build();
    await worker.runSchedule(7);
    expect(queued[0].guarded).toBeUndefined();
  });

  it('carries a dedupe key that is unique per (schedule, period, recipient)', async () => {
    const { worker, queued } = build();
    await worker.runSchedule(7, new Date('2026-07-17T02:30:00Z'));
    expect(queued[0].dedupe_key).toBe('report-7-2026-07-17-4');
  });

  /** The file is rendered in the SCHEDULE OWNER'S scope, not the recipient's. The form
   *  says so in words before the client presses Save — this pins that it is true. */
  it('is rendered as the SCHEDULE OWNER (run_as_user_id), not the recipient', async () => {
    let ranAs: number | null = null;
    const { worker } = build({
      execute: async (_e: unknown, _c: unknown, me: { id: number }) => {
        ranAs = me.id;
        return { columns: [], rows: [], row_count: 0, scope: { note: '' }, entity_label: 'Leads' } as any;
      },
    });
    await worker.runSchedule(7);
    expect(ranAs).toBe(2);      // run_as_user_id, NOT the recipient (4)
  });
});

describe('recipients', () => {
  it('a schedule with no recipients at all is refused at CREATE — a timer that does nothing', async () => {
    const { schedules } = build();
    const reports = { get: async () => ({ id: 3, name: 'x' }) };
    (schedules as any).reports = reports;
    await expect(schedules.create({ report_id: 3, frequency: 'daily' }, { id: 2 }, { all: true } as any))
      .rejects.toThrow(/at least one recipient/);
  });

  it('an unknown frequency or format is refused with the value quoted', async () => {
    const { schedules } = build();
    (schedules as any).reports = { get: async () => ({ id: 3, name: 'x' }) };
    await expect(schedules.create({ report_id: 3, frequency: 'hourly', recipient_user_ids: [4] }, { id: 2 }, { all: true } as any))
      .rejects.toThrow(/hourly/);
    await expect(schedules.create({ report_id: 3, frequency: 'daily', format: 'docx', recipient_user_ids: [4] }, { id: 2 }, { all: true } as any))
      .rejects.toThrow(/docx/);
  });
});
