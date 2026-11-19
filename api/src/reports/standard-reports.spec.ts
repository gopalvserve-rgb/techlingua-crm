import { readFileSync } from 'fs';
import { join } from 'path';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { REPORT_ENTITIES, entityByKey } from './entities';
import { buildReportQuery } from './query-builder';

/**
 * Client 12 Nov 2026 — Analytics & Reports. The ready-made reports seeded by migration 135 and
 * the eight new data sources. Every seeded config must BUILD (every key exists, every filter op
 * fits its column type), and every new entity must keep a counsellor to their own rows.
 */
const resolver = new ScopeResolverService();
const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({ allowed: true, all: false, filters: [], ...over } as ResolvedScope);
const ADMIN = scope({ all: true });
const OWN = scope({ filters: [{ kind: 'own', userId: 3 } as any] });

const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '135_standard_reports.sql'), 'utf8');
const seeded = [...sql.matchAll(/\('([^']+)',\s*'[^']*',\s*'([a-z_]+)',\s*'(\{[^']+\})'\)/g)]
  .map((m) => ({ name: m[1], entity: m[2], config: JSON.parse(m[3]) }));

describe('standard reports (migration 135)', () => {
  it('seeds at least ten ready-made reports', () => {
    expect(seeded.length).toBeGreaterThanOrEqual(10);
  });

  it.each(seeded.map((r) => [r.name, r]))('"%s" builds against its entity', (_n, r: any) => {
    const e = entityByKey(r.entity);
    expect(e).toBeTruthy();
    const q = buildReportQuery(e!, r.config, ADMIN, resolver);
    expect(q.sql).toContain('SELECT');
    if (r.config.chart) {
      // a chart is only drawn for a grouped report, and its measure must be an output column
      expect(q.grouped).toBe(true);
      expect(q.columns.map((c) => c.key)).toContain(r.config.chart.measure ?? '_count');
    }
  });
});

describe('the eight new data sources', () => {
  const NEW = ['calls', 'students', 'fee_dues', 'invoices', 'refunds', 'attendance', 'batches', 'walk_ins'];

  it('are all registered', () => {
    expect(NEW.every((k) => REPORT_ENTITIES.some((e) => e.key === k))).toBe(true);
  });

  it.each(NEW)('%s: default columns build, and an "own" scope narrows the WHERE', (k) => {
    const e = entityByKey(k)!;
    const q = buildReportQuery(e, { columns: e.defaultColumns, date_preset: 'all' }, OWN, resolver);
    // the owner column (when the entity has one) is in the WHERE, never a widened 1=1
    if (e.scopeCols.owner) expect(q.sql).toContain(`${e.scopeCols.owner} = $`);
    else expect(q.sql).toContain('1=0');
    expect(q.sql).not.toMatch(/WHERE[\s\S]*\b1=1\b/);
  });

  it('every default column and date field is a real column of its entity', () => {
    for (const k of NEW) {
      const e = entityByKey(k)!;
      for (const c of [...e.defaultColumns, ...e.dateFields, e.defaultDateField]) {
        expect({ k, c, ok: e.columns.some((x) => x.key === c) }).toEqual({ k, c, ok: true });
      }
    }
  });
});
