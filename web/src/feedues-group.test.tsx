import { describe, expect, it } from 'vitest';
import { groupDuesByEnrolment } from './paymentplans';
import { targetAchievement } from './targetincentive';

/** Client 31 Oct (12): a student with 3 instalments due showed 3 times in Fee Management. */
describe('groupDuesByEnrolment', () => {
  const inst = (enrolment_id: number, seq_no: number, due_date: string, outstanding_minor: number, overdue_days = 0, bucket = 'not_due') =>
    ({ enrolment_id, seq_no, due_date, outstanding_minor, overdue_days, bucket, student_name: `S${enrolment_id}` });

  it('one row per enrolment: next due instalment, total still due, worst ageing', () => {
    const rows = groupDuesByEnrolment([
      inst(3, 3, '2027-01-02', 683_400),
      inst(3, 1, '2026-11-02', 683_300, 2, 'b_0_30'),
      inst(3, 2, '2026-12-02', 683_300),
      inst(4, 1, '2026-12-01', 100_000),
    ]);
    expect(rows).toHaveLength(2);
    const r3 = rows.find((r) => r.enrolment_id === 3)!;
    expect(r3.due_count).toBe(3);
    expect(r3.seq_no).toBe(1);
    expect(r3.due_date).toBe('2026-11-02');
    expect(r3.outstanding_minor).toBe(2_050_000);
    expect(r3.overdue_days).toBe(2);
    expect(r3.bucket).toBe('b_0_30');
    expect(rows.find((r) => r.enrolment_id === 4)!.due_count).toBe(1);
  });
});

/** Client 31 Oct (7): the dashboard's achievement averages only the metrics a target sets. */
describe('targetAchievement', () => {
  it('ignores metrics with no target and caps each at 100%', () => {
    expect(targetAchievement({
      targets: { admissions: 2, revenue_minor: 100, collection_minor: 0 },
      pct: { admissions: 50, revenue: 150, collection: 0 },
    })).toBe(75);
    expect(targetAchievement({ targets: {}, pct: {} })).toBe(0);
  });
});
