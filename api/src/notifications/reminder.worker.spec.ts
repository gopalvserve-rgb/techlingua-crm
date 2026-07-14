import { ReminderWorker } from './reminder.worker';
import { NotifierService } from './notifier.service';
import { FollowUpRow, SlaRow, makeSprint3Db, managersReturning, noScoring, settingsWith } from './sprint3.testkit';

/**
 * REMINDERS · OVERDUE ESCALATION · SLA BREACH — the three sweeps.
 *
 * The property the client is buying is "it fires, and it fires ONCE". These tests drive
 * the worker's tick against a double that models the CLAIM (a conditional UPDATE that
 * returns a row only the first time), so "exactly once" is proven, not asserted.
 */

const mins = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

const fu = (over: Partial<FollowUpRow> = {}): FollowUpRow => ({
  id: 1, lead_id: 100, owner_id: 3, scheduled_at: mins(-200), notes: null,
  lead_name: 'Asha Rao', type_name: 'Call',
  reminded_at: null, escalated_at: null, escalation_level: 0, status: 'pending', ...over,
});
const sla = (over: Partial<SlaRow> = {}): SlaRow => ({
  id: 1, lead_id: 100, metric: 'first_response', due_at: mins(-30),
  policy_name: 'First response within 60 minutes', notify_manager: true, escalate_after_minutes: 0,
  lead_name: 'Asha Rao', owner_id: 3,
  breached_at: null, notified_at: null, satisfied_at: null, ...over,
});

const build = (state: Parameters<typeof makeSprint3Db>[0], policy = {}, managers: number[] = [9]) => {
  const { db, st } = makeSprint3Db(state);
  const settings = settingsWith(policy);
  const notifier = new NotifierService(db, settings);
  const worker = new ReminderWorker(db, settings, notifier, managersReturning(managers), noScoring());
  return { worker, st };
};

/* ============================== 1. REMINDERS ============================== */

describe('due-soon reminders', () => {
  it('notifies the OWNER when the reminder time arrives', async () => {
    // due in 10 minutes, policy reminds 30 minutes ahead -> the reminder is due now
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(10) })] });
    expect(await worker.sweepReminders(await worker.policy())).toBe(1);
    expect(st.notifications).toHaveLength(1);
    expect(st.notifications[0]).toMatchObject({
      user_id: 3, type: 'reminder', severity: 'info', link_type: 'lead', link_id: 100,
    });
    expect(st.notifications[0].title).toContain('Asha Rao');
  });

  it('does NOT remind before the lead time (a follow-up due tomorrow is not "due soon")', async () => {
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(24 * 60) })] });
    expect(await worker.sweepReminders(await worker.policy())).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });

  it('FIRES EXACTLY ONCE — a second sweep re-reads the row and does nothing', async () => {
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(5) })] });
    const p = await worker.policy();
    expect(await worker.sweepReminders(p)).toBe(1);
    expect(await worker.sweepReminders(p)).toBe(0);
    expect(await worker.sweepReminders(p)).toBe(0);
    expect(st.notifications).toHaveLength(1);
  });

  it('honours a LONGER lead time from the policy (client-editable, no deploy)', async () => {
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(90) })] }, { reminder_lead_minutes: 120 });
    expect(await worker.sweepReminders(await worker.policy())).toBe(1);
    expect(st.notifications).toHaveLength(1);
  });

  it('a DONE follow-up is never reminded', async () => {
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(5), status: 'done' })] });
    expect(await worker.sweepReminders(await worker.policy())).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });
});

/* ============================ 2. ESCALATION ============================ */

