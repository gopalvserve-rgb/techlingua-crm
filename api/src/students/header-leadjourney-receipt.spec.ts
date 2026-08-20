import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * dev/108 — student-profile header (admission-derived Branch › Vertical), the Lead Journey
 * aggregate, and the enrolment number carried on each fee receipt.
 *
 * These drive a hand-rolled db double: `one`/`query` route by a regex on the SQL, so the
 * assertions are about the SERVICE's derivation logic (which branch/vertical wins the header,
 * that receipts carry enrolment_no, that a lead-less student yields the empty journey) rather
 * than about the database.
 */

const scopeAll: ResolvedScope = {
  permissionKey: 'student.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};
const resolver = { buildScopeWhere: () => '1=1' };
const numbering = {} as never;

/** The stored student — its branch/vertical came from the LEAD (Vikaspuri › INSTA), stale. */
const STUDENT = (over: any = {}) => ({
  id: 20, org_id: 1, full_name: 'Aniket', customer_no: 'VP001-2026-020', lead_id: 10,
  branch_id: 9, branch_name: 'Vikaspuri', vertical_id: 3, vertical_name: 'INSTA',
  course_id: 100, course_name: 'French A1', status: 'active', ...over,
});

/** The ADMISSION enrolment — a DIFFERENT vertical (Vikaspuri › BCL › Spanish). */
const ENROL = (over: any = {}) => ({
  id: 900, enrolment_no: 'BCL1-2026-004', status: 'active', course_status: 'active',
  net_fee_minor: 45000, branch_id: 9, branch_name: 'Vikaspuri',
  vertical_id: 7, vertical_name: 'BCL', course_id: 200, course_name: 'Spanish A1', ...over,
});

function makeProfile(opts: { student?: any; enrolments?: any[]; receipts?: any[] } = {}) {
  const db = {
    one: async (sql: string) => {
      if (/FROM student s/.test(sql)) return opts.student === null ? null : (opts.student ?? STUDENT());
      if (/FROM attendance WHERE student_id/.test(sql)) return { total: 0 };
      if (/FROM student_document/.test(sql)) return null;
      return null;
    },
    query: async (sql: string) => {
      if (/FROM enrolment e/.test(sql)) return opts.enrolments ?? [ENROL()];
      if (/FROM fee_receipt fr/.test(sql)) return opts.receipts ?? [];
      return [];
    },
  };
  const svc = new StudentService(db as never, resolver as never, numbering);
  return svc;
}

describe('StudentService.profile — admission-derived header (dev/108 #1)', () => {
  it('header Branch/Vertical comes from the enrolment, NOT the stale lead vertical', async () => {
    const svc = makeProfile();
    const out: any = await svc.profile(20, scopeAll);
    // lead vertical was INSTA; the enrolment is BCL — the header must read the enrolment's.
    expect(out.student.admission_vertical_name).toBe('BCL');
    expect(out.student.admission_branch_name).toBe('Vikaspuri');
    expect(out.student.admission_vertical_id).toBe(7);
    // the stale stored (lead) vertical is still present but is NOT what the header uses.
    expect(out.student.vertical_name).toBe('INSTA');
  });

  it('a cancelled enrolment is skipped in favour of the active one', async () => {
    const svc = makeProfile({
      enrolments: [ENROL({ id: 901, course_status: 'cancelled', vertical_name: 'DEAD', vertical_id: 99 }), ENROL()],
    });
    const out: any = await svc.profile(20, scopeAll);
    expect(out.student.admission_vertical_name).toBe('BCL');
  });

  it('falls back to the stored branch/vertical when there is no enrolment', async () => {
    const svc = makeProfile({ enrolments: [] });
    const out: any = await svc.profile(20, scopeAll);
    expect(out.student.admission_vertical_name).toBe('INSTA');
    expect(out.student.admission_vertical_count).toBe(0);
  });
});

describe('StudentService.profile — receipts carry enrolment_no (dev/108 #3)', () => {
  it('each receipt row includes its course-code enrolment number', async () => {
    const svc = makeProfile({
      receipts: [{ id: 5, receipt_no: 'RCPT-1', amount_minor: 10000, enrolment_no: 'BCL1-2026-004' }],
    });
    const out: any = await svc.profile(20, scopeAll);
    expect(out.fees.receipts[0].enrolment_no).toBe('BCL1-2026-004');
  });
});

function makeJourney(opts: { student?: any; lead?: any; activities?: any[]; followUps?: any[] } = {}) {
  const db = {
    one: async (sql: string) => {
      if (/FROM student s/.test(sql)) return opts.student ?? STUDENT();
      if (/FROM lead l/.test(sql)) return opts.lead === undefined ? { id: 10, full_name: 'Aniket', branch_name: 'Vikaspuri', vertical_name: 'INSTA', pipeline_name: 'Admissions', campaign_name: 'Meta' } : opts.lead;
      return null;
    },
    query: async (sql: string) => {
      if (/FROM lead_activity a/.test(sql)) return opts.activities ?? [{ id: 1, type: 'created', occurred_at: '2026-01-01' }];
      if (/FROM follow_up f/.test(sql)) return opts.followUps ?? [];
      return [];
    },
  };
  return new StudentService(db as never, resolver as never, numbering);
}

describe('StudentService.leadJourney (dev/108 #2)', () => {
  it('returns the originating lead + its activity timeline', async () => {
    const svc = makeJourney();
    const out: any = await svc.leadJourney(20, scopeAll);
    expect(out.lead.id).toBe(10);
    expect(out.lead.path).toContain('Vikaspuri');
    expect(out.activities.length).toBe(1);
  });

  it('empty state when the student has no originating lead', async () => {
    const svc = makeJourney({ student: STUDENT({ lead_id: null }) });
    const out: any = await svc.leadJourney(20, scopeAll);
    expect(out.lead).toBeNull();
    expect(out.activities).toEqual([]);
  });

  it('empty state when the originating lead was hard-deleted', async () => {
    const svc = makeJourney({ lead: null });
    const out: any = await svc.leadJourney(20, scopeAll);
    expect(out.lead).toBeNull();
  });
});
