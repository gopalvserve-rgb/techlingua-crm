import { SupportService } from './support.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * SUPPORT & TICKETS — unit coverage for the lifecycle, RBAC scope fragment, SLA config,
 * assignee-active guard, comments and soft-delete. The SQL-computed SLA breach itself is
 * proven by the live smoke (a db double cannot evaluate `now() > created_at + interval`).
 */

const scopeAll: ResolvedScope = { permissionKey: 'ticket.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeBranch = (b: number): ResolvedScope => ({ permissionKey: 'ticket.read', allowed: true, all: false, filters: [{ kind: 'branch', branchId: b }], allowedFields: null, deniedFields: [] });
const scopeOwn = (u: number): ResolvedScope => ({ permissionKey: 'ticket.read', allowed: true, all: false, filters: [{ kind: 'own', userId: u }], allowedFields: null, deniedFields: [] });

function make(opts: { ticket?: any; activeUser?: boolean; list?: any[] } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/status = 'active'/.test(sql)) return opts.activeUser ? { id: (params as any)[0] } : null;
      if (/FROM support_ticket t/.test(sql)) return opts.ticket ?? null;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM support_ticket_comment/.test(sql)) return [];
      if (/FROM support_ticket t/.test(sql)) return opts.list ?? [];
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/RETURNING id/.test(sql)) return { rows: [{ id: 501 }] };
        return { rows: [] };
      },
    }),
  };
  const numbering = { allocate: async () => 'SUP-0001' };
  const settings = { get: async (_k: string, fb: any) => fb };
  const notifier = { notify: async () => undefined, notifyMany: async () => undefined };
  const svc = new SupportService(db as never, {} as never, numbering as never, notifier as never, settings as never);
  return { svc, issued };
}

const TICKET = (over: any = {}) => ({
  id: 77, org_id: 1, ticket_no: 'SUP-0001', subject: 'Projector down', status: 'open',
  priority: 'high', category: 'Technical', branch_id: 9, vertical_id: 1,
  assignee_id: null, created_by: 9, first_response_at: null, ...over,
});

describe('SupportService — create', () => {
  it('assigns a SUP number and defaults to status open', async () => {
    const { svc } = make();
    const out = await svc.create({ subject: 'Login broken', priority: 'medium', branch_id: 9 }, { id: 5 }, scopeAll);
    expect(out.ticket_no).toBe('SUP-0001');
    expect(out.status).toBe('open');
    expect(out.id).toBe(501);
  });

  it('refuses an empty subject', async () => {
    const { svc } = make();
    await expect(svc.create({ subject: '  ' }, { id: 5 }, scopeAll)).rejects.toThrow(/subject/i);
  });

  it('refuses an invalid priority', async () => {
    const { svc } = make();
    await expect(svc.create({ subject: 'x', priority: 'meltdown' }, { id: 5 }, scopeAll)).rejects.toThrow(/priority/i);
  });
});

describe('SupportService — lifecycle transitions', () => {
  it('allows open -> in_progress and stamps first response', async () => {
    const { svc, issued } = make({ ticket: TICKET({ status: 'open' }) });
    const r = await svc.transition(77, { status: 'in_progress' }, { id: 3 }, scopeAll);
    expect(r.status).toBe('in_progress');
    const upd = issued.find((q) => /UPDATE support_ticket/.test(q.sql) && /first_response_at/.test(q.sql));
    expect(upd).toBeTruthy();
    expect((upd!.params as any)[1]).toBe('in_progress');
  });

  it('allows in_progress -> resolved -> closed', async () => {
    const a = make({ ticket: TICKET({ status: 'in_progress' }) });
    expect((await a.svc.transition(77, { status: 'resolved' }, { id: 3 }, scopeAll)).status).toBe('resolved');
    const b = make({ ticket: TICKET({ status: 'resolved' }) });
    expect((await b.svc.transition(77, { status: 'closed' }, { id: 3 }, scopeAll)).status).toBe('closed');
  });

  it('reopens a closed ticket back to in_progress', async () => {
    const { svc } = make({ ticket: TICKET({ status: 'closed' }) });
    const r = await svc.transition(77, { status: 'in_progress' }, { id: 3 }, scopeAll);
    expect(r.status).toBe('in_progress');
    expect(r.reopened).toBe(true);
  });

  it('REJECTS an illegal jump open -> closed', async () => {
    const { svc } = make({ ticket: TICKET({ status: 'open' }) });
    await expect(svc.transition(77, { status: 'closed' }, { id: 3 }, scopeAll)).rejects.toThrow(/cannot move/i);
  });

  it('rejects an unknown status', async () => {
    const { svc } = make({ ticket: TICKET({ status: 'open' }) });
    await expect(svc.transition(77, { status: 'frozen' }, { id: 3 }, scopeAll)).rejects.toThrow(/Unknown status/i);
  });
});

