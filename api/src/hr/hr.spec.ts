import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResolvedScope } from '../rbac/rbac.types';
import { EmployeeService } from './employee.service';
import { HrAttendanceService } from './hr-attendance.service';
import { LeaveService } from './leave.service';
import { EmployeeController } from './employee.controller';
import { HrAttendanceController } from './hr-attendance.controller';
import { LeaveController } from './leave.controller';

/**
 * ERP BASIC HR (Batch 6) — unit coverage: employee CRUD + EMP- numbering + directory scope,
 * staff attendance mark + monthly summary tally, leave apply → approve deducts balance + marks
 * attendance + notifies, leave reject, a user cannot approve their own leave, RBAC census.
 */
const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: (scope: ResolvedScope) => (scope.all ? '1=1' : '1=0') };
const numbering = (map: Record<string, string> = {}) => ({ allocate: async (kind: string) => map[kind] ?? `${kind.toUpperCase()}-0001` });

describe('EmployeeService', () => {
  const mkDb = (cap: any[]) => ({
    one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /FROM branch/.test(sql) ? { id: 5 } : null),
    query: async (sql: string, p: unknown[]) => { cap.push({ sql, p }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, p: unknown[] = []) => {
        cap.push({ sql, p });
        if (/INSERT INTO employee/.test(sql)) return { rows: [{ id: 9 }] };
        return { rows: [] };
      },
    }),
  });
  it('mints an EMP- code from numbering and stores the record', async () => {
    const cap: any[] = [];
    const svc = new EmployeeService(mkDb(cap) as never, resolver as never, numbering({ employee: 'EMP-0001' }) as never);
    const out = await svc.create({ name: 'Asha Rao', branch_id: 5, employment_type: 'full_time', phone: '+919000000009' }, { id: 1 }, scopeAll);
    expect(out.employee_code).toBe('EMP-0001');
    const ins = cap.find((c) => /INSERT INTO employee/.test(c.sql));
    expect(ins.p).toContain('Asha Rao');
  });
  it('requires a branch and a name', async () => {
    const svc = new EmployeeService(mkDb([]) as never, resolver as never, numbering() as never);
    await expect(svc.create({ name: 'X' }, { id: 1 }, scopeAll)).rejects.toThrow(/branch/i);
    await expect(svc.create({ name: '', branch_id: 5 }, { id: 1 }, scopeAll)).rejects.toThrow(/name is required/i);
  });
});

describe('HrAttendanceService — monthly summary tally', () => {
  it('rolls up present/absent/leave into the sheet per employee', async () => {
    const recs = [
      { employee_id: 1, att_date: '2026-08-01', status: 'present' },
      { employee_id: 1, att_date: '2026-08-02', status: 'absent' },
      { employee_id: 1, att_date: '2026-08-03', status: 'leave' },
    ];
    const db = {
      one: async () => ({ id: 1 }),
      query: async (sql: string) => {
        if (/FROM employee e/.test(sql) && /ORDER BY e.name LIMIT 500/.test(sql)) return [{ id: 1, name: 'Asha', employee_code: 'EMP-0001', department: 'Sales' }];
        if (/FROM hr_attendance a/.test(sql)) return recs;
        return [];
      },
    };
    const svc = new HrAttendanceService(db as never, resolver as never);
    const out: any = await svc.sheet(scopeAll, { month: '2026-08' });
    expect(out.days_in_month).toBe(31);
    const e = out.employees[0];
    expect(e.present).toBe(1); expect(e.absent).toBe(1); expect(e.leave).toBe(1);
    expect(e.marks[1]).toBe('present'); expect(e.marks[3]).toBe('leave');
  });
  it('rejects an empty mark payload', async () => {
    const svc = new HrAttendanceService({ one: async () => ({ id: 1 }) } as never, resolver as never);
    await expect(svc.mark({ date: '2026-08-01', entries: [] }, { id: 1 }, scopeAll)).rejects.toThrow(/No attendance entries/i);
  });
});

