import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from './rbac.decorators';
import { PERMISSION_CATALOG } from './permission-catalog';
import { ReportController } from '../reports/report.controller';
import { WorkspaceController } from '../workspace/workspace.controller';

/**
 * RBAC ON EVERY SPRINT-6 ENDPOINT — the same mechanical check as Sprints 3, 4 and 5.
 *
 * A route that forgets @RequirePermission has no `request.scope`. In this module that is
 * not a 500: ReportService would receive `undefined` and — depending on the call — either
 * throw or fall open. THE REPORT BUILDER IS THE ONE PLACE IN THIS APP WHERE FALLING OPEN
 * MEANS "here is every lead in the company as a spreadsheet". So the decorator is checked
 * by walking the real controller prototypes, and it cannot go stale.
 */

const CONTROLLERS = [
  ['ReportController', ReportController],
  ['WorkspaceController', WorkspaceController],
] as const;

interface Route { controller: string; handler: string; permission?: string; public: boolean }

function routesOf(name: string, ctrl: new (...a: any[]) => unknown): Route[] {
  const proto = ctrl.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((m) => m !== 'constructor' && typeof proto[m] === 'function')
    .filter((m) => Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined
      || Reflect.getMetadata(PATH_METADATA, proto[m]) !== undefined)
    .map((m) => ({
      controller: name,
      handler: m,
      permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
      public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
    }));
}

const ALL = CONTROLLERS.flatMap(([n, c]) => routesOf(n, c as new (...a: any[]) => unknown));
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
const SQL: string = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '031_sprint6.sql'), 'utf8');
const granted = (perm: string, role: string) =>
  new RegExp(`'${perm.replace('.', '\\.')}'\\s*,\\s*'${role}'`).test(SQL);
const grantedScope = (perm: string, role: string, scope: string) =>
  new RegExp(`'${perm.replace('.', '\\.')}'\\s*,\\s*'${role}',\\s*'${scope}'`).test(SQL);

describe('Sprint-6 RBAC coverage', () => {
  it('found every Sprint-6 route (the reflection actually works)', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(30);
    for (const [name] of CONTROLLERS) expect(ALL.some((r) => r.controller === name)).toBe(true);
  });

  it('EVERY route requires a permission — none is unguarded', () => {
    expect(ALL.filter((r) => !r.permission && !r.public).map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('NOTHING in Sprint 6 is public — a report endpoint returns whatever the caller can see, and an anonymous caller can see nothing', () => {
    expect(ALL.filter((r) => r.public).map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('every permission a route names exists in the catalog (no typo grants access)', () => {
    expect(ALL.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission))
      .map((r) => `${r.controller}.${r.handler} -> ${r.permission}`)).toEqual([]);
  });

  it('migration 031 GRANTS every permission the catalog declares for Sprint 6', () => {
    const modules = ['report', 'workspace', 'kb', 'announcement'];
    const keys = PERMISSION_CATALOG.filter((m) => modules.includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`));
    expect(keys.length).toBeGreaterThanOrEqual(13);
    // A permission that exists but is granted to nobody is a screen nobody can open —
    // which is exactly how `report.read` sat dead from Sprint 1 to Sprint 6.
    expect(keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(SQL))).toEqual([]);
  });
});

describe('separation of duties', () => {
  /**
   * BUILDING a report for yourself is a counsellor's business — his scope does the
   * limiting. SHARING puts a definition in somebody else's list. SCHEDULING puts a FILE
   * IN AN INBOX on a timer, rendered in the scheduler's scope. The last two are the ones
   * that move data between people, so they are a manager's decision.
   */
  it('a Counsellor may build, run and export — but NOT share or schedule', () => {
    expect(granted('report.create', 'Counsellor')).toBe(true);
    expect(granted('report.export', 'Counsellor')).toBe(true);
    expect(granted('report.share', 'Counsellor')).toBe(false);
    expect(granted('report.schedule', 'Counsellor')).toBe(false);
    expect(granted('report.schedule', 'Telecaller')).toBe(false);
    expect(granted('report.schedule', 'Branch Manager')).toBe(true);
  });

  it('every counsellor-facing report permission is scoped `own`, never `all`', () => {
    for (const p of ['report.read', 'report.create', 'report.update', 'report.delete', 'report.export']) {
      expect({ p, own: grantedScope(p, 'Counsellor', 'own') }).toEqual({ p, own: true });
      expect({ p, all: grantedScope(p, 'Counsellor', 'all') }).toEqual({ p, all: false });
    }
  });

  it('only managers manage the KB and announcements — anyone may read them', () => {
    expect(granted('kb.read', 'Counsellor')).toBe(true);
    expect(granted('kb.manage', 'Counsellor')).toBe(false);
    expect(granted('kb.manage', 'Team Leader')).toBe(false);
    expect(granted('kb.manage', 'Branch Manager')).toBe(true);
    expect(granted('announcement.read', 'Telecaller')).toBe(true);
    expect(granted('announcement.manage', 'Counsellor')).toBe(false);
    expect(granted('announcement.manage', 'Branch Manager')).toBe(true);
  });

  it('a Counsellor may POST in the workspace but not create channels', () => {
    expect(granted('workspace.post', 'Counsellor')).toBe(true);
    expect(granted('workspace.manage', 'Counsellor')).toBe(false);
    expect(granted('workspace.manage', 'Branch Manager')).toBe(true);
  });

  /**
   * Deleting your OWN message is guarded by `workspace.post`, and the SERVICE decides
   * whether this person may delete this message. Guarding the route with
   * `workspace.manage` would stop a counsellor removing his own typo — a rule that reads
   * as "safer" and is just annoying.
   */
  it('deleting a message needs only `workspace.post` — the service checks authorship', () => {
    const del = ALL.find((r) => r.controller === 'WorkspaceController' && r.handler === 'deleteMessage');
    expect(del?.permission).toBe('workspace.post');
  });

  it('the announcement AUTHOR view needs `announcement.manage`, the reader view does not', () => {
    expect(ALL.find((r) => r.handler === 'announcementsAdmin')?.permission).toBe('announcement.manage');
    expect(ALL.find((r) => r.handler === 'announcements')?.permission).toBe('announcement.read');
  });

  it('the export DOWNLOAD needs report.export (a file of scoped rows is not a public URL)', () => {
    expect(ALL.find((r) => r.handler === 'download')?.permission).toBe('report.export');
    expect(ALL.find((r) => r.handler === 'exportStatus')?.permission).toBe('report.export');
  });

  it('"Send now" needs report.schedule — it emails real people', () => {
    expect(ALL.find((r) => r.handler === 'runNow')?.permission).toBe('report.schedule');
  });

  /** A Telecaller works his own leads. He must not be able to build a report on the
   *  fee ledger — and the entity registry enforces it too (he has no `fee.read`), but
   *  the grant table is where a reviewer looks first. */
  it('a Telecaller gets reports at `own` scope and nothing wider', () => {
    expect(grantedScope('report.read', 'Telecaller', 'own')).toBe(true);
    expect(granted('report.create', 'Telecaller')).toBe(false);
  });
});
