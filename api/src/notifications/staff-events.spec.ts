import { StaffEventsService, StaffRule } from './staff-events.service';

/** Client 11 Nov 2026 — Notification Settings: recipients, delay, once-only, hierarchy escalation. */
const rule = (o: Partial<StaffRule> = {}): StaffRule => ({
  event_key: 'lead_assigned', module: 'CRM', name: 'Lead Assigned', message: 'New lead assigned', timing_kind: 'instant',
  sort_order: 1, enabled: true, in_app: true, toast: true, sound: true, desktop: false, email: false, whatsapp: false,
  priority: 'high', delay_minutes: 0, notify_owner: true, role_ids: [], escalate: false, escalate_after_minutes: 30,
  escalate_levels: 1, ...o,
});

function harness(r: StaffRule, opts: { roleUsers?: number[]; reportTo?: Record<number, number>; modules?: Record<string, boolean>; read?: boolean } = {}) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  const sent = new Set<string>();
  let nid = 100;
  const queue: any[] = [];
  const db: any = {
    query: jest.fn(async (sql: string, p: unknown[] = []) => {
      calls.push({ sql, p });
      if (sql.includes('FROM staff_notif_rule')) return [r];
      if (sql.includes('INSERT INTO staff_notif_sent')) {
        const k = String(p[0]); if (sent.has(k)) return []; sent.add(k); return [{ dedupe_key: k }];
      }
      if (sql.includes('FROM user_assignment a') && sql.includes('role_id = ANY')) return (opts.roleUsers ?? []).map((id) => ({ id }));
      if (sql.includes('FROM organisation')) return [{ id: 1 }];
      if (sql.includes('INSERT INTO notification')) return [{ id: ++nid }];
      if (sql.includes('INSERT INTO staff_notif_queue')) { queue.push({ id: queue.length + 1, sql, p }); return []; }
      if (sql.includes('FROM staff_notif_queue WHERE sent_at IS NULL')) {
        return queue.filter((q) => !q.done).map((q) => ({
          id: q.id, event_key: q.p[0], user_id: q.p[1], level: q.sql.includes('parent_notification_id') ? q.p[2] : 0,
          payload: JSON.parse(String(q.sql.includes('parent_notification_id') ? q.p[4] : q.p[3])),
          parent_notification_id: q.sql.includes('parent_notification_id') ? q.p[5] : null, cond: q.sql.includes('parent_notification_id') ? q.p[6] : q.p[4],
        }));
      }
      if (sql.startsWith('UPDATE staff_notif_queue SET sent_at')) { const q = queue.find((x) => x.id === Number(p[0])); if (!q || q.done) return []; q.done = true; return [{ id: q.id }]; }
      return [];
    }),
    one: jest.fn(async (sql: string, p: unknown[] = []) => {
      if (sql.includes('report_to_id')) { const m = opts.reportTo?.[Number(p[0])]; return m ? { report_to_id: m } : null; }
      if (sql.includes('SELECT read_at FROM notification')) return { read_at: opts.read ? new Date().toISOString() : null };
      if (sql.includes('SELECT name FROM "user"')) return { name: `User ${p[0]}` };
      return null;
    }),
  };
  const settings: any = { get: jest.fn(async (_k: string, d: any) => ({ ...d, ...(opts.modules ? { modules: { ...d.modules, ...opts.modules } } : {}) })), set: jest.fn() };
  const svc = new StaffEventsService(db, settings);
  const bells = () => calls.filter((c) => c.sql.includes('INSERT INTO notification')).map((c) => ({ user: c.p[1], title: c.p[3], meta: JSON.parse(String(c.p[7])), priority: c.p[8] }));
  return { svc, calls, bells, queue };
}

describe('staff notification settings', () => {
  it('notifies the owner + role holders, never the actor, with the rule priority and pop-up/sound flags', async () => {
    const h = harness(rule({ role_ids: [7] }), { roleUsers: [21, 22, 5] });
    const n = await h.svc.emit('lead_assigned', { owner_id: 9, actor_id: 5, title: 'New lead assigned to you', lead_id: 3, branch_id: 1 });
    expect(n).toBe(3);
    expect(h.bells().map((b) => b.user).sort()).toEqual([21, 22, 9]);
    expect(h.bells()[0]).toMatchObject({ priority: 'high', meta: { toast: true, sound: true, desktop: false, event_key: 'lead_assigned' } });
  });

  it('a switched-off event or module sends nothing', async () => {
    expect(await harness(rule({ enabled: false })).svc.emit('lead_assigned', { owner_id: 9 })).toBe(0);
    expect(await harness(rule(), { modules: { CRM: false } }).svc.emit('lead_assigned', { owner_id: 9 })).toBe(0);
  });

  it('a delay queues the send instead of delivering now', async () => {
    const h = harness(rule({ delay_minutes: 15 }));
    await h.svc.emit('lead_assigned', { owner_id: 9 });
    expect(h.bells()).toEqual([]);
    expect(h.queue).toHaveLength(1);
    expect(h.queue[0].p[2]).toBe('15');
    await h.svc.processQueue();
    expect(h.bells().map((b) => b.user)).toEqual([9]);
  });

  it('a dedupe key fires once only', async () => {
    const h = harness(rule());
    await h.svc.emit('lead_assigned', { owner_id: 9, dedupe: 'inst:1' });
    await h.svc.emit('lead_assigned', { owner_id: 9, dedupe: 'inst:1' });
    expect(h.bells()).toHaveLength(1);
  });

  it('escalates up the Reports-To chain level by level while unread, then stops', async () => {
    const h = harness(rule({ escalate: true, escalate_levels: 2 }), { reportTo: { 9: 40, 40: 50 } });
    await h.svc.emit('lead_assigned', { owner_id: 9, title: 'Lead X' });
    expect(h.queue).toHaveLength(1);                       // level 1 scheduled for the owner
    await h.svc.processQueue();                              // level 1 → owner's manager (40)
    await h.svc.processQueue();                              // level 2 → manager's manager (50)
    await h.svc.processQueue();                              // no level 3 (levels = 2)
    const b = h.bells();
    expect(b.map((x) => x.user)).toEqual([9, 40, 50]);
    expect(b[1].title).toMatch(/^Escalation \(level 1\) — Lead X/);
    expect(b[2].title).toMatch(/^Escalation \(level 2\) — Lead X/);
  });

  it('does not escalate once the notification was opened', async () => {
    const h = harness(rule({ escalate: true }), { reportTo: { 9: 40 }, read: true });
    await h.svc.emit('lead_assigned', { owner_id: 9 });
    await h.svc.processQueue();
    expect(h.bells().map((x) => x.user)).toEqual([9]);
  });
});
