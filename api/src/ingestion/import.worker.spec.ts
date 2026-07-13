import { ImportWorker } from './import.worker';
import { LeadIngestionService } from './lead-ingestion.service';
import { DatabaseService } from '../database/database.service';
import { IngestValidationError } from './ingestion.types';

/** Captures every statement so we can assert queue semantics without Postgres. */
function makeDb(claimed: any[]) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  let handedOut = false;
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      sqls.push({ sql: s, params });
      if (s.includes('UPDATE import_job j') && s.includes('SKIP LOCKED')) {
        if (handedOut) return [];
        handedOut = true;
        return claimed;
      }
      return [];
    },
    one: async () => null,
    tx: async (fn: any) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
  } as unknown as DatabaseService;
  return { db, sqls, find: (frag: string) => sqls.filter((x) => x.sql.includes(frag)) };
}

const JOB = { id: 1, batch_id: 7, row_num: 3, payload: { full_name: 'A', phone: '9811100001' }, raw: { Name: 'A' }, attempts: 1, campaign_id: 5, source_id: 9, created_by: 2 };

describe('ImportWorker (postgres queue, in-process)', () => {
  it('claims jobs with FOR UPDATE SKIP LOCKED and rate-limits per tick', async () => {
    const { db, find } = makeDb([]);
    const w = new ImportWorker(db, { loadTarget: jest.fn() } as unknown as LeadIngestionService);
    await w.tick();
    const claim = find('SKIP LOCKED')[0];
    expect(claim).toBeDefined();
    expect(claim.params[0]).toBe(ImportWorker.BATCH_SIZE);
  });

  it('records the outcome and bumps the right batch counter', async () => {
    const { db, find } = makeDb([JOB]);
    const ingestion = {
      loadTarget: jest.fn().mockResolvedValue({}),
      ingest: jest.fn().mockResolvedValue({ status: 'created', lead_id: 42, reason: null }),
    } as unknown as LeadIngestionService;
    const w = new ImportWorker(db, ingestion);
    await w.tick();
    expect(find("SET status = $2, lead_id = $3")[0].params).toEqual([1, 'created', 42, null]);
    expect(find('SET created_count = created_count + 1')).toHaveLength(1);
  });

  it('a duplicate row is counted as duplicate, not failed', async () => {
    const { db, find } = makeDb([JOB]);
    const ingestion = {
      loadTarget: jest.fn().mockResolvedValue({}),
      ingest: jest.fn().mockResolvedValue({ status: 'duplicate', lead_id: null, reason: 'Duplicate of lead #900' }),
    } as unknown as LeadIngestionService;
    await new ImportWorker(db, ingestion).tick();
    expect(find('SET duplicate_count = duplicate_count + 1')).toHaveLength(1);
    expect(find('INSERT INTO import_error')).toHaveLength(0);
  });

  it('a VALIDATION error is permanent — dead-lettered, never retried', async () => {
    const { db, find } = makeDb([JOB]);
    const ingestion = {
      loadTarget: jest.fn().mockResolvedValue({}),
      ingest: jest.fn().mockRejectedValue(new IngestValidationError('Invalid mobile number: "12"')),
    } as unknown as LeadIngestionService;
    await new ImportWorker(db, ingestion).tick();

    const dead = find('INSERT INTO import_error')[0];
    expect(dead).toBeDefined();
    expect(dead.params[2]).toBe(3);                                  // row_num
    expect(dead.params[4]).toMatch(/Invalid mobile/);                // reason
    expect(JSON.parse(String(dead.params[3]))).toEqual({ Name: 'A' }); // the original row, for the error CSV
    expect(find("seconds')::interval")).toHaveLength(0); // no retry
    expect(find('SET failed_count = failed_count + 1')).toHaveLength(1);
  });

  it('a TRANSIENT error is retried with exponential backoff, then dead-lettered', async () => {
    const transient = () => ({
      loadTarget: jest.fn().mockResolvedValue({}),
      ingest: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    } as unknown as LeadIngestionService);

    const first = makeDb([{ ...JOB, attempts: 1 }]);
    await new ImportWorker(first.db, transient()).tick();
    const retry = first.find("seconds')::interval")[0];
    expect(retry).toBeDefined();
    expect(retry.params[1]).toBe('10');                    // 2^1 * 5s
    expect(first.find('INSERT INTO import_error')).toHaveLength(0);

    const last = makeDb([{ ...JOB, attempts: ImportWorker.MAX_ATTEMPTS }]);
    await new ImportWorker(last.db, transient()).tick();
    expect(last.find("seconds')::interval")).toHaveLength(0);
    expect(last.find('INSERT INTO import_error')[0].params[4]).toBe('ECONNRESET');
  });

  it('reclaims stuck jobs and settles drained batches', async () => {
    const { db, find } = makeDb([]);
    await new ImportWorker(db, { loadTarget: jest.fn() } as unknown as LeadIngestionService).tick();
    expect(find("status = 'running' AND locked_at <")).toHaveLength(1);
    expect(find('UPDATE import_batch b')[0].sql).toContain("SET status = CASE WHEN b.failed_count >= b.total_rows");
  });

  it('never overlaps two ticks', async () => {
    const { db } = makeDb([]);
    const w = new ImportWorker(db, { loadTarget: jest.fn() } as unknown as LeadIngestionService);
    const [a, b] = await Promise.all([w.tick(), w.tick()]);
    expect([a, b].filter((n) => n === 0).length).toBeGreaterThanOrEqual(1);
  });
});
