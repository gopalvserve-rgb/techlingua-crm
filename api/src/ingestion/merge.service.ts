import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import {
  MergeDiff, computeMergeDiff, describeDiff, diffIsEmpty, mergedCustomFields, MERGEABLE_FIELDS,
} from './merge.util';

/**
 * DUPLICATE MERGE ENGINE (NeoDove §4) — the half migration 018 left as a seam.
 *
 * ONE core, two entry points:
 *   applyMerge()   — used inside the ingestion transaction: fold an INCOMING
 *                    payload into an existing lead (no second lead is created).
 *   mergeLeads()   — used by the UI: fold one EXISTING lead into another; the
 *                    source lead becomes a soft-deleted tombstone pointing at
 *                    the survivor (merged_into_id), and its timeline and open
 *                    follow-ups move across so nothing is lost.
 *
 * Invariants (both paths):
 *   - non-destructive: blanks are filled, conflicts keep the EXISTING value and
 *     record the incoming one in the diff + the timeline (merge.util).
 *   - the surviving lead KEEPS its owner. A merge never re-runs round-robin —
 *     §4's "open lead -> same user" rule is preserved by construction.
 *   - every merge writes a lead_activity ('merge'), an audit_log row ('merge')
 *     and a lead_merge row carrying the diff the UI renders.
 */

const DUP_SCOPE_COLS: ScopeColumnMap = {
  owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};

export interface ApplyMergeOpts {
  action: 'merge' | 'merge_and_reopen';
  channel: string;
  actorId: number | null;
  /** set when an existing lead is being merged away (manual path) */
  sourceLeadId?: number | null;
  /** free-text note carried in with the incoming record */
  note?: string | null;
  incomingTagIds?: number[];
}

export interface ApplyMergeResult {
  merge_id: number;
  diff: MergeDiff;
  reopened: boolean;
  owner_id: number | null;
}