describe('LeaveService — apply → approve → reject → self-approval guard', () => {
  const app = {
    id: 3, employee_id: 1, leave_type_id: 2, branch_id: 5, vertical_id: null, applied_by: 7,
    employee_user_id: 7, from_date: '2026-08-10', to_date: '2026-08-11', days: 2, status: 'pending',
    type_name: 'Casual Leave', type_code: 'CL',
  };
  const mkDb = (cap: any[], appRow: any = app) => ({
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM employee e/.test(sql)) return { id: 1, name: 'Asha', branch_id: 5, vertical_id: null, user_id: 7, reporting_manager_id: 2 };
      if (/FROM leave_type/.test(sql)) return { id: 2 };
      if (/FROM leave_application la/.test(sql)) return { ...appRow };
      if (/FROM employee WHERE id/.test(sql)) return { user_id: 11 };
      return null;
    },
    query: async (sql: string, p: unknown[]) => { cap.push({ sql, p }); if (/INSERT INTO leave_application/.test(sql)) return [{ id: 3 }]; return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, p: unknown[] = []) => { cap.push({ sql, p }); if (/UPDATE leave_application SET status = 'approved'/.test(sql)) return { rows: [{ id: 3 }] }; return { rows: [] }; } }),
  });
  const notifier = () => { const sent: any[] = []; return { svc: { notify: async (m: any) => { sent.push(m); } }, sent }; };

  it('apply notifies the reporting manager', async () => {
    const cap: any[] = []; const n = notifier();
    const svc = new LeaveService(mkDb(cap) as never, resolver as never, n.svc as never);
    const out = await svc.apply({ employee_id: 1, leave_type_id: 2, from_date: '2026-08-10', to_date: '2026-08-11' }, { id: 9 }, scopeAll);
    expect(out.status).toBe('pending'); expect(out.days).toBe(2);
    expect(n.sent.some((m) => /awaiting your approval/i.test(m.title))).toBe(true);
  });

  it('approve deducts the balance, marks attendance as leave, notifies the employee', async () => {
    const cap: any[] = []; const n = notifier();
    const svc = new LeaveService(mkDb(cap) as never, resolver as never, n.svc as never);
    const out = await svc.approve(3, { note: 'ok' }, { id: 2 }, scopeAll);
    expect(out.status).toBe('approved');
    expect(cap.some((c) => /UPDATE leave_balance SET used = used \+/.test(c.sql))).toBe(true);
    expect(cap.some((c) => /INSERT INTO hr_attendance/.test(c.sql) && /'leave'/.test(c.sql))).toBe(true);
    expect(n.sent.some((m) => /approved/i.test(m.title))).toBe(true);
  });

  it('a user CANNOT approve their own leave', async () => {
    const cap: any[] = []; const n = notifier();
    const svc = new LeaveService(mkDb(cap) as never, resolver as never, n.svc as never);
    // me.id = 7 == applied_by/employee_user_id
    await expect(svc.approve(3, {}, { id: 7 }, scopeAll)).rejects.toThrow(/cannot approve your own/i);
  });

  it('reject notifies the employee and changes no balance', async () => {
    const cap: any[] = []; const n = notifier();
    const svc = new LeaveService(mkDb(cap) as never, resolver as never, n.svc as never);
    const out = await svc.reject(3, { note: 'busy period' }, { id: 2 }, scopeAll);
    expect(out.status).toBe('rejected');
    expect(cap.some((c) => /UPDATE leave_balance/.test(c.sql))).toBe(false);
    expect(n.sent.some((m) => /rejected/i.test(m.title))).toBe(true);
  });
});

describe('HR RBAC census', () => {
  const controllers: any[] = [EmployeeController, HrAttendanceController, LeaveController];
  const catalogKeys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
  it('every route declares a permission that exists in the catalog', () => {
    for (const C of controllers) {
      const proto = C.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const isRoute = Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined;
        if (!isRoute) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, proto[name]);
        expect(perm).toBeTruthy();
        expect(catalogKeys.has(perm)).toBe(true);
      }
    }
  });
  it('catalogs the three HR modules', () => {
    for (const m of ['employee', 'hr_attendance', 'leave']) {
      expect(PERMISSION_CATALOG.some((x) => x.module === m)).toBe(true);
    }
  });
});