describe('SupportService — comments', () => {
  it('adds a comment and records first response when the author is not the reporter', async () => {
    const { svc, issued } = make({ ticket: TICKET({ created_by: 9, first_response_at: null, status: 'open' }) });
    await svc.addComment(77, { body: 'On it' }, { id: 3 }, scopeAll);
    const ins = issued.find((q) => /INSERT INTO support_ticket_comment/.test(q.sql));
    expect(ins).toBeTruthy();
    const fr = issued.find((q) => /UPDATE support_ticket SET first_response_at/.test(q.sql));
    expect(fr).toBeTruthy();
  });

  it('refuses an empty comment', async () => {
    const { svc } = make({ ticket: TICKET() });
    await expect(svc.addComment(77, { body: '   ' }, { id: 3 }, scopeAll)).rejects.toThrow(/empty/i);
  });
});

describe('SupportService — reassign guards an active user', () => {
  it('rejects a deactivated / unknown assignee (DEF-R3-01 shared guard)', async () => {
    const { svc } = make({ ticket: TICKET(), activeUser: false });
    await expect(svc.update(77, { assignee_id: 999 }, { id: 3 }, scopeAll)).rejects.toThrow(/active user/i);
  });

  it('accepts an active assignee', async () => {
    const { svc } = make({ ticket: TICKET(), activeUser: true });
    await expect(svc.update(77, { assignee_id: 4 }, { id: 3 }, scopeAll)).resolves.toEqual({ id: 77, ok: true });
  });
});

describe('SupportService — RBAC scope goes INSIDE the SQL', () => {
  it('a branch-scoped user only sees their branch', async () => {
    const { svc, issued } = make({ list: [] });
    await svc.list(scopeBranch(9), {});
    const q = issued.find((x) => /FROM support_ticket t/.test(x.sql))!;
    expect(q.sql).toMatch(/t\.branch_id = \$/);
    expect(q.params).toContain(9);
  });

  it("an own-scoped user sees tickets they RAISED or are ASSIGNED (not just created_by)", async () => {
    const { svc, issued } = make({ list: [] });
    await svc.list(scopeOwn(7), {});
    const q = issued.find((x) => /FROM support_ticket t/.test(x.sql))!;
    expect(q.sql).toMatch(/t\.created_by = \$/);
    expect(q.sql).toMatch(/OR t\.assignee_id/);
  });

  it('applies the status / priority / overdue filters', async () => {
    const { svc, issued } = make({ list: [] });
    await svc.list(scopeAll, { status: 'open', priority: 'urgent', overdue: '1' });
    const q = issued.find((x) => /FROM support_ticket t/.test(x.sql))!;
    expect(q.sql).toMatch(/t\.status IN \(/);
    expect(q.sql).toMatch(/t\.priority IN \(/);
    expect(q.sql).toMatch(/now\(\) >/);            // the SLA overdue predicate
  });
});

describe('SupportService — SLA + meta', () => {
  it('exposes the per-priority SLA targets and the lifecycle map', async () => {
    const { svc } = make();
    const m = await svc.meta();
    expect(m.sla.urgent.resolution).toBe(240);
    expect(m.transitions.resolved).toContain('closed');
    expect(m.priorities.map((p) => p.key)).toEqual(['low', 'medium', 'high', 'urgent']);
  });
});

describe('SupportService — soft delete', () => {
  it('marks deleted_at rather than hard-deleting', async () => {
    const { svc, issued } = make({ ticket: TICKET() });
    await svc.remove(77, { id: 3 }, scopeAll);
    const del = issued.find((q) => /UPDATE support_ticket SET deleted_at/.test(q.sql));
    expect(del).toBeTruthy();
  });
});

/* --------------------------------------------------------------------------
 * Guard coverage — every SupportController route carries @RequirePermission,
 * and every permission it names exists in the catalog (a typo'd permission key
 * would silently grant access to nobody / everybody).
 * ------------------------------------------------------------------------ */
import 'reflect-metadata';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { SupportController } from './support.controller';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';

describe('SupportController — every route is guarded', () => {
  const proto: any = SupportController.prototype;
  const handlers = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function');
  const catalogKeys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));

  it('found the routes', () => { expect(handlers.length).toBeGreaterThanOrEqual(8); });

  it.each(handlers)('%s requires a permission (or is explicitly @Public)', (h) => {
    const perm = Reflect.getMetadata(PERMISSION_KEY, proto[h]) as string | undefined;
    const pub = Reflect.getMetadata(IS_PUBLIC_KEY, proto[h]) as boolean | undefined;
    expect(!!perm || !!pub).toBe(true);
    if (perm) expect(catalogKeys.has(perm)).toBe(true);
  });
});
