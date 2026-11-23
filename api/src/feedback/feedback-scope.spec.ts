import { FeedbackService } from './feedback.service';
import { NEW_REQUEST_NOTICE, ScopeItem, cleanList, matchScope, scopeNotice } from './feedback-scope';

/**
 * Out of scope (23 Nov 2026): a note that names something the agreed documents leave out is told
 * "we can't take this", with the document and section — and is still recorded. What has to hold:
 * the matching is by whole words (a bug on a screen the client has is never turned away by a loose
 * word), the saved note is closed as OUT_OF_SCOPE with the document's words, the team can mark any
 * note out of scope (against an item or as a new request), and an automatic flag the reporter
 * disputes goes back to a person.
 */
const TEAM = 1, ASHA = 2;
const CALLS: ScopeItem = {
  id: 1, title: 'Call transfer, conference calling and call routing',
  reference: 'Client Requirements Discovery Document, §7 Calls (Telephony) › Transfer / Conference / Routing',
  doc_says: 'answered "Not required"',
  phrases: ['call transfer', 'conference call', 'call routing'], page_paths: ['/m/calls/transfer'], is_active: true,
};
const HIRING: ScopeItem = {
  id: 6, title: 'Staff hiring and recruitment', reference: 'Client Requirements Discovery Document, §11 HR & Workforce › Hiring',
  doc_says: 'left unanswered, so not agreed', phrases: ['staff hiring', 'recruitment module'], page_paths: ['/m/hr/hiring'], is_active: true,
};

describe('matching a note to the scope list', () => {
  it('finds an item by its words — whole words, any case, punctuation ignored, a plural allowed', () => {
    expect(matchScope([CALLS], 'Please add CALL-TRANSFER to the dialer')?.item.id).toBe(1);
    expect(matchScope([CALLS], 'we need conference calls with the student and parent')?.item.id).toBe(1);
    expect(matchScope([CALLS], 'call transfer karna hai counsellor ko')?.phrase).toBe('call transfer');
  });

  it('never turns away a problem on a screen the client has: no partial words, no loose matches', () => {
    expect(matchScope([CALLS], 'The batch transfer screen does not save')).toBeNull();
    expect(matchScope([CALLS], 'call transferred count is wrong on the report')).toBeNull();   // "transferred" is not "transfer"
    expect(matchScope([CALLS, HIRING], 'Course transfer keeps the old fee')).toBeNull();
    expect(matchScope([CALLS], '')).toBeNull();
  });

  it('a note left on one of the item\'s screens matches it, whatever it says; switched-off items never match', () => {
    expect(matchScope([CALLS, HIRING], 'this page is empty', '/m/hr/hiring')).toMatchObject({ item: { id: 6 }, by: 'page' });
    expect(matchScope([CALLS], 'blank', '/m/calls/transfer?x=1')?.by).toBe('page');
    expect(matchScope([CALLS], 'blank', '/m/calls/transferlist')).toBeNull();     // a prefix of a word is not the screen
    expect(matchScope([{ ...CALLS, is_active: false }], 'add call transfer')).toBeNull();
  });

  it('says it the way the user asked: out of scope, we can\'t take this, refer to the document — not available', () => {
    const n = scopeNotice(CALLS);
    expect(n).toMatch(/^Out of scope — we can't take this\./);
    expect(n).toContain('"Call transfer, conference calling and call routing" is not available in this project');
    expect(n).toContain('refer to the scope document: Client Requirements Discovery Document, §7 Calls');
    expect(n).toContain('answered "Not required"');
    expect(NEW_REQUEST_NOTICE).toMatch(/new request that is not in the agreed scope documents \(the Client Requirements Discovery Document/);
    expect(NEW_REQUEST_NOTICE).toContain('this task is not available');
  });

  it('cleans what the team types: lower-case words, one per line or comma, paths starting with /', () => {
    expect(cleanList('Call Transfer,\n conference   CALL , ab, call transfer', { max: 10 })).toEqual(['call transfer', 'conference call']);
    expect(cleanList(['m/hr/hiring/', '/m/hr/hiring', '/m/x?y=1'], { max: 10, path: true })).toEqual(['/m/hr/hiring', '/m/x']);
  });
});

function mk(notes: Record<number, any> = {}, scope: ScopeItem[] = [CALLS, HIRING]) {
  const calls: Array<{ sql: string; p: any[] }> = [];
  const one = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p });
    if (/feedback\.manage/.test(sql)) return Number(p[0]) === TEAM ? { ok: 1 } : null;
    if (/SELECT f\.\* FROM feedback f WHERE f\.id/.test(sql)) {
      const n = notes[Number(p[2])];
      return n && (p[1] || Number(n.created_by) === Number(p[0])) ? n : null;
    }
    if (/FROM organisation/.test(sql)) return { id: '1' };
    if (/FROM user_assignment WHERE user_id/.test(sql)) return { branch_id: '40' };
    if (/nextval\('feedback_reference_seq'\)/.test(sql)) return { n: '8' };
    if (/INSERT INTO feedback \(/.test(sql)) return { id: '99', reference: p[1], status: p[10], resolution: p[13] };
    if (/SELECT id, title, reference, doc_says FROM feedback_scope_item WHERE id/.test(sql)) return scope.find((x) => x.id === Number(p[0])) ?? null;
    if (/FROM feedback_scope_item WHERE lower\(title\)/.test(sql)) return scope.find((x) => x.title.toLowerCase() === String(p[0]).toLowerCase() && x.id !== Number(p[1] ?? 0)) ? { id: 1 } : null;
    if (/SELECT \* FROM feedback_scope_item WHERE id/.test(sql)) return scope.find((x) => x.id === Number(p[0])) ?? null;
    if (/INSERT INTO feedback_scope_item/.test(sql)) return { id: '11', title: p[0], reference: p[1], doc_says: p[2], phrases: p[3], page_paths: p[4], is_active: p[5], sort_order: 110 };
    if (/UPDATE feedback_scope_item/.test(sql)) return { id: String(p[0]), title: p[1], reference: p[2], doc_says: p[3], phrases: p[4], page_paths: p[5], is_active: p[6], sort_order: p[7] };
    return null;
  });
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p });
    if (/FROM feedback_scope_item/.test(sql)) return /WHERE is_active/.test(sql) ? scope.filter((x) => x.is_active) : scope;
    return [];
  });
  const tx = jest.fn(async (fn: any) => fn({ query: async (sql: string, p: any[]) => { calls.push({ sql, p }); return { rows: [] }; } }));
  const svc = new FeedbackService({ one, query, tx } as any);
  jest.spyOn(svc, 'get').mockImplementation(async (_me: any, id: number) => ({ id } as any));
  const ins = () => calls.find((c) => /INSERT INTO feedback \(/.test(c.sql))!;
  const upd = () => calls.filter((c) => /UPDATE feedback SET status/.test(c.sql));
  return { svc, calls, ins, upd };
}
const page = { page_path: '/m/calls/dialer', page_title: 'Calls › Dialer', kind: 'SUGGESTION' };

