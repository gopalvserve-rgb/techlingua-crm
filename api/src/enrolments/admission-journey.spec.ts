import { assembleAdmissionJourney } from './admission-journey.util';
import { EnrolmentService } from './enrolment.service';

/**
 * ADMISSION JOURNEY (migration 075) — the intake funnel + approval/confirmation gates.
 * Pins: derived early stages from lead/payment/invoice presence; grandfathered = admitted;
 * the approve→confirm→admit→reject transitions + their gates.
 */

/** A DatabaseService double that routes db.one/db.query/db.tx by SQL shape. */
function makeDb(opts: {
  enrol: Record<string, any>;
  payment?: { n: number; first_at?: string; total_minor?: number; first_by?: string } | null;
  invoice?: Record<string, any> | null;
  events?: any[];
}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db: any = {
    one: async (sql: string, params: unknown[] = []) => {
      if (/e\.admission_approved_at/.test(sql)) return opts.enrol;                 // util enrolment select
      if (/FROM fee_receipt/.test(sql)) {
        const p = opts.payment ?? { n: 0 };
        return { n: p.n, first_at: p.first_at ?? null, last_at: p.first_at ?? null, total_minor: p.total_minor ?? 0, first_by: p.first_by ?? null };
      }
      if (/FROM gst_invoice/.test(sql)) {
        if (/count\(\*\)/.test(sql)) return { n: opts.invoice ? 1 : 0 };
        return opts.invoice ?? null;
      }
      if (/FROM enrolment e/.test(sql)) return opts.enrol;                          // admissionRow scoped select
      return null;
    },
    query: async (sql: string) => {
      if (/FROM admission_event/.test(sql)) return opts.events ?? [];
      return [];
    },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [] }; } }),
  };
  return { db, issued };
}

const resolver = { buildScopeWhere: () => '1=1' } as any;
function svc(db: any) { return new EnrolmentService(db, resolver, {} as never, {} as never, undefined); }

const CAPS = { canApprove: true, canUpdate: true };

describe('assembleAdmissionJourney — stage derivation', () => {
  it('a fresh enrolment with lead+payment+invoice sits at invoiced, awaiting approval', async () => {
    const { db } = makeDb({
      enrol: { id: 5, enrolment_no: 'ENR-1', course_id: 9, lead_id: 3, student_profile_id: 7,
        created_at: '2026-08-01', admission_stage: 'course_selected', lead_name: 'Asha', lead_source: 'Website' },
      payment: { n: 1, first_at: '2026-08-02', total_minor: 1500000, first_by: 'Counsellor' },
      invoice: { invoice_no: 'INV-1', invoice_date: '2026-08-02', total_minor: 3000000, issued_by: 'Admin' },
    });
    const j = (await assembleAdmissionJourney(db, 5, { ...CAPS, withEvents: false }))!;
    expect(j.current_stage).toBe('approved');
    const by = Object.fromEntries(j.stages.map((s) => [s.stage, s.status]));
    expect(by.lead).toBe('done');
    expect(by.course_selected).toBe('done');
    expect(by.payment_received).toBe('done');
    expect(by.invoiced).toBe('done');
    expect(by.approved).toBe('current');
    expect(j.next.action).toBe('approve');
    expect(j.next.can).toBe(true);           // canApprove + payment&invoice present
  });

  it('no payment/invoice → approve is blocked with a reason', async () => {
    const { db } = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', lead_id: 3, admission_stage: 'course_selected', created_at: '2026-08-01' } });
    const j = (await assembleAdmissionJourney(db, 5, { ...CAPS, withEvents: false }))!;
    expect(j.current_stage).toBe('payment_received');
    expect(j.next.action).toBe('approve');
    expect(j.next.can).toBe(false);
    expect(j.next.reason).toMatch(/payment and an invoice/i);
  });

  it('a grandfathered enrolment reads admitted (all stages done)', async () => {
    const { db } = makeDb({
      enrol: { id: 1, enrolment_no: 'ENR-OLD', lead_id: 3, admission_stage: 'admitted', created_at: '2025-01-01', admitted_at: '2025-01-01' },
      payment: { n: 1, total_minor: 100 }, invoice: { invoice_no: 'INV-9' },
    });
    const j = (await assembleAdmissionJourney(db, 1, { ...CAPS, withEvents: false }))!;
    expect(j.is_admitted).toBe(true);
    expect(j.stages.every((s) => s.status === 'done')).toBe(true);
    expect(j.next.action).toBeNull();
  });

  it('a rejected enrolment surfaces the reason and blocks the approval stage', async () => {
    const { db } = makeDb({
      enrol: { id: 5, enrolment_no: 'ENR-1', lead_id: 3, admission_stage: 'rejected',
        admission_rejected_reason: 'Documents incomplete', rejected_by_name: 'Manager', admission_rejected_at: '2026-08-05', created_at: '2026-08-01' },
      payment: { n: 1, total_minor: 100 }, invoice: { invoice_no: 'INV-1' },
    });
    const j = (await assembleAdmissionJourney(db, 5, { ...CAPS, withEvents: false }))!;
    expect(j.is_rejected).toBe(true);
    expect(j.rejected?.reason).toBe('Documents incomplete');
    expect(j.stages.find((s) => s.stage === 'approved')?.status).toBe('blocked');
  });
});

