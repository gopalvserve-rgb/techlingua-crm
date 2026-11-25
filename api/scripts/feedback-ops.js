/**
 * Feedback, worked through every day (24 Nov 2026): see what is waiting, take the notes (with their
 * screenshots and recordings) off the server, answer them, and close an answer a day later when the
 * reporter has not come back. Run on the server, from api/, after a deploy (it uses dist/):
 *
 *   node scripts/feedback-ops.js status
 *   node scripts/feedback-ops.js export <out-dir> [FB-2026-001,FB-2026-002]
 *   node scripts/feedback-ops.js answer <answers.json> [--dry-run]
 *   node scripts/feedback-ops.js acknowledge FB-2026-004,FB-2026-005 [--dry-run]
 *   node scripts/feedback-ops.js close FB-2026-002,FB-2026-003 [--hours 24] [--dry-run]
 *   node scripts/feedback-ops.js out-of-scope FB-2026-006 <scope-item-id | new> [--note "..."] [--dry-run]
 *   node scripts/feedback-ops.js file <notes.json> --as <reporter-user-id> [--dry-run]
 *
 * file (25 Nov 2026): points the client sent another way (a document, an email) become notes, filed
 *   in the REPORTER's name — the client's own words, so their thread, their answers, their "That
 *   answers it". notes.json: [{ "page_path": "/m/...", "page_title": "...", "kind": "ISSUE",
 *   "message": "From your 15 Nov feedback document, point 2: ...", "images": ["shot.png"] }]
 *   (images are read next to the JSON file). A note whose exact message is already filed is skipped.
 *
 * Everything is posted as the "Tech Lingua CRM Support" account (migration 143) — never as a person,
 * and it fails rather than falling back when that account is missing. Answers go through
 * FeedbackService.reply with answer:true, so the thread follows the same turn rules as the screen
 * (an answer leaves the note Answered, a reply from the reporter puts it back to Pending) and the
 * reporter gets the same "your feedback has an answer" notification.
 *
 * answers.json: [{ "reference": "FB-2026-002", "body": "Thank you … fixed: …" }]
 *   Posting the same text twice on a note is skipped, so a re-run does no harm.
 * acknowledge: OPEN → Acknowledged (in the queue), no message.
 * close: Answered → Resolved, only when the last word on the thread is our answer and it is at least
 *   --hours old (default 24): the reporter had a day to say it is not right. Anything else is skipped
 *   and the reason printed.
 */
const path = require('path');
const fs = require('fs');
const API = process.env.API_DIR || path.join(__dirname, '..');
require(path.join(API, 'node_modules/dotenv')).config({ path: path.join(API, '.env') });
const { Pool } = require(path.join(API, 'node_modules/pg'));

const SUPPORT_EMAIL = 'crm-support@techlingua.invalid';
const CLOSE_NOTE = 'Resolved: the fix described in the answer is live, and there was no follow-up within a day. '
  + 'If anything still isn\'t right, reply on this note and it opens again.';

