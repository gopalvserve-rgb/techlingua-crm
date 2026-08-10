import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException } from '@nestjs/common';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TrainingController } from './training.controller';
import { ReleaseNoteController } from './release-note.controller';
import { TrainingService } from './training.service';
import { ReleaseNoteService } from './release-note.service';

/* --------------------------------------------------------------- RBAC census */
function routesOf(ctrl: any) {
  const proto = ctrl.prototype; const base = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
  return Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function'
    && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined).map((m) => ({
    handler: m, base,
    permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
    public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
  }));
}
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
const ALL = [TrainingController, ReleaseNoteController].flatMap(routesOf);

describe('Support extras (Training Videos + Release Notes) RBAC census', () => {
  it('every route requires a permission — none unguarded/public', () => {
    expect(ALL.filter((r) => !r.permission || r.public).map((r) => r.handler)).toEqual([]);
  });
  it('every permission a route names exists in the catalog', () => {
    expect(ALL.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission!)).map((r) => r.permission)).toEqual([]);
  });
  it('reads are *.view, writes are *.manage', () => {
    const t = ALL.filter((r) => r.base === 'training-videos');
    expect(t.filter((r) => ['list', 'categories'].includes(r.handler)).every((r) => r.permission === 'training.view')).toBe(true);
    expect(t.filter((r) => ['create', 'update', 'remove', 'bulkDelete', 'bulkImpact'].includes(r.handler)).every((r) => r.permission === 'training.manage')).toBe(true);
    const rn = ALL.filter((r) => r.base === 'release-notes');
    expect(rn.filter((r) => ['list', 'feed'].includes(r.handler)).every((r) => r.permission === 'release_note.view')).toBe(true);
    expect(rn.filter((r) => ['create', 'update', 'remove', 'bulkDelete', 'bulkImpact'].includes(r.handler)).every((r) => r.permission === 'release_note.manage')).toBe(true);
  });
  it('migration 053 seeds + grants every training. / release_note. permission the catalog declares', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '053_erp_support_extras.sql'), 'utf8');
    const keys = PERMISSION_CATALOG.filter((m) => ['training', 'release_note'].includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`));
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
  });
});

/* ---------------------------------------------------------- mock db harness */
function mockDb(rows: any) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db: any = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM training_video t\b/.test(sql)) return rows.trainingRow ?? null;
      if (/FROM release_note r\b/.test(sql)) return rows.releaseRow ?? null;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/INSERT INTO/.test(sql)) return [{ id: 42 }];
      if (/DISTINCT category/.test(sql)) return [{ category: 'Onboarding' }, { category: 'Sales' }];
      return rows.list ?? [];
    },
    issued,
  };
  return db;
}

/* -------------------------------------------------------------- TrainingService */
describe('TrainingService', () => {
  it('create rejects a missing title', async () => {
    const svc = new TrainingService(mockDb({}));
    await expect(svc.create({ video_url: 'https://y' }, { id: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create rejects a missing video URL', async () => {
    const svc = new TrainingService(mockDb({}));
    await expect(svc.create({ title: 'Intro' }, { id: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create inserts and returns the new id', async () => {
    const svc = new TrainingService(mockDb({}));
    await expect(svc.create({ title: 'Intro', video_url: 'https://youtu.be/x', category: 'Onboarding' }, { id: 1 }))
      .resolves.toEqual({ id: 42 });
  });
  it('list filters by category / active / q / date and caps the limit', async () => {
    const db = mockDb({ list: [{ id: 1, title: 'A', active: true }] });
    const svc = new TrainingService(db);
    const out = await svc.list({ category: 'Onboarding', active: 'true', q: 'intro', from: '2026-01-01', to: '2026-12-31', limit: 9999 });
    expect(out).toHaveLength(1);
    const call = db.issued.find((c: any) => /FROM training_video t/.test(c.sql) && !/DISTINCT/.test(c.sql));
    expect(call.sql).toMatch(/t\.category IN \(/);
    expect(call.sql).toMatch(/t\.active = /);
    expect(call.sql).toMatch(/ILIKE/);
    expect(call.params[call.params.length - 1]).toBe(1000); // limit capped
  });
  it('categories returns the distinct in-use list', async () => {
    const svc = new TrainingService(mockDb({}));
    await expect(svc.categories()).resolves.toEqual(['Onboarding', 'Sales']);
  });
  it('bulkImpact reports in/out of scope counts', async () => {
    const db = mockDb({ list: [{ id: 1 }, { id: 2 }] });
    const svc = new TrainingService(db);
    const out = await svc.bulkImpact([1, 2, 3]);
    expect(out).toMatchObject({ entity: 'training_video', requested: 3, in_scope: 2, out_of_scope: 1 });
  });
});

/* ------------------------------------------------------------ ReleaseNoteService */
describe('ReleaseNoteService', () => {
  it('create rejects a missing title', async () => {
    const svc = new ReleaseNoteService(mockDb({}));
    await expect(svc.create({ notes: 'x' }, { id: 1 })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('create defaults an unknown category to feature and inserts', async () => {
    const db = mockDb({});
    const svc = new ReleaseNoteService(db);
    await expect(svc.create({ title: 'v2', category: 'bogus' }, { id: 1 })).resolves.toEqual({ id: 42 });
    const ins = db.issued.find((c: any) => /INSERT INTO release_note/.test(c.sql));
    expect(ins.params).toContain('feature');
  });
  it('feed reads active notes newest-first and caps the limit', async () => {
    const db = mockDb({ list: [{ id: 9, title: 'New', category: 'feature' }] });
    const svc = new ReleaseNoteService(db);
    const out = await svc.feed(9999);
    expect(out).toHaveLength(1);
    const call = db.issued.find((c: any) => /FROM release_note r/.test(c.sql));
    expect(call.sql).toMatch(/active = TRUE/);
    expect(call.sql).toMatch(/ORDER BY r\.release_date DESC/);
    expect(call.params[0]).toBe(100); // limit capped
  });
  it('update rejects an invalid category', async () => {
    const svc = new ReleaseNoteService(mockDb({ releaseRow: { id: 1, title: 'x' } }));
    await expect(svc.update(1, { category: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
