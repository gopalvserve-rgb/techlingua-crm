import { NotFoundException } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { DatabaseService } from '../database/database.service';
import { NotifierService } from '../notifications/notifier.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * WORKSPACE SCOPING.
 *
 * =============================================================================
 * THE `IS NULL` HALF IS LOAD-BEARING
 * =============================================================================
 * Org-wide content has `branch_id IS NULL`. A Branch Manager's scope fragment is
 * `branch_id = 9`, and **NULL is not equal to 9** — so a plain scope filter makes the
 * General channel, and every org-wide announcement, INVISIBLE to every manager in the
 * company while remaining visible to admins. That is a bug the client finds on day one
 * and it looks like the permissions are broken.
 *
 * The other way round — dropping the scope and keeping only the NULL check — shows every
 * branch's channel to everybody.
 *
 * Both directions are tested, because both are one character apart.
 */

const resolver = new ScopeResolverService();
const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'workspace.read', allowed: true, all: false, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});
const BRANCH = scope({ filters: [{ kind: 'branch', branchId: 9 }] });
const ADMIN = scope({ all: true });
const DENIED = scope({ allowed: false });

class FakeDb {
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];
  rows: any[] = [];
  async query(sql: string, params: unknown[] = []) {
    this.sql.push(sql); this.params.push(params);
    if (/FROM organisation/.test(sql)) return [{ id: '1' }];
    return this.rows;
  }
  async one(sql: string, params: unknown[] = []) {
    this.sql.push(sql); this.params.push(params);
    if (/FROM organisation/.test(sql)) return { id: '1' } as any;
    return this.rows[0] ?? null;
  }
  async tx(fn: any) { return fn({ query: async () => ({ rows: [] }) }); }
  find(re: RegExp) { return this.sql.find((s) => re.test(s)); }
}

const build = () => {
  const db = new FakeDb();
  const notified: any[] = [];
  const notifier = { notify: async (m: any) => { notified.push(m); } };
  const svc = new WorkspaceService(db as unknown as DatabaseService, resolver, notifier as unknown as NotifierService);
  return { db, svc, notified };
};

