import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadsService } from './leads.service';

/**
 * Lead RED FLAG (client request, Aug 2026) — addRedFlag stores an entry, sets the lead's
 * red-flagged state and writes a `red_flag` lead_activity so it also shows on the main
 * timeline; redFlags reads the conversation; clearRedFlag flips the state off. Unit-tested
 * against hand-built db doubles (no Postgres), the house style for this service.
 */
const make = (leadRow: any = { org_id: '1', branch_id: '2' }) => {
  const one = jest.fn().mockResolvedValue(leadRow);
  const cQuery = jest.fn().mockResolvedValue({ rows: [{ id: '55', remark: 'watch this', created_at: 'T', created_by: '9' }] });
  const query = jest.fn().mockResolvedValue([]);
  const db = { one, query, tx: jest.fn(async (cb: any) => cb({ query: cQuery })) } as any;
  const svc = new LeadsService(db, {} as any, {} as any, null as any, null as any, null as any);
  return { svc, db, one, query, cQuery };
};

describe('LeadsService.addRedFlag', () => {
  it('rejects an empty remark and never touches the DB write', async () => {
    const { svc, db } = make();
    await expect(svc.addRedFlag(10, '   ', 9)).rejects.toThrow(BadRequestException);
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('404s when the lead does not exist', async () => {
    const { svc } = make(null);
    await expect(svc.addRedFlag(10, 'hi', 9)).rejects.toThrow(NotFoundException);
  });

  it('stores the entry, sets the flag state, and writes a red_flag activity', async () => {
    const { svc, cQuery } = make();
    const out = await svc.addRedFlag(10, '  watch this  ', 9);
    expect(out).toEqual({ ok: true, is_red_flagged: true, entry: { id: '55', remark: 'watch this', created_at: 'T', created_by: '9' } });
    const sql = cQuery.mock.calls.map((c: any[]) => c[0]);
    // 1) inserts the trimmed remark into lead_red_flag
    const insEntry = cQuery.mock.calls.find((c: any[]) => /INSERT INTO lead_red_flag/.test(c[0]));
    expect(insEntry).toBeTruthy();
    expect(insEntry[1]).toEqual([10, 1, 2, 'watch this', 9]);
    // 2) sets is_red_flagged TRUE
    expect(sql.some((q: string) => /UPDATE lead SET is_red_flagged = TRUE/.test(q))).toBe(true);
    // 3) writes a red_flag lead_activity carrying the remark
    const act = cQuery.mock.calls.find((c: any[]) => /INSERT INTO lead_activity/.test(c[0]) && /'red_flag'/.test(c[0]));
    expect(act).toBeTruthy();
    expect(act[1]).toContain('watch this');
  });

  it('accumulates: a second flag inserts another entry (state COALESCEs the timestamp)', async () => {
    const { svc, cQuery } = make({ org_id: '1', branch_id: '2' });
    await svc.addRedFlag(10, 'first', 9);
    await svc.addRedFlag(10, 'second', 9);
    const inserts = cQuery.mock.calls.filter((c: any[]) => /INSERT INTO lead_red_flag/.test(c[0]));
    expect(inserts).toHaveLength(2);
    // red_flagged_at only stamped when null, so re-flagging keeps the first timestamp
    expect(cQuery.mock.calls.some((c: any[]) => /red_flagged_at = COALESCE\(red_flagged_at, now\(\)\)/.test(c[0]))).toBe(true);
  });
});

describe('LeadsService.redFlags', () => {
  it('reads only non-deleted entries, newest first, with the author name', async () => {
    const { svc, query } = make();
    await svc.redFlags(10);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM lead_red_flag rf/);
    expect(sql).toMatch(/rf\.deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY rf\.created_at DESC/);
    expect(sql).toMatch(/created_by_name/);
    expect(params).toEqual([10]);
  });
});

describe('LeadsService.clearRedFlag', () => {
  it('404s when the lead is missing', async () => {
    const { svc } = make(null);
    await expect(svc.clearRedFlag(10, 9)).rejects.toThrow(NotFoundException);
  });

  it('is a no-op when the lead is not flagged', async () => {
    const { svc, db } = make({ org_id: '1', branch_id: '2', is_red_flagged: false });
    const out = await svc.clearRedFlag(10, 9);
    expect(out).toEqual({ ok: true, is_red_flagged: false });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('clears the state and logs a red_flag cleared activity', async () => {
    const { svc, cQuery } = make({ org_id: '1', branch_id: '2', is_red_flagged: true });
    const out = await svc.clearRedFlag(10, 9);
    expect(out).toEqual({ ok: true, is_red_flagged: false });
    expect(cQuery.mock.calls.some((c: any[]) => /UPDATE lead SET is_red_flagged = FALSE/.test(c[0]))).toBe(true);
    const act = cQuery.mock.calls.find((c: any[]) => /INSERT INTO lead_activity/.test(c[0]) && /'red_flag'/.test(c[0]));
    expect(JSON.stringify(act[1])).toContain('cleared');
  });
});
