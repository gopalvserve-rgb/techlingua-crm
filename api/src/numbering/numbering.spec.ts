import { formatNumber, periodToken, NumberingService } from './numbering.service';

/** A tiny fake db that records the SQL and answers with scripted rows. */
function fakeDb(rows: Record<string, unknown[]>) {
  const seen: string[] = [];
  const pick = (sql: string): unknown[] => {
    seen.push(sql);
    for (const k of Object.keys(rows)) if (sql.includes(k)) return rows[k] as unknown[];
    return [];
  };
  return {
    seen,
    db: {
      query: async (sql: string) => pick(sql),
      one: async (sql: string) => pick(sql)[0] ?? null,
      tx: async (fn: any) => fn({ query: async (sql: string) => ({ rows: pick(sql) }) }),
    } as never,
  };
}

describe('the period token', () => {
  it('yearly embeds the calendar year; monthly embeds YYYYMM; none embeds nothing', () => {
    const d = new Date('2026-07-16T12:00:00Z');
    expect(periodToken('yearly', d)).toBe('2026');
    expect(periodToken('monthly', d)).toBe('202607');
    expect(periodToken('none', d)).toBe('');
  });
});

describe('the number format', () => {
  it('prefix + period + zero-padded counter + suffix', () => {
    expect(formatNumber({ prefix: 'QT-', suffix: '', padding: 4, token: '2026', n: 7 })).toBe('QT-2026/0007');
    expect(formatNumber({ prefix: 'RCP-', suffix: '', padding: 4, token: '', n: 1 })).toBe('RCP-0001');
    expect(formatNumber({ prefix: '', suffix: '/DEL', padding: 6, token: '', n: 42 })).toBe('000042/DEL');
    expect(formatNumber({ prefix: 'X', suffix: '', padding: 0, token: '', n: 5 })).toBe('X5');
  });

  it('a counter wider than its padding is NOT truncated — the number stays unique', () => {
    expect(formatNumber({ prefix: 'QT-', suffix: '', padding: 2, token: '', n: 12345 })).toBe('QT-12345');
  });
});

describe('allocation', () => {
  const seriesRow = {
    id: 3, kind: 'quotation', branch_id: null, vertical_id: null,
    prefix: 'QT-', suffix: '', next_number: 7, padding: 4,
    reset_period: 'yearly', period_token: '2026',
  };

  it('is ONE statement — the row lock is the mutex, not a read-modify-write', async () => {
    const { db, seen } = fakeDb({
      'FROM organisation': [{ id: 1 }],
      'FROM number_series': [seriesRow],
      'UPDATE number_series': [{ allocated: 7, prefix: 'QT-', suffix: '', padding: 4, period_token: '2026' }],
    });
    const svc = new NumberingService(db);
    const no = await svc.allocate('quotation', {}, undefined, new Date('2026-07-16T12:00:00Z'));
    expect(no).toBe('QT-2026/0007');
    // NO "SELECT ... next_number" followed by a separate "SET next_number = 8".
    const updates = seen.filter((s) => /UPDATE number_series/.test(s));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/next_number\s*=\s*CASE/);
    expect(updates[0]).toMatch(/RETURNING next_number - 1 AS allocated/);
  });

  it('resolves MOST SPECIFIC WINS — the same rule channel_config and SLA use', async () => {
    const { db, seen } = fakeDb({ 'FROM organisation': [{ id: 1 }], 'FROM number_series': [seriesRow] });
    const svc = new NumberingService(db);
    await svc.resolve('quotation', 9, 1);
    const q = seen.find((s) => /FROM number_series/.test(s))!;
    // branch+vertical beats vertical beats branch beats org-wide
    expect(q).toMatch(/ORDER BY \(branch_id IS NOT NULL\)::int \+ \(vertical_id IS NOT NULL\)::int DESC/);
    // NULL rows are the fallback and must still match
    expect(q).toMatch(/branch_id IS NULL OR branch_id = \$3::bigint/);
    // every parameter is explicitly cast — the Sprint-3 $3-cast bug was live-only
    expect(q).toMatch(/\$1::bigint/);
    expect(q).toMatch(/\$2::varchar/);
  });

  it('peek() shows the NEXT number without allocating anything', async () => {
    const { db, seen } = fakeDb({ 'FROM organisation': [{ id: 1 }], 'FROM number_series': [seriesRow] });
    const svc = new NumberingService(db);
    expect(await svc.peek('quotation')).toMatch(/^QT-\d{4}\/0007$/);
    expect(seen.filter((s) => /UPDATE/.test(s))).toHaveLength(0);
  });

  it('peek() on a NEW period shows 0001 — the counter resets with the year', async () => {
    const stale = { ...seriesRow, period_token: '2025', next_number: 812 };
    const { db } = fakeDb({ 'FROM organisation': [{ id: 1 }], 'FROM number_series': [stale] });
    const svc = new NumberingService(db);
    const n = await svc.peek('quotation');
    expect(n).toBe(`QT-${new Date().getUTCFullYear()}/0001`);
  });

  it('refuses an unknown kind rather than inventing a series', async () => {
    const { db } = fakeDb({ 'FROM organisation': [{ id: 1 }], 'FROM number_series': [] });
    const svc = new NumberingService(db);
    await expect(svc.allocate('unicorn')).rejects.toThrow(/Unknown numbering series/);
  });
});

describe('the migrated `lead` series', () => {
  it('is a KNOWN kind, so its row is labelled and its Edit button works', async () => {
    // it came across from the client's old app_setting JSON. It was rendering as a bare
    // lowercase "lead" and Edit 400'd with "Unknown numbering series" — found live.
    const { db } = fakeDb({ 'FROM organisation': [{ id: 1 }], 'INSERT INTO number_series': [{ id: 9 }] });
    const svc = new NumberingService(db as never);
    await expect(svc.save({ kind: 'lead', next_number: 1, reset_period: 'none' }, 1)).resolves.toBeDefined();
  });
});

describe('admin CRUD', () => {
  it('refuses to delete the ORG-WIDE series — it is every branch\'s fallback', async () => {
    const { db } = fakeDb({ 'FROM number_series': [{ id: 3, kind: 'quotation', branch_id: null, vertical_id: null }] });
    const svc = new NumberingService(db);
    await expect(svc.remove(3)).rejects.toThrow(/cannot be deleted/);
  });

  it('allows deleting a branch-specific override', async () => {
    const { db } = fakeDb({ 'FROM number_series': [{ id: 4, kind: 'quotation', branch_id: 9, vertical_id: null }] });
    const svc = new NumberingService(db);
    await expect(svc.remove(4)).resolves.toEqual({ ok: true });
  });

  it('validates what a client can type', async () => {
    const { db } = fakeDb({ 'FROM organisation': [{ id: 1 }] });
    const svc = new NumberingService(db);
    await expect(svc.save({ kind: 'nope' }, 1)).rejects.toThrow(/Unknown numbering series/);
    await expect(svc.save({ kind: 'quotation', reset_period: 'daily' }, 1)).rejects.toThrow(/none, yearly, monthly or fy/);
    await expect(svc.save({ kind: 'quotation', next_number: 0 }, 1)).rejects.toThrow(/1 or more/);
    await expect(svc.save({ kind: 'quotation', next_number: 1, padding: 99 }, 1)).rejects.toThrow(/between 0 and 12/);
  });
});
