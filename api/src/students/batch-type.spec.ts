import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  BatchService, normaliseClassDays, normaliseBatchType, normaliseFrequency, BATCH_TYPE_CODES,
} from './batch.service';
import { BatchController } from './batch.controller';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * BATCH TYPE + CLASS DAYS + FREQUENCY (migration 081) — the frequency→class_days derivation,
 * that create persists all three, and the type-catalog route.
 */

const scopeAll: ResolvedScope = { permissionKey: 'batch.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

/** A capturing mock DB that satisfies create()'s hierarchy + org lookups. */
function make() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM vertical/.test(sql)) return { id: 4 };
      if (/FROM m_course/.test(sql)) return { id: 5 };
      if (/FROM organisation/.test(sql)) return { id: 1 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 55 }] }; },
    }),
  } as any;
  return { svc: new BatchService(db, resolver), issued };
}

const me = { id: 9 };

describe('normaliseClassDays — frequency derives the class-day set', () => {
  it('daily -> [1..7]', () => expect(normaliseClassDays('daily', undefined)).toEqual([1, 2, 3, 4, 5, 6, 7]));
  it('weekdays -> [1..5]', () => expect(normaliseClassDays('weekdays', undefined)).toEqual([1, 2, 3, 4, 5]));
  it('weekends -> [6,7]', () => expect(normaliseClassDays('weekends', undefined)).toEqual([6, 7]));
  it('custom -> the supplied set, sanitised (dedup, sorted, 1..7 only)', () => {
    expect(normaliseClassDays('custom', [5, 1, 3, 1, 9, 0, 'x'])).toEqual([1, 3, 5]);
    expect(normaliseClassDays('custom', undefined)).toEqual([]);
  });
});

describe('normalisers fall back safely', () => {
  it('batch_type: unknown -> regular; known passes', () => {
    expect(normaliseBatchType('banana')).toBe('regular');
    expect(normaliseBatchType('weekend')).toBe('weekend');
    expect(BATCH_TYPE_CODES.length).toBe(9);
  });
  it('frequency: unknown -> custom; known passes', () => {
    expect(normaliseFrequency('banana')).toBe('custom');
    expect(normaliseFrequency('weekends')).toBe('weekends');
  });
});

describe('BatchService.create — persists batch_type + frequency + class_days', () => {
  const dto = (over: any = {}) => ({
    branch_id: 3, vertical_id: 4, course_id: 5, name: 'ZZTEST', ...over,
  });

  it('a Weekends batch derives class_days [6,7] and stores the three fields', async () => {
    const { svc, issued } = make();
    await svc.create(dto({ batch_type: 'weekend', frequency: 'weekends', class_days: [1] }), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql));
    expect(ins).toBeTruthy();
    // last three params are batch_type, frequency, class_days
    expect(ins!.params).toEqual(expect.arrayContaining(['weekend', 'weekends']));
    const days = ins!.params.find((p) => Array.isArray(p));
    expect(days).toEqual([6, 7]); // derived from frequency, NOT the supplied [1]
  });

  it('a Custom batch stores exactly the sanitised selected days', async () => {
    const { svc, issued } = make();
    await svc.create(dto({ frequency: 'custom', class_days: [1, 3, 5] }), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql));
    const days = ins!.params.find((p) => Array.isArray(p));
    expect(days).toEqual([1, 3, 5]);
  });

  it('defaults: no type/frequency -> regular / custom / empty class_days', async () => {
    const { svc, issued } = make();
    await svc.create(dto(), me, scopeAll);
    const ins = issued.find((i) => /INSERT INTO batch \(/.test(i.sql));
    expect(ins!.params).toEqual(expect.arrayContaining(['regular', 'custom']));
    expect(ins!.params.find((p) => Array.isArray(p))).toEqual([]);
  });
});

describe('BatchController — the type-catalog route', () => {
  it('GET /batches/type-catalog requires batch.read and is declared before :id', () => {
    const proto = BatchController.prototype as any;
    expect(Reflect.getMetadata(PERMISSION_KEY, proto.typeCatalog)).toBe('batch.read');
    expect(Reflect.getMetadata(PATH_METADATA, proto.typeCatalog)).toBe('type-catalog');
  });
});
