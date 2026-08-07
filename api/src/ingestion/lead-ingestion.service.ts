import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { ScoringService } from '../scoring/scoring.service';
import { SlaService } from '../sla/sla.service';
import { normalizePhone } from '../common/phone.util';
import { DistributionConfig, matchCondition, pickFromPool } from '../leads/distribution.util';
import {
  DuplicateAction, DuplicatePolicy, IngestChannel, IngestContext, IngestOutcome, IngestPayload,
  IngestValidationError,
} from './ingestion.types';
import { LeadMergeService } from './merge.service';
import { JourneyService } from '../journeys/journey.service';
import { MERGEABLE_FIELDS } from './merge.util';
import { toDateString } from '../common/date.util';

/** Campaign duplicacy_config (migration 002). */
export interface DuplicacyConfig {
  // Client change (Jul 2026): scope = { this_campaign, this_vertical, this_branch,
  // global }. `this_pipeline` removed; a legacy stored value is treated as
  // `this_campaign` (see findDuplicate).
  check_scope?: 'this_campaign' | 'this_vertical' | 'this_branch' | 'global' | 'this_pipeline';
  match_key?: 'phone';
  on_duplicate?: 'ignore' | 'merge' | 'create' | 'merge_and_reopen' | 'flag';
  open_reassign_same_user?: boolean;
}

/** Everything a channel needs about its target, loaded ONCE per batch. */
export interface IngestTarget {
  org_id: number;
  branch_id: number; vertical_id: number; pipeline_id: number;
  campaign_id: number; source_id: number;
  distribution: DistributionConfig;
  duplicacy: DuplicacyConfig;
  default_stage_id: number | null;
  default_status_id: number | null;
  masters: Record<string, Map<string, number>>;   // 'course' -> name(lower) -> id
  stages: Map<string, number>;
  customKeys: Set<string>;
}

export interface NormalisedLead {
  full_name: string; phone: string; email: string | null; alt_phone: string | null;
  whatsapp_phone: string | null;
  dob: string | null;
  state_id: number | null; city_id: number | null; course_id: number | null;
  qualification_id: number | null; budget_id: number | null;
  status_id: number | null; stage_id: number | null;
  priority: 'low' | 'med' | 'high'; temperature: 'hot' | 'warm' | 'cold' | null; score: number;
  next_follow_up_at: string | null; note: string | null;
  tag_ids: number[]; custom_fields: Record<string, unknown>; external_id: string | null;
  /** master values that could not be resolved under softMasters (label, raw) — surfaced in the import preview. */
  unresolved?: Array<[string, string]>;
}

const MASTER_TABLE: Record<string, string> = {
  state: 'state', city: 'city', course: 'm_course', qualification: 'm_qualification',
  budget: 'm_budget', status: 'm_status', tag: 'm_tag',
};

/** Sentinel: another worker already ingested this exact record (unique-index race). */
class AlreadyIngested extends Error {}

/**
 * THE shared ingestion pipeline. Every capture channel goes through ingest():
 *   normalise -> resolve hierarchy -> E.164 phone -> duplicate check (NeoDove §4)
 *   -> distribution (campaign engine) -> persist + audit, idempotently.
 *
 * Idempotency: a record is keyed (source_id, dedupe_key) in lead_ingest_record,
 * where dedupe_key = the provider's record id when it has one, else a sha-256 of
 * the payload. Re-ingesting the same record NEVER creates a second lead and
 * NEVER bumps the round-robin cursor a second time.
 *
 * Duplicate actions (NeoDove §4) — ALL FOUR are executed here:
 *   ignore           -> no new lead; the incoming record is dropped (ledger only)
 *   create           -> a second lead, flagged is_duplicate + duplicate_of_id
 *   merge            -> LeadMergeService folds the payload into the existing lead
 *                       (non-destructive; see merge.util) — no second lead
 *   merge_and_reopen -> merge, and a won/lost lead goes back to an open stage
 * A merge NEVER re-runs round-robin: the existing lead keeps its owner, which is
 * exactly §4's "open duplicate stays with the same user" rule.
 */
