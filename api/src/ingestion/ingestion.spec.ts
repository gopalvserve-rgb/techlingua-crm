import { IngestValidationError } from './ingestion.types';
import { makeFakeDb, makeIngestion } from './fake-db.testkit';

/**
 * The shared ingestion pipeline, driven against an in-memory Postgres double.
 * Covers exactly what the client cares about: nothing is lost, nothing is
 * duplicated, and leads land on the right agent — plus all FOUR NeoDove §4
 * duplicate actions, which are now executed (not just flagged).
 */

const ctx = (over: Partial<any> = {}) => ({
  channel: 'csv' as const, campaign_id: 5, source_id: 7, actor_id: 9, batch_id: 1, ...over,
});

describe('LeadIngestionService', () => {
  it('normalises the phone to E.164 and creates the lead', async () => {
    const { db, st } = makeFakeDb();
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'Asha Rao', phone: '098111 00001', external_id: 'A1' }, ctx());
    expect(out.status).toBe('created');
    expect(st.leads[0].phone).toBe('+919811100001');
    expect(st.audit).toHaveLength(1);            // worker-created leads are audited
  });

  it('is IDEMPOTENT — re-ingesting the same record creates nothing new', async () => {
    const { db, st } = makeFakeDb();
    const { svc } = makeIngestion(db);
    const rec = { full_name: 'Asha Rao', phone: '9811100001', external_id: 'A1' };
    const first = await svc.ingest(rec, ctx());
    const second = await svc.ingest(rec, ctx());
    expect(first.status).toBe('created');
    expect(second.status).toBe('skipped');
    expect(st.leads).toHaveLength(1);
    expect(st.cursor).toBe(0);                   // the round-robin cursor moved ONCE
  });

  it('is idempotent without an external id (content hash)', async () => {
    const { db, st } = makeFakeDb();
    const { svc } = makeIngestion(db);
    const rec = { full_name: 'Ravi K', phone: '9811100002', email: 'r@x.com' };
    await svc.ingest(rec, ctx());
    const again = await svc.ingest({ ...rec }, ctx());
    expect(again.status).toBe('skipped');
    expect(st.leads).toHaveLength(1);
  });

  it('applies EQUAL distribution round-robin across the agent pool', async () => {
    const { db, st } = makeFakeDb();
    const { svc } = makeIngestion(db);
    for (let i = 1; i <= 4; i++) {
      await svc.ingest({ full_name: `L${i}`, phone: `98111000${10 + i}`, external_id: `E${i}` }, ctx());
    }
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 12, 13, 11]);
  });

  it('skips agents who were disabled after the campaign was configured', async () => {
    const { db, st } = makeFakeDb({ users: [11, 13] });
    const { svc } = makeIngestion(db);
    await svc.ingest({ full_name: 'A', phone: '9811100021', external_id: 'X1' }, ctx());
    await svc.ingest({ full_name: 'B', phone: '9811100022', external_id: 'X2' }, ctx());
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 13]);
  });

  it('skips a user with the GLOBAL lead-assignment switch OFF (migration 039), org-wide', async () => {
    // user 12 is active (still in the pool) but lead_assignment_enabled = FALSE, so the
    // distribution engine hands NEW leads only to 11 and 13 — the org-wide equivalent of
    // the per-campaign pause. Re-enabling (empty leadAssignOff) would restore 12.
    const { db, st } = makeFakeDb({ leadAssignOff: [12] });
    const { svc } = makeIngestion(db);
    for (let i = 1; i <= 4; i++) {
      await svc.ingest({ full_name: `G${i}`, phone: `98111000${30 + i}`, external_id: `G${i}` }, ctx());
    }
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 13, 11, 13]);
  });

  it('applies CONDITIONAL distribution rules', async () => {
    const { db, st } = makeFakeDb({
      distribution: { mode: 'conditional', conditions: [{ field: 'course', value: 'IELTS', assign_to_user_ids: [13] }] },
    });
    const { svc } = makeIngestion(db);
    await svc.ingest({ full_name: 'A', phone: '9811100031', course: 'IELTS', external_id: 'C1' }, ctx());
    await svc.ingest({ full_name: 'B', phone: '9811100032', course: 'Spoken English', external_id: 'C2' }, ctx());
    expect(st.leads[0].owner_id).toBe(13);
    expect(st.leads[1].owner_id).toBeNull();     // no rule matched -> unassigned
  });

  it('leaves leads unassigned under ON DEMAND distribution', async () => {
    const { db, st } = makeFakeDb({ distribution: { mode: 'on_demand', batch_size: 10 } });
    const { svc } = makeIngestion(db);
    await svc.ingest({ full_name: 'A', phone: '9811100041', external_id: 'D1' }, ctx());
    expect(st.leads[0].owner_id).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // NeoDove §4 — the four duplicate actions, END TO END
  // ---------------------------------------------------------------------------
  describe('duplicate actions (NeoDove §4)', () => {
    const dup = (over: Partial<any> = {}) => ({
      check_scope: 'this_campaign', match_key: 'phone', on_duplicate: 'ignore',
      open_reassign_same_user: true, ...over,
    });

    it('IGNORE -> the incoming record is dropped, the existing lead is untouched', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'ignore' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100051', email: 'a@x.com', external_id: 'P1' }, ctx());
      const out = await svc.ingest({ full_name: 'A again', phone: '+91 98111 00051', email: 'other@x.com', external_id: 'P2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.action).toBe('ignore');
      expect(out.lead_id).toBeNull();
      expect(st.leads).toHaveLength(1);
      expect(st.leads[0].email).toBe('a@x.com');       // untouched
      expect(st.ledger[1].applied_action).toBe('ignore');
      expect(st.merges).toHaveLength(0);
    });

    it('CREATE -> a second lead, flagged and LINKED to the one it duplicates', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'create', open_reassign_same_user: false }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100061', external_id: 'Q1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100061', external_id: 'Q2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.action).toBe('create');
      expect(st.leads).toHaveLength(2);
      expect(st.leads[1].is_duplicate).toBe(true);
      expect(Number(st.leads[1].duplicate_of_id)).toBe(Number(st.leads[0].id));  // the panel can find it
    });

    it('MERGE -> folded into the existing lead: no second lead, blanks filled', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'Asha', phone: '9811100071', external_id: 'R1' }, ctx());
      const first = st.leads[0];
      expect(first.email).toBeNull();

      const out = await svc.ingest(
        { full_name: 'Asha', phone: '9811100071', email: 'asha@x.com', city: 'Delhi', course: 'IELTS', external_id: 'R2' },
        ctx(),
      );
      expect(out.status).toBe('duplicate');
      expect(out.action).toBe('merge');
      expect(out.merged).toBe(true);
      expect(out.lead_id).toBe(Number(first.id));
      expect(st.leads).toHaveLength(1);                       // NO second lead
      expect(st.leads[0].email).toBe('asha@x.com');           // blank filled
      expect(Number(st.leads[0].city_id)).toBe(71);
      expect(Number(st.leads[0].course_id)).toBe(21);
      // timeline + audit + merge record
      expect(st.activities.some((a) => a.type === 'merge' && String(a.note).includes('Duplicate merged from csv'))).toBe(true);
      expect(st.audit.some((a) => a.action === 'merge')).toBe(true);
      expect(st.merges).toHaveLength(1);
      expect(st.merges[0].action).toBe('merge');
    });

    it('MERGE is NON-DESTRUCTIVE on a conflict — existing wins, incoming is recorded', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest(
        { full_name: 'Asha Rao', phone: '9811100081', email: 'real@x.com', course: 'IELTS', external_id: 'S1' },
        ctx(),
      );
      await svc.ingest(
        { full_name: 'Asha R', phone: '9811100081', email: 'typo@x.com', course: 'Spoken English', external_id: 'S2' },
        ctx(),
      );
      const lead = st.leads[0];
      expect(st.leads).toHaveLength(1);
      expect(lead.email).toBe('real@x.com');                  // NOT overwritten
      expect(lead.full_name).toBe('Asha Rao');
      expect(Number(lead.course_id)).toBe(21);               // NOT overwritten

      const diff = st.merges[0].diff;
      expect(diff.conflicts.email).toEqual({ kept: 'real@x.com', incoming: 'typo@x.com' });
      expect(diff.conflicts.full_name).toEqual({ kept: 'Asha Rao', incoming: 'Asha R' });
      expect(diff.conflicts.course_id).toEqual({ kept: 21, incoming: 22 });
      // ...and the losing values are visible on the lead's timeline, so nothing is lost
      const act = st.activities.find((a) => a.type === 'merge');
      expect(JSON.parse(act.from_value).conflicts.email.incoming).toBe('typo@x.com');
    });

    it('MERGE unions tags and APPENDS the incoming note (never overwrites)', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100091', tags: 'Priority', note: 'first call done', external_id: 'T1' }, ctx());
      await svc.ingest({ full_name: 'A', phone: '9811100091', tags: 'Referral', note: 'came back via Meta', external_id: 'T2' }, ctx());
      const leadId = Number(st.leads[0].id);
      expect(st.tags.filter((t) => t.lead_id === leadId).map((t) => t.tag_id).sort()).toEqual([41, 42]);
      const notes = st.activities.filter((a) => a.type === 'note').map((a) => a.note);
      expect(notes).toContain('came back via Meta');          // appended, both survive
    });

    it('MERGE merges CUSTOM FIELDS by the same rule (fill blanks, keep on conflict)', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100101', custom_fields: { batch: 'Morning' }, external_id: 'U1' }, ctx());
      await svc.ingest({ full_name: 'A', phone: '9811100101', custom_fields: { batch: 'Evening', ref: 'RJ-9' }, external_id: 'U2' }, ctx());
      expect(st.leads[0].custom_fields).toEqual({ batch: 'Morning', ref: 'RJ-9' });   // filled, not overwritten
      const diff = st.merges[0].diff;
      expect(diff.custom_filled).toEqual({ ref: 'RJ-9' });
      expect(diff.custom_conflicts.batch).toEqual({ kept: 'Morning', incoming: 'Evening' });
    });

    it('MERGE keeps the existing OWNER and never re-runs round-robin (§4)', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100111', external_id: 'V1' }, ctx());   // -> agent 11
      expect(st.leads[0].owner_id).toBe(11);
      const out = await svc.ingest({ full_name: 'A', phone: '9811100111', email: 'a@x.com', external_id: 'V2' }, ctx());
      expect(out.owner_id).toBe(11);            // NOT 12
      expect(st.leads[0].owner_id).toBe(11);
      expect(st.cursor).toBe(0);                // the cursor did NOT move
    });

    it('MERGE & REOPEN moves a LOST lead back to an open stage AND assigns it to the next round-robin agent', async () => {
      // Client change (Jul 2026): a re-opened CLOSED lead is FRESH work — it goes to
      // the campaign's next round-robin agent, not the old owner. Default pool
      // [11,12,13]: the create put it on 11 (cursor 0); the reopen bumps to 12.
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge_and_reopen' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100121', external_id: 'W1' }, ctx());
      expect(st.leads[0].owner_id).toBe(11);
      st.leads[0].stage_id = 59;                                   // the counsellor lost it
      const out = await svc.ingest({ full_name: 'A', phone: '9811100121', email: 'back@x.com', external_id: 'W2' }, ctx());
      expect(out.action).toBe('merge_and_reopen');
      expect(out.reopened).toBe(true);
      expect(Number(st.leads[0].stage_id)).toBe(51);               // back to the default OPEN stage
      expect(st.leads[0].email).toBe('back@x.com');
      expect(st.leads[0].owner_id).toBe(12);                       // re-assigned to the NEXT round-robin agent
      expect(out.owner_id).toBe(12);
      expect(st.activities.some((a) => a.type === 'stage_change' && String(a.note).includes('re-opened'))).toBe(true);
      expect(st.activities.some((a) => a.type === 'assign' && String(a.note).includes('round-robin'))).toBe(true);
      expect(st.merges[0].reopened).toBe(true);
    });

    it('MERGE & REOPEN with NO eligible agents leaves the re-opened lead with its owner', async () => {
      // Empty pool (on_demand) -> pickOwner returns null -> owner is left unchanged.
      const { db, st } = makeFakeDb({
        duplicacy: dup({ on_duplicate: 'merge_and_reopen' }),
        distribution: { mode: 'on_demand', batch_size: 10 },
      });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100141', external_id: 'Y1' }, ctx());
      st.leads[0].owner_id = 77;                                   // set an owner by hand (on_demand created it unassigned)
      st.leads[0].stage_id = 59;                                   // lost
      const out = await svc.ingest({ full_name: 'A', phone: '9811100141', external_id: 'Y2' }, ctx());
      expect(out.reopened).toBe(true);
      expect(st.leads[0].owner_id).toBe(77);                       // no pool -> owner kept
    });

    it('MERGE & REOPEN leaves an already-OPEN lead where it is, WITH its owner (no round-robin)', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge_and_reopen' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100131', external_id: 'X1' }, ctx());
      expect(st.leads[0].owner_id).toBe(11);
      st.leads[0].stage_id = 52;                                   // "Contacted" — open
      const out = await svc.ingest({ full_name: 'A', phone: '9811100131', external_id: 'X2' }, ctx());
      expect(out.reopened).toBe(false);
      expect(Number(st.leads[0].stage_id)).toBe(52);               // not dragged backwards
      expect(st.leads[0].owner_id).toBe(11);                       // OPEN duplicate stays with its owner
      expect(st.cursor).toBe(0);                                   // round-robin did NOT advance
    });

    it('FLAG action creates a second lead flagged is_duplicate, linked to the original', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'flag' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100151', external_id: 'Z1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100151', email: 'dup@x.com', external_id: 'Z2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.action).toBe('flag');
      expect(st.leads).toHaveLength(2);                            // the duplicate is kept, not swallowed
      const flagged = st.leads[1];
      expect(flagged.is_duplicate).toBe(true);
      expect(Number(flagged.duplicate_of_id)).toBe(Number(st.leads[0].id));
    });

    it('a repeated MERGE ingest is IDEMPOTENT — the merge happens exactly once', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100141', external_id: 'Y1' }, ctx());
      const rec = { full_name: 'A', phone: '9811100141', email: 'a@x.com', external_id: 'Y2' };
      const first = await svc.ingest(rec, ctx());
      const again = await svc.ingest(rec, ctx());
      expect(first.merged).toBe(true);
      expect(again.status).toBe('skipped');
      expect(st.merges).toHaveLength(1);                            // NOT 2
      expect(st.activities.filter((a) => a.type === 'merge')).toHaveLength(1);
      expect(st.leads).toHaveLength(1);
    });

    it('an OPEN duplicate under CREATE re-assigns to the same owner (spec §4)', async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'create', open_reassign_same_user: true }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100151', external_id: 'Z1' }, ctx());   // -> agent 11
      const out = await svc.ingest({ full_name: 'A', phone: '9811100151', external_id: 'Z2' }, ctx());
      expect(st.leads[0].owner_id).toBe(11);
      expect(out.owner_id).toBe(11);              // NOT 12 — the round-robin is bypassed
      expect(st.cursor).toBe(0);
    });

    it("the manual 'always_create' policy ignores the campaign's ignore rule", async () => {
      const { db, st } = makeFakeDb();                // on_duplicate = ignore
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100161', external_id: 'M1' }, ctx());
      const out = await svc.ingest({ full_name: 'A', phone: '9811100161' }, ctx({ channel: 'manual', duplicate_policy: 'always_create' }));
      expect(st.leads).toHaveLength(2);
      expect(st.leads[1].is_duplicate).toBe(true);
      expect(out.duplicate_of).toBe(Number(st.leads[0].id));
      expect(Number(st.leads[1].duplicate_of_id)).toBe(Number(st.leads[0].id));   // mergeable by hand
    });

    // -------------------------------------------------------------------------
    // DEF-S2-01 (QA-10) — the idempotency ledger must never swallow a MANUAL add
    // -------------------------------------------------------------------------
    it('DEF-S2-01: adding the SAME lead twice by hand creates TWO leads (no silent skip)', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      const rec = { full_name: 'Zed Idem Probe', phone: '9810000061' };
      const manual = ctx({ channel: 'manual', duplicate_policy: 'always_create', batch_id: null });
      const first = await svc.ingest(rec, manual);
      const second = await svc.ingest({ ...rec }, manual);

      expect(first.status).toBe('created');
      expect(second.status).toBe('duplicate');               // flagged as a duplicate — NOT 'skipped'
      expect(second.action).toBe('create');
      expect(second.lead_id).not.toBe(first.lead_id);        // a REAL second lead
      expect(st.leads).toHaveLength(2);
      expect(st.leads[1].is_duplicate).toBe(true);           // flagged + linked, per §4
      expect(Number(st.leads[1].duplicate_of_id)).toBe(Number(st.leads[0].id));
      expect(st.ledger).toHaveLength(2);                     // the audit trail stays complete
    });

    it('DEF-S2-01: add -> soft-delete -> add again returns a NEW live lead, never the deleted id', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      const rec = { full_name: 'Zed Idem Probe', phone: '9810000062' };
      const manual = ctx({ channel: 'manual', duplicate_policy: 'always_create', batch_id: null });
      const first = await svc.ingest(rec, manual);
      st.leads[0].deleted_at = new Date().toISOString();     // the counsellor deletes it
      const again = await svc.ingest({ ...rec }, manual);

      expect(again.status).toBe('created');
      expect(again.lead_id).not.toBe(first.lead_id);
      const live = st.leads.filter((l) => !l.deleted_at);
      expect(live).toHaveLength(1);
      expect(Number(live[0].id)).toBe(Number(again.lead_id));  // the id handed back IS the live lead
    });

    it('DEF-S2-01: an AUTOMATED replay whose lead was soft-deleted re-ingests (no dead id handed back)', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      const rec = { full_name: 'Sheet Row', phone: '9810000063', external_id: 'ROW-9' };
      const first = await svc.ingest(rec, ctx({ channel: 'sheet' }));
      expect(first.status).toBe('created');
      st.leads[0].deleted_at = new Date().toISOString();

      const replay = await svc.ingest({ ...rec }, ctx({ channel: 'sheet' }));
      expect(replay.status).toBe('created');
      expect(st.leads.filter((l) => !l.deleted_at)).toHaveLength(1);
    });

    it('DEF-S2-01 guard: channel idempotency is UNCHANGED while the lead is alive', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      const rec = { full_name: 'Meta Lead', phone: '9810000064', external_id: 'LG-1' };
      await svc.ingest(rec, ctx({ channel: 'webhook' }));
      const replay = await svc.ingest({ ...rec }, ctx({ channel: 'webhook' }));
      expect(replay.status).toBe('skipped');                 // Meta/Google/form/sheet/CSV replay
      expect(st.leads).toHaveLength(1);
      expect(st.cursor).toBe(0);                             // and the cursor never moved
    });

    it('DEF-S2-03: the WhatsApp number is normalised and stored on the lead', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'Wa Lead', phone: '9810000065', whatsapp_phone: '098100 00066' },
        ctx({ channel: 'manual', duplicate_policy: 'always_create' }));
      expect(st.leads[0].whatsapp_phone).toBe('+919810000066');
    });

    it("a manual add under a MERGE campaign still creates (a human's entry is never swallowed)", async () => {
      const { db, st } = makeFakeDb({ duplicacy: dup({ on_duplicate: 'merge' }) });
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100171', external_id: 'N1' }, ctx());
      await svc.ingest({ full_name: 'A', phone: '9811100171' }, ctx({ channel: 'manual', duplicate_policy: 'always_create' }));
      expect(st.leads).toHaveLength(2);
      expect(st.merges).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // duplicate SCOPE: campaign vs vertical vs branch vs global
  // (Client change Jul 2026: `this_pipeline` REMOVED; a stray legacy value is
  //  treated as `this_campaign`. Target hierarchy = branch 2 / vertical 3 /
  //  pipeline 4 / campaign 5.)
  // ---------------------------------------------------------------------------
  describe('duplicate scope (§4, client Jul 2026)', () => {
    /** Seed an existing same-phone lead anywhere in the org (id 900). */
    const seedOther = (st: any, phone: string, h: { campaign_id: number; pipeline_id?: number; vertical_id: number; branch_id: number }) =>
      st.leads.push({
        id: 900, phone, campaign_id: h.campaign_id, pipeline_id: h.pipeline_id ?? 4,
        vertical_id: h.vertical_id, branch_id: h.branch_id, owner_id: 77,
        stage_id: 51, is_active: true, deleted_at: null, custom_fields: {},
        org_id: 1, full_name: 'Existing', email: null,
      });

    it('this_campaign: a lead in a DIFFERENT campaign (same vertical/branch) is not a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_campaign', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100201', { campaign_id: 999, vertical_id: 3, branch_id: 2 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100201', external_id: 'SC1' }, ctx());
      expect(out.status).toBe('created');
      expect(st.merges).toHaveLength(0);
    });

    it('this_vertical: a same-phone lead in the SAME vertical (other campaign) IS a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_vertical', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100202', { campaign_id: 999, vertical_id: 3, branch_id: 2 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100202', email: 'a@x.com', external_id: 'SC2' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.merged).toBe(true);
      expect(out.lead_id).toBe(900);
      expect(st.leads).toHaveLength(1);
    });

    it('this_vertical: a same-phone lead in ANOTHER vertical is NOT a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_vertical', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100205', { campaign_id: 999, vertical_id: 99, branch_id: 2 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100205', external_id: 'SC5' }, ctx());
      expect(out.status).toBe('created');
      expect(st.merges).toHaveLength(0);
    });

    it('this_branch: a same-phone lead in the SAME branch (other vertical) IS a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_branch', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100206', { campaign_id: 999, vertical_id: 99, branch_id: 2 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100206', email: 'a@x.com', external_id: 'SC6' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.merged).toBe(true);
      expect(out.lead_id).toBe(900);
    });

    it('this_branch: a same-phone lead in ANOTHER branch is NOT a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_branch', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100207', { campaign_id: 999, vertical_id: 3, branch_id: 88 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100207', external_id: 'SC7' }, ctx());
      expect(out.status).toBe('created');
    });

    it('global: a lead in another branch AND vertical is a duplicate too', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'global', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100203', { campaign_id: 999, vertical_id: 88, branch_id: 88 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100203', email: 'a@x.com', external_id: 'SC3' }, ctx());
      expect(out.status).toBe('duplicate');
      expect(out.merged).toBe(true);
      expect(out.lead_id).toBe(900);
    });

    it('legacy this_pipeline is treated as this_campaign — a diff-campaign same-pipeline lead is NOT a duplicate', async () => {
      const { db, st } = makeFakeDb({ duplicacy: { check_scope: 'this_pipeline', on_duplicate: 'merge' } });
      const { svc } = makeIngestion(db);
      seedOther(st, '+919811100204', { campaign_id: 999, pipeline_id: 4, vertical_id: 3, branch_id: 2 });
      const out = await svc.ingest({ full_name: 'A', phone: '9811100204', external_id: 'SC4' }, ctx());
      expect(out.status).toBe('created');
    });
  });

  describe('validation (rows that can never succeed -> dead-letter, never retried)', () => {
    const cases: Array<[string, any, RegExp]> = [
      ['missing name', { phone: '9811100001' }, /Name is required/],
      ['missing phone', { full_name: 'A' }, /Mobile number is required/],
      ['short phone', { full_name: 'A', phone: '123' }, /Invalid mobile/],
      ['bad email', { full_name: 'A', phone: '9811100001', email: 'not-an-email' }, /Invalid email/],
      ['bad priority', { full_name: 'A', phone: '9811100001', priority: 'urgent' }, /Invalid priority/],
      ['bad temperature', { full_name: 'A', phone: '9811100001', temperature: 'lukewarm' }, /Invalid temperature/],
      ['bad score', { full_name: 'A', phone: '9811100001', score: '999' }, /Invalid score/],
      ['bad date', { full_name: 'A', phone: '9811100001', next_follow_up_at: '31/31/2026' }, /Invalid date/],
      ['unknown stage', { full_name: 'A', phone: '9811100001', stage: 'Nowhere' }, /Unknown Stage/],
    ];
    it.each(cases)('rejects %s', async (_label, payload, re) => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      await expect(svc.ingest(payload, ctx())).rejects.toThrow(IngestValidationError);
      await expect(svc.ingest(payload, ctx())).rejects.toThrow(re);
      expect(st.leads).toHaveLength(0);
    });

    // Import course fix (Aug 2026): an interactive/strict channel still hard-rejects an unknown
    // Course, but a CSV bulk import (a machine feed like the inbound channels) must NOT drop the
    // row — it imports and keeps the raw value on the note, exactly like OBS-02 for inbound.
    it('a STRICT channel (manual) still rejects an unknown course', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      await expect(
        svc.ingest({ full_name: 'A', phone: '9811100001', course: 'Klingon' },
          ctx({ channel: 'manual', duplicate_policy: 'always_create' })),
      ).rejects.toThrow(/Unknown Course/);
      expect(st.leads).toHaveLength(0);
    });

    it('a CSV import SOFT-imports an unknown course (lead created, value kept on the note)', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      const out = await svc.ingest({ full_name: 'A', phone: '9811100001', course: 'Klingon' }, ctx());
      expect(out.status).toBe('created');
      expect(st.leads).toHaveLength(1);
      expect(st.leads[0].course_id).toBeNull();          // left blank — not hard-failed
      // the raw value is preserved on the lead's create activity note so nothing is lost (OBS-02)
      const created = st.activities.find((a) => a.type === 'create');
      expect(String(created?.note)).toMatch(/Course: Klingon/);
    });

    it('accepts DD/MM/YYYY and YYYY-MM-DD follow-up dates', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100001', next_follow_up_at: '20/07/2026', external_id: 'U1' }, ctx());
      await svc.ingest({ full_name: 'B', phone: '9811100002', next_follow_up_at: '2026-07-20', external_id: 'U2' }, ctx());
      expect(st.leads).toHaveLength(2);
    });

    it('resolves master values by name (case-insensitive) and by id', async () => {
      const { db, st } = makeFakeDb();
      const { svc } = makeIngestion(db);
      await svc.ingest({ full_name: 'A', phone: '9811100001', course: 'ielts', tags: 'Priority', external_id: 'V1' }, ctx());
      expect(Number(st.leads[0].course_id)).toBe(21);
      expect(st.tags).toEqual([{ lead_id: Number(st.leads[0].id), tag_id: 41 }]);
    });
  });
});

