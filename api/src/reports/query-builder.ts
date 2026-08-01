import { BadRequestException } from '@nestjs/common';
import { ResolvedScope } from '../rbac/rbac.types';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ColType, ReportColumn, ReportEntity, columnByKey, isFilterable, isGroupable } from './entities';
import { toDateString } from '../common/date.util';

/**
 * =============================================================================
 * THE QUERY BUILDER — a PURE function from (definition, scope) to (sql, params).
 * =============================================================================
 *
 * It is pure on purpose, and that is not an aesthetic choice.
 *
 * DEF-S5-02 is the reason: the receipt-balance arithmetic lived inside a SQL string,
 * and *no unit test could ever reach it* — every fee spec drives a db double that
 * returns whatever it likes and never parses a predicate. 1047 green tests were
 * structurally incapable of noticing a false financial document. Moving the logic to
 * a pure function (`fees/as-at.ts`) is what made it testable.
 *
 * The report builder is the same shape of risk, one order of magnitude larger: this
 * is the code that decides WHICH ROWS A USER SEES. So it returns the SQL as a value.
 * `query-builder.spec.ts` asserts, on the string itself:
 *
 *   · a counsellor's scope fragment IS PRESENT in the WHERE clause;
 *   · no value from the request ever reaches the SQL text (every one is a `$n`);
 *   · an unknown column key is a 400, not a query;
 *   · `1=0` when nothing is allowed, never `1=1`.
 *
 * You can read those tests and know the rule holds. You cannot do that with a builder
 * that runs the query itself.
 */

export type FilterOp =
  | 'eq' | 'neq' | 'contains' | 'starts' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'between' | 'is_null' | 'not_null' | 'is_true' | 'is_false';

export const FILTER_OPS: Record<FilterOp, { label: string; types: ColType[]; arity: 0 | 1 | 2 }> = {
  eq:        { label: 'is',            types: ['text', 'number', 'money', 'date', 'datetime', 'bool'], arity: 1 },
  neq:       { label: 'is not',        types: ['text', 'number', 'money', 'date', 'datetime', 'bool'], arity: 1 },
  contains:  { label: 'contains',      types: ['text'], arity: 1 },
  starts:    { label: 'starts with',   types: ['text'], arity: 1 },
  in:        { label: 'is any of',     types: ['text', 'number'], arity: 1 },
  gt:        { label: 'greater than',  types: ['number', 'money', 'date', 'datetime'], arity: 1 },
  gte:       { label: 'at least',      types: ['number', 'money', 'date', 'datetime'], arity: 1 },
  lt:        { label: 'less than',     types: ['number', 'money', 'date', 'datetime'], arity: 1 },
  lte:       { label: 'at most',       types: ['number', 'money', 'date', 'datetime'], arity: 1 },
  between:   { label: 'between',       types: ['number', 'money', 'date', 'datetime'], arity: 2 },
  is_null:   { label: 'is empty',      types: ['text', 'number', 'money', 'date', 'datetime', 'bool'], arity: 0 },
  not_null:  { label: 'is not empty',  types: ['text', 'number', 'money', 'date', 'datetime', 'bool'], arity: 0 },
  is_true:   { label: 'is yes',        types: ['bool'], arity: 0 },
  is_false:  { label: 'is no',         types: ['bool'], arity: 0 },
};

export interface ReportFilter { col: string; op: FilterOp; value?: unknown; value2?: unknown }
export interface ReportSort { col: string; dir?: 'asc' | 'desc' }

export type DatePreset =
  | 'all' | 'today' | 'yesterday' | 'this_week' | 'last_7' | 'last_30' | 'this_month'
  | 'last_month' | 'this_quarter' | 'this_year' | 'custom';

export interface ReportConfig {
  columns?: string[];
  filters?: ReportFilter[];
  group_by?: string[];
  sort?: ReportSort[];
  date_field?: string;
  date_preset?: DatePreset;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  /** the output columns, in order, with the type the renderer needs */
  columns: Array<{ key: string; label: string; type: ColType; aggregate?: string }>;
  grouped: boolean;
}

export const MAX_ROWS = 50_000;
const DEFAULT_LIMIT = 500;

/* ------------------------------------------------------------------ dates */

/** A date preset -> [from, to) in ISO dates. PURE — the clock is an argument, so the
 *  tests are not flaky at midnight and "this month" means the same thing in a spec as
 *  it does at 23:59 on the 31st. */
