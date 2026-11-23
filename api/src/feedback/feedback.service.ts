import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { StorageService } from '../storage/storage.service';
import { NotifierService } from '../notifications/notifier.service';
import { NEW_REQUEST_NOTICE, ScopeItem, cleanList, matchScope, scopeNotice } from './feedback-scope';

/**
 * FEEDBACK (22 Nov 2026) — a note pinned to the page it was written on, from the "✎ Feedback"
 * button on every signed-in page: the page (path, title, window size, browser), up to six
 * screenshots and up to two screen recordings with the person's voice. Every note is a
 * conversation, and its status always says WHOSE TURN IT IS:
 *
 *   OPEN / ACKNOWLEDGED  with the team (the Pending tab)
 *   ANSWERED             the team replied; waiting on the reporter
 *   RESOLVED / WONT_FIX  settled (the reporter accepted, or the team closed it)
 *   OUT_OF_SCOPE         not in the agreed scope documents: "we can't take this" (23 Nov 2026) —
 *                        set by itself when the note names an item on the scope list, or by the team
 *
 * WHO (one rule, in visibleNote()/list()): everyone may file; a reporter sees only their own
 * notes; holders of feedback.manage — the team — see, answer and close all of them. A reporter
 * may reply on their own note (which reopens it, even from Resolved) and accept the answer.
 */
export const KINDS = ['ISSUE', 'SUGGESTION', 'QUESTION', 'PRAISE'] as const;
export const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'ANSWERED', 'RESOLVED', 'WONT_FIX', 'OUT_OF_SCOPE'] as const;
/** What the team may set by hand. ANSWERED only ever follows from a reply. */
const SETTABLE = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'WONT_FIX', 'OUT_OF_SCOPE'];
const CLOSING = ['RESOLVED', 'WONT_FIX', 'OUT_OF_SCOPE'];
export const KIND_WORD: Record<string, string> = {
  ISSUE: 'Something is wrong', SUGGESTION: 'Could be better', QUESTION: 'A question', PRAISE: 'Works well',
};
export const LIMITS = { imageBytes: 8 * 1024 * 1024, images: 6, videoBytes: 50 * 1024 * 1024, videos: 2 };

type Me = { id: number | string };
type Sniff = { mime: string; ext: string };

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const ftypBrand = (b: Buffer) => (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' ? b.toString('latin1', 8, 12) : null);

/** A screenshot, by its bytes: PNG, JPEG, WebP, or an iPhone photo (HEIC). */
export function sniffImage(b: Buffer): Sniff | null {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  const brand = ftypBrand(b);
  if (brand && HEIC_BRANDS.includes(brand)) return { mime: 'image/heic', ext: 'heic' };
  return null;
}

/**
 * A screen recording, by its bytes, as the browser's MediaRecorder makes it: WebM (Chrome, Edge,
 * Firefox) starts with the EBML header 1A 45 DF A3; MP4 (Safari) has "ftyp" at byte 4.
 */
export function sniffVideo(b: Buffer, declared: string): Sniff | null {
  const mime = String(declared ?? '').split(';')[0].trim().toLowerCase();
  if (!b || b.length < 12) return null;
  if (mime === 'video/webm') return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 ? { mime, ext: 'webm' } : null;
  if (mime === 'video/mp4') { const brand = ftypBrand(b); return brand && !HEIC_BRANDS.includes(brand) ? { mime, ext: 'mp4' } : null; }
  return null;
}

const safeName = (raw: unknown, fallback: string) =>
  String(raw ?? '').trim().replace(/[\r\n\t]+/g, ' ').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120) || fallback;