describe('filing a note that is out of scope', () => {
  it('is saved — never lost — but closed as OUT_OF_SCOPE, by itself, with the document\'s words as its outcome', async () => {
    const { svc, ins } = mk();
    const row = await svc.create({ id: ASHA }, { ...page, message: 'Please add call transfer to another counsellor' });
    expect(row).toMatchObject({ reference: expect.stringMatching(/^FB-\d{4}-008$/), status: 'OUT_OF_SCOPE' });
    const p = ins().p;
    expect(p.slice(10, 13)).toEqual(['OUT_OF_SCOPE', 1, true]);
    expect(p[13]).toBe(scopeNotice(CALLS));
    expect(ins().sql).toMatch(/, now\(\)\) RETURNING/);            // closed the moment it was filed
  });

  it('a note on a screen the client has, about that screen, goes to the team as usual (Pending)', async () => {
    const { svc, ins } = mk();
    await svc.create({ id: ASHA }, { ...page, message: 'The dialer does not log the call against the lead' });
    expect(ins().p.slice(10, 14)).toEqual(['OPEN', null, false, null]);
    expect(ins().sql).toMatch(/, NULL\) RETURNING/);
  });
});

describe('the team marking a note out of scope', () => {
  const note = (over: any = {}) => ({ id: 10, reference: 'FB-2026-010', created_by: ASHA, status: 'OPEN', scope_auto: false, ...over });

  it('against an item on the scope list: the reporter reads that document reference, then the team\'s note', async () => {
    const { svc, upd } = mk({ 10: note() });
    await svc.resolve({ id: TEAM }, 10, { status: 'OUT_OF_SCOPE', scope_item_id: 6, resolution: 'Raise it as a change request.' });
    const [u] = upd();
    expect(u.p[1]).toBe('OUT_OF_SCOPE');
    expect(u.p[2]).toBe(`${scopeNotice(HIRING)} Note from the team: Raise it as a change request.`);
    expect(u.p.slice(3)).toEqual([TEAM, 6]);
    expect(u.sql).toMatch(/resolution = \$3,/);                    // replaced, not merged
    expect(u.sql).toMatch(/resolved_at = now\(\)/);
  });

  it('as a new request no agreed document mentions; an unknown item is refused; only the team may do it', async () => {
    const { svc, upd } = mk({ 10: note() });
    await svc.resolve({ id: TEAM }, 10, { status: 'OUT_OF_SCOPE' });
    expect(upd()[0].p[2]).toBe(NEW_REQUEST_NOTICE);
    expect(upd()[0].p[4]).toBeNull();
    await expect(svc.resolve({ id: TEAM }, 10, { status: 'OUT_OF_SCOPE', scope_item_id: 999 })).rejects.toThrow(/Pick an item/);
    await expect(svc.resolve({ id: ASHA }, 10, { status: 'OUT_OF_SCOPE' })).rejects.toThrow(/Only the team/);
  });

  it('reopening drops the out-of-scope words, so they can\'t become a later outcome', async () => {
    const { svc, upd } = mk({ 10: note({ status: 'OUT_OF_SCOPE', scope_item_id: 1, resolution: scopeNotice(CALLS) }) });
    await svc.resolve({ id: TEAM }, 10, { status: 'OPEN' });
    const [u] = upd();
    expect(u.p).toEqual([10, 'OPEN', null, null, null]);
    expect(u.sql).toMatch(/resolution = \$3,/);
    expect(u.sql).toMatch(/resolved_at = NULL/);
  });
});

