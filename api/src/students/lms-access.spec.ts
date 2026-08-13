import { studentLmsAccess, canViewMaterial, canAttempt, SENSITIVE_STATUSES, REVENUE_CANCELLING_STATUSES } from './lms-access';

describe('studentLmsAccess (single source of truth)', () => {
  it('maps every lifecycle status to the spec-sheet LMS access', () => {
    expect(studentLmsAccess('active')).toBe('full');
    expect(studentLmsAccess('on_hold')).toBe('limited');
    expect(studentLmsAccess('inactive')).toBe('limited');
    expect(studentLmsAccess('suspended')).toBe('none');
    expect(studentLmsAccess('withdrawn')).toBe('none');
    expect(studentLmsAccess('dropped_out')).toBe('none');
    expect(studentLmsAccess('transferred')).toBe('depends');
    expect(studentLmsAccess('completed')).toBe('alumni');
    expect(studentLmsAccess('cancelled')).toBe('none');
    expect(studentLmsAccess('failed')).toBe('none');
    expect(studentLmsAccess('course_expired')).toBe('none');
    expect(studentLmsAccess(undefined)).toBe('full'); // default
  });

  it('FULL/DEPENDS may attempt; LIMITED/ALUMNI may view but not attempt; NONE neither', () => {
    // attempts
    expect(canAttempt(studentLmsAccess('active'))).toBe(true);
    expect(canAttempt(studentLmsAccess('transferred'))).toBe(true);
    expect(canAttempt(studentLmsAccess('on_hold'))).toBe(false);
    expect(canAttempt(studentLmsAccess('inactive'))).toBe(false);
    expect(canAttempt(studentLmsAccess('completed'))).toBe(false);
    expect(canAttempt(studentLmsAccess('suspended'))).toBe(false);
    // material
    expect(canViewMaterial(studentLmsAccess('on_hold'))).toBe(true);
    expect(canViewMaterial(studentLmsAccess('completed'))).toBe(true);
    expect(canViewMaterial(studentLmsAccess('suspended'))).toBe(false);
    expect(canViewMaterial(studentLmsAccess('cancelled'))).toBe(false);
  });

  it('sensitive + revenue-cancelling sets are exactly as designed', () => {
    expect([...SENSITIVE_STATUSES].sort()).toEqual(['cancelled', 'dropped_out', 'on_hold', 'suspended', 'withdrawn']);
    expect([...REVENUE_CANCELLING_STATUSES].sort()).toEqual(['cancelled', 'dropped_out', 'withdrawn']);
  });
});