const istYear = () => Number(new Intl.DateTimeFormat('en-IN', { year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date()));
const str = (v: unknown, max: number) => {
  const t = v == null ? '' : String(v).trim();
  return t ? t.slice(0, max) : null;
};

export interface CreateFeedbackInput {
  page_path: string; page_title?: string | null; message: string; kind?: string; viewport?: string | null; user_agent?: string | null;
}

@Injectable()
export class FeedbackService {
  private readonly log = new Logger('Feedback');
  /** "New feedback" goes to the team a minute after filing, once the files are attached. */
  static NOTIFY_DELAY_MS = 60_000;

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly notifier?: NotifierService,
  ) {}

  /** The team: holds feedback.manage through an active role assignment. */
  async isTeam(userId: number): Promise<boolean> {
    const r = await this.db.one(
      `SELECT 1 AS ok FROM user_assignment ua JOIN role_permission rp ON rp.role_id = ua.role_id
         JOIN permission p ON p.id = rp.permission_id
        WHERE ua.user_id = $1 AND ua.is_active AND p.key = 'feedback.manage' LIMIT 1`, [userId]);
    return !!r;
  }

  /**
   * THE access rule, written once: the team sees every note, anybody else only their own.
   * Params: $1 = the caller's user id, $2 = whether the caller is on the team.
   */
  static readonly VISIBLE = `($2::boolean OR f.created_by = $1::bigint)`;

  private async visibleNote(meId: number, id: number, team: boolean) {
    return this.db.one<any>(`SELECT f.* FROM feedback f WHERE f.id = $3::bigint AND ${FeedbackService.VISIBLE}`, [meId, team, id]);
  }

  /* ------------------------------------------------------------------ filing */

  static cleanCreate(dto: any): Required<CreateFeedbackInput> {
    const page_path = String(dto?.page_path ?? '').trim();
    if (!page_path || !page_path.startsWith('/')) throw new BadRequestException('Send the page path, not the full URL');
    if (page_path.length > 512) throw new BadRequestException('That page path is too long');
    const message = String(dto?.message ?? '').trim();
    if (message.length < 3) throw new BadRequestException('Tell us what went wrong');
    if (message.length > 4000) throw new BadRequestException('Keep the note under 4000 characters');
    const kind = dto?.kind == null || dto.kind === '' ? 'ISSUE' : String(dto.kind).toUpperCase();
    if (!(KINDS as readonly string[]).includes(kind)) throw new BadRequestException('Unknown kind of feedback');
    return {
      page_path: page_path.split('?')[0].split('#')[0],
      page_title: str(dto?.page_title, 200), message, kind,
      viewport: str(dto?.viewport, 32), user_agent: str(dto?.user_agent, 400),
    };
  }

  /**
   * created_by and branch come from the session, never from the request. A note that names an item
   * on the scope list (or is left on one of its screens) is saved as OUT_OF_SCOPE straight away,
   * with the scope document's words as its outcome — recorded, never lost, and not on the to-do list.
   */
  async create(me: Me, dto: any) {
    const input = FeedbackService.cleanCreate(dto);
    const meId = Number(me.id);
    const hit = matchScope(await this.scopeItems(true), input.message, input.page_path);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const br = await this.db.one<{ branch_id: string }>(
      `SELECT branch_id FROM user_assignment WHERE user_id = $1 AND is_active AND branch_id IS NOT NULL ORDER BY id LIMIT 1`, [meId]);
    const seq = await this.db.one<{ n: string }>(`SELECT nextval('feedback_reference_seq') AS n`);
    const reference = `FB-${istYear()}-${String(seq?.n ?? 0).padStart(3, '0')}`;
    const row = await this.db.one<any>(
      `INSERT INTO feedback (org_id, reference, page_path, page_title, message, kind, created_by, branch_id, viewport, user_agent,
                             status, scope_item_id, scope_auto, resolution, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${hit ? 'now()' : 'NULL'}) RETURNING *`,
      [org?.id ?? null, reference, input.page_path, input.page_title, input.message, input.kind, meId,
        br?.branch_id ?? null, input.viewport, input.user_agent,
        hit ? 'OUT_OF_SCOPE' : 'OPEN', hit ? hit.item.id : null, !!hit, hit ? scopeNotice(hit.item) : null]);
    if (this.notifier) {
      const t = setTimeout(() => { void this.notifyNew(Number(row.id)); }, FeedbackService.NOTIFY_DELAY_MS);
      (t as { unref?: () => void }).unref?.();
    }
    return row;
  }

  /* ------------------------------------------------------------------ reading */

  /** Notes with their thread and files. The team gets everything, a reporter their own. */
  async list(me: Me, q: { status?: string; kind?: string; page_path?: string } = {}, onlyId?: number) {
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const where = [FeedbackService.VISIBLE];
    const p: unknown[] = [meId, team];
    const status = String(q?.status ?? '').toUpperCase();
    if ((STATUSES as readonly string[]).includes(status)) { p.push(status); where.push(`f.status = $${p.length}`); }
    const kind = String(q?.kind ?? '').toUpperCase();
    if ((KINDS as readonly string[]).includes(kind)) { p.push(kind); where.push(`f.kind = $${p.length}`); }
    if (q?.page_path) { p.push(String(q.page_path).slice(0, 512)); where.push(`f.page_path = $${p.length}`); }
    if (onlyId) { p.push(onlyId); where.push(`f.id = $${p.length}::bigint`); }
    const rows = await this.db.query<any>(
      `SELECT f.id, f.reference, f.page_path, f.page_title, f.message, f.kind, f.status, f.created_by, f.viewport,
              f.user_agent, f.resolution, f.resolved_by, f.resolved_at, f.created_at, f.updated_at,
              f.scope_item_id, f.scope_auto, si.title AS scope_title,
              u.name AS author_name, ar.role_name AS author_role, b.name AS branch_name, rv.name AS resolver_name
         FROM feedback f
         JOIN "user" u ON u.id = f.created_by
         LEFT JOIN feedback_scope_item si ON si.id = f.scope_item_id
         LEFT JOIN branch b ON b.id = f.branch_id
         LEFT JOIN "user" rv ON rv.id = f.resolved_by
         LEFT JOIN LATERAL (SELECT r.name AS role_name FROM user_assignment ua JOIN role r ON r.id = ua.role_id
                             WHERE ua.user_id = f.created_by AND ua.is_active ORDER BY ua.id LIMIT 1) ar ON true
        WHERE ${where.join(' AND ')}
        ORDER BY CASE f.status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 WHEN 'ANSWERED' THEN 2 ELSE 3 END, f.created_at DESC
        LIMIT 200`, p);
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const msgs = await this.db.query<any>(
      `SELECT m.id, m.feedback_id, m.body, m.is_answer, m.created_at, m.author_id, u.name AS author_name,
              (SELECT r.name FROM user_assignment ua JOIN role r ON r.id = ua.role_id
                WHERE ua.user_id = m.author_id AND ua.is_active ORDER BY ua.id LIMIT 1) AS author_role
         FROM feedback_message m JOIN "user" u ON u.id = m.author_id
        WHERE m.feedback_id = ANY($1::bigint[]) ORDER BY m.created_at, m.id`, [ids]);
    const files = await this.db.query<any>(
      `SELECT id, feedback_id, kind, file_name, mime, size_bytes, created_at FROM feedback_attachment
        WHERE feedback_id = ANY($1::bigint[]) ORDER BY created_at, id`, [ids]);
    return rows.map((r) => {
      const id = Number(r.id);
      const mine = (x: any) => Number(x.feedback_id) === id;
      const file = (a: any) => ({ id: Number(a.id), kind: a.kind, file_name: a.file_name, mime: a.mime, size_bytes: Number(a.size_bytes), created_at: a.created_at });
      return {
        ...r,
        id,
        created_by: Number(r.created_by),
        resolved_by: r.resolved_by == null ? null : Number(r.resolved_by),
        scope_item_id: r.scope_item_id == null ? null : Number(r.scope_item_id),
        scope_auto: !!r.scope_auto,
        author: { id: Number(r.created_by), name: r.author_name, role: r.author_role ?? null, branch: r.branch_name ?? null },
        resolver: r.resolved_by == null ? null : { id: Number(r.resolved_by), name: r.resolver_name },
        messages: msgs.filter(mine).map((m) => ({
          id: Number(m.id), body: m.body, is_answer: !!m.is_answer, created_at: m.created_at,
          author: { id: Number(m.author_id), name: m.author_name, role: m.author_role ?? null },
        })),
        screenshots: files.filter((a) => mine(a) && a.kind === 'image').map(file),
        recordings: files.filter((a) => mine(a) && a.kind === 'video').map(file),
      };
    });
  }

  async get(me: Me, id: number) {
    const [row] = await this.list(me, {}, id);
    if (!row) throw new NotFoundException('Feedback not found');
    return row;
  }

  /** Counts by status — of what the caller may see — and whether they are on the team. */
  async summary(me: Me) {
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const rows = await this.db.query<{ status: string; n: string }>(
      `SELECT f.status, count(*) AS n FROM feedback f WHERE ${FeedbackService.VISIBLE} GROUP BY f.status`, [meId, team]);
    const c = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    return {
      team,
      open: c.OPEN ?? 0, acknowledged: c.ACKNOWLEDGED ?? 0, answered: c.ANSWERED ?? 0,
      resolved: c.RESOLVED ?? 0, wont_fix: c.WONT_FIX ?? 0, out_of_scope: c.OUT_OF_SCOPE ?? 0,
      pending: (c.OPEN ?? 0) + (c.ACKNOWLEDGED ?? 0),
    };
  }

  /* ------------------------------------------------------------------ files */

  /**
   * A screenshot or a screen recording, on a note the caller filed (or any note, for the team).
   * The type is decided by the file's bytes, not its name or the browser's word for it.
   */
  async addAttachment(me: Me, id: number, kind: 'image' | 'video', bytes: Buffer, opts: { name?: string; type?: string } = {}) {
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const note = await this.visibleNote(meId, id, team);
    if (!note) throw new NotFoundException('Feedback not found');
    if (Number(note.created_by) !== meId && !team) {
      throw new ForbiddenException(kind === 'image' ? 'You can only add screenshots to your own feedback' : 'You can only add a recording to your own feedback');
    }
    let t: Sniff | null;
    let fileName: string;
    if (kind === 'image') {
      if (!bytes?.length) throw new BadRequestException('No screenshot was sent');
      if (bytes.length > LIMITS.imageBytes) throw new BadRequestException('A screenshot can be 8 MB at most');
      t = sniffImage(bytes);
      if (!t) throw new BadRequestException('Screenshots have to be PNG, JPEG, WebP or an iPhone photo (HEIC)');
      fileName = safeName(opts.name, `screenshot.${t.ext}`);
      if (!fileName.toLowerCase().endsWith(`.${t.ext}`) && !(t.ext === 'jpg' && /\.jpe?g$/i.test(fileName))) fileName = `${fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${t.ext}`;
    } else {
      if (!bytes?.length) throw new BadRequestException('No recording was sent');
      const declared = String(opts.type ?? '').split(';')[0].trim().toLowerCase();
      if (declared !== 'video/webm' && declared !== 'video/mp4') throw new BadRequestException('A recording has to be a WebM or MP4 video');
      if (bytes.length > LIMITS.videoBytes) throw new BadRequestException('A recording can be 50 MB at most — record a shorter one');
      t = sniffVideo(bytes, declared);
      if (!t) throw new BadRequestException(`That file is not a readable ${declared === 'video/mp4' ? 'MP4' : 'WEBM'} video`);
      fileName = `screen-recording.${t.ext}`;
    }
    const have = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM feedback_attachment WHERE feedback_id = $1 AND kind = $2`, [id, kind]);
    if (Number(have?.n ?? 0) >= (kind === 'image' ? LIMITS.images : LIMITS.videos)) {
      throw new BadRequestException(kind === 'image' ? 'Six screenshots is the most one note takes' : 'Two recordings is the most one note takes');
    }
    // Cloudflare R2 (private; served by short-lived signed links) when configured, else the database.
    let r2Key: string | null = null;
    if (this.storage && await this.storage.isConfigured()) {
      r2Key = `feedback/${id}/${randomUUID()}-${fileName.replace(/ /g, '_')}`;
      try { await this.storage.putObject(r2Key, bytes, t.mime); } catch (e) {
        this.log.warn(`feedback file to R2 failed, kept in the database: ${(e as Error).message}`);
        r2Key = null;
      }
    }
    const row = await this.db.one<any>(
      `INSERT INTO feedback_attachment (feedback_id, kind, file_name, mime, size_bytes, r2_key, content, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, kind, file_name, mime, size_bytes, created_at`,
      [id, kind, fileName, t.mime, bytes.length, r2Key, r2Key ? null : bytes, meId]);
    return { ...row, id: Number(row.id), size_bytes: Number(row.size_bytes) };
  }

  private async visibleFile(me: Me, fileId: number) {
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const f = await this.db.one<any>(
      `SELECT a.id, a.kind, a.file_name, a.mime, a.size_bytes, a.r2_key, (a.content IS NOT NULL) AS in_db
         FROM feedback_attachment a JOIN feedback f ON f.id = a.feedback_id
        WHERE a.id = $3::bigint AND ${FeedbackService.VISIBLE}`, [meId, team, fileId]);
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  /** A short-lived signed link to the file in R2 — or null: then read it through /raw. */
  async fileUrl(me: Me, fileId: number) {
    const f = await this.visibleFile(me, fileId);
    let url: string | null = null;
    if (f.r2_key && this.storage) {
      try { url = await this.storage.presignGet(String(f.r2_key), 300, String(f.file_name)); } catch { url = null; }
    }
    return { id: Number(f.id), kind: f.kind, mime: f.mime, file_name: f.file_name, url };
  }

  async fileBytes(me: Me, fileId: number): Promise<{ body: Buffer; mime: string; file_name: string }> {
    const f = await this.visibleFile(me, fileId);
    if (f.r2_key && this.storage) {
      const o = await this.storage.getObject(String(f.r2_key));
      return { body: o.body, mime: String(f.mime), file_name: String(f.file_name) };
    }
    const row = await this.db.one<{ content: Buffer }>(`SELECT content FROM feedback_attachment WHERE id = $1`, [fileId]);
    if (!row?.content) throw new NotFoundException('File not found');
    return { body: row.content, mime: String(f.mime), file_name: String(f.file_name) };
  }

  /* ------------------------------------------------------------------ the thread */

  /**
   * A message on the thread, and the turn it moves to. Decided by whether the REPORTER just spoke
   * — not by whether the speaker is on the team: a team member files notes too, and their own
   * reply on their own note is "the reporter came back". When the team posts the official answer
   * from the account that filed the note (one shared admin login), `answer: true` says so.
   * WONT_FIX is a decision, not a turn: a reply never undoes it. OUT_OF_SCOPE too — except when it
   * was set automatically and the reporter comes back (it may be a problem on a screen they already
   * have): then a person on the team looks at it again, so it goes back to Pending.
   */
  async reply(me: Me, id: number, body: unknown, opts: { answer?: boolean } = {}) {
    const text = String(body ?? '').trim();
    if (text.length < 2) throw new BadRequestException('Write something before sending');
    if (text.length > 4000) throw new BadRequestException('Keep the reply under 4000 characters');
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const note = await this.visibleNote(meId, id, team);
    if (!note) throw new NotFoundException('Feedback not found');
    const mine = Number(note.created_by) === meId;
    if (!team && !mine) throw new ForbiddenException('That feedback is not yours');
    const asAnswer = !mine || (team && !!opts.answer);
    const next = note.status === 'WONT_FIX' ? 'WONT_FIX'
      : note.status === 'OUT_OF_SCOPE' ? (note.scope_auto && !asAnswer ? 'OPEN' : 'OUT_OF_SCOPE')
        : asAnswer ? 'ANSWERED' : 'OPEN';
    const leavesScope = note.status === 'OUT_OF_SCOPE' && next === 'OPEN';
    await this.db.tx(async (c) => {
      await c.query(`INSERT INTO feedback_message (feedback_id, author_id, body, is_answer) VALUES ($1, $2, $3, $4)`, [id, meId, text, asAnswer]);
      await c.query(
        `UPDATE feedback SET status = $2, updated_at = now()${next === 'OPEN' ? ', resolved_by = NULL, resolved_at = NULL' : ''}${leavesScope ? ', resolution = NULL, scope_item_id = NULL, scope_auto = false' : ''} WHERE id = $1`,
        [id, next]);
    });
    void this.notifyReply(note, meId, asAnswer, text);
    return this.get(me, id);
  }

  /** The reporter saying the answer settles it. Their own note only. */
  async accept(me: Me, id: number) {
    const meId = Number(me.id);
    const team = await this.isTeam(meId);
    const note = await this.visibleNote(meId, id, team);
    if (!note) throw new NotFoundException('Feedback not found');
    if (Number(note.created_by) !== meId) throw new ForbiddenException('Only the person who reported it can accept the answer');
    await this.db.query(
      `UPDATE feedback SET status = 'RESOLVED', resolved_by = $2, resolved_at = now(), updated_at = now() WHERE id = $1`, [id, meId]);
    return this.get(me, id);
  }

  /**
   * The team acknowledging, re-opening or closing a note (Resolved / Won't fix / Out of scope), with
   * an outcome note. Out of scope takes the scope-list item it falls under (`scope_item_id`), or none
   * for a new request that no agreed document mentions; the reporter then reads the scope document's
   * words, and the team's own note after them.
   */
  async resolve(me: Me, id: number, dto: any) {
    const meId = Number(me.id);
    if (!(await this.isTeam(meId))) throw new ForbiddenException('Only the team can close or change feedback');
    const status = String(dto?.status ?? '').toUpperCase();
    if (!SETTABLE.includes(status)) throw new BadRequestException('Choose Open, Acknowledged, Resolved, Won\'t fix or Out of scope');
    let resolution = dto?.resolution == null ? null : String(dto.resolution).trim().slice(0, 2000) || null;
    const note = await this.visibleNote(meId, id, true);
    if (!note) throw new NotFoundException('Feedback not found');
    let scopeItemId: number | null = null;
    if (status === 'OUT_OF_SCOPE') {
      let base = NEW_REQUEST_NOTICE;
      if (dto?.scope_item_id != null && dto.scope_item_id !== '') {
        const sid = Number(dto.scope_item_id);
        const item = Number.isInteger(sid) && sid > 0
          ? await this.db.one<any>(`SELECT id, title, reference, doc_says FROM feedback_scope_item WHERE id = $1`, [sid]) : null;
        if (!item) throw new BadRequestException('Pick an item from the scope list, or "New request"');
        scopeItemId = sid;
        base = scopeNotice(item);
      }
      resolution = resolution ? `${base} Note from the team: ${resolution}` : base;
    }
    const closing = CLOSING.includes(status);
    // leaving Out of scope drops its words, so they can't become the outcome of a later Resolve
    const replace = status === 'OUT_OF_SCOPE' || note.status === 'OUT_OF_SCOPE';
    await this.db.query(
      `UPDATE feedback SET status = $2, resolution = ${replace ? '$3' : 'COALESCE($3, resolution)'},
              resolved_by = $4, resolved_at = ${closing ? 'now()' : 'NULL'}, scope_item_id = $5, scope_auto = false,
              updated_at = now() WHERE id = $1`,
      [id, status, resolution, closing ? meId : null, scopeItemId]);
    if (closing && Number(note.created_by) !== meId) {
      void this.notifyUsers([Number(note.created_by)], {
        title: `Your feedback ${note.reference} is ${status === 'RESOLVED' ? 'resolved' : status === 'OUT_OF_SCOPE' ? 'out of scope' : 'closed (won\'t fix)'}`,
        body: resolution ?? undefined, id,
      });
    }
    return this.get(me, id);
  }

  /* ------------------------------------------------------------------ the scope list */

  private static scopeRow(r: any) {
    const item: ScopeItem = {
      id: Number(r.id), title: r.title, reference: r.reference, doc_says: r.doc_says ?? null,
      phrases: r.phrases ?? [], page_paths: r.page_paths ?? [], is_active: !!r.is_active,
    };
    return { ...item, sort_order: Number(r.sort_order ?? 0), notice: scopeNotice(item), updated_at: r.updated_at ?? null };
  }

  /** The scope list, in its order; the switched-off items only when asked. */
  async scopeItems(activeOnly = true) {
    const rows = await this.db.query<any>(
      `SELECT id, title, reference, doc_says, phrases, page_paths, is_active, sort_order, updated_at
         FROM feedback_scope_item${activeOnly ? ' WHERE is_active' : ''} ORDER BY sort_order, id`);
    return (rows ?? []).map((r) => FeedbackService.scopeRow(r));
  }

  /** Everyone may read what is out of scope (the panel checks a note against it as it is typed); the team also sees what is switched off. */
  async scopeList(me: Me) {
    return this.scopeItems(!(await this.isTeam(Number(me.id))));
  }

  static cleanScope(dto: any, partial = false) {
    const has = (k: string) => !!dto && Object.prototype.hasOwnProperty.call(dto, k);
    const out: { title?: string; reference?: string; doc_says?: string | null; phrases?: string[]; page_paths?: string[]; is_active?: boolean; sort_order?: number } = {};
    if (!partial || has('title')) {
      const t = String(dto?.title ?? '').trim().replace(/\s+/g, ' ');
      if (t.length < 3) throw new BadRequestException('Name what is out of scope');
      out.title = t.slice(0, 160);
    }
    if (!partial || has('reference')) {
      const t = String(dto?.reference ?? '').trim().replace(/\s+/g, ' ');
      if (t.length < 5) throw new BadRequestException('Say where the scope document says so — the document and its section');
      out.reference = t.slice(0, 300);
    }
    if (!partial || has('doc_says')) out.doc_says = str(dto?.doc_says, 300);
    if (!partial || has('phrases')) out.phrases = cleanList(dto?.phrases, { max: 40 });
    if (!partial || has('page_paths')) out.page_paths = cleanList(dto?.page_paths, { max: 10, path: true });
    if (has('is_active')) out.is_active = dto.is_active === true || dto.is_active === 'true';
    if (has('sort_order')) out.sort_order = Math.max(0, Math.min(9999, Math.round(Number(dto.sort_order) || 0)));
    return out;
  }

  private static needsMatch(v: { phrases?: string[]; page_paths?: string[] }) {
    if (!(v.phrases ?? []).length && !(v.page_paths ?? []).length) {
      throw new BadRequestException('Add the words (or the screen) that mean this item, so a note can be matched to it');
    }
  }

  async createScope(me: Me, dto: any) {
    const meId = Number(me.id);
    if (!(await this.isTeam(meId))) throw new ForbiddenException('Only the team can change the scope list');
    const v = FeedbackService.cleanScope(dto);
    FeedbackService.needsMatch(v);
    if (await this.db.one(`SELECT id FROM feedback_scope_item WHERE lower(title) = lower($1)`, [v.title])) {
      throw new BadRequestException('That item is already on the scope list');
    }
    const row = await this.db.one<any>(
      `INSERT INTO feedback_scope_item (title, reference, doc_says, phrases, page_paths, is_active, sort_order, created_by)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6,
               COALESCE($7::int, (SELECT COALESCE(max(sort_order), 0) + 10 FROM feedback_scope_item)), $8) RETURNING *`,
      [v.title, v.reference, v.doc_says ?? null, v.phrases, v.page_paths, v.is_active ?? true, v.sort_order ?? null, meId]);
    return FeedbackService.scopeRow(row);
  }

  async updateScope(me: Me, id: number, dto: any) {
    if (!(await this.isTeam(Number(me.id)))) throw new ForbiddenException('Only the team can change the scope list');
    const cur = await this.db.one<any>(`SELECT * FROM feedback_scope_item WHERE id = $1`, [id]);
    if (!cur) throw new NotFoundException('That item is not on the scope list');
    const v = FeedbackService.cleanScope(dto, true);
    const next = { ...cur, ...v };
    FeedbackService.needsMatch(next);
    if (v.title && await this.db.one(`SELECT id FROM feedback_scope_item WHERE lower(title) = lower($1) AND id <> $2`, [v.title, id])) {
      throw new BadRequestException('That item is already on the scope list');
    }
    const row = await this.db.one<any>(
      `UPDATE feedback_scope_item SET title = $2, reference = $3, doc_says = $4, phrases = $5::text[], page_paths = $6::text[],
              is_active = $7, sort_order = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, next.title, next.reference, next.doc_says, next.phrases, next.page_paths, !!next.is_active, Number(next.sort_order ?? 0)]);
    return FeedbackService.scopeRow(row);
  }

  /* ------------------------------------------------------------------ telling people */

  private async teamIds(exceptId?: number): Promise<number[]> {
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT ua.user_id FROM user_assignment ua JOIN role_permission rp ON rp.role_id = ua.role_id
         JOIN permission p ON p.id = rp.permission_id JOIN "user" u ON u.id = ua.user_id
        WHERE ua.is_active AND p.key = 'feedback.manage' AND u.deleted_at IS NULL`);
    return rows.map((r) => Number(r.user_id)).filter((n) => n !== exceptId);
  }

  private async notifyUsers(ids: number[], m: { title: string; body?: string; id: number; severity?: 'info' | 'warn' }) {
    if (!this.notifier || !ids.length) return;
    try {
      await this.notifier.notifyMany(ids, {
        type: 'system', severity: m.severity ?? 'info', title: m.title.slice(0, 200), body: m.body,
        link: { type: 'feedback', id: m.id }, meta: { feedback_id: m.id },
      });
    } catch (e) { this.log.warn(`feedback notification failed: ${(e as Error).message}`); }
  }

  /** "New feedback FB-2026-001 · Something is wrong" — to the team, with what is attached. */
  async notifyNew(id: number) {
    try {
      const f = await this.db.one<any>(
        `SELECT f.reference, f.kind, f.status, f.page_title, f.page_path, f.message, f.created_by, u.name AS author,
                (SELECT count(*) FROM feedback_attachment a WHERE a.feedback_id = f.id AND a.kind = 'image') AS shots,
                (SELECT count(*) FROM feedback_attachment a WHERE a.feedback_id = f.id AND a.kind = 'video') AS videos
           FROM feedback f JOIN "user" u ON u.id = f.created_by WHERE f.id = $1`, [id]);
      if (!f) return;
      const shots = Number(f.shots), videos = Number(f.videos);
      const attached = [shots ? `${shots} screenshot${shots > 1 ? 's' : ''}` : '', videos ? `${videos} screen recording${videos > 1 ? 's' : ''}` : '']
        .filter(Boolean).join(', ');
      const said = String(f.message).replace(/\s+/g, ' ').slice(0, 400) + (String(f.message).length > 400 ? '…' : '');
      const outOfScope = f.status === 'OUT_OF_SCOPE';
      await this.notifyUsers(await this.teamIds(Number(f.created_by)), {
        title: outOfScope ? `Out-of-scope request ${f.reference} (closed by itself)` : `New feedback ${f.reference} · ${KIND_WORD[f.kind] ?? f.kind}`,
        body: `${f.page_title || f.page_path} — ${f.author}: "${said}"${attached ? ` · ${attached}` : ''}`,
        id, severity: f.kind === 'ISSUE' && !outOfScope ? 'warn' : 'info',
      });
    } catch (e) { this.log.warn(`new-feedback notification failed: ${(e as Error).message}`); }
  }

  private async notifyReply(note: any, meId: number, asAnswer: boolean, text: string) {
    const said = text.replace(/\s+/g, ' ').slice(0, 300);
    const id = Number(note.id);
    if (asAnswer) {
      if (Number(note.created_by) !== meId) {
        await this.notifyUsers([Number(note.created_by)], { title: `Your feedback ${note.reference} has an answer`, body: said, id });
      }
    } else {
      await this.notifyUsers(await this.teamIds(meId), { title: `Feedback ${note.reference}: the reporter replied`, body: said, id });
    }
  }
}