describe('overdue escalation', () => {
  it('after N minutes overdue: notifies the owner AND the manager, and flags the lead', async () => {
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(-200) })] });
    expect(await worker.sweepEscalations(await worker.policy())).toBe(1);

    const owner = st.notifications.filter((n) => n.user_id === 3);
    const manager = st.notifications.filter((n) => n.user_id === 9);
    expect(owner).toHaveLength(1);
    expect(manager).toHaveLength(1);
    expect(owner[0]).toMatchObject({ type: 'escalation', severity: 'warn' });
    expect(st.leads[100].is_flagged).toBe(true);
    expect(st.leads[100].flag_reason).toMatch(/overdue/i);
    expect(st.audit).toEqual([{ action: 'escalate', entity_id: 1 }]);
  });

  it('does NOT escalate before overdue_after_minutes has elapsed', async () => {
    // 30 min overdue, but the policy says escalate only after 120
    const { worker, st } = build({ followUps: [fu({ scheduled_at: mins(-30) })] });
    expect(await worker.sweepEscalations(await worker.policy())).toBe(0);
    expect(st.notifications).toHaveLength(0);
    expect(st.leads[100]).toBeUndefined();
  });

  it('FIRES EXACTLY ONCE (max_levels = 1): repeated ticks change nothing', async () => {
    const { worker, st } = build({ followUps: [fu()] });
    const p = await worker.policy();
    expect(await worker.sweepEscalations(p)).toBe(1);
    expect(await worker.sweepEscalations(p)).toBe(0);
    expect(await worker.sweepEscalations(p)).toBe(0);
    expect(st.notifications).toHaveLength(2);          // owner + manager, once
    expect(st.audit).toHaveLength(1);
  });

  it('the ACTIONS are configurable — notify_manager off means the manager is not told', async () => {
    const { worker, st } = build({ followUps: [fu()] }, { actions: ['notify_owner'] });
    await worker.sweepEscalations(await worker.policy());
    expect(st.notifications.map((n) => n.user_id)).toEqual([3]);
    expect(st.leads[100]).toBeUndefined();             // flag_lead was not in `actions`
  });

  it('reassign_to_manager moves BOTH the follow-up and the lead, and tells the manager', async () => {
    const { worker, st } = build(
      { followUps: [fu()] },
      { actions: ['notify_manager', 'reassign_to_manager'] },
    );
    await worker.sweepEscalations(await worker.policy());
    expect(st.followUps[0].owner_id).toBe(9);
    expect(st.leads[100].owner_id).toBe(9);
    expect(st.notifications.some((n) => n.user_id === 9 && n.type === 'assignment')).toBe(true);
  });

  it('escalation can REPEAT when the policy says so (max_levels + repeat_every_minutes)', async () => {
    const { worker, st } = build(
      { followUps: [fu({ scheduled_at: mins(-500) })] },
      { max_levels: 3, repeat_every_minutes: 0 },
    );
    const p = await worker.policy();
    // repeat_every_minutes = 0 means "once per level"; with max_levels 3 and an
    // escalated_at already set, the next sweep must NOT fire (no repeat window).
    expect(await worker.sweepEscalations(p)).toBe(1);
    expect(await worker.sweepEscalations(p)).toBe(0);
    expect(st.followUps[0].escalation_level).toBe(1);
  });

  it('escalation is disabled entirely when the policy says enabled: false', async () => {
    const { worker, st } = build({ followUps: [fu()] }, { enabled: false });
    const res = await worker.tick();
    expect(res.escalations).toBe(0);
    expect(res.reminders).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });

  it('a notifier failure ROLLS THE CLAIM BACK — the escalation is retried, never swallowed', async () => {
    const { db, st } = makeSprint3Db({ followUps: [fu()] });
    const settings = settingsWith({});
    const broken = {
      notify: async () => { throw new Error('bell is down'); },
      notifyMany: async () => { throw new Error('bell is down'); },
    } as unknown as NotifierService;
    const worker = new ReminderWorker(db, settings, broken, managersReturning([9]), noScoring());
    await expect(worker.sweepEscalations(await worker.policy())).rejects.toThrow('bell is down');
    expect(st.rollbacks).toBe(1);
    expect(st.followUps[0].escalated_at).toBeNull();   // the claim was rolled back
    expect(st.followUps[0].escalation_level).toBe(0);
  });
});

/* ============================ 3. SLA BREACH ============================ */

describe('SLA breach detection', () => {
  it('an unsatisfied clock past its due time breaches, flags the lead, and notifies owner + manager', async () => {
    const { worker, st } = build({ slas: [sla()] });
    expect(await worker.sweepSlaBreaches()).toBe(1);
    expect(st.slas[0].breached_at).not.toBeNull();
    expect(st.notifications.map((n) => n.user_id).sort()).toEqual([3, 9]);
    expect(st.notifications[0]).toMatchObject({ type: 'sla_breach', severity: 'error' });
    expect(st.leads[100].is_flagged).toBe(true);
    expect(st.audit).toEqual([{ action: 'sla_breach', entity_id: 100 }]);
  });

  it('a SATISFIED clock never breaches, however old', async () => {
    const { worker, st } = build({ slas: [sla({ due_at: mins(-5000), satisfied_at: mins(-4999) })] });
    expect(await worker.sweepSlaBreaches()).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });

  it('a clock that is NOT yet due does not breach', async () => {
    const { worker, st } = build({ slas: [sla({ due_at: mins(30) })] });
    expect(await worker.sweepSlaBreaches()).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });

  it('escalate_after_minutes DELAYS the notification (the breach is not announced early)', async () => {
    // 30 min past due, but the policy waits 60 min before shouting
    const { worker, st } = build({ slas: [sla({ due_at: mins(-30), escalate_after_minutes: 60 })] });
    expect(await worker.sweepSlaBreaches()).toBe(0);
    expect(st.notifications).toHaveLength(0);
  });

  it('NOTIFIES EXACTLY ONCE across repeated ticks', async () => {
    const { worker, st } = build({ slas: [sla()] });
    expect(await worker.sweepSlaBreaches()).toBe(1);
    expect(await worker.sweepSlaBreaches()).toBe(0);
    expect(await worker.sweepSlaBreaches()).toBe(0);
    expect(st.notifications).toHaveLength(2);          // owner + manager, once
    expect(st.audit).toHaveLength(1);
  });

  it('notify_manager = false keeps the breach between the system and the owner', async () => {
    const { worker, st } = build({ slas: [sla({ notify_manager: false })] });
    await worker.sweepSlaBreaches();
    expect(st.notifications.map((n) => n.user_id)).toEqual([3]);
  });

  it('an UNASSIGNED lead still breaches (and still tells the manager)', async () => {
    const { worker, st } = build({ slas: [sla({ owner_id: null })] });
    expect(await worker.sweepSlaBreaches()).toBe(1);
    expect(st.notifications.map((n) => n.user_id)).toEqual([9]);
  });
});

describe('the tick runs all four sweeps and never throws', () => {
  it('reports what each sweep did', async () => {
    const { worker } = build({ followUps: [fu({ scheduled_at: mins(5) })], slas: [sla()] });
    const res = await worker.tick();
    expect(res).toEqual({ reminders: 1, escalations: 0, breaches: 1, rescored: 0 });
  });

  it('a failing sweep is logged, not propagated (the API must not crash on a bad tick)', async () => {
    const { db } = makeSprint3Db({});
    const boom = { get: async () => { throw new Error('settings exploded'); } } as any;
    const worker = new ReminderWorker(db, boom, {} as NotifierService, managersReturning([]), noScoring());
    await expect(worker.tick()).resolves.toEqual({ reminders: 0, escalations: 0, breaches: 0, rescored: 0 });
  });
});
