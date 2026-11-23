import { FeedbackService, LIMITS, sniffImage, sniffVideo } from './feedback.service';

/**
 * Feedback (22 Nov 2026). The rules worth proving: who may see and touch a note, whose turn it is
 * after each reply, that only the reporter accepts and only the team closes, and the file limits
 * (type by bytes, size, count). The same rules run against the real database in the live check
 * (scratchpad verify_feedback.js, inside a rolled-back transaction).
 */
const TEAM = 1, ASHA = 2, RAVI = 3;   // Super Admin; two counsellors

function mk(notes: Record<number, any> = {}, opts: { files?: number } = {}) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const isTeam = (id: number) => id === TEAM;
  const one = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p });
    if (/feedback\.manage/.test(sql)) return isTeam(Number(p[0])) ? { ok: 1 } : null;
    if (/SELECT f\.\* FROM feedback f WHERE f\.id/.test(sql)) {
      const n = notes[Number(p[2])];
      return n && (p[1] || Number(n.created_by) === Number(p[0])) ? n : null;
    }
    if (/FROM organisation/.test(sql)) return { id: '1' };
    if (/FROM user_assignment WHERE user_id/.test(sql)) return { branch_id: '40' };
    if (/nextval\('feedback_reference_seq'\)/.test(sql)) return { n: '7' };
    if (/INSERT INTO feedback \(/.test(sql)) return { id: '99', reference: p[1], page_path: p[2], status: p[10] ?? 'OPEN', created_by: p[6], viewport: p[8] };
    if (/count\(\*\) AS n FROM feedback_attachment/.test(sql)) return { n: String(opts.files ?? 0) };
    if (/INSERT INTO feedback_attachment/.test(sql)) return { id: '5', kind: p[1], file_name: p[2], mime: p[3], size_bytes: String(p[4]) };
    return null;
  });
  const query = jest.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); return []; });
  const tx = jest.fn(async (fn: any) => fn({ query: async (sql: string, p: any[]) => { calls.push({ sql, p }); return { rows: [] }; } }));
  const svc = new FeedbackService({ one, query, tx } as any);
  jest.spyOn(svc, 'get').mockImplementation(async (_me: any, id: number) => ({ id } as any));
  const statusSet = () => calls.filter((c) => /UPDATE feedback SET status/.test(c.sql)).map((c) => c.p[1]);
  const msgs = () => calls.filter((c) => /INSERT INTO feedback_message/.test(c.sql)).map((c) => ({ author: c.p[1], body: c.p[2], answer: c.p[3] }));
  return { svc, calls, statusSet, msgs };
}
const note = (over: any = {}) => ({ id: 10, reference: 'FB-2026-010', created_by: ASHA, status: 'OPEN', ...over });
const page = { page_path: '/m/leads/all', page_title: 'Leads', message: 'The deadline column is empty', kind: 'ISSUE', viewport: '1440x900' };

