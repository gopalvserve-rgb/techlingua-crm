import { DuesService } from './dues.service';
import { DEFAULT_FEE_REMINDER } from './reminder.worker';

/**
 * MANUAL FEE REMINDER (client feedback item 5) — POST /fee-dues/remind.
 * Scope-enforced, IDEMPOTENT per enrolment per IST day, and DEGRADES CLEANLY when a
 * channel has no credentials (a failed/not_configured log row, never a throw).
 */

const ENR = {
  id: 5, enrolment_no: 'ENR-2026/0005', net_fee_minor: 2000000, branch_id: 9, vertical_id: 1,
  lead_id: 31, student_name: 'Asha', student_phone: '+919000000009', student_email: 'asha@example.com',
  course_name: 'IELTS', paid_minor: 500000,
};

/** A fake world: the enrolment lookup, a manual-reminder claim ledger, a recording messaging. */
function world(opts: { paid_minor?: number; channels?: string[]; found?: boolean; queueStatus?: string } = {}) {
  const claimed = new Set<string>();
  const sent: any[] = [];
  const enr = { ...ENR, paid_minor: opts.paid_minor ?? ENR.paid_minor };
  const db = {
    async query(sql: string) {
      if (/FROM enrolment e/.test(sql)) return opts.found === false ? [] : [enr];
      return [];
    },
    async tx(fn: any) {
      return fn({
        async query(sql: string, params: any[]) {
          if (/INSERT INTO fee_manual_reminder/.test(sql)) {
            const k = `${params[0]}`; // by enrolment (one IST day in the test window)
            if (claimed.has(k)) return { rowCount: 0, rows: [] };
            claimed.add(k);
            return { rowCount: 1, rows: [{ id: 42 }] };
          }
          if (/UPDATE fee_manual_reminder/.test(sql)) return { rowCount: 1, rows: [] };
          return { rowCount: 0, rows: [] };
        },
      });
    },
  };
  const resolver = { buildScopeWhere: () => 'TRUE' };
  const settings = { get: async () => ({ ...DEFAULT_FEE_REMINDER, channels: opts.channels ?? ['whatsapp', 'sms', 'email'] }) };
  const messaging = { queue: async (m: any) => { sent.push(m); return { id: 1, status: opts.queueStatus ?? 'queued' }; } };
  const svc = new DuesService(db as never, resolver as never, messaging as never, settings as never);
  return { svc, sent, claimed };
}

const SCOPE = {} as never;
const ME = { id: 7, name: 'Clerk' };

describe('DuesService.remind', () => {
  it('sends a reminder on every configured channel the student is reachable on', async () => {
    const { svc, sent } = world();
    const r = await svc.remind(SCOPE, 5, ME);
    expect(r.sent).toBe(3);
    expect(r.already).toBe(false);
    expect(sent.map((m) => m.channel).sort()).toEqual(['email', 'sms', 'whatsapp']);
    // every send is guarded (honours opt-out / business hours), carries the branch+vertical.
    expect(sent.every((m) => m.guarded === true && m.branch_id === 9 && m.vertical_id === 1)).toBe(true);
  });

  it('is idempotent — a second call the same IST day sends nothing', async () => {
    const { svc, sent } = world();
    const first = await svc.remind(SCOPE, 5, ME);
    const second = await svc.remind(SCOPE, 5, ME);
    expect(first.sent).toBe(3);
    expect(second.sent).toBe(0);
    expect(second.already).toBe(true);
    expect(sent).toHaveLength(3); // the second claim was a no-op
  });

  it('degrades cleanly — a not_configured channel still counts as attempted, never throws', async () => {
    const { svc, sent } = world({ queueStatus: 'not_configured' });
    const r = await svc.remind(SCOPE, 5, ME);
    expect(r.sent).toBe(3);           // queued to each channel; the log row is failed/not_configured
    expect(sent).toHaveLength(3);
  });

  it('skips when nothing is outstanding', async () => {
    const { svc, sent } = world({ paid_minor: ENR.net_fee_minor });
    const r = await svc.remind(SCOPE, 5, ME);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe('no_outstanding');
    expect(sent).toHaveLength(0);
  });

  it('404s when the enrolment is out of scope / not found', async () => {
    const { svc } = world({ found: false });
    await expect(svc.remind(SCOPE, 999, ME)).rejects.toThrow('Enrolment not found');
  });

  it('400s on a missing enrolment id', async () => {
    const { svc } = world();
    await expect(svc.remind(SCOPE, NaN, ME)).rejects.toThrow('enrolment_id is required');
  });
});