describe('org-wide content stays visible to a scoped manager (the `IS NULL` half)', () => {
  it('a branch manager\'s channel query is `(branch scope) OR (both units are NULL)`', async () => {
    const { db, svc } = build();
    await svc.channels(BRANCH);
    const q = db.find(/FROM workspace_channel c/)!;
    expect(q).toMatch(/c\.branch_id = \$\d+/);
    // WITHOUT this, the seeded "General" channel is invisible to every manager in the org.
    expect(q).toContain('c.branch_id IS NULL AND c.vertical_id IS NULL');
    expect(q).toMatch(/OR \(/);
  });

  it('an admin gets 1=1 with NO `IS NULL` branch bolted on', async () => {
    const { db, svc } = build();
    await svc.channels(ADMIN);
    const q = db.find(/FROM workspace_channel c/)!;
    expect(q).toContain('(1=1)');
    expect(q).not.toContain('OR (c.branch_id IS NULL');
  });

  it('NO PERMISSION => 1=0, and the `IS NULL` escape does NOT re-open it', async () => {
    const { db, svc } = build();
    await svc.channels(DENIED);
    const q = db.find(/FROM workspace_channel c/)!;
    expect(q).toContain('(1=0)');
    // the bug this asserts against: `1=0 OR branch_id IS NULL` would hand every org-wide
    // channel to somebody with no workspace permission at all.
    expect(q).not.toContain('1=0 OR');
  });

  it('the same rule holds for the KB and for announcements', async () => {
    const { db, svc } = build();
    await svc.kb(BRANCH);
    await svc.announcements({ id: 3 }, BRANCH);
    expect(db.find(/FROM kb_article a/)).toContain('a.branch_id IS NULL AND a.vertical_id IS NULL');
    expect(db.find(/FROM announcement a/)).toContain('a.branch_id IS NULL AND a.vertical_id IS NULL');
  });
});

describe('a PRIVATE note is private from EVERYONE', () => {
  /**
   * A Branch Manager's scope covers a counsellor's rows. If notes were scoped like leads,
   * he would read his team's private notepads. A notepad a manager can read is not a
   * notepad — so `owner_id = me` is checked FIRST and the scope only ever applies to
   * SHARED notes.
   */
  it('the query is `mine OR (shared AND in-scope)` — the scope never reaches a private note', async () => {
    const { db, svc } = build();
    await svc.notes({ id: 3 }, BRANCH);
    const q = db.find(/FROM workspace_note n/)!.replace(/\s+/g, ' ');
    expect(q).toContain('n.owner_id = $1 OR (n.is_shared AND');
    // a manager's branch fragment must be INSIDE the is_shared branch, never a top-level OR
    expect(q).not.toMatch(/n\.owner_id = \$1 OR \(n\.branch_id/);
  });

  it('a note search is parameterised and its LIKE metacharacters escaped', async () => {
    const { db, svc } = build();
    await svc.notes({ id: 3 }, ADMIN, '50%_x');
    expect(db.params.flat()).toContain('%50\\%\\_x%');
    expect(db.find(/FROM workspace_note n/)).not.toContain('50%');
  });

  it('you cannot edit or delete a note you do not own', async () => {
    const { db, svc } = build();
    db.rows = [{ id: 4, owner_id: 99, title: 'theirs' }];
    await expect(svc.saveNote({ title: 'hijack' }, { id: 3 }, 4)).rejects.toThrow(NotFoundException);
    await expect(svc.deleteNote(4, { id: 3 })).rejects.toThrow(NotFoundException);
  });
});

describe('a channel out of scope is a 404, not an empty thread', () => {
  it('reading messages of a channel you cannot see is a 404', async () => {
    const { db, svc } = build();
    db.rows = [];   // channels() returns nothing for this user
    await expect(svc.messages(1, BRANCH)).rejects.toThrow(NotFoundException);
    await expect(svc.post(1, { body: 'hi' }, { id: 3 }, BRANCH)).rejects.toThrow(NotFoundException);
  });

  it('an empty message is refused', async () => {
    const { db, svc } = build();
    db.rows = [{ id: 1, name: 'General' }];
    await expect(svc.post(1, { body: '   ' }, { id: 3 }, BRANCH)).rejects.toThrow(/Type a message/);
  });

  it('the author may delete their own message; a stranger gets a 404', async () => {
    const { db, svc } = build();
    db.rows = [{ id: 5, author_id: 3, body: 'oops' }];
    await expect(svc.deleteMessage(5, { id: 3 }, false)).resolves.toEqual({ id: 5, deleted: true });
    await expect(svc.deleteMessage(5, { id: 99 }, false)).rejects.toThrow(NotFoundException);
    // …and a manager may, because moderation is a real need
    await expect(svc.deleteMessage(5, { id: 99 }, true)).resolves.toEqual({ id: 5, deleted: true });
  });

  it('deletes are SOFT everywhere (Deleted Items can restore them)', async () => {
    const { db, svc } = build();
    db.rows = [{ id: 5, author_id: 3 }];
    await svc.deleteMessage(5, { id: 3 }, false);
    expect(db.find(/UPDATE workspace_message SET deleted_at/)).toBeTruthy();
  });
});

describe('announcements', () => {
  it('an EMPTY role list means EVERYONE, not nobody', async () => {
    const { db, svc } = build();
    await svc.announcements({ id: 3 }, ADMIN);
    const q = db.find(/FROM announcement a/)!;
    // `role_ids @> to_jsonb(role)` against `[]` is false for every role. Without the
    // explicit length check, an announcement aimed at "everyone" reaches NOBODY — and it
    // would look like the feature simply does not work.
    expect(q).toContain('jsonb_array_length(a.role_ids) = 0');
    expect(q).toContain('OR EXISTS');
  });

  it('only PUBLISHED announcements reach the reader view; the author view shows drafts', async () => {
    const { db, svc } = build();
    await svc.announcements({ id: 3 }, ADMIN);
    const reader = db.sql.filter((x) => /FROM announcement a/.test(x)).pop()!;
    expect(reader).toContain('a.is_published');

    const { db: db2, svc: svc2 } = build();
    await svc2.announcementsAdmin(ADMIN);
    const author = db2.sql.filter((x) => /FROM announcement a/.test(x)).pop()!;
    // The author must see his own drafts — that is the difference between the two views.
    expect(author).not.toMatch(/AND a\.is_published\b/);
    expect(author).toContain('read_count');
  });

  it('read tracking is an upsert — reading twice does not double-count', async () => {
    const { db, svc } = build();
    await svc.markRead(4, { id: 3 });
    expect(db.find(/INSERT INTO announcement_read/)).toContain('ON CONFLICT (announcement_id, user_id) DO NOTHING');
  });

  /**
   * Editing a typo in a published announcement must not re-ring every bell in the
   * company — and pressing Save twice must not either.
   */
  it('the bell rings on FIRST PUBLISH ONLY', async () => {
    const { db, svc, notified } = build();
    db.rows = [{ id: 4, is_published: true, title: 'Fee change', body: 'x', role_ids: [], branch_id: null, vertical_id: null }];
    // already published -> editing it notifies nobody
    await svc.saveAnnouncement({ title: 'Fee change (typo fixed)', is_published: true }, { id: 2 }, 4);
    expect(notified).toHaveLength(0);
  });

  it('a draft notifies nobody', async () => {
    const { db, svc, notified } = build();
    db.rows = [{ id: 4, is_published: false }];
    await svc.saveAnnouncement({ title: 'Later', is_published: false }, { id: 2 }, 4);
    expect(notified).toHaveLength(0);
  });

  it('an untitled announcement is refused', async () => {
    const { svc } = build();
    await expect(svc.saveAnnouncement({ title: ' ' }, { id: 2 })).rejects.toThrow(/needs a title/);
  });

  it('published_at is stamped ONCE — re-saving does not move the date', async () => {
    const { db, svc } = build();
    db.rows = [{ id: 4, is_published: true, role_ids: [] }];
    await svc.saveAnnouncement({ title: 'x', is_published: true }, { id: 2 }, 4);
    expect(db.find(/UPDATE announcement SET/)).toContain('WHEN $7 AND published_at IS NULL THEN now() ELSE published_at END');
  });
});

/**
 * THE DOCUMENTED GAP. Workspace Tasks IS the follow-up module — no `workspace_task`
 * table, no second API, no second form. This test is the thing that makes that a
 * DECISION rather than a thing somebody forgot: adding a task table will fail it, and
 * whoever does so has to come here and read why.
 */
describe('Workspace TASKS reuse the follow-up module — they are not forked', () => {
  it('there is no workspace_task table in any migration', () => {
    const { readFileSync, readdirSync } = require('fs');
    const { join } = require('path');
    const dir = join(__dirname, '..', '..', 'db', 'migrations');
    const all = readdirSync(dir).filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(all).not.toMatch(/CREATE TABLE[^;]*workspace_task/i);
  });

  it('the WorkspaceService has no task methods (they would be a fork of follow_up)', () => {
    const methods = Object.getOwnPropertyNames(WorkspaceService.prototype);
    expect(methods.filter((m) => /task/i.test(m))).toEqual([]);
  });

  it('the web Tasks screen reads /follow-ups — the same table, the same statuses', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const dyn = readFileSync(join(__dirname, '..', '..', '..', 'web', 'src', 'dyn.tsx'), 'utf8');
    const fn = dyn.slice(dyn.indexOf('function WorkTasks()'), dyn.indexOf('function WorkTasks()') + 400);
    expect(fn).toContain('/follow-ups');
    expect(fn).not.toContain('/workspace/tasks');
  });
});