describe('filing feedback', () => {
  it('records the page it came from, a FB-<year>-<nnn> reference, and the person from the session', async () => {
    const { svc, calls } = mk();
    const row = await svc.create({ id: ASHA }, { ...page, created_by: TEAM });
    expect(row.reference).toMatch(/^FB-\d{4}-007$/);
    const ins = calls.find((c) => /INSERT INTO feedback \(/.test(c.sql))!;
    expect(ins.p[2]).toBe('/m/leads/all');
    expect(ins.p[6]).toBe(ASHA);            // never the created_by the caller sent
    expect(ins.p[7]).toBe('40');             // the reporter's branch
    expect(ins.p[8]).toBe('1440x900');
  });

  it('keeps the path only (no query string), and refuses a full URL, an empty note or an unknown kind', () => {
    expect(FeedbackService.cleanCreate({ ...page, page_path: '/m/leads/all?lead=12#x' }).page_path).toBe('/m/leads/all');
    expect(() => FeedbackService.cleanCreate({ ...page, page_path: 'https://connect.techlingua.net/m/x' })).toThrow(/path, not the full URL/);
    expect(() => FeedbackService.cleanCreate({ ...page, message: ' hi ' })).toThrow(/what went wrong/);
    expect(() => FeedbackService.cleanCreate({ ...page, kind: 'RANT' })).toThrow(/Unknown kind/);
    expect(FeedbackService.cleanCreate({ ...page, kind: undefined }).kind).toBe('ISSUE');
    expect(FeedbackService.cleanCreate({ ...page, user_agent: 'x'.repeat(900) }).user_agent).toHaveLength(400);
  });
});

describe('whose turn it is', () => {
  it('the team answering moves it to ANSWERED; the reporter coming back reopens it — even from Resolved', async () => {
    const a = mk({ 10: note() });
    await a.svc.reply({ id: TEAM }, 10, 'Fixed — please check again.');
    expect(a.statusSet()).toEqual(['ANSWERED']);
    expect(a.msgs()[0]).toMatchObject({ author: TEAM, answer: true });

    const b = mk({ 10: note({ status: 'RESOLVED' }) });
    await b.svc.reply({ id: ASHA }, 10, 'Still wrong on the second page');
    expect(b.statusSet()).toEqual(['OPEN']);
    expect(b.calls.find((c) => /UPDATE feedback SET status/.test(c.sql))!.sql).toMatch(/resolved_by = NULL/);
  });

  it('WONT_FIX is a decision: nobody\'s reply undoes it', async () => {
    const { svc, statusSet } = mk({ 10: note({ status: 'WONT_FIX' }) });
    await svc.reply({ id: ASHA }, 10, 'But I really need it');
    await svc.reply({ id: TEAM }, 10, 'Understood, still no.');
    expect(statusSet()).toEqual(['WONT_FIX', 'WONT_FIX']);
  });

  it('a team member\'s own note: their reply reopens it, their answer (answer: true) does not', async () => {
    const { svc, statusSet } = mk({ 10: note({ created_by: TEAM }) });
    await svc.reply({ id: TEAM }, 10, 'One more thing');
    await svc.reply({ id: TEAM }, 10, 'Done and tested.', { answer: true });
    expect(statusSet()).toEqual(['OPEN', 'ANSWERED']);
  });

  it('a reporter cannot mark their own reply as the answer', async () => {
    const { svc, statusSet } = mk({ 10: note() });
    await svc.reply({ id: ASHA }, 10, 'This is the answer', { answer: true });
    expect(statusSet()).toEqual(['OPEN']);
  });

  it('nobody else can reply, and an empty reply is refused', async () => {
    const { svc, msgs } = mk({ 10: note() });
    await expect(svc.reply({ id: RAVI }, 10, 'me too')).rejects.toThrow(/not found/i);
    await expect(svc.reply({ id: ASHA }, 10, ' ')).rejects.toThrow(/Write something/);
    expect(msgs()).toEqual([]);
  });
});

describe('closing it', () => {
  it('only the reporter accepts the answer — not the team, not another user', async () => {
    const { svc, calls } = mk({ 10: note({ status: 'ANSWERED' }) });
    await expect(svc.accept({ id: TEAM }, 10)).rejects.toThrow(/Only the person who reported it/);
    await expect(svc.accept({ id: RAVI }, 10)).rejects.toThrow(/not found/i);
    await svc.accept({ id: ASHA }, 10);
    const up = calls.find((c) => /status = 'RESOLVED'/.test(c.sql))!;
    expect(up.p).toEqual([10, ASHA]);
  });

  it('only the team resolves or marks won\'t fix, and records who and when', async () => {
    const { svc, calls } = mk({ 10: note() });
    await expect(svc.resolve({ id: ASHA }, 10, { status: 'RESOLVED' })).rejects.toThrow(/Only the team/);
    await svc.resolve({ id: TEAM }, 10, { status: 'WONT_FIX', resolution: 'Out of scope' });
    const up = calls.find((c) => /UPDATE feedback SET status = \$2, resolution/.test(c.sql))!;
    expect(up.p).toEqual([10, 'WONT_FIX', 'Out of scope', TEAM, null]);
    expect(up.sql).toMatch(/resolved_at = now\(\)/);
  });

  it('acknowledging leaves it unresolved; ANSWERED cannot be set by hand', async () => {
    const { svc, calls } = mk({ 10: note() });
    await svc.resolve({ id: TEAM }, 10, { status: 'ACKNOWLEDGED' });
    const up = calls.find((c) => /UPDATE feedback SET status = \$2, resolution/.test(c.sql))!;
    expect(up.p[3]).toBeNull();
    expect(up.sql).toMatch(/resolved_at = NULL/);
    await expect(svc.resolve({ id: TEAM }, 10, { status: 'ANSWERED' })).rejects.toThrow(/Choose Open/);
  });
});

describe('screenshots and screen recordings', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

  it('knows a picture and a video by their bytes, whatever they are called', () => {
    expect(sniffImage(png)?.mime).toBe('image/png');
    expect(sniffImage(jpg)?.mime).toBe('image/jpeg');
    expect(sniffImage(webp)?.mime).toBe('image/webp');
    expect(sniffImage(heic)?.mime).toBe('image/heic');
    expect(sniffImage(Buffer.from('MZ this is an exe really'))).toBeNull();
    expect(sniffVideo(webm, 'video/webm;codecs=vp9,opus')?.ext).toBe('webm');
    expect(sniffVideo(mp4, 'video/mp4')?.ext).toBe('mp4');
    expect(sniffVideo(Buffer.from('MZ not a video at all'), 'video/webm')).toBeNull();
    expect(sniffVideo(heic, 'video/mp4')).toBeNull();
  });

  it('stores a screenshot under the note (in the database when there is no R2) and a recording as screen-recording.webm', async () => {
    const { svc, calls } = mk({ 10: note() });
    const s = await svc.addAttachment({ id: ASHA }, 10, 'image', png, { name: 'my screen.png' });
    expect(s).toMatchObject({ kind: 'image', file_name: 'my screen.png', mime: 'image/png' });
    const v = await svc.addAttachment({ id: ASHA }, 10, 'video', webm, { type: 'video/webm;codecs=vp9,opus' });
    expect(v).toMatchObject({ kind: 'video', file_name: 'screen-recording.webm', mime: 'video/webm' });
    const ins = calls.filter((c) => /INSERT INTO feedback_attachment/.test(c.sql));
    expect(ins[0].p[5]).toBeNull();            // no R2 key …
    expect(Buffer.isBuffer(ins[0].p[6])).toBe(true);   // … the bytes are kept instead
  });

  it('refuses the wrong type, an empty or oversized file, a seventh screenshot, a third recording', async () => {
    const { svc } = mk({ 10: note() });
    await expect(svc.addAttachment({ id: ASHA }, 10, 'image', Buffer.from('%PDF-1.4 not a picture'))).rejects.toThrow(/PNG, JPEG, WebP/);
    await expect(svc.addAttachment({ id: ASHA }, 10, 'video', webm, { type: 'image/png' })).rejects.toThrow(/WebM or MP4/);
    await expect(svc.addAttachment({ id: ASHA }, 10, 'video', Buffer.from('MZ not a video at all'), { type: 'video/webm' })).rejects.toThrow(/not a readable WEBM/);
    await expect(svc.addAttachment({ id: ASHA }, 10, 'video', Buffer.alloc(0), { type: 'video/webm' })).rejects.toThrow(/No recording/);
    await expect(svc.addAttachment({ id: ASHA }, 10, 'image', Buffer.concat([png, Buffer.alloc(LIMITS.imageBytes)]))).rejects.toThrow(/8 MB/);
    await expect(mk({ 10: note() }, { files: 6 }).svc.addAttachment({ id: ASHA }, 10, 'image', png)).rejects.toThrow(/Six screenshots/);
    await expect(mk({ 10: note() }, { files: 2 }).svc.addAttachment({ id: ASHA }, 10, 'video', webm, { type: 'video/webm' })).rejects.toThrow(/Two recordings/);
  });

  it('nobody adds files to somebody else\'s note; the team may', async () => {
    const { svc } = mk({ 10: note() });
    await expect(svc.addAttachment({ id: RAVI }, 10, 'image', png)).rejects.toThrow(/not found/i);
    await expect(svc.addAttachment({ id: TEAM }, 10, 'image', png)).resolves.toMatchObject({ kind: 'image' });
  });
});

describe('who can read it', () => {
  it('every list and count goes through the one access rule (the team, or the author)', async () => {
    const { svc, calls } = mk();
    await svc.list({ id: RAVI }, { status: 'OPEN', page_path: '/m/leads/all' });
    await svc.summary({ id: RAVI });
    const reads = calls.filter((c) => /FROM feedback f/.test(c.sql) && !/f\.id = \$3/.test(c.sql));
    expect(reads.length).toBe(2);
    for (const r of reads) {
      expect(r.sql).toContain(FeedbackService.VISIBLE);
      expect(r.p.slice(0, 2)).toEqual([RAVI, false]);
    }
  });
});