describe('replies on an out-of-scope note', () => {
  const note = (over: any = {}) => ({ id: 10, reference: 'FB-2026-010', created_by: ASHA, status: 'OUT_OF_SCOPE', scope_auto: true, ...over });

  it('flagged by itself and the reporter disputes it -> back to Pending for a person to decide', async () => {
    const { svc, upd } = mk({ 10: note() });
    await svc.reply({ id: ASHA }, 10, 'This is a bug on the dialer screen, not a new feature');
    const [u] = upd();
    expect(u.p).toEqual([10, 'OPEN']);
    expect(u.sql).toMatch(/resolution = NULL, scope_item_id = NULL, scope_auto = false/);
  });

  it('decided by the team, it stays out of scope whoever replies (like Won\'t fix)', async () => {
    const { svc, upd } = mk({ 10: note({ scope_auto: false }) });
    await svc.reply({ id: ASHA }, 10, 'But we really need it');
    await svc.reply({ id: TEAM }, 10, 'It is in the scope statement — a change request.');
    expect(upd().map((u) => u.p[1])).toEqual(['OUT_OF_SCOPE', 'OUT_OF_SCOPE']);
  });
});

describe('keeping the scope list', () => {
  it('everyone reads the switched-on items; the team also sees the switched-off ones, each with its message', async () => {
    const { svc } = mk({}, [CALLS, { ...HIRING, is_active: false }]);
    const forAsha = await svc.scopeList({ id: ASHA });
    expect(forAsha.map((x) => x.id)).toEqual([1]);
    expect(forAsha[0].notice).toBe(scopeNotice(CALLS));
    expect((await svc.scopeList({ id: TEAM })).map((x) => x.id)).toEqual([1, 6]);
  });

  it('the team adds an item — it needs a name, the document reference and words to match — and switches one off', async () => {
    const { svc, calls } = mk();
    await expect(svc.createScope({ id: ASHA }, { title: 'Payroll export', reference: 'Doc §11', phrases: 'payroll export' })).rejects.toThrow(/Only the team/);
    await expect(svc.createScope({ id: TEAM }, { title: 'Payroll export', reference: 'Doc §11' })).rejects.toThrow(/Add the words/);
    await expect(svc.createScope({ id: TEAM }, { title: 'Payroll export', phrases: 'payroll export' })).rejects.toThrow(/document and its section/);
    await expect(svc.createScope({ id: TEAM }, { title: 'call transfer, conference calling and call routing', reference: 'Doc §7', phrases: 'x y z' })).rejects.toThrow(/already on the scope list/);
    const made = await svc.createScope({ id: TEAM }, { title: 'Tally export', reference: 'Client Requirements Discovery Document, §6 › Collection reports', doc_says: 'not asked for', phrases: 'Tally Export\ntally sync' });
    expect(made).toMatchObject({ id: 11, phrases: ['tally export', 'tally sync'], is_active: true });
    expect(made.notice).toContain('"Tally export" is not available');
    const off = await svc.updateScope({ id: TEAM }, 6, { is_active: false });
    expect(off).toMatchObject({ id: 6, is_active: false, title: HIRING.title, phrases: HIRING.phrases });
    expect(calls.some((c) => /UPDATE feedback_scope_item/.test(c.sql))).toBe(true);
  });
});
