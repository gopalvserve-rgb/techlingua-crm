import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { NotifierService } from '../notifications/notifier.service';

export interface Me { id: number; name?: string }

/**
 * WORKSPACE — internal team messages · notes · knowledge base · announcements.
 *
 * =============================================================================
 * WHERE ARE THE TASKS?
 * =============================================================================
 * Workspace › Tasks is THE FOLLOW-UP MODULE. Not a copy of it — it.
 *
 * The doc says "tasks (same fields/statuses as follow-up tasks)". A `workspace_task`
 * table with the same columns, the same four statuses and the same three priorities IS
 * the fork that sentence forbids, and it would mean two "My Tasks" counts, two overdue
 * sweeps, two reminder workers and — eventually — two different answers to "how many
 * tasks do I have". So the Workspace Tasks screen renders `/follow-ups`, with the same
 * form, the same Report To field and the same "Myself" behaviour the client asked for in
 * update #5.
 *
 * WHAT THAT COSTS, SAID PLAINLY: a task must belong to a lead. "Prepare the July
 * report", which belongs to nobody, cannot be created today. Making `follow_up.lead_id`
 * nullable is the fix, and it touches fifteen scoped queries that INNER JOIN follow_up to
 * lead — every one of which would silently DROP a lead-less task rather than fail. That
 * is precisely the class of silent bug this project has been burned by three times, and
 * it is not a change to make in the last week of Phase 1 on a live database. It is
 * written up as a client decision in docs/dev/08 §5 and PROJECT_STATUS §4, not left for
 * Gopal to discover.
 *
 * =============================================================================
 * SCOPING
 * =============================================================================
 * Every entity here carries `branch_id` / `vertical_id` and is filtered with the same
 * `buildScopeWhere` as everything else. NULL means org-wide, which is the useful default
 * for an announcement or a KB article — but a NULL is not matched by `branch_id = 9`, so
 * an org-wide row would VANISH for a Branch Manager. That is why every scoped read here
 * is `(<scope> OR <the column> IS NULL)`: org-wide content is visible to everyone, and
 * branch content only to that branch. Getting this backwards is the difference between
 * "nobody can see the General channel" and "everybody can see every branch's channel".
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly notifier: NotifierService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id ?? 1);
  }

  /**
   * The scope fragment for a workspace entity, PLUS the org-wide escape.
   * See the class header — the `IS NULL` half is load-bearing, not defensive noise.
   */
  private where(scope: ResolvedScope, cols: ScopeColumnMap, params: unknown[], branchCol: string, verticalCol: string): string {
    const w = this.resolver.buildScopeWhere(scope, cols, params);
    if (w === '1=1') return '1=1';
    if (w === '1=0') return '1=0';
    return `(${w} OR (${branchCol} IS NULL AND ${verticalCol} IS NULL))`;
  }

  /* ============================================================ TEAM MESSAGES */

  async channels(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.where(scope, { branch: 'c.branch_id', vertical: 'c.vertical_id' }, params, 'c.branch_id', 'c.vertical_id');
    const rows = await this.db.query<any>(
      `SELECT c.id, c.name, c.topic, c.branch_id, c.vertical_id, c.is_active,
              br.name AS branch_name, vt.name AS vertical_name,
              (SELECT count(*) FROM workspace_message m WHERE m.channel_id = c.id AND m.deleted_at IS NULL)::int AS message_count,
              (SELECT max(m2.created_at) FROM workspace_message m2 WHERE m2.channel_id = c.id AND m2.deleted_at IS NULL) AS last_at
         FROM workspace_channel c
         LEFT JOIN branch br ON br.id = c.branch_id
         LEFT JOIN vertical vt ON vt.id = c.vertical_id
        WHERE c.deleted_at IS NULL AND c.is_active AND (${w})
        ORDER BY c.name`,
      params,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async createChannel(dto: any, me: Me, scope: ResolvedScope) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('A channel needs a name.');
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO workspace_channel (org_id, name, topic, branch_id, vertical_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [await this.orgId(), name.slice(0, 120), dto?.topic ?? null,
        dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null, me.id],
    );
    const list = await this.channels(scope);
    return list.find((c) => c.id === Number(r!.id)) ?? { id: Number(r!.id), name };
  }

  /** A channel the caller's scope does not cover is a 404, not an empty thread — the
   *  ScopeEnforcer rule for by-id routes, applied by hand because a channel's scope
   *  columns are its own. */
  private async channelInScope(id: number, scope: ResolvedScope) {
    const list = await this.channels(scope);
    const c = list.find((x) => x.id === Number(id));
    if (!c) throw new NotFoundException('Channel not found.');
    return c;
  }

  async messages(channelId: number, scope: ResolvedScope, limit = 100) {
    await this.channelInScope(channelId, scope);
    const rows = await this.db.query<any>(
      `SELECT m.id, m.body, m.created_at, m.author_id, u.name AS author_name
         FROM workspace_message m
         LEFT JOIN "user" u ON u.id = m.author_id
        WHERE m.channel_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.id DESC LIMIT $2`,
      [channelId, Math.min(Math.max(1, Number(limit) || 100), 500)],
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), author_id: r.author_id == null ? null : Number(r.author_id) })).reverse();
  }

  async post(channelId: number, dto: any, me: Me, scope: ResolvedScope) {
    await this.channelInScope(channelId, scope);
    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('Type a message first.');
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO workspace_message (channel_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [channelId, me.id, body.slice(0, 8000)],
    );
    return { id: Number(r!.id), body, author_id: me.id, author_name: me.name, created_at: new Date().toISOString() };
  }

  /** A message is deleted by its author, or by someone with workspace.manage — which the
   *  controller checks. Soft, like everything else, so Deleted Items can restore it. */
  async deleteMessage(id: number, me: Me, canManage: boolean) {
    const row = await this.db.one<any>(`SELECT * FROM workspace_message WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Message not found.');
    if (!canManage && Number(row.author_id) !== me.id) throw new NotFoundException('Message not found.');
    await this.db.query(`UPDATE workspace_message SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ==================================================================== NOTES */

  async notes(me: Me, scope: ResolvedScope, q?: string) {
    const params: unknown[] = [me.id];
    const w = this.where(scope, { owner: 'n.owner_id', branch: 'n.branch_id', vertical: 'n.vertical_id' }, params, 'n.branch_id', 'n.vertical_id');
    let search = '';
    if (q) { params.push(`%${String(q).replace(/([\\%_])/g, '\\$1')}%`); search = ` AND (n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`; }
    const rows = await this.db.query<any>(
      // A PRIVATE note is the owner's alone — a Branch Manager's `branch` scope must not
      // reach into a counsellor's private notepad. Shared notes follow the normal scope.
      `SELECT n.id, n.title, n.body, n.is_shared, n.is_pinned, n.owner_id, n.branch_id, n.vertical_id,
              n.created_at, n.updated_at, u.name AS owner_name
         FROM workspace_note n
         LEFT JOIN "user" u ON u.id = n.owner_id
        WHERE n.deleted_at IS NULL
          AND (n.owner_id = $1 OR (n.is_shared AND (${w})))${search}
        ORDER BY n.is_pinned DESC, n.updated_at DESC
        LIMIT 200`,
      params,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), owner_id: r.owner_id == null ? null : Number(r.owner_id), is_mine: Number(r.owner_id) === me.id }));
  }

  async saveNote(dto: any, me: Me, id?: number) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('A note needs a title.');
    if (id) {
      const row = await this.db.one<any>(`SELECT * FROM workspace_note WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!row) throw new NotFoundException('Note not found.');
      if (Number(row.owner_id) !== me.id) throw new NotFoundException('Note not found.');
      await this.db.query(
        `UPDATE workspace_note SET title = $2, body = $3, is_shared = $4, is_pinned = $5,
                branch_id = $6, vertical_id = $7, updated_at = now()
          WHERE id = $1`,
        [id, title.slice(0, 200), dto?.body ?? '', dto?.is_shared === true, dto?.is_pinned === true,
          dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null],
      );
      return { id, updated: true };
    }
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO workspace_note (org_id, title, body, is_shared, is_pinned, branch_id, vertical_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [await this.orgId(), title.slice(0, 200), dto?.body ?? '', dto?.is_shared === true, dto?.is_pinned === true,
        dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null, me.id],
    );
    return { id: Number(r!.id), created: true };
  }

  async deleteNote(id: number, me: Me) {
    const row = await this.db.one<any>(`SELECT * FROM workspace_note WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row || Number(row.owner_id) !== me.id) throw new NotFoundException('Note not found.');
    await this.db.query(`UPDATE workspace_note SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }

  /* =========================================================== KNOWLEDGE BASE */

  async kb(scope: ResolvedScope, f: { q?: string; category?: string } = {}) {
    const params: unknown[] = [];
    const w = this.where(scope, { branch: 'a.branch_id', vertical: 'a.vertical_id' }, params, 'a.branch_id', 'a.vertical_id');
    let extra = '';
    if (f.q) { params.push(`%${String(f.q).replace(/([\\%_])/g, '\\$1')}%`); extra += ` AND (a.title ILIKE $${params.length} OR a.body ILIKE $${params.length})`; }
    if (f.category) { params.push(f.category); extra += ` AND a.category = $${params.length}`; }
    const rows = await this.db.query<any>(
      `SELECT a.id, a.category, a.title, a.body, a.is_published, a.branch_id, a.vertical_id,
              a.author_id, a.created_at, a.updated_at, u.name AS author_name,
              br.name AS branch_name, vt.name AS vertical_name
         FROM kb_article a
         LEFT JOIN "user" u ON u.id = a.author_id
         LEFT JOIN branch br ON br.id = a.branch_id
         LEFT JOIN vertical vt ON vt.id = a.vertical_id
        WHERE a.deleted_at IS NULL AND a.is_published AND (${w})${extra}
        ORDER BY a.category, a.title
        LIMIT 300`,
      params,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async saveArticle(dto: any, me: Me, id?: number) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('An article needs a title.');
    const args = [
      String(dto?.category ?? 'General').slice(0, 120), title.slice(0, 200), dto?.body ?? '',
      dto?.is_published !== false,
      dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null,
    ];
    if (id) {
      const row = await this.db.one<any>(`SELECT id FROM kb_article WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!row) throw new NotFoundException('Article not found.');
      await this.db.query(
        `UPDATE kb_article SET category = $2, title = $3, body = $4, is_published = $5,
                branch_id = $6, vertical_id = $7, updated_at = now() WHERE id = $1`,
        [id, ...args],
      );
      return { id, updated: true };
    }
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO kb_article (org_id, category, title, body, is_published, branch_id, vertical_id, author_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [await this.orgId(), ...args, me.id],
    );
    return { id: Number(r!.id), created: true };
  }

  async deleteArticle(id: number, me: Me) {
    const row = await this.db.one<any>(`SELECT id FROM kb_article WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Article not found.');
    await this.db.query(`UPDATE kb_article SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ============================================================ ANNOUNCEMENTS */

  /**
   * The reader's view. Only PUBLISHED ones, only those whose audience covers them, each
   * with whether THEY have read it.
   *
   * `role_ids` is an extra narrowing on top of the unit scope: an announcement aimed at
   * Counsellors in Vikaspuri is both. An EMPTY role_ids means everyone in that unit —
   * `[]` is "no filter", not "nobody", and the SQL says so explicitly rather than
   * relying on `= ANY('{}')` returning false, which is the sort of thing that reads as
   * correct and quietly hides every announcement the client writes.
   */
  async announcements(me: Me, scope: ResolvedScope) {
    const params: unknown[] = [me.id];
    const w = this.where(scope, { branch: 'a.branch_id', vertical: 'a.vertical_id' }, params, 'a.branch_id', 'a.vertical_id');
    const rows = await this.db.query<any>(
      `SELECT a.id, a.title, a.body, a.branch_id, a.vertical_id, a.role_ids, a.published_at,
              a.created_by, u.name AS created_by_name,
              br.name AS branch_name, vt.name AS vertical_name,
              EXISTS (SELECT 1 FROM announcement_read r WHERE r.announcement_id = a.id AND r.user_id = $1) AS is_read,
              (SELECT count(*) FROM announcement_read r2 WHERE r2.announcement_id = a.id)::int AS read_count
         FROM announcement a
         LEFT JOIN "user" u ON u.id = a.created_by
         LEFT JOIN branch br ON br.id = a.branch_id
         LEFT JOIN vertical vt ON vt.id = a.vertical_id
        WHERE a.deleted_at IS NULL AND a.is_published AND (${w})
          AND (jsonb_array_length(a.role_ids) = 0
               OR EXISTS (SELECT 1 FROM user_assignment ua
                           WHERE ua.user_id = $1 AND ua.is_active
                             AND a.role_ids @> to_jsonb(ua.role_id)))
        ORDER BY a.published_at DESC NULLS LAST, a.id DESC
        LIMIT 100`,
      params,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  /** The AUTHOR's view — includes drafts, and the read count that makes "read tracking"
   *  mean something. */
  async announcementsAdmin(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.where(scope, { branch: 'a.branch_id', vertical: 'a.vertical_id' }, params, 'a.branch_id', 'a.vertical_id');
    const rows = await this.db.query<any>(
      `SELECT a.id, a.title, a.body, a.branch_id, a.vertical_id, a.role_ids, a.is_published,
              a.published_at, a.notify, a.created_at, u.name AS created_by_name,
              br.name AS branch_name, vt.name AS vertical_name,
              (SELECT count(*) FROM announcement_read r WHERE r.announcement_id = a.id)::int AS read_count
         FROM announcement a
         LEFT JOIN "user" u ON u.id = a.created_by
         LEFT JOIN branch br ON br.id = a.branch_id
         LEFT JOIN vertical vt ON vt.id = a.vertical_id
        WHERE a.deleted_at IS NULL AND (${w})
        ORDER BY a.id DESC LIMIT 200`,
      params,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  async saveAnnouncement(dto: any, me: Me, id?: number) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('An announcement needs a title.');
    const publish = dto?.is_published === true;
    const roleIds = (dto?.role_ids ?? []).map(Number).filter(Boolean);
    const args = [
      title.slice(0, 200), dto?.body ?? '',
      dto?.branch_id ? Number(dto.branch_id) : null, dto?.vertical_id ? Number(dto.vertical_id) : null,
      JSON.stringify(roleIds), publish, dto?.notify !== false,
    ];

    let annId: number;
    let firstPublish = false;
    if (id) {
      const row = await this.db.one<any>(`SELECT * FROM announcement WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!row) throw new NotFoundException('Announcement not found.');
      firstPublish = publish && !row.is_published;
      await this.db.query(
        `UPDATE announcement SET title = $2, body = $3, branch_id = $4, vertical_id = $5,
                role_ids = $6::jsonb, is_published = $7, notify = $8,
                published_at = CASE WHEN $7 AND published_at IS NULL THEN now() ELSE published_at END,
                updated_at = now()
          WHERE id = $1`,
        [id, ...args],
      );
      annId = id;
    } else {
      firstPublish = publish;
      const r = await this.db.one<{ id: string }>(
        `INSERT INTO announcement (org_id, title, body, branch_id, vertical_id, role_ids, is_published, notify,
                                   published_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, CASE WHEN $7 THEN now() ELSE NULL END, $9) RETURNING id`,
        [await this.orgId(), ...args, me.id],
      );
      annId = Number(r!.id);
    }

    // NOTIFY ON FIRST PUBLISH ONLY. Editing a typo in a published announcement must not
    // re-ring every bell in the company — and it must not be possible to make it do so
    // by pressing Save twice.
    if (firstPublish && dto?.notify !== false) await this.notifyAudience(annId, me);
    return { id: annId, published: publish };
  }

  /** Through the SPRINT-3 NOTIFIER — the same bell, the same notification matrix, the
   *  same channels. An announcement is not special enough to deserve its own delivery
   *  mechanism. */
  private async notifyAudience(id: number, me: Me) {
    const a = await this.db.one<any>(`SELECT * FROM announcement WHERE id = $1`, [id]);
    if (!a) return;
    const params: unknown[] = [a.branch_id ?? null, a.vertical_id ?? null, JSON.stringify(a.role_ids ?? [])];
    const users = await this.db.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM "user" u
         JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
        WHERE u.deleted_at IS NULL AND u.status = 'active'
          AND ($1::bigint IS NULL OR ua.branch_id = $1 OR ua.branch_id IS NULL)
          AND ($2::bigint IS NULL OR ua.vertical_id = $2 OR ua.vertical_id IS NULL)
          AND (jsonb_array_length($3::jsonb) = 0 OR $3::jsonb @> to_jsonb(ua.role_id))`,
      params,
    );
    for (const u of users) {
      if (Number(u.id) === me.id) continue;   // nobody needs a bell for their own post
      // type 'system' — the notifier's NotificationType union is a closed set that the
      // notification MATRIX routes on, and an announcement is exactly what 'system' is
      // for. Adding an 'announcement' type would mean a new matrix row the client has
      // to discover and switch on before his first announcement rings anybody's bell.
      await this.notifier.notify({
        userId: Number(u.id),
        type: 'system',
        severity: 'info',
        title: a.title,
        body: String(a.body ?? '').slice(0, 200),
        meta: { kind: 'announcement', announcement_id: id },
      });
    }
  }

  async publishAnnouncement(id: number, me: Me) {
    return this.saveAnnouncement({ ...(await this.db.one<any>(`SELECT * FROM announcement WHERE id = $1`, [id])), is_published: true }, me, id);
  }

  async markRead(id: number, me: Me) {
    await this.db.query(
      `INSERT INTO announcement_read (announcement_id, user_id) VALUES ($1, $2)
       ON CONFLICT (announcement_id, user_id) DO NOTHING`,
      [id, me.id],
    );
    return { id, read: true };
  }

  async deleteAnnouncement(id: number, me: Me) {
    const row = await this.db.one<any>(`SELECT id FROM announcement WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('Announcement not found.');
    await this.db.query(`UPDATE announcement SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, me.id]);
    return { id, deleted: true };
  }
}
