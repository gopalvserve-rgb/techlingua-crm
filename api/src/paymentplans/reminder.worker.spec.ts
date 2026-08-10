import { FeeReminderWorker, DEFAULT_FEE_REMINDER } from './reminder.worker';

/**
 * THE FEE-REMINDER SWEEP — finds due-soon/today/overdue installments, sends once per
 * (installment, offset) IDEMPOTENTLY, and DEGRADES CLEANLY when a channel has no creds.
 */
describe('specsFor — config expands to reminder specs', () => {
  it('expands due-soon offsets, due-today, and overdue offsets', () => {
    const specs = FeeReminderWorker.specsFor({ enabled: true, channels: ['sms'], due_soon_days: [3, 1], remind_on_due: true, overdue_days: [3, 7] });
    expect(specs.map((s) => s.key)).toEqual(['due_soon:3', 'due_soon:1', 'due_today', 'overdue:3', 'overdue:7']);
  });
  it('omits due-today when remind_on_due is false', () => {
    const specs = FeeReminderWorker.specsFor({ ...DEFAULT_FEE_REMINDER, remind_on_due: false, due_soon_days: [], overdue_days: [] });
    expect(specs).toHaveLength(0);
  });
});

/** A fake world: one due-today installment, a claim ledger, and a recording messaging. */
function world(opts: { queueStatus?: string } = {}) {
  const claimed = new Set<string>();
  const sent: any[] = [];
  const CANDIDATE = {
    installment_id: 77, seq_no: 2, due_date: '2026-08-10', outstanding_minor: 1500000,
    enrolment_id: 1, enrolment_no: 'ENR-1', branch_id: 9, vertical_id: 1,
    lead_id: 31, student_name: 'Asha', student_phone: '+919000000009', student_email: 'asha@example.com', course_name: 'IELTS',
  };
  const db = {
    async query(sql: string, params: any[]) {
      if (/FROM installment i[\s\S]*JOIN payment_plan/.test(sql)) {
        const key = String(params[1]);
        // only the due_today spec has a live candidate; and only until it is claimed
        return key === 'due_today' && !claimed.has(`77:${key}`) ? [CANDIDATE] : [];
      }
      return [];
    },
    async tx(fn: any) {
      return fn({
        async query(sql: string, params: any[]) {
          if (/INSERT INTO installment_reminder/.test(sql)) {
            const k = `${params[0]}:${params[1]}`;
            if (claimed.has(k)) return { rowCount: 0, rows: [] };
            claimed.add(k);
            return { rowCount: 1, rows: [{ id: 1 }] };
          }
          if (/UPDATE installment_reminder SET message_log_id/.test(sql)) return { rowCount: 1, rows: [] };
          return { rowCount: 0, rows: [] };
        },
      });
    },
  };
  const settings = { get: async () => ({ ...DEFAULT_FEE_REMINDER, channels: ['whatsapp', 'sms', 'email'] }) };
  const messaging = { queue: async (m: any) => { sent.push(m); return { id: 1, status: opts.queueStatus ?? 'queued' }; } };
  const w = new FeeReminderWorker(db as never, settings as never, messaging as never);
  return { w, sent, claimed };
}

describe('tick — send once, idempotent, degrade cleanly', () => {
  it('sends a due-today reminder on each configured channel the student is reachable on', async () => {
    const { w, sent } = world();
    const r = await w.tick();
    expect(r.sent).toBe(1);
    expect(sent.map((m) => m.channel).sort()).toEqual(['email', 'sms', 'whatsapp']);
    expect(sent.every((m) => m.guarded === true)).toBe(true);   // customer message: opt-out + hours honoured
    expect(sent.find((m) => m.channel === 'email').subject).toContain('ENR-1');
  });

  it('is IDEMPOTENT — a second tick sends nothing (the claim already exists)', async () => {
    const { w } = world();
    expect((await w.tick()).sent).toBe(1);
    expect((await w.tick()).sent).toBe(0);
  });

  it('DEGRADES CLEANLY — a skipped/failed queue (no creds) still counts the reminder as handled, never throws', async () => {
    const { w } = world({ queueStatus: 'skipped' });
    const r = await w.tick();
    expect(r.sent).toBe(1);   // claimed + attempted; the send log holds the skipped rows
  });
});