describe('EnrolmentService — admission transitions + gates', () => {
  const scope = {} as any;
  const me = { id: 42 };

  it('approve requires payment AND invoice (400 otherwise)', async () => {
    const { db } = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'course_selected' }, payment: { n: 0 }, invoice: null });
    await expect(svc(db).approveAdmission(5, {}, me, scope)).rejects.toThrow(/payment and an invoice/i);
  });

  it('approve from course_selected with payment+invoice → approved + writes event', async () => {
    const { db, issued } = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'course_selected' }, payment: { n: 1 }, invoice: { invoice_no: 'INV-1' } });
    const r = await svc(db).approveAdmission(5, { remarks: 'ok' }, me, scope);
    expect(r.admission_stage).toBe('approved');
    expect(issued.some((q) => /admission_stage = 'approved'/.test(q.sql))).toBe(true);
    expect(issued.some((q) => /INSERT INTO admission_event/.test(q.sql))).toBe(true);
  });

  it('confirm is only allowed from approved (else 400) and needs a method', async () => {
    const notApproved = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'course_selected' } });
    await expect(svc(notApproved.db).confirmAdmission(5, { student_confirmed_via: 'phone' }, me, scope)).rejects.toThrow(/only recorded after approval/i);
    const approved = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'approved' } });
    await expect(svc(approved.db).confirmAdmission(5, {}, me, scope)).rejects.toThrow(/method/i);
    const ok = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'approved' } });
    const r = await svc(ok.db).confirmAdmission(5, { student_confirmed_via: 'in_person', note: 'signed' }, me, scope);
    expect(r.admission_stage).toBe('student_confirmed');
  });

  // dev/84 item 5 — MANUAL confirmation override: when the student's confirmation cannot be
  // captured (technical issue), staff record student_confirmed_via='manual' + a reason; the
  // note is stored and the confirming staff user is stamped (confirmation_captured_by=me.id),
  // so the journey can advance to admit. The confirm endpoint already accepts any method.
  it('records a MANUAL confirmation with a reason + captured_by, and advances to student_confirmed', async () => {
    const ok = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'approved' } });
    const r = await svc(ok.db).confirmAdmission(5,
      { student_confirmed_via: 'manual', note: 'Confirmed manually — OTP channel down' }, me, scope);
    expect(r.admission_stage).toBe('student_confirmed');
    const upd = ok.issued.find((q) => /admission_stage = 'student_confirmed'/.test(q.sql))!;
    expect(upd).toBeTruthy();
    expect(upd.params).toEqual([5, 'manual', 'Confirmed manually — OTP channel down', 42]); // id, via, note, captured_by=me.id
    const ev = ok.issued.find((q) => /INSERT INTO admission_event/.test(q.sql))!;
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev.params)).toMatch(/manual/i);
  });

  it('admit is only allowed from student_confirmed', async () => {
    const bad = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'approved' } });
    await expect(svc(bad.db).admitAdmission(5, {}, me, scope)).rejects.toThrow(/after student confirmation/i);
    const ok = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'student_confirmed' } });
    const r = await svc(ok.db).admitAdmission(5, {}, me, scope);
    expect(r.admission_stage).toBe('admitted');
  });

  it('reject needs remarks and sets rejected', async () => {
    const noRemarks = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'invoiced' } });
    await expect(svc(noRemarks.db).rejectAdmission(5, {}, me, scope)).rejects.toThrow(/reason .*required/i);
    const ok = makeDb({ enrol: { id: 5, enrolment_no: 'ENR-1', org_id: 1, admission_stage: 'invoiced' } });
    const r = await svc(ok.db).rejectAdmission(5, { remarks: 'Fake payment' }, me, scope);
    expect(r.admission_stage).toBe('rejected');
    expect(ok.issued.some((q) => /admission_stage = 'rejected'/.test(q.sql))).toBe(true);
  });
});
