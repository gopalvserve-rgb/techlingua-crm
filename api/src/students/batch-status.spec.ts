import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BatchService, deriveBatchStatus, BATCH_MANUAL_STATUSES } from './batch.service';
import { BatchController } from './batch.controller';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * BATCH STATUS LIFECYCLE (migration 080) — the derivation rule, manual-sticky vs auto re-derive,
 * suspend→resume, the change-status permission gate + scope, and the list status filter.
 */

const scopeAll: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeOwn: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: false, filters: [{ kind: 'own', userId: 7 }], allowedFields: null, deniedFields: [] };

const resolver = {
  buildScopeWhere: (scope: ResolvedScope, _cols: any, _params: unknown[]) => (scope.all ? '1=1' : '1=0'),
} as any;

/** A capturing mock DB. `batchRow` is what get()'s SELECT returns (null => out of scope). */
function make(opts: { batchRow?: any } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM batch_status_def WHERE code/.test(sql)) {
        const code = String(params[0]);
        const manual = BATCH_MANUAL_STATUSES.has(code);
        const known = ['upcoming', 'active', 'completed', 'cancelled', 'expired', 'archived', 'suspended'].includes(code);
        return known ? { code, label: code[0].toUpperCase() + code.slice(1), meaning: 'x', is_manual: manual, is_terminal: false } : null;
      }
      if (/FROM batch bt/.test(sql)) return opts.batchRow === undefined ? null : opts.batchRow;
      if (/count\(\*\).*FROM student/.test(sql)) return { n: 0 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 55 }] }; },
    }),
  } as any;
  const svc = new BatchService(db, resolver);
  return { svc, issued };
}

const me = { id: 9 };

describe('deriveBatchStatus (IST date derivation)', () => {
  it('before start_date -> upcoming', () => {
    expect(deriveBatchStatus('2026-09-01', '2026-12-01', '2026-08-15')).toBe('upcoming');
  });
  it('within start..end -> active', () => {
    expect(deriveBatchStatus('2026-08-01', '2026-12-01', '2026-08-15')).toBe('active');
    expect(deriveBatchStatus('2026-08-15', '2026-08-15', '2026-08-15')).toBe('active'); // boundary inclusive
  });
  it('after end_date -> expired', () => {
    expect(deriveBatchStatus('2026-01-01', '2026-06-30', '2026-08-15')).toBe('expired');
  });
  it('only a start date, already passed -> active', () => {
    expect(deriveBatchStatus('2026-08-01', null, '2026-08-15')).toBe('active');
  });
  it('no dates -> null (caller keeps stored value)', () => {
    expect(deriveBatchStatus(null, null, '2026-08-15')).toBeNull();
  });
});