/* ========================================================================== */
/*  UAT-R2 #22 — WhatsApp Group duplicate validation (phone <-> whatsapp       */
/*  cross-matching), plus every duplicacy SCOPE; and #24 agent pause.          */
/* ========================================================================== */
describe('#22 — duplicate detection cross-matches phone AND WhatsApp', () => {
  const seed = (over: Record<string, unknown> = {}) => ([{
    id: 900, full_name: 'Existing', phone: '+919811100050', whatsapp_phone: '+919811100051',
    campaign_id: 5, pipeline_id: 4, vertical_id: 3, branch_id: 2,
    is_active: true, deleted_at: null, stage_id: 51, owner_id: 11,
    ...over,
  }]);

  it('incoming PHONE that matches an existing WHATSAPP number is a duplicate', async () => {
    const { db, st } = makeFakeDb({ leads: seed() });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'New', phone: '9811100051', external_id: 'W1' }, ctx());
    expect(out.status).toBe('duplicate');
    expect(out.duplicate_of).toBe(900);
    expect(st.leads).toHaveLength(1);                 // ignore rule -> no second lead
  });

  it('incoming WHATSAPP that matches an existing PHONE number is a duplicate', async () => {
    const { db } = makeFakeDb({ leads: seed() });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest(
      { full_name: 'New', phone: '9811109999', whatsapp_phone: '9811100050', external_id: 'W2' }, ctx());
    expect(out.status).toBe('duplicate');
    expect(out.duplicate_of).toBe(900);
  });

  it('incoming WHATSAPP that matches an existing WHATSAPP number is a duplicate', async () => {
    const { db } = makeFakeDb({ leads: seed() });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest(
      { full_name: 'New', phone: '9811109999', whatsapp_phone: '9811100051', external_id: 'W3' }, ctx());
    expect(out.status).toBe('duplicate');
    expect(out.duplicate_of).toBe(900);
  });

  it('no shared number on either field -> a normal new lead', async () => {
    const { db, st } = makeFakeDb({ leads: seed() });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest(
      { full_name: 'New', phone: '9811108888', whatsapp_phone: '9811108889', external_id: 'W4' }, ctx());
    expect(out.status).toBe('created');
    expect(st.leads).toHaveLength(2);
  });

  it('SCOPE this_campaign — a match in a DIFFERENT campaign is NOT a duplicate', async () => {
    const { db, st } = makeFakeDb({ leads: seed({ campaign_id: 99 }) });   // default scope = this_campaign
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'New', phone: '9811100050', external_id: 'S1' }, ctx());
    expect(out.status).toBe('created');
    expect(st.leads).toHaveLength(2);
  });

  it('SCOPE this_vertical — a WhatsApp match across campaigns in the SAME vertical IS a duplicate', async () => {
    const { db } = makeFakeDb({
      leads: seed({ campaign_id: 99, vertical_id: 3 }),
      duplicacy: { check_scope: 'this_vertical', match_key: 'phone', on_duplicate: 'ignore', open_reassign_same_user: true },
    });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest(
      { full_name: 'New', phone: '9811109999', whatsapp_phone: '9811100050', external_id: 'S2' }, ctx());
    expect(out.status).toBe('duplicate');
    expect(out.duplicate_of).toBe(900);
  });

  it('SCOPE global — a match in any campaign/vertical/branch IS a duplicate', async () => {
    const { db } = makeFakeDb({
      leads: seed({ campaign_id: 99, pipeline_id: 88, vertical_id: 88, branch_id: 88 }),
      duplicacy: { check_scope: 'global', match_key: 'phone', on_duplicate: 'ignore', open_reassign_same_user: true },
    });
    const { svc } = makeIngestion(db);
    const out = await svc.ingest({ full_name: 'New', phone: '9811100051', external_id: 'S3' }, ctx());
    expect(out.status).toBe('duplicate');
    expect(out.duplicate_of).toBe(900);
  });
});

describe('#24 — a PAUSED agent is skipped by distribution, an un-paused one is not', () => {
  it('equal round-robin skips the paused agent (12), rotates over the rest', async () => {
    const { db, st } = makeFakeDb({ pausedAgents: [{ campaign_id: 5, user_id: 12 }] });
    const { svc } = makeIngestion(db);
    for (let i = 1; i <= 3; i++) {
      await svc.ingest({ full_name: `L${i}`, phone: `98111002${10 + i}`, external_id: `P${i}` }, ctx());
    }
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 13, 11]);   // 12 never receives a lead
  });

  it('#23 — a campaign MANAGER is not in the agent pool, so it receives no auto-assigned leads', async () => {
    // managers live in campaign_manager, never in distribution_config.agent_user_ids.
    const { db, st } = makeFakeDb({ distribution: { mode: 'equal', agent_user_ids: [11] } });
    const { svc } = makeIngestion(db);
    for (let i = 1; i <= 2; i++) {
      await svc.ingest({ full_name: `M${i}`, phone: `98111003${10 + i}`, external_id: `M${i}` }, ctx());
    }
    expect(st.leads.map((l) => l.owner_id)).toEqual([11, 11]);       // only the pool member
  });
});
