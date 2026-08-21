import { FeeService } from './fee.service';

/**
 * dev/116 — Fee Receipt row actions: Email / WhatsApp DEGRADE CLEANLY when the channel is
 * unconfigured (a failed/not_configured send-log row, never a throw); Send-for-approval sets
 * pending_approval and Approve clears it, via the reusable content-approval workflow.
 */

const RECEIPT = {
  id: 55, receipt_no: 'RCP-2026/0055', amount_minor: 500000, mode: 'cash', reference: null,
  received_at: '2026-08-01T00:00:00.000Z', note: null, enrolment_id: 5, net_fee_minor: 4500000,
  lead_id: 31, student_name: 'ZZTEST Student', student_phone: '9990001111', student_email: 'zz@example.com',
  course_name: 'IELTS', received_by_name: 'Clerk', branch_id: 9, vertical_id: 1,
  branch_name: 'HSR', vertical_name: 'IELTS', org_name: 'Tech Lingua', org_gst: null,
  branch_address: 'x', branch_phone: '1', branch_email: 'b@e.com',
};

function build(opts: { sendStatus?: string; sendReason?: string; email?: string; phone?: string } = {}) {
  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM fee_receipt fr/.test(sql)) return { ...RECEIPT, student_email: opts.email ?? RECEIPT.student_email, student_phone: opts.phone ?? RECEIPT.student_phone };
      return null;
    },
    query: async () => [],
    tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocate: async () => 'X' };
  const sent: any[] = [];
  const messaging = { sendNow: async (m: any) => { sent.push(m); return { id: 7, status: opts.sendStatus ?? 'failed', reason: opts.sendReason ?? 'not configured' }; } };
  const approvals = {
    submitted: [] as number[], approved: [] as number[],
    submit: async (_t: string, id: number) => { approvals.submitted.push(id); return { workflow_status: 'pending_approval' }; },
    approve: async (_t: string, id: number) => { approvals.approved.push(id); return { workflow_status: 'published' }; },
    reject: async () => ({ workflow_status: 'changes_requested' }),
  };
  const svc = new FeeService(db as never, resolver as never, numbering as never, undefined, undefined, undefined, messaging as never, approvals as never);
  return { svc, sent, approvals };
}

describe('receipt Email / WhatsApp degrade cleanly', () => {
  it('EMAIL — unconfigured SMTP does not throw, reports not_configured, and still logs the attempt', async () => {
    const { svc, sent } = build({ sendStatus: 'failed', sendReason: 'not configured' });
    const res = await svc.emailReceipt(55, { id: 3 }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.configured).toBe(false);
    expect(res.not_configured).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('email');
  });

  it('EMAIL — a student with no email is skipped cleanly (no send, no throw)', async () => {
    const { svc, sent } = build({ email: '' as any });
    const res = await svc.emailReceipt(55, { id: 3 }, {} as never);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('no_email');
    expect(sent).toHaveLength(0);
  });

  it('WHATSAPP — unconfigured channel does not throw and reports not_configured', async () => {
    const { svc, sent } = build({ sendStatus: 'failed' });
    const res = await svc.whatsappReceipt(55, { id: 3 }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.not_configured).toBe(true);
    expect(sent[0].channel).toBe('whatsapp');
  });

  it('EMAIL — a configured SMTP reports configured:true', async () => {
    const { svc } = build({ sendStatus: 'sent' });
    const res = await svc.emailReceipt(55, { id: 3 }, {} as never);
    expect(res.configured).toBe(true);
    expect(res.not_configured).toBe(false);
  });
});

describe('receipt Send-for-approval + Approve', () => {
  it('submit sets pending_approval; approve clears it to published', async () => {
    const { svc, approvals } = build();
    const s = await svc.submitApproval(55, { id: 3 }, {} as never);
    expect(s.workflow_status).toBe('pending_approval');
    expect(approvals.submitted).toContain(55);
    const a = await svc.approveReceipt(55, { id: 9 }, {} as never);
    expect(a.workflow_status).toBe('published');
    expect(approvals.approved).toContain(55);
  });
});