export function presetWindow(preset: DatePreset, now: Date): [string | null, string | null] {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const at = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day));
  const Y = now.getUTCFullYear(); const M = now.getUTCMonth(); const D = now.getUTCDate();
  switch (preset) {
    case 'today':      return [d(at(Y, M, D)), d(at(Y, M, D + 1))];
    case 'yesterday':  return [d(at(Y, M, D - 1)), d(at(Y, M, D))];
    // This week — Sunday start, matching the shared front-end date-range control (daterange.tsx).
    case 'this_week':  return [d(at(Y, M, D - now.getUTCDay())), d(at(Y, M, D + 1))];
    case 'last_7':     return [d(at(Y, M, D - 6)), d(at(Y, M, D + 1))];
    case 'last_30':    return [d(at(Y, M, D - 29)), d(at(Y, M, D + 1))];
    case 'this_month': return [d(at(Y, M, 1)), d(at(Y, M + 1, 1))];
    case 'last_month': return [d(at(Y, M - 1, 1)), d(at(Y, M, 1))];
    case 'this_quarter': { const q = Math.floor(M / 3) * 3; return [d(at(Y, q, 1)), d(at(Y, q + 3, 1))]; }
    case 'this_year':  return [d(at(Y, 0, 1)), d(at(Y + 1, 0, 1))];
    case 'all':
    case 'custom':
    default:           return [null, null];
  }
}

/* ---------------------------------------------------------------- the build */

const ident = (i: number) => `c${i}`;   // output aliases we control; never client text

function requireColumn(entity: ReportEntity, key: string, what: string): ReportColumn {
  const c = columnByKey(entity, key);
  // The whole containment strategy is this line. An unknown key never becomes SQL.
  if (!c) throw new BadRequestException(`Unknown ${what} "${key}" on the "${entity.label}" report. Pick one from the column list.`);
  return c;
}

/** One filter -> a parameterised predicate. `value` is ALWAYS a `$n`. */
function filterSql(entity: ReportEntity, f: ReportFilter, params: unknown[]): string {
  const col = requireColumn(entity, f.col, 'filter column');
  if (!isFilterable(col)) throw new BadRequestException(`"${col.label}" cannot be filtered on.`);
  const spec = FILTER_OPS[f.op];
  if (!spec) throw new BadRequestException(`Unknown filter "${f.op}".`);
  if (!spec.types.includes(col.type)) {
    throw new BadRequestException(`"${spec.label}" does not apply to ${col.label} (${col.type}).`);
  }
  const sql = col.sql;   // a constant from entities.ts

  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const num = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequestException(`"${col.label}" needs a number, got "${String(v)}".`);
    // money columns are stored in PAISE and the client filters in RUPEES — the same
    // rule as every other money boundary in this app (money.util.ts).
    return col.type === 'money' ? Math.round(n * 100) : n;
  };
  const val = (v: unknown) => (col.type === 'money' || col.type === 'number' ? num(v) : v);

  switch (f.op) {
    case 'eq':       return `${sql} = ${p(val(f.value))}`;
    case 'neq':      return `(${sql} IS DISTINCT FROM ${p(val(f.value))})`;
    // ILIKE with the wildcards added to the PARAMETER, not to the SQL. `%` inside a
    // parameter is data; `%` inside the statement is a decision.
    case 'contains': return `${sql} ILIKE ${p(`%${escapeLike(String(f.value ?? ''))}%`)}`;
    case 'starts':   return `${sql} ILIKE ${p(`${escapeLike(String(f.value ?? ''))}%`)}`;
    case 'in': {
      const list = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) return '1=0';
      return `${sql}::text = ANY(${p(list.map((x) => String(x)))}::text[])`;
    }
    case 'gt':       return `${sql} > ${p(val(f.value))}`;
    case 'gte':      return `${sql} >= ${p(val(f.value))}`;
    case 'lt':       return `${sql} < ${p(val(f.value))}`;
    case 'lte':      return `${sql} <= ${p(val(f.value))}`;
    case 'between':  return `${sql} BETWEEN ${p(val(f.value))} AND ${p(val(f.value2))}`;
    case 'is_null':  return `${sql} IS NULL`;
    case 'not_null': return `${sql} IS NOT NULL`;
    case 'is_true':  return `${sql} IS TRUE`;
    case 'is_false': return `(${sql} IS NOT TRUE)`;
    default:         throw new BadRequestException(`Unknown filter "${String(f.op)}".`);
  }
}

/** LIKE metacharacters in a user's search text are DATA. Escaping them is why searching
 *  for "50%" finds "50%" and not every row in the table. */
const escapeLike = (s: string) => s.replace(/([\\%_])/g, '\\$1');

/**
 * BUILD. Returns the statement and its parameters; runs nothing.
 *
 * @param scope  the RUNNER's resolved scope for `entity.permission`. Resolved fresh on
 *               every run — never stored on the definition, never inherited from whoever
 *               saved or shared it.
 */
