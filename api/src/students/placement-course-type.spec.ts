/**
 * dev/122 — STUDENT PLACEMENT COURSE TYPE. The student add/edit form persists a
 * course-type preference (placement_course_type) via the same profilePairs mapper the
 * create + update paths share. This proves the column/value pair is emitted on save
 * and cleared to NULL when blank.
 */
import { StudentService } from './student.service';

const svc = () => new StudentService({} as never, {} as never, {} as never);
const pairs = (dto: any): Array<[string, unknown]> => (svc() as any).profilePairs(dto);
const get = (ps: Array<[string, unknown]>, col: string) => ps.find(([c]) => c === col)?.[1];

describe('profilePairs persists placement_course_type', () => {
  it('stores the chosen course-type label', () => {
    const ps = pairs({ placement_course_type: 'Diploma' });
    expect(ps.some(([c]) => c === 'placement_course_type')).toBe(true);
    expect(get(ps, 'placement_course_type')).toBe('Diploma');
  });

  it('clears to null when blank', () => {
    const ps = pairs({ placement_course_type: '' });
    expect(get(ps, 'placement_course_type')).toBeNull();
  });

  it('omits the column entirely when the key is absent (partial edit)', () => {
    const ps = pairs({ full_name: 'ZZTEST Only' });
    expect(ps.some(([c]) => c === 'placement_course_type')).toBe(false);
  });
});
