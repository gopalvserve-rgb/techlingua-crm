import { BadRequestException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * ATTENDANCE ↔ CLASS DAYS (migration 081). A batch with a non-empty class_days set only meets on
 * those ISO weekdays; a session on any other weekday is a 400 that names the day. An EMPTY set
 * (legacy) is unrestricted. Reference dates: 2026-08-17 = Monday(1), 2026-08-15 = Saturday(6).
 */

const scopeAll: ResolvedScope = { permissionKey: 'attendance.mark', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

function make(classDays: number[]) {
  const db = {
    one: async (sql: string) => {
      if (/FROM batch bt/.test(sql)) return { id: 1, name: 'ZZTEST', branch_id: 3, vertical_id: 4, class_days: classDays };
      if (/FROM organisation/.test(sql)) return { id: 1 };
      return null;
    },
    query: async () => [],
    tx: async (fn: any) => fn({ query: async () => ({ rowCount: 1, rows: [] }) }),
  } as any;
  return new AttendanceService(db, resolver);
}

const me = { id: 9 };
const entries = [{ student_id: 100, status: 'present' }];

describe('AttendanceService.mark — class-day enforcement', () => {
  it('a WEEKEND batch [6,7] rejects a Monday session with a 400 naming the day', async () => {
    const svc = make([6, 7]);
    await expect(svc.mark({ batch_id: 1, date: '2026-08-17', entries }, me, scopeAll))
      .rejects.toThrow(/Monday is not a class day for this batch/);
  });

  it('the same batch ACCEPTS a Saturday session (a class day)', async () => {
    const svc = make([6, 7]);
    const res = await svc.mark({ batch_id: 1, date: '2026-08-15', entries }, me, scopeAll);
    expect(res.marked).toBe(1);
  });

  it('an EMPTY class_days set (legacy) is unrestricted — any weekday is fine', async () => {
    const svc = make([]);
    const res = await svc.mark({ batch_id: 1, date: '2026-08-17', entries }, me, scopeAll);
    expect(res.marked).toBe(1);
  });

  it('the 400 is a BadRequestException', async () => {
    const svc = make([1, 2, 3, 4, 5]); // weekdays
    await expect(svc.mark({ batch_id: 1, date: '2026-08-15', entries }, me, scopeAll))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