@Injectable()
export class LeadIngestionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly merger: LeadMergeService,
    /**
     * Sprint 3 — every lead, from EVERY channel, gets its SLA clock started and its
     * score computed the moment it exists. Hooking it here (rather than in each of the
     * five callers) is what keeps "one ingestion path" true: CSV, Meta, Google, the
     * website form, the Sheet pull, walk-ins, referrals and manual Add Lead all get it.
     * Optional so the in-memory test double can omit them.
     */
    private readonly scoring?: ScoringService,
    private readonly sla?: SlaService,
    /**
     * Sprint 4 — automation journeys. Hooked in the SAME one place, so a `lead_created`
     * journey fires for a Meta lead, a Google lead, a website form, a Sheet row, a CSV
     * import, a walk-in, a referral AND a manual Add Lead, without any of them knowing
     * that journeys exist. Optional so the in-memory test double can omit it.
     */
    private readonly journeys?: JourneyService,
  ) {}

  /**
   * Fired after the ingest transaction has COMMITTED. Best-effort by design: a scoring
   * or SLA hiccup must never lose a lead that is already durably stored.
   */
  private async afterIngest(outcome: IngestOutcome): Promise<void> {
    const id = outcome?.lead_id;
    if (!id) return;
    if (outcome.status === 'created') {
      await this.sla?.safe(() => this.sla!.onLeadCreated(Number(id)), 'sla.onLeadCreated(ingest)');
    }
    if (outcome.status === 'created' || outcome.merged) {
      await this.scoring?.safeRescore(Number(id));
    }
    // Fire AFTER scoring: a journey conditioned on "score band = Hot" must see the score
    // this lead actually has, not the zero it had a millisecond ago.
    if (outcome.status === 'created') {
      await this.journeys?.safeFire('lead_created', Number(id));
    }
  }

  // ---- target resolution ---------------------------------------------------

  async loadTarget(campaignId: number, sourceId: number): Promise<IngestTarget> {
    const camp = await this.db.one<any>(
      `SELECT id, org_id, branch_id, vertical_id, pipeline_id, distribution_config, duplicacy_config
         FROM campaign WHERE id = $1 AND is_active AND deleted_at IS NULL`, [campaignId],
    );
    if (!camp) throw new NotFoundException('campaign not found');
    const src = await this.db.one<any>(
      `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`,
      [sourceId, campaignId],
    );
    if (!src) throw new BadRequestException('source does not belong to the campaign');

    const org = Number(camp.org_id);
    const masters: Record<string, Map<string, number>> = {};
    for (const [key, table] of Object.entries(MASTER_TABLE)) {
      if (key === 'course') continue; // resolved Branch>Vertical-aware just below
      const rows = await this.db.query<{ id: string; name: string }>(
        `SELECT id, name FROM ${table} WHERE deleted_at IS NULL AND is_active`,
      );
      masters[key] = new Map(rows.map((r) => [String(r.name).trim().toLowerCase(), Number(r.id)]));
    }
    // A Course belongs to a Branch > Vertical (m_course.meta.branch_id / .vertical_id — the SAME
    // scoping the Add-Lead course dropdown uses, UAT #27). Resolve a Course value the way manual
    // entry does: a course scoped to a DIFFERENT branch/vertical is NOT eligible for this import,
    // and where a name exists in several places the one scoped to THIS import's branch+vertical
    // wins. An unscoped course (no meta branch/vertical) stays eligible everywhere.
    masters['course'] = await this.loadCourseMaster(Number(camp.branch_id), Number(camp.vertical_id));
    const stageRows = await this.db.query<{ id: string; name: string; is_default: boolean; sort_order: number }>(
      `SELECT id, name, is_default, sort_order FROM pipeline_stage
        WHERE pipeline_id = $1 AND is_active ORDER BY is_default DESC, sort_order ASC`,
      [Number(camp.pipeline_id)],
    );
    const defStatus = await this.db.one<{ id: string }>(`SELECT id FROM m_status WHERE org_id = $1 AND code = 'NEW'`, [org]);
    const cfs = await this.db.query<{ field_key: string }>(
      `SELECT field_key FROM custom_field_def WHERE entity = 'lead' AND is_active AND deleted_at IS NULL`,
    );

    return {
      org_id: org,
      branch_id: Number(camp.branch_id), vertical_id: Number(camp.vertical_id),
      pipeline_id: Number(camp.pipeline_id), campaign_id: campaignId, source_id: sourceId,
      distribution: (camp.distribution_config ?? {}) as DistributionConfig,
      duplicacy: (camp.duplicacy_config ?? {}) as DuplicacyConfig,
      default_stage_id: stageRows[0] ? Number(stageRows[0].id) : null,
      default_status_id: defStatus ? Number(defStatus.id) : null,
      masters,
      stages: new Map(stageRows.map((s) => [String(s.name).trim().toLowerCase(), Number(s.id)])),
      customKeys: new Set(cfs.map((c) => c.field_key)),
    };
  }

  /**
   * Course master resolution, scoped to the import target's Branch > Vertical (UAT #27).
   * A course whose meta pins it to a different branch/vertical is filtered out; among the
   * eligible ones a better-scoped match overwrites an unscoped same-named course.
   */
  private async loadCourseMaster(branchId: number, verticalId: number): Promise<Map<string, number>> {
    const rows = await this.db.query<{ id: string; name: string; branch_id: string | null; vertical_id: string | null }>(
      `SELECT id, name,
              NULLIF(meta->>'branch_id','')::bigint   AS branch_id,
              NULLIF(meta->>'vertical_id','')::bigint AS vertical_id
         FROM m_course WHERE deleted_at IS NULL AND is_active`,
    );
    const rank = (r: { branch_id: string | null; vertical_id: string | null }): number => {
      const branchOk = r.branch_id == null || Number(r.branch_id) === branchId;
      const verticalOk = r.vertical_id == null || Number(r.vertical_id) === verticalId;
      if (!branchOk || !verticalOk) return -1; // pinned elsewhere — not a course of THIS import
      return (r.branch_id != null ? 1 : 0) + (r.vertical_id != null ? 1 : 0);
    };
    const map = new Map<string, number>();
    const eligible = rows.map((r) => ({ r, rk: rank(r) })).filter((x) => x.rk >= 0).sort((a, b) => a.rk - b.rk);
    for (const { r } of eligible) map.set(String(r.name).trim().toLowerCase(), Number(r.id)); // ascending rank: best wins
    return map;
  }

  // ---- normalisation / validation (pure over the target) -------------------

  /**
   * Resolve a master value that may be an id or a name. Unknown -> throws (visible in
   * preview; rejected for manual UI entry and CSV import).
   *
   * OBS-02: on an INBOUND integration/marketplace lead (`soft` = true) an unknown master
   * value must NEVER drop the lead. Instead of throwing we record it in `unresolved`
   * (surfaced on the lead note by normalise) and return null — the lead is still created
   * with the raw value preserved, so no marketplace lead is silently lost. We do NOT
   * auto-create the master value, because an untrusted inbound feed would pollute the
   * City/Course masters with typos and spam; preserving the raw value is the safe option.
   */
  private master(
    target: IngestTarget, kind: string, label: string, raw: unknown,
    soft = false, unresolved?: Array<[string, string]>,
  ): number | null {
    if (raw == null || String(raw).trim() === '') return null;
    const v = String(raw).trim();
    if (/^\d+$/.test(v)) {
      const id = Number(v);
      if ([...target.masters[kind].values()].includes(id)) return id;
      if (soft) { unresolved?.push([label, v]); return null; }
      throw new IngestValidationError(`Unknown ${label}: "${v}"`);
    }
    const hit = target.masters[kind].get(v.toLowerCase());
    if (hit == null) {
      if (soft) { unresolved?.push([label, v]); return null; }
      throw new IngestValidationError(`Unknown ${label}: "${v}"`);
    }
    return hit;
  }

  /** dd/mm/yyyy · dd-mm-yyyy · yyyy-mm-dd · ISO — anything else is a row error. */
  private date(raw: unknown): string | null {
    if (raw == null || String(raw).trim() === '') return null;
    const v = String(raw).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(v);
    if (m) {
      const d = new Date(m[4] ? v.replace(' ', 'T') : `${v}T00:00:00`);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(v);
    if (m) {
      const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
      if (!isNaN(d.getTime()) && d.getUTCMonth() === Number(m[2]) - 1) return d.toISOString();
    }
    throw new IngestValidationError(`Invalid date: "${v}" (use YYYY-MM-DD or DD/MM/YYYY)`);
  }

  normalise(p: IngestPayload, target: IngestTarget, opts: { softMasters?: boolean } = {}): NormalisedLead {
    const soft = !!opts.softMasters;
    // OBS-02: raw master values we could not resolve on an inbound lead — preserved on the note.
    const unresolved: Array<[string, string]> = [];
    const name = String(p.full_name ?? '').trim();
    if (!name) throw new IngestValidationError('Name is required');
    const rawPhone = String(p.phone ?? '').trim();
    if (!rawPhone) throw new IngestValidationError('Mobile number is required');
    const phone = normalizePhone(rawPhone) as string;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) throw new IngestValidationError(`Invalid mobile number: "${rawPhone}"`);

    const email = p.email ? String(p.email).trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new IngestValidationError(`Invalid email: "${email}"`);

    const prio = String(p.priority ?? 'med').trim().toLowerCase();
    const priority = ({ low: 'low', med: 'med', medium: 'med', high: 'high' } as Record<string, 'low' | 'med' | 'high'>)[prio];
    if (!priority) throw new IngestValidationError(`Invalid priority: "${p.priority}" (low / med / high)`);

    let temperature: 'hot' | 'warm' | 'cold' | null = null;
    if (p.temperature != null && String(p.temperature).trim() !== '') {
      const t = String(p.temperature).trim().toLowerCase();
      if (!['hot', 'warm', 'cold'].includes(t)) throw new IngestValidationError(`Invalid temperature: "${p.temperature}" (hot / warm / cold)`);
      temperature = t as 'hot' | 'warm' | 'cold';
    }

    let score = 0;
    if (p.score != null && String(p.score).trim() !== '') {
      score = Number(p.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) throw new IngestValidationError(`Invalid score: "${p.score}" (0-100)`);
      score = Math.round(score);
    }

    let stage_id = target.default_stage_id;
    if (p.stage != null && String(p.stage).trim() !== '') {
      const s = String(p.stage).trim();
      const hit = /^\d+$/.test(s) ? ([...target.stages.values()].includes(Number(s)) ? Number(s) : undefined) : target.stages.get(s.toLowerCase());
      if (hit == null) throw new IngestValidationError(`Unknown Stage: "${s}" (must be a stage of the campaign's pipeline)`);
      stage_id = hit;
    }

    const tagNames = Array.isArray(p.tags) ? p.tags : String(p.tags ?? '').split(',');
    const tag_ids = tagNames.map((t) => String(t).trim()).filter(Boolean)
      .map((t) => this.master(target, 'tag', 'Tag', t, soft, unresolved))
      .filter((x): x is number => x != null);

    // Resolve the validated masters (soft on inbound channels — OBS-02).
    const state_id = this.master(target, 'state', 'State', p.state, soft, unresolved);
    const city_id = this.master(target, 'city', 'City', p.city, soft, unresolved);
    const course_id = this.master(target, 'course', 'Course', p.course, soft, unresolved);
    const qualification_id = this.master(target, 'qualification', 'Qualification', p.qualification, soft, unresolved);
    const budget_id = this.master(target, 'budget', 'Budget', p.budget, soft, unresolved);
    const status_id = this.master(target, 'status', 'Status', p.status, soft, unresolved) ?? target.default_status_id;

    // OBS-02: append any unresolved master values to the note so nothing the source sent is lost.
    const baseNote = p.note ? String(p.note).trim() : null;
    const note = unresolved.length
      ? [baseNote, ...unresolved.map(([l, v]) => `${l}: ${v}`)].filter(Boolean).join('\n')
      : baseNote;

    return {
      full_name: name, phone,
      email, alt_phone: p.alt_phone ? normalizePhone(String(p.alt_phone)) : null,
      // DEF-S2-03: WhatsApp Number is a real, stored contact field
      whatsapp_phone: p.whatsapp_phone ? normalizePhone(String(p.whatsapp_phone)) : null,
      // an unparseable date must not fail the whole ingest — it just means no birthday journey
      dob: toDateString(p.dob) ?? null,
      state_id, city_id, course_id, qualification_id, budget_id, status_id,
      stage_id, priority, temperature, score,
      next_follow_up_at: this.date(p.next_follow_up_at),
      note,
      tag_ids: [...new Set(tag_ids)],
      custom_fields: (p.custom_fields ?? {}) as Record<string, unknown>,
      external_id: p.external_id ? String(p.external_id).trim().slice(0, 120) : null,
      unresolved: unresolved.length ? [...unresolved] : undefined,
    };
  }

  // ---- idempotency key -----------------------------------------------------

  /**
   * Provider record id when present, else a stable sha-256 of the payload.
   *
   * DEF-S2-01: `always_create` (the interactive "Add lead" form) gets a key that
   * can NEVER collide. A human deliberately typing the same lead twice must get
   * two leads — the idempotency ledger exists to swallow *machine* replays
   * (Meta/Google/form/sheet/CSV), not deliberate human acts. The ledger row is
   * still written, so the audit trail of every ingest stays complete.
   */
  dedupeKey(p: IngestPayload, ctx: IngestContext): string {
    if ((ctx.duplicate_policy ?? 'campaign') === 'always_create') return `man:${randomUUID()}`;
    const explicit = ctx.external_key ?? p.external_id;
    if (explicit && String(explicit).trim()) return `ext:${String(explicit).trim()}`.slice(0, 120);
    const canonical = JSON.stringify(
      Object.keys(p).sort().reduce<Record<string, unknown>>((o, k) => {
        const v = (p as Record<string, unknown>)[k];
        if (v != null && String(v).trim() !== '') o[k] = typeof v === 'object' ? v : String(v).trim();
        return o;
      }, {}),
    );
    return `sha:${createHash('sha256').update(`${ctx.campaign_id}|${ctx.source_id}|${canonical}`).digest('hex')}`;
  }

  // ---- duplicate detection (NeoDove §4) ------------------------------------

  /**
   * NeoDove §4 duplicate detection. The match key is the PHONE, but UAT-R2 #22 —
   * "WhatsApp Group duplicate validation" — extends it: an incoming lead is a
   * duplicate when EITHER its phone OR its WhatsApp number matches EITHER the
   * phone OR the WhatsApp number of an existing lead in scope. Every number is
   * canonical E.164, so the comparison is exact and country-aware.
   *
   * `numbers` = the incoming lead's contact numbers (its phone plus, when it
   * differs, its WhatsApp number). Scope (campaign / pipeline / global) is the
   * campaign's configured `check_scope`, unchanged.
   */
  async findDuplicate(numbers: string | string[], target: IngestTarget) {
    const nums = [...new Set((Array.isArray(numbers) ? numbers : [numbers]).map((n) => n).filter(Boolean))];
    if (!nums.length) return null;
    // Client change (Jul 2026): scope = campaign | vertical | branch | global.
    // A legacy `this_pipeline` value is narrowed to `this_campaign` (pipeline
    // scope was removed); migration 040 rewrites stored rows, this is defence in
    // depth for any row that slips through.
    const raw = target.duplicacy.check_scope ?? 'this_campaign';
    const scope = raw === 'this_pipeline' ? 'this_campaign' : raw;
    const params: unknown[] = [nums];
    let extra = '';
    if (scope === 'this_campaign') { params.push(target.campaign_id); extra = `AND l.campaign_id = $${params.length}`; }
    else if (scope === 'this_vertical') { params.push(target.vertical_id); extra = `AND l.vertical_id = $${params.length}`; }
    else if (scope === 'this_branch') { params.push(target.branch_id); extra = `AND l.branch_id = $${params.length}`; }
    // scope === 'global' -> no extra clause (match anywhere in the org)
    return this.db.one<{ id: string; owner_id: string | null; stage_type: string | null }>(
      `SELECT l.id, l.owner_id, st.stage_type
         FROM lead l LEFT JOIN pipeline_stage st ON st.id = l.stage_id
        WHERE (l.phone = ANY($1::text[]) OR l.whatsapp_phone = ANY($1::text[]))
          AND l.is_active AND l.deleted_at IS NULL ${extra}
        ORDER BY l.id LIMIT 1`,
      params,
    );
  }

  /** The normalised record in lead-column shape — what the merge core consumes. */
  private asMergeInput(lead: NormalisedLead): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const src = lead as unknown as Record<string, unknown>;
    for (const f of MERGEABLE_FIELDS) out[f] = src[f];
    out.custom_fields = lead.custom_fields ?? {};
    return out;
  }

  // ---- distribution (the ONE campaign engine; shared with manual create) ----

  /** The eligible agent pool for this record (empty = leave unassigned). */
  async resolvePool(target: IngestTarget, ctx: Record<string, unknown>): Promise<{ pool: number[]; note: string | null }> {
    const dist = target.distribution ?? {};
    let pool: number[] = [];
    let note: string | null = null;
    if (dist.mode === 'equal' && Array.isArray(dist.agent_user_ids) && dist.agent_user_ids.length) {
      pool = dist.agent_user_ids.map(Number);
      note = 'auto-assigned: equal round-robin';
    } else if (dist.mode === 'conditional' && Array.isArray(dist.conditions) && dist.conditions.length) {
      const hit = matchCondition(dist.conditions, ctx);
      if (hit) {
        pool = hit.rule.assign_to_user_ids.map(Number);
        note = `auto-assigned: condition #${hit.index + 1} (${hit.rule.field} ${hit.rule.op ?? 'equals'} ${JSON.stringify(hit.rule.value)})`;
      }
    }
    if (pool.length) {
      // pool hygiene: skip users disabled/deleted since the campaign was configured
      const live = await this.db.query<{ id: string }>(
        `SELECT id FROM "user" WHERE id = ANY($1::bigint[]) AND status = 'active' AND deleted_at IS NULL`, [pool],
      );
      const ok = new Set(live.map((r) => Number(r.id)));
      pool = pool.filter((id) => ok.has(id));
      // UAT-R2 #24 — a PAUSED agent (campaign_agent_pause) is skipped by round-robin
      // AND by conditional distribution, and resumes the instant it is un-paused.
      // Guarded: a DB without the table (or a unit double that does not model it)
      // simply yields no pauses — the documented default.
      if (pool.length) {
        try {
          const paused = await this.db.query<{ user_id: string }>(
            `SELECT user_id FROM campaign_agent_pause
              WHERE campaign_id = $1 AND paused AND user_id = ANY($2::bigint[])`,
            [target.campaign_id, pool],
          );
          const off = new Set(paused.map((r) => Number(r.user_id)));
          if (off.size) pool = pool.filter((id) => !off.has(id));
        } catch { /* table absent — no agent is paused */ }
      }
      // Users row-action #8 — a user with lead_assignment_enabled = FALSE is skipped by
      // round-robin AND by conditional distribution in EVERY campaign (the ORG-WIDE
      // equivalent of the per-campaign campaign_agent_pause above), and resumes the
      // instant it is re-enabled. Guarded: a DB/double without the column (migration 039
      // not yet applied) simply yields no rows — every user is treated as enabled.
      if (pool.length) {
        try {
          const disabled = await this.db.query<{ id: string }>(
            `SELECT u.id FROM "user" u
              WHERE u.id = ANY($1::bigint[]) AND u.lead_assignment_enabled = FALSE`,
            [pool],
          );
          const skip = new Set(disabled.map((r) => Number(r.id)));
          if (skip.size) pool = pool.filter((id) => !skip.has(id));
        } catch { /* column absent — every user is assignment-enabled */ }
      }
    }
    return { pool, note };
  }

  /** Transactional round-robin cursor bump -> the owner for THIS lead. */
  async pickOwner(c: PoolClient, campaignId: number, pool: number[]): Promise<number | null> {
    if (!pool.length) return null;
    const cur = await c.query(
      `INSERT INTO campaign_distribution_state (campaign_id, last_agent_idx) VALUES ($1, 0)
       ON CONFLICT (campaign_id)
       DO UPDATE SET last_agent_idx = campaign_distribution_state.last_agent_idx + 1, updated_at = now()
       RETURNING last_agent_idx`,
      [campaignId],
    );
    return pickFromPool(pool, Number(cur.rows[0].last_agent_idx));
  }

  // ---- THE pipeline --------------------------------------------------------

  async ingest(payload: IngestPayload, ctx: IngestContext, preloaded?: IngestTarget): Promise<IngestOutcome> {
    const outcome = await this.ingestInner(payload, ctx, preloaded);
    await this.afterIngest(outcome);
    return outcome;
  }

  /** The ingestion transaction itself (unchanged from Sprint 2). */
  private async ingestInner(payload: IngestPayload, ctx: IngestContext, preloaded?: IngestTarget): Promise<IngestOutcome> {
    const target = preloaded ?? (await this.loadTarget(ctx.campaign_id, ctx.source_id));
    const policy: DuplicatePolicy = ctx.duplicate_policy ?? 'campaign';
    const key = this.dedupeKey(payload, ctx);

    // 1) idempotency — a record already ingested for this source is a no-op.
    //    DEF-S2-01: the ledger governs AUTOMATED channels only. `always_create`
    //    (manual Add lead) skips the lookup entirely, so a second identical Add
    //    can never be reported as a "skipped replay" of the first.
    if (policy !== 'always_create') {
      const seen = await this.db.one<{ id: string; lead_id: string | null; outcome: string }>(
        `SELECT id, lead_id, outcome FROM lead_ingest_record WHERE source_id = $1 AND dedupe_key = $2`,
        [target.source_id, key],
      );
      if (seen) {
        // DEF-S2-01: a ledger row whose lead has since been SOFT-DELETED is not a
        // live hit — handing that id back would resurrect a deleted lead in the API
        // response while the list stays empty. Drop the dead row and ingest afresh.
        const live = seen.lead_id == null
          ? true
          : !!(await this.db.one(`SELECT id FROM lead WHERE id = $1 AND deleted_at IS NULL`, [Number(seen.lead_id)]));
        if (live) {
          return {
            status: 'skipped', lead_id: seen.lead_id ? Number(seen.lead_id) : null,
            reason: `Already imported (${seen.outcome}) — idempotent replay`,
          };
        }
        await this.db.query(`DELETE FROM lead_ingest_record WHERE id = $1`, [Number(seen.id)]);
      }
    }

    // 2) normalise + resolve (throws IngestValidationError -> dead-letter, no retry)
    // OBS-02: inbound integration/marketplace channels never drop a lead on an unknown
    // master value; CSV import (preview) and manual UI entry stay strict.
    // OBS-02 / import course fix (Aug 2026): CSV bulk import is a MACHINE feed, like the inbound
    // channels — an unknown master value (a Course/City/etc. not in the master) must NOT dead-letter
    // the row. It resolves case-insensitively when known and is preserved on the lead note when not,
    // exactly like Meta/Google/form/sheet. Interactive UI entry (manual/walk-in/referral) stays
    // strict so a human typing a value gets immediate validation.
    const softMasters = ['webhook', 'form', 'sheet', 'csv'].includes(ctx.channel);
    const lead = this.normalise(payload, target, { softMasters });

    // 3) duplicate check (phone + WhatsApp cross-match, campaign-configured scope — #22)
    const dup = await this.findDuplicate([lead.phone, lead.whatsapp_phone].filter(Boolean) as string[], target);
    const action: DuplicateAction = policy === 'always_create'
      ? 'create'
      : ((target.duplicacy.on_duplicate ?? 'ignore') as DuplicateAction);
    const dupOpen = dup ? !['won', 'lost'].includes(String(dup.stage_type ?? '')) : false;

    // 3a) IGNORE — drop the incoming record, keep the existing lead
    if (dup && action === 'ignore') {
      await this.db.query(
        `INSERT INTO lead_ingest_record (org_id, source_id, dedupe_key, channel, outcome, lead_id, batch_id,
                                         duplicate_of_id, applied_action)
         VALUES ($1,$2,$3,$4,'duplicate',NULL,$5,$6,'ignore') ON CONFLICT (source_id, dedupe_key) DO NOTHING`,
        [target.org_id, target.source_id, key, ctx.channel, ctx.batch_id ?? null, Number(dup.id)],
      );
      return {
        status: 'duplicate', lead_id: null, duplicate_of: Number(dup.id), action: 'ignore',
        reason: `Duplicate of lead #${dup.id} — ignored per campaign rule`,
      };
    }

    // 3b) MERGE / MERGE & REOPEN — fold the payload into the EXISTING lead.
    //     No second lead is created. For a plain `merge` the existing owner is
    //     preserved (§4's "open duplicate stays with the same user" rule).
    //     Client change (Jul 2026): for `merge_and_reopen`, when a CLOSED (won/
    //     lost) lead is actually re-opened, it is RE-ASSIGNED to the campaign's
    //     next round-robin agent (the reopened lead is fresh work). An OPEN
    //     duplicate is not reopened and keeps its owner, unchanged.
    if (dup && (action === 'merge' || action === 'merge_and_reopen')) {
      try {
        const merged = await this.db.tx(async (c) => {
          const existing = (await c.query(`SELECT * FROM lead WHERE id = $1 AND deleted_at IS NULL`, [Number(dup.id)])).rows[0];
          if (!existing) throw new IngestValidationError(`Duplicate target lead #${dup.id} no longer exists`);
          const res = await this.merger.applyMerge(c, existing, this.asMergeInput(lead), {
            action, channel: ctx.channel, actorId: ctx.actor_id,
            note: lead.note, incomingTagIds: lead.tag_ids,
          });
          // Client change (Jul 2026): a CLOSED lead re-opened by merge_and_reopen
          // is handed to the campaign's NEXT round-robin agent (not kept with the
          // old owner). Only fires when the lead was genuinely reopened (res.reopened)
          // and the campaign has an eligible pool; an empty pool leaves the owner as-is.
          let reopenOwner: number | null = null;
          if (action === 'merge_and_reopen' && res.reopened && policy === 'campaign') {
            const conditionCtx: Record<string, unknown> = {
              ...lead.custom_fields, ...payload,
              full_name: lead.full_name, phone: lead.phone, email: lead.email,
              priority: lead.priority, temperature: lead.temperature, score: lead.score,
              source_id: target.source_id, course_id: lead.course_id, city_id: lead.city_id,
              state_id: lead.state_id, budget_id: lead.budget_id, qualification_id: lead.qualification_id,
            };
            const { pool } = await this.resolvePool(target, conditionCtx);
            const nextOwner = await this.pickOwner(c, target.campaign_id, pool);
            if (nextOwner != null) {
              reopenOwner = nextOwner;
              const prevOwner = existing.owner_id == null ? null : Number(existing.owner_id);
              await c.query(`UPDATE lead SET owner_id = $1, updated_at = now() WHERE id = $2`, [nextOwner, Number(dup.id)]);
              await c.query(
                `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
                 VALUES ($1,$2,$3,$4,'assign',$5,$6,$7)`,
                [Number(dup.id), target.org_id, target.branch_id, ctx.actor_id,
                  prevOwner == null ? null : JSON.stringify({ owner_id: prevOwner }),
                  JSON.stringify({ owner_id: nextOwner }),
                  'Re-opened duplicate assigned to the next round-robin agent (campaign rule: merge & reopen)'],
              );
            }
          }
          // ledger LAST: a unique conflict = a concurrent worker already ingested
          // this record -> roll the whole tx back, so the merge happens ONCE.
          const led = await c.query(
            `INSERT INTO lead_ingest_record (org_id, source_id, dedupe_key, channel, outcome, lead_id, batch_id,
                                             duplicate_of_id, applied_action, merge_id)
             VALUES ($1,$2,$3,$4,'duplicate',$5,$6,$7,$8,$9)
             ON CONFLICT (source_id, dedupe_key) DO NOTHING RETURNING id`,
            [target.org_id, target.source_id, key, ctx.channel, Number(dup.id), ctx.batch_id ?? null,
              Number(dup.id), action, res.merge_id],
          );
          if (!led.rowCount) throw new AlreadyIngested();
          return { ...res, reopenOwner };
        });
        return {
          status: 'duplicate', lead_id: Number(dup.id), duplicate_of: Number(dup.id),
          action, merged: true, merge_id: merged.merge_id, reopened: merged.reopened,
          owner_id: merged.reopenOwner ?? merged.owner_id,
          reason: `Duplicate of lead #${dup.id} — merged into it${merged.reopened ? ' and re-opened' : ''}`,
        };
      } catch (e) {
        if (e instanceof AlreadyIngested) return this.replay(target.source_id, key);
        throw e;
      }
    }

    // 3c) CREATE / FLAG (or manual always_create) — a second, flagged lead.
    //     Client change (Jul 2026): the `flag` action lands the incoming duplicate
    //     as its own lead marked is_duplicate=TRUE (linked via duplicate_of_id), so
    //     every duplicate-type lead is visible and filterable on the Leads list
    //     (Duplicates filter). Functionally like `create`; recorded distinctly so
    //     the timeline/ledger say "flagged" rather than "created".
    // 4) owner: explicit > same-owner-on-open-duplicate (§4) > distribution engine
    let ownerId: number | null = ctx.owner_id ?? null;
    let assignNote: string | null = ownerId ? null : null;
    let pool: number[] = [];
    if (ownerId == null && dup && dupOpen && target.duplicacy.open_reassign_same_user !== false
        && policy === 'campaign' && dup.owner_id) {
      ownerId = Number(dup.owner_id);
      assignNote = `re-assigned to the existing owner of duplicate lead #${dup.id} (campaign rule: open -> same user)`;
    }
    if (ownerId == null) {
      const conditionCtx: Record<string, unknown> = {
        ...lead.custom_fields, ...payload,
        full_name: lead.full_name, phone: lead.phone, email: lead.email,
        priority: lead.priority, temperature: lead.temperature, score: lead.score,
        source_id: target.source_id, course_id: lead.course_id, city_id: lead.city_id,
        state_id: lead.state_id, budget_id: lead.budget_id, qualification_id: lead.qualification_id,
      };
      const r = await this.resolvePool(target, conditionCtx);
      pool = r.pool; assignNote = r.note;
    }

    // 5) persist (+ ledger inside the SAME tx => idempotent under concurrency)
    try {
      const created = await this.db.tx(async (c) => {
        const owner = ownerId ?? (await this.pickOwner(c, target.campaign_id, pool));
        const ins = await c.query(
          `INSERT INTO lead (org_id, branch_id, vertical_id, pipeline_id, campaign_id, source_id,
                             full_name, phone, email, alt_phone, whatsapp_phone, dob, status_id, stage_id, priority, temperature, score,
                             owner_id, next_follow_up_at, last_activity_at, is_duplicate,
                             state_id, city_id, course_id, qualification_id, budget_id, custom_fields,
                             created_by, ingest_batch_id, external_id, duplicate_of_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
           RETURNING *`,
          [target.org_id, target.branch_id, target.vertical_id, target.pipeline_id, target.campaign_id, target.source_id,
            lead.full_name, lead.phone, lead.email, lead.alt_phone, lead.whatsapp_phone, lead.dob, lead.status_id, lead.stage_id,
            lead.priority, lead.temperature, lead.score, owner, lead.next_follow_up_at, !!dup,
            lead.state_id, lead.city_id, lead.course_id, lead.qualification_id, lead.budget_id,
            JSON.stringify(lead.custom_fields), ctx.actor_id, ctx.batch_id ?? null, lead.external_id,
            dup ? Number(dup.id) : null],
        );
        const row = ins.rows[0];
        const leadId = Number(row.id);

        for (const tagId of lead.tag_ids) {
          await c.query(`INSERT INTO lead_tag (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [leadId, tagId]);
        }

        // ledger LAST: a unique-index conflict means a concurrent worker won the
        // race -> roll the whole tx back (no duplicate lead, no cursor bump).
        const led = await c.query(
          `INSERT INTO lead_ingest_record (org_id, source_id, dedupe_key, channel, outcome, lead_id, batch_id,
                                           applied_action, duplicate_of_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id, dedupe_key) DO NOTHING RETURNING id`,
          [target.org_id, target.source_id, key, ctx.channel, dup ? 'duplicate' : 'created', leadId,
            ctx.batch_id ?? null, dup ? action : null, dup ? Number(dup.id) : null],
        );
        if (!led.rowCount) throw new AlreadyIngested();

        const log = (type: string, from: unknown, to: unknown, note?: string | null) => c.query(
          `INSERT INTO lead_activity (lead_id, org_id, branch_id, actor_id, type, from_value, to_value, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [leadId, target.org_id, target.branch_id, ctx.actor_id, type,
            from == null ? null : JSON.stringify(from), to == null ? null : JSON.stringify(to), note ?? null],
        );
        const dupNote = dup
          ? (action === 'flag'
              ? `Duplicate phone — matches lead #${dup.id}; flagged as a duplicate (campaign rule: flag duplicates)`
              : `Duplicate phone — matches lead #${dup.id} (campaign rule: create duplicate leads)`)
          : null;
        await log('create', null, { source_id: target.source_id, campaign_id: target.campaign_id, channel: ctx.channel },
          dupNote ?? lead.note);
        if (dupNote && lead.note) await log('note', null, null, lead.note);
        if (owner) await log('assign', null, { owner_id: owner }, assignNote);

        // worker-created leads never pass through the HTTP AuditInterceptor
        await c.query(
          `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
           VALUES ($1,$2,'leads',$3,'create',$4)`,
          [target.org_id, ctx.actor_id, leadId,
            JSON.stringify({ id: leadId, channel: ctx.channel, batch_id: ctx.batch_id ?? null, owner_id: owner })],
        );
        return { row, leadId, owner };
      });

      return {
        status: dup ? 'duplicate' : 'created',
        lead_id: created.leadId,
        duplicate_of: dup ? Number(dup.id) : null,
        action: dup ? action : null,
        owner_id: created.owner ?? null,
        reason: dup
          ? (action === 'flag'
              ? `Duplicate of lead #${dup.id} — created & flagged as a duplicate`
              : `Duplicate of lead #${dup.id} — created & flagged`)
          : null,
      };
    } catch (e) {
      if (e instanceof AlreadyIngested) return this.replay(target.source_id, key);
      throw e;
    }
  }

  /** A concurrent worker won the (source_id, dedupe_key) race — report its outcome. */
  private async replay(sourceId: number, key: string): Promise<IngestOutcome> {
    const again = await this.db.one<{ lead_id: string | null; outcome: string }>(
      `SELECT lead_id, outcome FROM lead_ingest_record WHERE source_id = $1 AND dedupe_key = $2`,
      [sourceId, key],
    );
    return {
      status: 'skipped', lead_id: again?.lead_id ? Number(again.lead_id) : null,
      reason: 'Already imported — idempotent replay',
    };
  }

  /** Channels that need the raw lead row back (manual "Add lead"). */
  async ingestAndReturn(payload: IngestPayload, ctx: IngestContext) {
    const out = await this.ingest(payload, ctx);
    if (out.lead_id == null) return { outcome: out, lead: null };
    const lead = await this.db.one(`SELECT * FROM lead WHERE id = $1`, [out.lead_id]);
    return { outcome: out, lead };
  }
}

export const INGEST_CHANNELS: IngestChannel[] = ['csv', 'webhook', 'form', 'sheet', 'api', 'manual'];
