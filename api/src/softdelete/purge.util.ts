/**
 * PERMANENT DELETE engine (client, Oct 2026) — used by SoftDeleteService.purge / purgePreview.
 *
 * Client rule: permanently deleting a Branch / Vertical / Pipeline / Campaign / Source / Course
 * from Deleted Items removes it AND EVERYTHING LINKED TO IT (verticals under a branch, sources and
 * leads under a campaign, their activity, …). Nothing blocks.
 *
 * The links are read from the Postgres catalog at run time (a branch alone has ~80 referencing
 * foreign keys), and resolved with one rule set:
 *
 *   ON DELETE CASCADE / SET NULL / SET DEFAULT -> left to the database.
 *   DETACH tables (below)                      -> optional "default" pointers set to NULL.
 *   PROTECTED tables (users, roles, org)       -> never deleted through a link: a referencing
 *                                                 row there blocks (it cannot happen for the
 *                                                 hierarchy today; this is a safety net).
 *   every other referencing row                -> permanently deleted, recursively, same rules.
 *
 * Everything runs inside the caller's transaction. purgePreview runs the same walk and ROLLS BACK,
 * so the confirmation dialog can say exactly what will go before anything does.
 */

/** Optional "default" pointers that are cleared instead of deleting the row. */
export const PURGE_DETACH_TABLES = new Set(['api_key']);
/** Never removed as a side effect of purging something else. */
export const PURGE_PROTECTED_TABLES = new Set(['user', 'role', 'organisation', 'permission']);

const MAX_DEPTH = 10;

export class PurgeBlocked extends Error {
  constructor(public readonly blockers: string[]) { super(blockers.join('; ')); }
}

interface Fk { tbl: string; col: string; rule: string; notnull: boolean; has_id: boolean }
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** "user_assignment" / "\"user\"" -> "user assignment" (for messages). */
export const humanTable = (t: string) => t.replace(/"/g, '').replace(/^m_/, '').replace(/_/g, ' ');

export class PurgeRunner {
  private fkCache = new Map<string, Fk[]>();
  private seen = new Set<string>();
  /** what else was removed: label -> count */
  readonly removed = new Map<string, number>();

  constructor(private readonly c: Client) {}

  private bump(label: string, n: number) { if (n > 0) this.removed.set(label, (this.removed.get(label) ?? 0) + n); }

  private async fks(table: string): Promise<Fk[]> {
    if (!this.fkCache.has(table)) {
      const r = await this.c.query(
        `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS rule, a.attnotnull AS notnull,
                EXISTS (SELECT 1 FROM pg_attribute d WHERE d.attrelid = c.conrelid AND d.attname = 'id' AND NOT d.attisdropped) AS has_id
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1
          ORDER BY 1, 2`, [table]);
      this.fkCache.set(table, (r.rows ?? []) as Fk[]);
    }
    return this.fkCache.get(table)!;
  }

  /** Permanently delete table#id and everything that points at it. */
  async purge(table: string, id: number, depth = 0): Promise<void> {
    const key = `${table}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (depth > MAX_DEPTH) throw new PurgeBlocked(['records linked too deeply to remove safely']);

    for (const fk of await this.fks(table)) {
      if (fk.rule === 'c' || fk.rule === 'n' || fk.rule === 'd') continue;   // the database handles these
      const ref = fk.tbl;                     // regclass text — already quoted when needed
      const plain = ref.replace(/"/g, '');
      const col = `"${fk.col.replace(/"/g, '')}"`;
      if (ref === table && fk.has_id && !fk.notnull) {
        // optional self-reference (e.g. lead.merged_into_id): detach rather than delete the sibling
        await this.c.query(`UPDATE ${ref} SET ${col} = NULL WHERE ${col} = $1 AND id <> $1`, [id]);
        continue;
      }
      const cnt = Number((await this.c.query(`SELECT count(*)::int AS n FROM ${ref} WHERE ${col} = $1`, [id])).rows[0]?.n ?? 0);
      if (!cnt) continue;

      if (PURGE_DETACH_TABLES.has(plain) && !fk.notnull) {
        await this.c.query(`UPDATE ${ref} SET ${col} = NULL WHERE ${col} = $1`, [id]);
      } else if (PURGE_PROTECTED_TABLES.has(plain)) {
        if (fk.notnull) throw new PurgeBlocked([`${cnt} ${humanTable(plain)} record(s)`]);
        await this.c.query(`UPDATE ${ref} SET ${col} = NULL WHERE ${col} = $1`, [id]);
      } else if (fk.has_id) {
        const rows = (await this.c.query(`SELECT id FROM ${ref} WHERE ${col} = $1 ORDER BY id`, [id])).rows;
        for (const r of rows) await this.purge(ref, Number(r.id), depth + 1);
        this.bump(humanTable(plain), rows.length);
      } else {
        await this.c.query(`DELETE FROM ${ref} WHERE ${col} = $1`, [id]);
        this.bump(humanTable(plain), cnt);
      }
    }
    await this.c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }

  /** "2 vertical, 3 user assignment" for messages. */
  removedSummary(): string {
    return [...this.removed.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
  }
}
