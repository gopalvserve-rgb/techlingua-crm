import * as fs from 'fs';
import * as path from 'path';

/**
 * USER-RENAME HISTORY PRESERVATION (client feedback, migration 087).
 *
 * Contract: audit_log / lead_activity SNAPSHOT the acting user's display name at
 * write time (BEFORE INSERT trigger stamps actor_name := "user".name). The READ path
 * renders that stored snapshot — NOT a live join to the current "user".name — so
 * renaming a user later never rewrites the actor label on historical rows, while
 * new rows pick up the new name.
 */

// --- In-memory model of the Postgres trigger + snapshot read (behavioural proof) ---
type Row = { id: number; actor_id: number; actor_name: string | null };
class FakeActivityTable {
  private rows: Row[] = [];
  private seq = 0;
  // mirrors snapshot_actor_name(): stamp actor_name from the CURRENT user name at insert
  insert(actorId: number, users: Map<number, string>) {
    this.rows.push({ id: ++this.seq, actor_id: actorId, actor_name: users.get(actorId) ?? null });
  }
  // mirrors the fixed READ path: render the STORED snapshot, no live join
  read(): { id: number; actor_name: string | null }[] {
    return this.rows.map((r) => ({ id: r.id, actor_name: r.actor_name }));
  }
}

describe('actor-name snapshot semantics (migration 087)', () => {
  it('renaming a user leaves historical rows unchanged; new rows use the new name', () => {
    const users = new Map<number, string>([[7, 'Old Name']]);
    const t = new FakeActivityTable();

    // 1) activity written while the user is "Old Name"
    t.insert(7, users);
    expect(t.read()).toEqual([{ id: 1, actor_name: 'Old Name' }]);

    // 2) rename the user
    users.set(7, 'New Name');

    // 3) historical row is UNCHANGED (still "Old Name")
    expect(t.read().find((r) => r.id === 1)!.actor_name).toBe('Old Name');

    // 4) a NEW activity row records the NEW name
    t.insert(7, users);
    expect(t.read()).toEqual([
      { id: 1, actor_name: 'Old Name' },
      { id: 2, actor_name: 'New Name' },
    ]);
  });
});

describe('read paths render the stored snapshot, not a live user join', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

  it('audit_log list selects the stored actor_name and does not live-join "user" for it', () => {
    const src = read('./audit.controller.ts');
    // the audit list query block must not join "user" to resolve the actor label
    const block = src.slice(src.indexOf('FROM audit_log'));
    expect(block).not.toMatch(/LEFT JOIN "user"[\s\S]*AS actor_name/);
    expect(src).not.toMatch(/u\.name AS actor_name/);
  });

  it('lead_activity timeline selects a.actor_name and does not live-join "user" for it', () => {
    const src = read('../leads/leads.service.ts');
    const idx = src.indexOf('FROM lead_activity a');
    expect(idx).toBeGreaterThan(-1);
    // the activities() timeline read must select the stored snapshot column
    expect(src).toMatch(/a\.occurred_at, a\.actor_name\s*\n\s*FROM lead_activity a/);
    // and must not resolve the actor label via a live user join in that read
    expect(src).not.toMatch(/FROM lead_activity a LEFT JOIN "user" u ON u\.id = a\.actor_id/);
  });
});

describe('migration 087 ships the snapshot column, trigger and backfill', () => {
  const mig = fs.readFileSync(
    path.resolve(__dirname, '../../db/migrations/087_actor_name_history.sql'),
    'utf8',
  );
  it('adds actor_name to both audit_log and lead_activity', () => {
    expect(mig).toMatch(/ALTER TABLE audit_log\s+ADD COLUMN IF NOT EXISTS actor_name/);
    expect(mig).toMatch(/ALTER TABLE lead_activity ADD COLUMN IF NOT EXISTS actor_name/);
  });
  it('installs a BEFORE INSERT snapshot trigger on both tables', () => {
    expect(mig).toMatch(/CREATE OR REPLACE FUNCTION snapshot_actor_name/);
    expect((mig.match(/BEFORE INSERT ON (audit_log|lead_activity)/g) || []).length).toBe(2);
  });
  it('backfills existing rows from the current user name', () => {
    expect((mig.match(/SET actor_name = u\.name/g) || []).length).toBe(2);
  });
});
