import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadMergeService } from './merge.service';
import { allScopeResolver, makeFakeDb } from './fake-db.testkit';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * The MANUAL merge path (the UI's "merge these two leads" button).
 * The target survives; the source becomes a soft-deleted tombstone that points
 * at it, and its timeline + open follow-ups move across — nothing is lost.
 */

const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

function seed(st: any) {
  st.leads.push({
    id: 201, org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4, campaign_id: 5, source_id: 7,
    full_name: 'Asha Rao', phone: '+919811100001', email: 'asha@real.com', alt_phone: null,
    city_id: 71, course_id: null, budget_id: null, temperature: 'warm', priority: 'med', score: 0,
    next_follow_up_at: null, owner_id: 11, stage_id: 51, is_active: true, deleted_at: null,
    custom_fields: { batch: 'Morning' }, is_duplicate: false, merged_into_id: null, duplicate_of_id: null,
  });
  st.leads.push({
    id: 202, org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4, campaign_id: 5, source_id: 7,
    full_name: 'Asha R', phone: '+919811100001', email: 'typo@x.com', alt_phone: '+919812300000',
    city_id: 71, course_id: 21, budget_id: null, temperature: null, priority: 'high', score: 80,
    next_follow_up_at: null, owner_id: 12, stage_id: 51, is_active: true, deleted_at: null,
    custom_fields: { batch: 'Evening', ref: 'RJ-9' }, is_duplicate: true, merged_into_id: null, duplicate_of_id: 201,
  });
  st.tags.push({ lead_id: 201, tag_id: 41 }, { lead_id: 202, tag_id: 42 });
  st.activities.push({ lead_id: 202, type: 'note', note: 'called, wants evening batch' });
  st.followups.push({ id: 1, lead_id: 202, status: 'pending' }, { id: 2, lead_id: 202, status: 'done' });
}

const svcOf = (db: any) => new LeadMergeService(db, allScopeResolver);

describe('LeadMergeService — manual merge of two existing leads', () => {
  it('previews the diff without writing anything', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    const p = await svcOf(db).preview(201, 202);
    expect(p.diff.filled).toEqual(expect.objectContaining({ alt_phone: '+919812300000', course_id: 21, score: 80 }));
    expect(p.diff.conflicts.email).toEqual({ kept: 'asha@real.com', incoming: 'typo@x.com' });
    expect(p.diff.custom_conflicts.batch).toEqual({ kept: 'Morning', incoming: 'Evening' });
    expect(p.diff.tags_added).toEqual([42]);
    expect(p.target_closed).toBe(false);
    // nothing was written
    expect(st.merges).toHaveLength(0);
    expect(st.leads[0].alt_phone).toBeNull();
  });

  it('merges non-destructively: blanks filled, conflicts keep the existing value', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await svcOf(db).mergeLeads(201, 202, 9);
    const target = st.leads.find((l: any) => l.id === 201);
    expect(target.alt_phone).toBe('+919812300000');   // filled
    expect(target.course_id).toBe(21);                // filled
    expect(target.score).toBe(80);                    // 0 -> filled
    expect(target.email).toBe('asha@real.com');       // conflict -> existing WINS
    expect(target.priority).toBe('med');              // conflict -> existing WINS
    expect(target.custom_fields).toEqual({ batch: 'Morning', ref: 'RJ-9' });
  });

  it('keeps the target OWNER — a merge never re-assigns or re-runs round-robin', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    const res = await svcOf(db).mergeLeads(201, 202, 9);
    expect(res.owner_id).toBe(11);                    // NOT 12 (the source's owner)
    expect(st.leads.find((l: any) => l.id === 201).owner_id).toBe(11);
    expect(st.cursor).toBe(-1);                       // the distribution cursor never moved
  });

  it('writes the timeline entry, the audit rows and the merge diff', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await svcOf(db).mergeLeads(201, 202, 9);
    const merge = st.activities.find((a: any) => a.type === 'merge');
    expect(merge.note).toMatch(/Duplicate merged from manual \(lead #202\)/);
    expect(st.merges).toHaveLength(1);
    expect(st.merges[0].target_lead_id).toBe(201);
    expect(st.merges[0].source_lead_id).toBe(202);
    expect(st.merges[0].diff.conflicts.email.incoming).toBe('typo@x.com');
    // one audit row for the survivor, one for the tombstone
    expect(st.audit.filter((a: any) => a.action === 'merge')).toHaveLength(2);
  });

  it('moves the source timeline and its OPEN follow-ups to the survivor (nothing is lost)', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await svcOf(db).mergeLeads(201, 202, 9);
    expect(st.activities.filter((a: any) => Number(a.lead_id) === 202)).toHaveLength(0);
    expect(st.activities.some((a: any) => Number(a.lead_id) === 201 && a.note === 'called, wants evening batch')).toBe(true);
    expect(st.followups.find((f: any) => f.id === 1).lead_id).toBe(201);   // pending -> moved
    expect(st.followups.find((f: any) => f.id === 2).lead_id).toBe(202);   // done -> stays
  });

  it('turns the source into a soft-deleted tombstone pointing at the survivor', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await svcOf(db).mergeLeads(201, 202, 9);
    const src = st.leads.find((l: any) => l.id === 202);
    expect(src.merged_into_id).toBe(201);
    expect(src.deleted_at).toBeTruthy();          // soft delete convention — never a hard delete
    expect(src.deleted_by).toBe(9);
    expect(src.is_duplicate).toBe(true);
  });

  it('appends the source tags to the survivor', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await svcOf(db).mergeLeads(201, 202, 9);
    expect(st.tags.filter((t: any) => t.lead_id === 201).map((t: any) => t.tag_id).sort()).toEqual([41, 42]);
  });

  it('reopens a WON/LOST survivor when asked (merge & reopen)', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    st.leads[0].stage_id = 59;                    // Lost
    st.leads[0].status_id = 35;                   // ... and Status = Lost (dev/130 DEFECT 1)
    const res = await svcOf(db).mergeLeads(201, 202, 9, true);
    expect(res.reopened).toBe(true);
    expect(Number(st.leads[0].stage_id)).toBe(51);
    // dev/130 (DEFECT 1): the status must NOT stay Lost — it is reset to the OPEN 'New' status
    // (id 31) so Stage and Status can never contradict on the re-opened lead.
    expect(Number(st.leads[0].status_id)).toBe(31);
    expect(st.activities.some((a: any) => a.type === 'status_change')).toBe(true);
    expect(st.leads[0].owner_id).toBe(11);        // the closed lead's owner is preserved
  });

  it('does not reopen an already-open survivor', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    const res = await svcOf(db).mergeLeads(201, 202, 9, true);
    expect(res.reopened).toBe(false);
    expect(Number(st.leads[0].stage_id)).toBe(51);
  });

  it('refuses to merge a lead into itself', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await expect(svcOf(db).mergeLeads(201, 201, 9)).rejects.toThrow(BadRequestException);
  });

  it('refuses to merge a lead that was already merged away', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    st.leads[1].merged_into_id = 999;
    await expect(svcOf(db).mergeLeads(201, 202, 9)).rejects.toThrow(/already been merged/);
  });

  it('404s on a missing / soft-deleted lead', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    await expect(svcOf(db).mergeLeads(201, 777, 9)).rejects.toThrow(NotFoundException);
    st.leads[1].deleted_at = new Date().toISOString();
    await expect(svcOf(db).mergeLeads(201, 202, 9)).rejects.toThrow(NotFoundException);
  });

  it('duplicatesFor() reports the duplicate group and the merge history', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    const before = await svcOf(db).duplicatesFor(201, ALL);
    expect(before.counts.open).toBe(1);                        // lead 202 is a live duplicate
    expect(Number(before.duplicates[0].id)).toBe(202);
    expect(before.merges).toHaveLength(0);

    await svcOf(db).mergeLeads(201, 202, 9);
    const after = await svcOf(db).duplicatesFor(201, ALL);
    expect(after.counts.open).toBe(0);                         // no longer mergeable
    expect(after.counts.merged).toBe(1);                       // it is a tombstone now
    expect(after.merges).toHaveLength(1);
    expect(after.merges[0].diff.conflicts.email.incoming).toBe('typo@x.com');
  });

  it('duplicatesFor() on the duplicate shows what it is a duplicate OF', async () => {
    const { db, st } = makeFakeDb();
    seed(st);
    const d = await svcOf(db).duplicatesFor(202, ALL);
    expect(Number((d.duplicate_of as any).id)).toBe(201);
    expect(d.is_duplicate).toBe(true);
  });
});
