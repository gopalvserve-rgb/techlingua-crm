import { makeFakeDb, makeIngestion } from './fake-db.testkit';

/**
 * dev/95 item 1 — RETURNING STUDENT (alumni) flag.
 *
 * A NEW lead whose contact (E.164 phone / WhatsApp / alt phone, or email) matches an EXISTING
 * converted student is STILL created, but flagged is_existing_student=TRUE with a reference to
 * the matched student. Uses the same contact keys the duplicate check uses, but against the
 * STUDENTS table. A lead with no student match is created unflagged.
 */
const ctx = (over: Partial<any> = {}) => ({
  channel: 'manual' as const, campaign_id: 5, source_id: 7, actor_id: 9,
  duplicate_policy: 'always_create' as const, ...over,
});

describe('LeadIngestionService — returning-student flag', () => {
  it('flags a lead whose PHONE matches a converted student', async () => {
    const students = [{ id: 20, full_name: 'Meera Old', student_no: 'STU-0020', phone: '+919811100001', whatsapp_phone: null, alt_phone: null, email: null }];
    const { db, st } = makeFakeDb({ students });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'Meera Returns', phone: '9811100001' }, ctx());
    expect(out.status).toBe('created');
    const lead = st.leads[0];
    expect(lead.is_existing_student).toBe(true);
    expect(Number(lead.existing_student_id)).toBe(20);
  });

  it('flags a lead whose EMAIL matches a converted student (phone differs)', async () => {
    const students = [{ id: 21, full_name: 'Ravi Alum', student_no: 'STU-0021', phone: '+919999999999', whatsapp_phone: null, alt_phone: null, email: 'ravi@x.com' }];
    const { db, st } = makeFakeDb({ students });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'Ravi Again', phone: '9811100055', email: 'RAVI@x.com' }, ctx());
    expect(out.status).toBe('created');
    expect(st.leads[0].is_existing_student).toBe(true);
    expect(Number(st.leads[0].existing_student_id)).toBe(21);
  });

  it('does NOT flag a lead with no matching student', async () => {
    const students = [{ id: 22, full_name: 'Someone', student_no: 'STU-0022', phone: '+919820000000', whatsapp_phone: null, alt_phone: null, email: 'nomatch@x.com' }];
    const { db, st } = makeFakeDb({ students });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'Fresh Lead', phone: '9811100077', email: 'fresh@x.com' }, ctx());
    expect(out.status).toBe('created');
    expect(!!st.leads[0].is_existing_student).toBe(false);
    expect(st.leads[0].existing_student_id ?? null).toBeNull();
  });
});