@Injectable()
export class LeadMergeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  // ---- the core (runs inside a caller-supplied transaction) ----------------

  /**
   * Fold `incoming` (lead-column shaped) into the existing lead row `target`.
   * Returns the merge id + the diff. Never touches owner_id.
   */
  async applyMerge(
    c: PoolClient, target: Record<string, any>, incoming: Record<string, unknown>, opts: ApplyMergeOpts,
  ): Promise<ApplyMergeResult> {
    const leadId = Number(target.id);
    const org = Number(target.org_id);

    const existingTags = (await c.query(`SELECT tag_id FROM lead_tag WHERE lead_id = $1`, [leadId]))
      .rows.map((r: any) => Number(r.tag_id));

    const diff = computeMergeDiff(
      target, incoming, opts.incomingTagIds ?? [], existingTags, opts.note ?? null,
    );

    // 1) fill the blanks (conflicts deliberately do NOT write — existing wins)
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    for (const f of MERGEABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(diff.filled, f)) set(f, diff.filled[f]);
    }
    if (Object.keys(diff.custom_filled).length) {
      set('custom_fields', JSON.stringify(mergedCustomFields(target.custom_fields ?? {}, diff)));
    }

    // 2) merge_and_reopen — a won/lost lead goes back to an OPEN stage (§4)
    let reopened = false;
    let reopenFrom: { id: number; name: string } | null = null;
    let reopenTo: { id: number; name: string } | null = null;
    if (opts.action === 'merge_and_reopen') {
      const cur = (await c.query(
        `SELECT s.id, s.name, s.stage_type FROM pipeline_stage s WHERE s.id = $1`, [target.stage_id],
      )).rows[0];
      if (cur && ['won', 'lost'].includes(String(cur.stage_type))) {
        const open = (await c.query(
          `SELECT id, name FROM pipeline_stage
            WHERE pipeline_id = $1 AND is_active AND stage_type = 'open'
            ORDER BY is_default DESC, sort_order ASC LIMIT 1`,
          [target.pipeline_id],
        )).rows[0];
        if (open) {
          set('stage_id', Number(open.id));
          reopened = true;
          reopenFrom = { id: Number(cur.id), name: String(cur.name) };
          reopenTo = { id: Number(open.id), name: String(open.name) };
        }
      }
    }

    // the lead was touched even when only a conflict was recorded
    if (sets.length) {
      params.push(leadId);
      await c.query(
        `UPDATE lead SET ${sets.join(', ')}, last_activity_at = now(), updated_at = now()
          WHERE id = $${params.length}`, params,
      );
    } else {
      await c.query(`UPDATE lead SET last_activity_at = now(), updated_at = now() WHERE id = $1`, [leadId]);
    }

    // 3) tags: append, never replace
    for (const tagId of diff.tags_added) {
      await c.query(`INSERT INTO lead_tag (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [leadId, tagId]);
    }

    // 4) the merge record (carries the diff the UI shows)
    const m = await c.query(
      `INSERT INTO lead_merge (org_id, target_lead_id, source_lead_id, channel, action, reopened, diff, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [org, leadId, opts.sourceLeadId ?? null, opts.channel, opts.action, reopened,
        JSON.stringify(diff), opts.actorId],
    );
    const mergeId = Number(m.rows[0].id);

    // 5) timeline — "Duplicate merged from <channel>" + the diff
    const log = (type: string, from: unknown, to: unknown, note: string | null) => c.query(
      `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [leadId, org, target.branch_id, opts.actorId, type,
        from == null ? null : JSON.stringify(from), to == null ? null : JSON.stringify(to), note],
    );
    const src = opts.sourceLeadId ? ` (lead #${opts.sourceLeadId})` : '';
    await log(
      'merge',
      { conflicts: diff.conflicts, custom_conflicts: diff.custom_conflicts },
      {
        action: opts.action, channel: opts.channel, merge_id: mergeId,
        source_lead_id: opts.sourceLeadId ?? null, reopened,
        filled: diff.filled, custom_filled: diff.custom_filled, tags_added: diff.tags_added,
      },
      `Duplicate merged from ${opts.channel}${src} — ${describeDiff(diff)}`,
    );
    // notes are APPENDED, never merged into a field
    if (diff.note) await log('note', null, null, diff.note);
    if (reopened) {
      await log('stage_change', reopenFrom, reopenTo, 'Closed lead re-opened by duplicate merge (campaign rule: merge & reopen)');
    }

    // 6) audit (channel workers never pass through the HTTP AuditInterceptor)
    await c.query(
      `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after)
       VALUES ($1,$2,'leads',$3,'merge',$4,$5)`,
      [org, opts.actorId, leadId,
        JSON.stringify({ conflicts: diff.conflicts, custom_conflicts: diff.custom_conflicts }),
        JSON.stringify({
          merge_id: mergeId, action: opts.action, channel: opts.channel,
          source_lead_id: opts.sourceLeadId ?? null, reopened,
          filled: diff.filled, custom_filled: diff.custom_filled, tags_added: diff.tags_added,
          empty: diffIsEmpty(diff),
        })],
    );

    return { merge_id: mergeId, diff, reopened, owner_id: target.owner_id == null ? null : Number(target.owner_id) };
  }

  // ---- manual path: merge one EXISTING lead into another --------------------

  private async loadLead(id: number): Promise<Record<string, any>> {
    const l = await this.db.one<Record<string, any>>(
      `SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!l) throw new NotFoundException('lead not found');
    return l;
  }

  /** Lead row -> the "incoming" shape the merge core consumes. */
  private asIncoming(l: Record<string, any>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of MERGEABLE_FIELDS) out[f] = l[f];
    out.custom_fields = l.custom_fields ?? {};
    return out;
  }

  private async tagsOf(leadId: number): Promise<number[]> {
    const rows = await this.db.query<{ tag_id: string }>(`SELECT tag_id FROM lead_tag WHERE lead_id = $1`, [leadId]);
    return rows.map((r) => Number(r.tag_id));
  }

  /** What WOULD a merge of `sourceId` into `targetId` do? (no writes) */
  async preview(targetId: number, sourceId: number) {
    if (Number(targetId) === Number(sourceId)) throw new BadRequestException('A lead cannot be merged into itself.');
    const target = await this.loadLead(targetId);
    const source = await this.loadLead(sourceId);
    const diff = computeMergeDiff(
      target, this.asIncoming(source), await this.tagsOf(sourceId), await this.tagsOf(targetId), null,
    );
    const stage = await this.db.one<{ stage_type: string }>(
      `SELECT stage_type FROM pipeline_stage WHERE id = $1`, [target.stage_id],
    );
    const closed = ['won', 'lost'].includes(String(stage?.stage_type ?? ''));
    return {
      target: await this.summary(targetId),
      source: await this.summary(sourceId),
      diff,
      target_closed: closed,
      can_reopen: closed,
      summary: describeDiff(diff),
    };
  }

  private summary(id: number) {
    return this.db.one(
      `SELECT l.id, l.full_name, l.phone, l.email, l.owner_id, l.created_at, l.is_duplicate,
              l.duplicate_of_id, l.merged_into_id, l.deleted_at,
              u.name AS owner_name, st.name AS stage_name, st.stage_type,
              c.name AS campaign_name, s.name AS source_name
         FROM lead l
         LEFT JOIN "user" u ON u.id = l.owner_id
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
         LEFT JOIN campaign c ON c.id = l.campaign_id
         LEFT JOIN source s ON s.id = l.source_id
        WHERE l.id = $1`, [id],
    );
  }

  /**
   * Merge `sourceId` INTO `targetId` (the target survives).
   * RBAC is enforced by the controller: BOTH ids pass the record-scope enforcer.
   */
  async mergeLeads(
    targetId: number, sourceId: number, actorId: number, reopen = false,
  ) {
    if (Number(targetId) === Number(sourceId)) throw new BadRequestException('A lead cannot be merged into itself.');
    const target = await this.loadLead(targetId);
    const source = await this.loadLead(sourceId);
    if (source.merged_into_id) throw new BadRequestException(`Lead #${sourceId} has already been merged.`);
    if (Number(target.org_id) !== Number(source.org_id)) throw new BadRequestException('Leads belong to different organisations.');

    const incoming = this.asIncoming(source);
    const srcTags = await this.tagsOf(sourceId);
    // the source's own notes ride along as the merge note (appended to the target)
    const note = `Merged from lead #${sourceId} (${source.full_name}, ${source.phone}).`;

    return this.db.tx(async (c) => {
      const res = await this.applyMerge(c, target, incoming, {
        action: reopen ? 'merge_and_reopen' : 'merge',
        channel: 'manual', actorId, sourceLeadId: sourceId, note, incomingTagIds: srcTags,
      });

      // the source's HISTORY moves to the survivor — append, nothing lost
      await c.query(`UPDATE lead_activity SET lead_id = $1 WHERE lead_id = $2`, [targetId, sourceId]);
      // open follow-ups move too (a closed lead must not keep live tasks)
      await c.query(
        `UPDATE follow_up SET lead_id = $1, updated_at = now()
          WHERE lead_id = $2 AND status = 'pending' AND deleted_at IS NULL`,
        [targetId, sourceId],
      );

      // the source becomes a tombstone: soft-deleted, pointing at the survivor
      await c.query(
        `UPDATE lead
            SET merged_into_id = $1, duplicate_of_id = COALESCE(duplicate_of_id, $1), is_duplicate = TRUE,
                deleted_at = now(), deleted_by = $2, updated_at = now()
          WHERE id = $3`,
        [targetId, actorId, sourceId],
      );
      await c.query(
        `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
         VALUES ($1,$2,'leads',$3,'merge',$4)`,
        [Number(source.org_id), actorId, sourceId,
          JSON.stringify({ merged_into_id: targetId, merge_id: res.merge_id, soft_deleted: true })],
      );
      return { ok: true, target_lead_id: targetId, source_lead_id: sourceId, ...res };
    });
  }

  // ---- read side: the lead-detail duplicate panel ---------------------------

  /**
   * "This lead is a duplicate of X" + "this lead has N duplicates" + merge history.
   * Every lead listed is filtered through the caller's lead.read record scope, so
   * a scoped user never sees an out-of-scope lead through this panel.
   */
  async duplicatesFor(leadId: number, scope: ResolvedScope) {
    const lead = await this.loadLead(leadId);

    const scoped = async (extraWhere: string, extraParams: unknown[]) => {
      const params: unknown[] = [];
      const where = this.resolver.buildScopeWhere(scope, DUP_SCOPE_COLS, params);
      const offset = params.length;
      const sql = extraWhere.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + offset}`);
      return this.db.query(
        `SELECT l.id, l.full_name, l.phone, l.email, l.created_at, l.owner_id, l.deleted_at,
                l.merged_into_id, l.duplicate_of_id, l.is_duplicate,
                u.name AS owner_name, st.name AS stage_name, st.stage_type,
                c.name AS campaign_name, s.name AS source_name
           FROM lead l
           LEFT JOIN "user" u ON u.id = l.owner_id
           LEFT JOIN pipeline_stage st ON st.id = l.stage_id
           LEFT JOIN campaign c ON c.id = l.campaign_id
           LEFT JOIN source s ON s.id = l.source_id
          WHERE (${where}) AND ${sql}
          ORDER BY l.created_at DESC LIMIT 50`,
        [...params, ...extraParams],
      );
    };

    // the lead THIS one duplicates (from the ingest flag or a completed merge)
    const parentId = lead.merged_into_id ?? lead.duplicate_of_id ?? null;
    const duplicateOf = parentId ? (await scoped('l.id = $1', [parentId]))[0] ?? null : null;

    // live duplicates of THIS lead (still separate leads — mergeable)
    const duplicates = await scoped('l.duplicate_of_id = $1 AND l.deleted_at IS NULL AND l.id <> $1', [leadId]);
    // duplicates already merged away into this lead (tombstones)
    const merged = await scoped('l.merged_into_id = $1', [leadId]);

    const merges = await this.db.query(
      `SELECT m.id, m.action, m.reopened, m.channel, m.diff, m.created_at,
              m.source_lead_id, u.name AS actor_name
         FROM lead_merge m LEFT JOIN "user" u ON u.id = m.actor_id
        WHERE m.target_lead_id = $1
        ORDER BY m.created_at DESC LIMIT 50`,
      [leadId],
    );

    return {
      lead_id: leadId,
      is_duplicate: !!lead.is_duplicate,
      merged_into_id: lead.merged_into_id ? Number(lead.merged_into_id) : null,
      duplicate_of: duplicateOf,
      duplicates,
      merged,
      merges,
      counts: { open: duplicates.length, merged: merged.length },
    };
  }
}