const args = process.argv.slice(2);
const cmd = args[0];
const dry = args.includes('--dry-run');
const opt = (name, dflt) => { const i = args.indexOf(name); return i > -1 && args[i + 1] ? args[i + 1] : dflt; };
const refsArg = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter((x) => /^FB-\d{4}-\d{3,}$/.test(x));
const hours = (d) => Math.round((Date.now() - new Date(d).getTime()) / 36e5);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = {
    query: async (s, p) => (await pool.query(s, p)).rows,
    one: async (s, p) => (await pool.query(s, p)).rows[0] ?? null,
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
  };
  const end = () => pool.end();
  try {
    if (cmd === 'status') return await status(db);
    if (cmd === 'export') return await exportNotes(db, args[1], refsArg(args[2]));
    if (cmd === 'file') return await fileNotes(db, args[1], Number(opt('--as', 0)));
    if (!['answer', 'acknowledge', 'close', 'out-of-scope'].includes(cmd)) {
      throw new Error('usage: status | export <dir> [refs] | answer <file> | acknowledge <refs> | close <refs> [--hours 24] | out-of-scope <ref> <item-id|new> [--note ".."] | file <notes.json> --as <user-id> — add --dry-run to see what would happen');
    }

    const me = await db.one(`SELECT id, name FROM "user" WHERE lower(email) = $1 AND deleted_at IS NULL`, [SUPPORT_EMAIL]);
    if (!me) throw new Error(`the support account (${SUPPORT_EMAIL}) is missing — run migration 143`);
    const { FeedbackService } = require(path.join(API, 'dist/feedback/feedback.service'));
    const { NotifierService } = require(path.join(API, 'dist/notifications/notifier.service'));
    const { SettingsService } = require(path.join(API, 'dist/common/settings.service'));
    const svc = new FeedbackService(db, undefined, new NotifierService(db, new SettingsService(db)));
    if (!(await svc.isTeam(Number(me.id)))) throw new Error('the support account is not on the feedback team (feedback.manage)');
    const ctx = { id: Number(me.id) };
    const note = (ref) => db.one(`SELECT id, reference, status, created_by FROM feedback WHERE reference = $1`, [ref]);

    if (cmd === 'answer') {
      const answers = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      if (!Array.isArray(answers)) throw new Error('answers file must be a JSON array');
      for (const a of answers) {
        const body = String(a.body ?? '').trim();
        const n = await note(String(a.reference ?? ''));
        if (!n || body.length < 2) { console.log(`  ${a.reference}: no such note or empty answer, skipped`); continue; }
        const same = await db.one(`SELECT 1 AS x FROM feedback_message WHERE feedback_id = $1 AND body = $2`, [n.id, body]);
        if (same) { console.log(`  ${n.reference}: this answer is already on the thread, skipped`); continue; }
        if (dry) { console.log(`  ${n.reference}: WOULD answer (${n.status} → ANSWERED), ${body.length} chars`); continue; }
        const after = await svc.reply(ctx, Number(n.id), body, { answer: true });
        console.log(`  ${n.reference}: answered as ${me.name} · ${n.status} → ${after?.status ?? '?'}`);
      }
    }

    if (cmd === 'acknowledge') {
      for (const ref of refsArg(args[1])) {
        const n = await note(ref);
        if (!n) { console.log(`  ${ref}: no such note`); continue; }
        if (n.status !== 'OPEN') { console.log(`  ${ref}: is ${n.status}, left as it is`); continue; }
        if (dry) { console.log(`  ${ref}: WOULD acknowledge`); continue; }
        await svc.resolve(ctx, Number(n.id), { status: 'ACKNOWLEDGED' });
        console.log(`  ${ref}: OPEN → ACKNOWLEDGED`);
      }
    }

    if (cmd === 'out-of-scope') {
      // out-of-scope <ref> <scope-item-id | new> [--note "what the team adds"]
      const [ref] = refsArg(args[1]);
      const item = String(args[2] ?? '');
      const n = ref ? await note(ref) : null;
      if (!n) throw new Error('usage: out-of-scope <FB-ref> <scope-item-id | new> [--note "..."]');
      if (item !== 'new' && !/^\d+$/.test(item)) throw new Error('the second argument is a scope-list item id, or "new" for a request no document mentions');
      if (['RESOLVED', 'WONT_FIX', 'OUT_OF_SCOPE'].includes(n.status)) { console.log(`  ${ref}: is ${n.status} already, left as it is`); return; }
      if (dry) { console.log(`  ${ref}: WOULD mark out of scope (${item})`); return; }
      const after = await svc.resolve(ctx, Number(n.id), { status: 'OUT_OF_SCOPE', scope_item_id: item === 'new' ? null : Number(item), resolution: opt('--note', null) });
      console.log(`  ${ref}: ${n.status} → ${after?.status ?? '?'}`);
    }

    if (cmd === 'close') {
      const minH = Number(opt('--hours', '24'));
      for (const ref of refsArg(args[1])) {
        const n = await note(ref);
        if (!n) { console.log(`  ${ref}: no such note`); continue; }
        if (n.status !== 'ANSWERED') { console.log(`  ${ref}: is ${n.status}, not closed`); continue; }
        const last = await db.one(
          `SELECT author_id, is_answer, created_at FROM feedback_message WHERE feedback_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [n.id]);
        if (!last || !last.is_answer) { console.log(`  ${ref}: the last word is not our answer, not closed`); continue; }
        if (hours(last.created_at) < minH) { console.log(`  ${ref}: answered ${hours(last.created_at)}h ago (< ${minH}h), not closed yet`); continue; }
        if (dry) { console.log(`  ${ref}: WOULD resolve (answered ${hours(last.created_at)}h ago)`); continue; }
        await svc.resolve(ctx, Number(n.id), { status: 'RESOLVED', resolution: CLOSE_NOTE });
        console.log(`  ${ref}: ANSWERED → RESOLVED (answered ${hours(last.created_at)}h ago)`);
      }
    }
  } finally { await end(); }
}

/** What is waiting on us (oldest first), and what is answered — with how long ago and who spoke last. */
async function status(db) {
  const rows = await db.query(
    `SELECT f.id, f.reference, f.status, f.kind, f.page_path, f.message, f.created_at, f.updated_at, u.name AS author,
            (SELECT count(*)::int FROM feedback_attachment a WHERE a.feedback_id = f.id) AS files,
            lm.is_answer AS last_is_answer, lm.created_at AS last_at, lu.name AS last_by
       FROM feedback f JOIN "user" u ON u.id = f.created_by
       LEFT JOIN LATERAL (SELECT m.author_id, m.is_answer, m.created_at FROM feedback_message m
                           WHERE m.feedback_id = f.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) lm ON true
       LEFT JOIN "user" lu ON lu.id = lm.author_id
      WHERE f.status IN ('OPEN', 'ACKNOWLEDGED', 'ANSWERED')
      ORDER BY CASE f.status WHEN 'ANSWERED' THEN 1 ELSE 0 END, f.created_at`);
  const counts = await db.query(`SELECT status, count(*)::int AS n FROM feedback GROUP BY status ORDER BY status`);
  console.log('ALL:', counts.map((c) => `${c.status} ${c.n}`).join(' · ') || 'none');
  for (const r of rows) {
    const last = r.last_at ? ` | last word: ${r.last_is_answer ? 'our answer' : r.last_by} ${hours(r.last_at)}h ago` : '';
    console.log(`${r.reference} | ${r.status} | ${r.kind} | ${r.page_path} | filed ${hours(r.created_at)}h ago by ${r.author} | ${r.files} file(s)${last}`);
    console.log(`    ${String(r.message).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

/** Points sent another way (a document) filed as notes in the reporter's own name, with their screenshots. */
async function fileNotes(db, file, asId) {
  if (!file || !asId) throw new Error('usage: file <notes.json> --as <reporter-user-id>');
  const who = await db.one(`SELECT id, name FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [asId]);
  if (!who) throw new Error(`no user ${asId}`);
  const notes = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(notes)) throw new Error('notes file must be a JSON array');
  const { FeedbackService } = require(path.join(API, 'dist/feedback/feedback.service'));
  const { ChannelConfigService } = require(path.join(API, 'dist/messaging/channel-config.service'));
  const { StorageService } = require(path.join(API, 'dist/storage/storage.service'));
  // no notifier: the "new feedback" alert would only tell the team about notes the team itself filed
  const svc = new FeedbackService(db, new StorageService(new ChannelConfigService(db)));
  const me = { id: Number(who.id) };
  for (const n of notes) {
    const message = String(n.message ?? '').trim();
    const dup = await db.one(`SELECT reference FROM feedback WHERE created_by = $1 AND message = $2`, [me.id, message]);
    if (dup) { console.log(`  already filed as ${dup.reference}: ${message.slice(0, 60)}`); continue; }
    if (dry) { console.log(`  WOULD file (${n.page_path}, ${(n.images ?? []).length} image(s)) as ${who.name}: ${message.slice(0, 70)}`); continue; }
    const row = await svc.create(me, { page_path: n.page_path, page_title: n.page_title ?? null, message, kind: n.kind ?? 'ISSUE' });
    for (const img of n.images ?? []) {
      const bytes = fs.readFileSync(path.join(path.dirname(file), img));
      await svc.addAttachment(me, Number(row.id), 'image', bytes, { name: img });
    }
    console.log(`  ${row.reference} ${row.status} — ${(n.images ?? []).length} image(s) — ${message.slice(0, 60)}`);
  }
}

/** The waiting notes (or the ones named) with their thread and files, into <dir>: manifest.json + files. */
async function exportNotes(db, out, refs) {
  if (!out) throw new Error('usage: export <out-dir> [refs]');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const { ChannelConfigService } = require(path.join(API, 'dist/messaging/channel-config.service'));
  const { StorageService } = require(path.join(API, 'dist/storage/storage.service'));
  const storage = new StorageService(new ChannelConfigService(db));
  const notes = await db.query(
    `SELECT f.id, f.reference, f.status, f.kind, f.page_path, f.page_title, f.viewport, f.user_agent, f.message, f.created_at,
            u.name AS author
       FROM feedback f JOIN "user" u ON u.id = f.created_by
      WHERE ${refs.length ? 'f.reference = ANY($1::text[])' : `f.status IN ('OPEN', 'ACKNOWLEDGED')`}
      ORDER BY f.created_at`, refs.length ? [refs] : []);
  const manifest = [];
  for (const n of notes) {
    const thread = await db.query(
      `SELECT m.body, m.is_answer, m.created_at, u.name AS by FROM feedback_message m JOIN "user" u ON u.id = m.author_id
        WHERE m.feedback_id = $1 ORDER BY m.created_at, m.id`, [n.id]);
    const files = await db.query(`SELECT id, kind, file_name, mime, size_bytes, r2_key FROM feedback_attachment WHERE feedback_id = $1 ORDER BY id`, [n.id]);
    const outFiles = [];
    for (const [i, f] of files.entries()) {
      const ext = (String(f.file_name).split('.').pop() || (f.kind === 'video' ? 'webm' : 'png')).toLowerCase().replace(/[^a-z0-9]/g, '');
      const name = `${n.reference}-${i + 1}.${ext}`;
      try {
        const body = f.r2_key ? (await storage.getObject(String(f.r2_key))).body
          : (await db.one(`SELECT content FROM feedback_attachment WHERE id = $1`, [f.id]))?.content;
        if (!body) throw new Error('no bytes');
        fs.writeFileSync(path.join(out, name), body, { mode: 0o600 });
        outFiles.push({ name, kind: f.kind, mime: f.mime, size: Number(f.size_bytes) });
      } catch (e) { outFiles.push({ name, kind: f.kind, error: e.message }); }
    }
    manifest.push({ ...n, id: Number(n.id), thread, files: outFiles });
    console.log(`  ${n.reference}: ${outFiles.length} file(s)`);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`${notes.length} note(s) exported to ${out}`);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