export function buildReportQuery(
  entity: ReportEntity,
  config: ReportConfig,
  scope: ResolvedScope,
  resolver: ScopeResolverService,
  now: Date = new Date(),
): BuiltQuery {
  const params: unknown[] = [];

  /* -------- SCOPE FIRST. Not last, not "if". First. -------- */
  // buildScopeWhere returns '1=0' when the permission is not held or when no filter
  // maps to a column of this entity. It NEVER opens up. If this line is wrong, nothing
  // downstream can save us — which is why it is one call to the one shared function
  // the lead list, the dashboard and PerformanceService all use, and not SQL written
  // here for reports.
  const scopeWhere = resolver.buildScopeWhere(scope, entity.scopeCols, params);

  /* -------- columns -------- */
  const wanted = (config.columns?.length ? config.columns : entity.defaultColumns);
  const cols = wanted.map((k) => requireColumn(entity, k, 'column'));
  if (!cols.length) throw new BadRequestException('A report needs at least one column.');

  const groupKeys = config.group_by ?? [];
  const groupCols = groupKeys.map((k) => {
    const c = requireColumn(entity, k, 'group-by column');
    if (!isGroupable(c)) throw new BadRequestException(`"${c.label}" cannot be grouped on — it is a measure, not a category.`);
    return c;
  });
  const grouped = groupCols.length > 0;

  /* -------- SELECT -------- */
  const out: BuiltQuery['columns'] = [];
  const selects: string[] = [];

  if (grouped) {
    // A grouped report is: the group columns, a row count, and the SUM/AVG of every
    // selected measure. Anything selected that is neither is silently meaningless in a
    // GROUP BY, so it is DROPPED rather than wrapped in min()/max() — a report that
    // shows "the alphabetically-first phone number in this branch" is worse than one
    // that does not show a phone number at all.
    groupCols.forEach((c, i) => {
      selects.push(`${c.sql} AS ${ident(i)}`);
      out.push({ key: c.key, label: c.label, type: c.type });
    });
    selects.push(`count(*)::bigint AS ${ident(out.length)}`);
    out.push({ key: '_count', label: 'Count', type: 'number', aggregate: 'count' });
    for (const c of cols) {
      if (groupCols.some((g) => g.key === c.key)) continue;
      if (!c.aggregate || c.aggregate === 'count') continue;
      const fn = c.aggregate === 'avg' ? 'avg' : 'sum';
      const cast = c.aggregate === 'avg' ? '::numeric' : '::bigint';
      selects.push(`COALESCE(${fn}(${c.sql})${cast}, 0) AS ${ident(out.length)}`);
      out.push({ key: c.key, label: `${c.label} (${fn === 'avg' ? 'avg' : 'total'})`, type: c.type, aggregate: fn });
    }
  } else {
    cols.forEach((c, i) => {
      selects.push(`${c.sql} AS ${ident(i)}`);
      out.push({ key: c.key, label: c.label, type: c.type });
    });
  }

  /* -------- WHERE -------- */
  const where: string[] = [...entity.where, scopeWhere];

  // the date window
  const dateKey = config.date_field ?? entity.defaultDateField;
  if (config.date_preset && config.date_preset !== 'all') {
    const dc = requireColumn(entity, dateKey, 'date field');
    if (!entity.dateFields.includes(dateKey)) {
      throw new BadRequestException(`"${dc.label}" is not a date window on this report.`);
    }
    let from: string | null; let to: string | null;
    if (config.date_preset === 'custom') {
      from = toDateString(config.date_from) ?? null;
      to = toDateString(config.date_to) ?? null;
      // `to` is INCLUSIVE for a human ("1st to 31st") and EXCLUSIVE in SQL, or the
      // 31st's rows vanish. Adding a day here is the difference between a report the
      // client trusts and one he corrects by hand every month.
      if (to) { const t = new Date(`${to}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); to = t.toISOString().slice(0, 10); }
    } else {
      [from, to] = presetWindow(config.date_preset, now);
    }
    // ::date casts spelled out — the Sprint-3 `$3`-cast lesson: an inferred parameter
    // type is a live-only failure that every double passes.
    if (from) { params.push(from); where.push(`${dc.sql} >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`${dc.sql} < $${params.length}::date`); }
  }

  for (const f of config.filters ?? []) where.push(filterSql(entity, f, params));

  /* -------- ORDER BY -------- */
  const orderParts: string[] = [];
  for (const s of config.sort ?? []) {
    const c = requireColumn(entity, s.col, 'sort column');
    // In a grouped report you may only order by something that is IN the result.
    if (grouped && !groupCols.some((g) => g.key === c.key) && !c.aggregate) continue;
    // `dir` is not client text in the statement — it is matched to one of two literals.
    const dir = String(s.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const expr = grouped && c.aggregate ? `${c.aggregate === 'avg' ? 'avg' : 'sum'}(${c.sql})` : c.sql;
    orderParts.push(`${expr} ${dir} NULLS LAST`);
  }
  if (!orderParts.length) {
    orderParts.push(grouped ? `count(*) DESC` : `${cols[0].sql} ASC NULLS LAST`);
  }

  const limit = Math.min(Math.max(1, Number(config.limit) || DEFAULT_LIMIT), MAX_ROWS);

  const sql = `SELECT ${selects.join(',\n       ')}
  FROM ${entity.from}
 WHERE ${where.join('\n   AND ')}
${grouped ? ` GROUP BY ${groupCols.map((c) => c.sql).join(', ')}\n` : ''} ORDER BY ${orderParts.join(', ')}
 LIMIT ${limit}`;

  return { sql, params, columns: out, grouped };
}

/** Map a raw pg row (aliased c0, c1 …) onto the report's own column keys. */
export const shapeRow = (row: Record<string, unknown>, columns: BuiltQuery['columns']) =>
  columns.map((_, i) => row[ident(i)] ?? null);
