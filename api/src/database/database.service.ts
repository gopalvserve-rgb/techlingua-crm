import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';
import { APP_TZ } from '../common/date.util';

/**
 * Thin typed wrapper over a pg Pool. All data access goes through this service;
 * scope filters produced by the RBAC layer are appended as parameterised WHERE fragments.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    // ONE APP TIMEZONE for every server-side day-bucket computation. Opening the pool in
    // APP_TZ (Asia/Kolkata) makes CURRENT_DATE / now()::date / date_trunc / `::date` casts
    // evaluate in IST on every connection, so the server's "today" agrees with the client's
    // IST date-range presets (no more off-by-one at the UTC/IST boundary). The `options`
    // startup parameter sets it before the first query; the `connect` handler re-applies it
    // on every pooled/re-used connection so it can't be lost behind a pooling proxy. Single
    // source of truth: APP_TZ in common/date.util.ts.
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      options: `-c timezone=${APP_TZ}`,
    });
    this.pool.on('connect', (client) => {
      client.query(`SET TIME ZONE '${APP_TZ}'`).catch(() => { /* best-effort; options already set it */ });
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params as any[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Run work inside a transaction. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