describe('BatchService.changeStatus', () => {
  const baseBatch = (over: any = {}) => ({
    id: 55, status: 'active', status_is_manual: false, branch_id: 3, vertical_id: 4,
    start_date: '2026-08-01', end_date: '2026-12-01', ...over,
  });

  it('a MANUAL status (completed) sticks — status_is_manual becomes TRUE', async () => {
    const { svc, issued } = make({ batchRow: baseBatch() });
    const res = await svc.changeStatus(55, { to_status: 'completed' }, me, scopeAll);
    expect(res.to_status).toBe('completed');
    expect(res.status_is_manual).toBe(true);
    const upd = issued.find((i) => /UPDATE batch SET status = \$2, status_is_manual = \$3/.test(i.sql));
    expect(upd).toBeTruthy();
    expect(upd!.params[1]).toBe('completed');
    expect(upd!.params[2]).toBe(true); // pinned manual
    expect(issued.some((i) => /INSERT INTO batch_status_history/.test(i.sql))).toBe(true);
  });

  it('suspend then RESUME (to active) clears the manual pin and re-derives from dates', async () => {
    // suspend
    const s1 = make({ batchRow: baseBatch() });
    const r1 = await s1.svc.changeStatus(55, { to_status: 'suspended', reason: 'trainer leave' }, me, scopeAll);
    expect(r1.to_status).toBe('suspended');
    expect(r1.status_is_manual).toBe(true);

    // resume: the batch is now suspended+manual; asking for 'active' re-derives (today within window -> active)
    const s2 = make({ batchRow: baseBatch({ status: 'suspended', status_is_manual: true }) });
    const r2 = await s2.svc.changeStatus(55, { to_status: 'active' }, me, scopeAll);
    expect(r2.status_is_manual).toBe(false);           // pin cleared
    expect(r2.resumed).toBe(true);
    expect(['upcoming', 'active', 'expired']).toContain(r2.to_status); // a derived value
    const upd = s2.issued.find((i) => /UPDATE batch SET status = \$2/.test(i.sql));
    expect(upd!.params[2]).toBe(false);                // not manual anymore
  });

  it('resuming a suspended batch whose window is in the FUTURE re-derives to upcoming', async () => {
    const { svc } = make({ batchRow: baseBatch({ status: 'suspended', status_is_manual: true, start_date: '2099-01-01', end_date: '2099-06-01' }) });
    const res = await svc.changeStatus(55, { to_status: 'active' }, me, scopeAll);
    expect(res.to_status).toBe('upcoming');
    expect(res.status_is_manual).toBe(false);
  });

  it('is idempotent — no real change returns unchanged:true and writes no history', async () => {
    const { svc, issued } = make({ batchRow: baseBatch({ status: 'active', status_is_manual: false }) });
    const res = await svc.changeStatus(55, { to_status: 'active' }, me, scopeAll);
    expect(res.unchanged).toBe(true);
    expect(issued.some((i) => /INSERT INTO batch_status_history/.test(i.sql))).toBe(false);
  });

  it('rejects an unknown status with 400', async () => {
    const { svc } = make({ batchRow: baseBatch() });
    await expect(svc.changeStatus(55, { to_status: 'banana' }, me, scopeAll)).rejects.toThrow(/Unknown status/);
  });

  it('is scope-enforced — an out-of-scope batch is a 404 (never mutated)', async () => {
    const { svc } = make({ batchRow: null });
    await expect(svc.changeStatus(55, { to_status: 'completed' }, me, scopeOwn)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BatchService.list — status filter', () => {
  it('narrows on the status codes (multi-select), honouring only the 7 valid codes', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { status: 'active,upcoming,banana' });
    const sel = issued.find((i) => /FROM batch bt/.test(i.sql) && /ORDER BY/.test(i.sql));
    expect(sel).toBeTruthy();
    expect(sel!.sql).toMatch(/bt\.status = ANY\(\$\d+::varchar\[\]\)/);
    // banana dropped; active + upcoming kept
    expect(sel!.params.some((p) => Array.isArray(p) && (p as string[]).length === 2 && (p as string[]).includes('active') && (p as string[]).includes('upcoming'))).toBe(true);
    // an opportunistic refresh sweep runs before the list
    expect(issued.some((i) => /UPDATE batch bt SET status/.test(i.sql))).toBe(true);
  });

  it('with no status filter, no status predicate is added', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, {});
    const sel = issued.find((i) => /FROM batch bt/.test(i.sql) && /ORDER BY/.test(i.sql));
    expect(sel!.sql).not.toMatch(/bt\.status = ANY/);
  });
});

describe('BatchController — the change-status route is permission-gated', () => {
  it('POST /batches/:id/status requires batch.update (403 without it)', () => {
    const proto = BatchController.prototype as any;
    const perm = Reflect.getMetadata(PERMISSION_KEY, proto.changeStatus);
    expect(perm).toBe('batch.update');
    const path = Reflect.getMetadata(PATH_METADATA, proto.changeStatus);
    const method = Reflect.getMetadata(METHOD_METADATA, proto.changeStatus);
    expect(path).toBe(':id/status');
    expect(method).toBe(1); // RequestMethod.POST
  });

  it('the status-catalog + history reads require batch.read', () => {
    const proto = BatchController.prototype as any;
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.statusCatalog)).toBe('batch.read');
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.statusHistory)).toBe('batch.read');
    // the literal status-catalog route is declared BEFORE :id so it is not shadowed
    expect(Reflect.getMetadata(PATH_METADATA, proto.statusCatalog)).toBe('status-catalog');
  });
});
