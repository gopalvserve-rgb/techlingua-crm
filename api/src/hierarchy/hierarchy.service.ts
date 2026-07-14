import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { validateDistributionConfig, validateDuplicacyConfig } from './campaign-config.validator';

/**
 * Hierarchy CRUD: Branch > Vertical > Pipeline (+stages) > Campaign > Source.
 * On create, each child copies its parent's ancestor chain (full-path denormalisation)
 * so no client can produce an inconsistent path.
 */
export interface BranchDto {
  name: string;
  code: string;
  state_id?: number | null;
  city_id?: number | null;
  address?: string | null;
  /** 'company' | 'franchise' (accepts the form's "Company Branch" / "Franchise Branch") */
  branch_type?: string | null;
  contact_number?: string | null;
  email?: string | null;
  head_user_id?: number | null;
  /** QA-10 sweep: the Add Branch form has a Status select — honour it on create. */
  is_active?: boolean;
}

@Injectable()
export class HierarchyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
  ) {}

  /**
   * Agent-pool referential check (user picker): every user id referenced by a
   * campaign's distribution_config (agent_user_ids + conditions[].assign_to_user_ids)
   * must be an EXISTING, ACTIVE, non-deleted user (400 with the offending ids),
   * and must fall inside the caller's resolved scope (404, assertRefInScope
   * policy — no existence oracle across scope boundaries).
   */
  private async assertDistributionUsers(dist: Record<string, unknown> | null, scope: ResolvedScope, actorId: number) {
    if (!dist) return;
    const ids = new Set<number>();
    for (const id of (dist.agent_user_ids as number[] | undefined) ?? []) ids.add(Number(id));
    for (const c of (dist.conditions as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const id of (c.assign_to_user_ids as number[] | undefined) ?? []) ids.add(Number(id));
    }
    if (!ids.size) return;
    const list = [...ids];
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM "user" WHERE id = ANY($1::bigint[]) AND status = 'active' AND deleted_at IS NULL`, [list],
    );
    const ok = new Set(rows.map((r) => Number(r.id)));
    const bad = list.filter((id) => !ok.has(id));
    if (bad.length) {
      throw new BadRequestException(
        `distribution_config references unknown, inactive or deleted user id(s): ${bad.join(', ')}`,
      );
    }
    for (const id of list) await this.enforcer.assertRefInScope(scope, 'user', id, actorId);
  }

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  // ---- branches -----------------------------------------------------------

  /** Trim a free-text form value; '' (an untouched input) is NULL, never an empty string. */
  static text(v?: string | null, max = 32): string | null {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t === '' ? null : t.slice(0, max);
  }

  /** A date input sends '' when cleared — that is NULL, not an invalid date (22P02). */
  static date(v?: string | null): string | null {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    if (t === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(t)) throw new BadRequestException(`invalid date: ${v} (expected YYYY-MM-DD)`);
    return t.slice(0, 10);
  }

  /** Form sends the prototype labels ("Company Branch" / "Franchise Branch"); store the enum. */
  static branchType(v?: string | null): string | null {
    if (v === undefined || v === null || v === '') return null;
    const t = String(v).trim().toLowerCase();
    if (t.startsWith('franchise')) return 'franchise';
    if (t.startsWith('company')) return 'company';
    if (t === 'company' || t === 'franchise') return t;
    throw new BadRequestException(`invalid branch_type: ${v}`);
  }


  /** UAT: lists hide inactive rows by default; `?include_inactive=1` shows them (scope-safe). */
  static activeFilter(alias: string, includeInactive?: boolean): string {
    return includeInactive ? '' : ` AND ${alias}.is_active`;
  }

  listBranches(scope: ResolvedScope, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'b.id' }, params);
    return this.db.query(
      `SELECT b.*, s.name AS state_name, c.name AS city_name, hu.name AS head_name,
              (SELECT COUNT(*)::int FROM vertical v WHERE v.branch_id = b.id AND v.is_active AND v.deleted_at IS NULL) AS vertical_count
         FROM branch b LEFT JOIN state s ON s.id = b.state_id LEFT JOIN city c ON c.id = b.city_id
              LEFT JOIN "user" hu ON hu.id = b.head_user_id
        WHERE ${where} AND b.deleted_at IS NULL${HierarchyService.activeFilter('b', includeInactive)} ORDER BY b.name`,
      params,
    );
  }

  async createBranch(dto: BranchDto, actorId: number) {
    if (!dto?.name || !dto?.code) throw new BadRequestException('name and code are required');
    const rows = await this.db.query(
      `INSERT INTO branch (org_id, name, code, state_id, city_id, address,
                           branch_type, contact_number, email, head_user_id, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, TRUE),$12) RETURNING *`,
      [await this.orgId(), dto.name.trim(), dto.code.trim().toUpperCase(),
        dto.state_id ?? null, dto.city_id ?? null, dto.address ?? null,
        HierarchyService.branchType(dto.branch_type), dto.contact_number ?? null,
        dto.email ?? null, dto.head_user_id ?? null, dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  /** DEF-2: every field the Add Branch form shows is now persisted and PATCHable. */
  updateBranch(id: number, dto: Partial<BranchDto> & { is_active?: boolean }) {
    const clean = { ...dto };
    if (clean.branch_type !== undefined) clean.branch_type = HierarchyService.branchType(clean.branch_type) as any;
    return this.genericUpdate('branch', id, clean, [
      'name', 'code', 'state_id', 'city_id', 'address',
      'branch_type', 'contact_number', 'email', 'head_user_id', 'is_active',
    ]);
  }

  // ---- verticals ----------------------------------------------------------

  listVerticals(scope: ResolvedScope, branchId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, params);
    let sql = `SELECT v.*, b.name AS branch_name, hu.name AS head_name,
                      (SELECT COUNT(*)::int FROM pipeline p WHERE p.vertical_id = v.id AND p.is_active AND p.deleted_at IS NULL) AS pipeline_count
                 FROM vertical v JOIN branch b ON b.id = v.branch_id
                      LEFT JOIN "user" hu ON hu.id = v.head_user_id
                WHERE ${where} AND v.deleted_at IS NULL${HierarchyService.activeFilter('v', includeInactive)}`;
    if (branchId) { params.push(branchId); sql += ` AND v.branch_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY v.name`, params);
  }

  async createVertical(dto: { branch_id: number; name: string; code: string; smtp_config?: object; gateway_config?: object; head_user_id?: number | null; description?: string | null; is_active?: boolean }, actorId: number) {
    if (!dto?.branch_id || !dto?.name || !dto?.code) throw new BadRequestException('branch_id, name and code are required');
    const branch = await this.db.one<{ org_id: string }>(`SELECT org_id FROM branch WHERE id = $1 AND deleted_at IS NULL`, [dto.branch_id]);
    if (!branch) throw new NotFoundException('branch not found');
    // DEF-S2-04: Vertical Head + Description are on the Add form and MUST be in the
    // INSERT (they were only in the PATCH whitelist, so Add silently dropped them).
    const rows = await this.db.query(
      `INSERT INTO vertical (org_id, branch_id, name, code, smtp_config, gateway_config,
                             head_user_id, description, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE),$10) RETURNING *`,
      [Number(branch.org_id), dto.branch_id, dto.name.trim(), dto.code.trim().toUpperCase(),
        JSON.stringify(dto.smtp_config ?? {}), JSON.stringify(dto.gateway_config ?? {}),
        dto.head_user_id ?? null, dto.description?.trim() ? dto.description.trim() : null,
        dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  updateVertical(id: number, dto: Record<string, unknown>) {
    return this.genericUpdate('vertical', id, dto,
      ['name', 'code', 'smtp_config', 'gateway_config', 'head_user_id', 'description', 'is_active']);
  }

  // ---- pipelines + stages -------------------------------------------------

  listPipelines(scope: ResolvedScope, verticalId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'p.branch_id', vertical: 'p.vertical_id', pipeline: 'p.id',
    }, params);
    let sql = `SELECT p.*, v.name AS vertical_name, b.name AS branch_name, ou.name AS owner_name
                 FROM pipeline p JOIN vertical v ON v.id = p.vertical_id JOIN branch b ON b.id = p.branch_id
                      LEFT JOIN "user" ou ON ou.id = p.owner_user_id
                WHERE ${where} AND p.deleted_at IS NULL${HierarchyService.activeFilter('p', includeInactive)}`;
    if (verticalId) { params.push(verticalId); sql += ` AND p.vertical_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY p.name`, params);
  }

  async createPipeline(dto: { vertical_id: number; name: string; code: string; owner_user_id?: number | null; is_active?: boolean }, actorId: number) {
    if (!dto?.vertical_id || !dto?.name || !dto?.code) throw new BadRequestException('vertical_id, name and code are required');
    const v = await this.db.one<{ org_id: string; branch_id: string }>(
      `SELECT org_id, branch_id FROM vertical WHERE id = $1 AND deleted_at IS NULL`, [dto.vertical_id],
    );
    if (!v) throw new NotFoundException('vertical not found');
    return this.db.tx(async (c) => {
      const p = await c.query(
        `INSERT INTO pipeline (org_id, branch_id, vertical_id, name, code, owner_user_id, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, TRUE),$8) RETURNING *`,
        [Number(v.org_id), Number(v.branch_id), dto.vertical_id, dto.name.trim(), dto.code.trim().toUpperCase(),
          dto.owner_user_id ?? null, dto.is_active ?? null, actorId],
      );
      // every pipeline starts with a default stage set (editable afterwards)
      const defaults: Array<[string, string, boolean]> = [
        ['New Lead', 'open', true], ['Contacted', 'open', false], ['Counselling', 'open', false],
        ['Negotiation', 'open', false], ['Enrolled', 'won', false], ['Lost', 'lost', false],
      ];
      let sort = 0;
      for (const [name, type, isDefault] of defaults) {
        await c.query(
          `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.rows[0].id, name, sort++, type, isDefault, actorId],
        );
      }
      return p.rows[0];
    });
  }

  updatePipeline(id: number, dto: Record<string, unknown>) {
    return this.genericUpdate('pipeline', id, dto, ['name', 'code', 'owner_user_id', 'is_active']);
  }

  listStages(pipelineId: number) {
    return this.db.query(
      `SELECT * FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY sort_order`, [pipelineId],
    );
  }

  /** Stage tags (configurator chips: Cold / Warm / Hot / free text).
   *  Trimmed, case-insensitively deduped, each <= 40 chars, max 20 per stage. */
  static normalizeTags(input: unknown): string[] {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestException('tags must be an array of strings');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of input) {
      if (typeof t !== 'string') throw new BadRequestException('tags must be an array of strings');
      const v = t.trim();
      if (!v) continue;
      if (v.length > 40) throw new BadRequestException('each tag must be 40 characters or fewer');
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    if (out.length > 20) throw new BadRequestException('a stage can carry at most 20 tags');
    return out;
  }

  /**
   * Create a stage. Stage-configurator insert-at-position: when `after_stage_id`
   * is present, the stage lands directly after that stage (`null` = head of the
   * flow) and every later stage is reindexed (+1) in the same transaction so
   * sort_order stays contiguous. Without it, behaviour is unchanged (append, or
   * an explicit `sort_order`).
   */
  async createStage(
    pipelineId: number,
    dto: { name: string; stage_type?: string; sort_order?: number; is_default?: boolean; tags?: unknown; after_stage_id?: number | null },
    actorId: number,
  ) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const type = dto.stage_type ?? 'open';
    if (!['open', 'won', 'lost'].includes(type)) throw new BadRequestException('stage_type must be open|won|lost');
    const tags = HierarchyService.normalizeTags(dto.tags);

    if (dto.after_stage_id !== undefined) {
      let newSort = 0;
      if (dto.after_stage_id !== null) {
        const after = await this.db.one<{ pipeline_id: string; sort_order: number }>(
          `SELECT pipeline_id, sort_order FROM pipeline_stage WHERE id = $1`, [dto.after_stage_id],
        );
        if (!after || Number(after.pipeline_id) !== Number(pipelineId)) {
          throw new BadRequestException('after_stage_id must reference a stage of the same pipeline');
        }
        newSort = Number(after.sort_order) + 1;
      }
      return this.db.tx(async (c) => {
        await c.query(
          `UPDATE pipeline_stage SET sort_order = sort_order + 1, updated_at = now()
            WHERE pipeline_id = $1 AND sort_order >= $2`, [pipelineId, newSort],
        );
        if (dto.is_default) {
          await c.query(
            `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default`,
            [pipelineId],
          );
        }
        const ins = await c.query(
          `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, tags, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [pipelineId, dto.name.trim(), newSort, type, dto.is_default ?? false, JSON.stringify(tags), actorId],
        );
        return ins.rows[0];
      });
    }

    if (dto.is_default) {
      await this.db.query(
        `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default`,
        [pipelineId],
      );
    }
    const rows = await this.db.query(
      `INSERT INTO pipeline_stage (pipeline_id, name, sort_order, stage_type, is_default, tags, created_by)
       VALUES ($1,$2,COALESCE($3,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM pipeline_stage WHERE pipeline_id=$1)),$4,$5,$6,$7)
       RETURNING *`,
      [pipelineId, dto.name.trim(), dto.sort_order ?? null, type, dto.is_default ?? false, JSON.stringify(tags), actorId],
    );
    return rows[0];
  }

  async updateStage(id: number, dto: Record<string, unknown>) {
    if (dto.stage_type !== undefined && !['open', 'won', 'lost'].includes(String(dto.stage_type))) {
      throw new BadRequestException('stage_type must be open|won|lost');
    }
    if (dto.tags !== undefined) dto = { ...dto, tags: HierarchyService.normalizeTags(dto.tags) };
    if (dto.is_default === true) {
      // a pipeline keeps exactly one default landing stage
      const st = await this.db.one<{ pipeline_id: string }>(`SELECT pipeline_id FROM pipeline_stage WHERE id = $1`, [id]);
      if (!st) throw new NotFoundException('pipeline_stage not found');
      await this.db.query(
        `UPDATE pipeline_stage SET is_default = FALSE, updated_at = now() WHERE pipeline_id = $1 AND is_default AND id <> $2`,
        [Number(st.pipeline_id), id],
      );
    }
    return this.genericUpdate('pipeline_stage', id, dto, ['name', 'sort_order', 'stage_type', 'is_default', 'tags', 'is_active']);
  }

  /**
   * Hard-delete a stage. Guard: any lead still referencing the stage blocks the
   * delete with 409 (rename/deactivate instead, or move the leads first).
   * Remaining stages are compacted so sort_order stays contiguous.
   */
  async deleteStage(id: number) {
    const st = await this.db.one<{ id: string; pipeline_id: string; name: string; sort_order: number }>(
      `SELECT id, pipeline_id, name, sort_order FROM pipeline_stage WHERE id = $1`, [id],
    );
    if (!st) throw new NotFoundException('pipeline_stage not found');
    const ref = await this.db.one<{ ct: number }>(`SELECT COUNT(*)::int AS ct FROM lead WHERE stage_id = $1`, [id]);
    if (ref && Number(ref.ct) > 0) {
      throw new ConflictException(
        `Cannot delete stage "${st.name}" — ${ref.ct} lead(s) are currently in it. ` +
        `Move those leads to another stage first, or mark the stage Inactive instead.`,
      );
    }
    return this.db.tx(async (c) => {
      await c.query(`DELETE FROM pipeline_stage WHERE id = $1`, [id]);
      await c.query(
        `UPDATE pipeline_stage SET sort_order = sort_order - 1, updated_at = now()
          WHERE pipeline_id = $1 AND sort_order > $2`, [Number(st.pipeline_id), st.sort_order],
      );
      return { deleted: true, id: Number(st.id), name: st.name };
    });
  }

  /** Reorder every stage of a pipeline (future drag). `order` must be a permutation of the pipeline's stage ids. */
  async reorderStages(pipelineId: number, order: unknown) {
    if (!Array.isArray(order) || order.length === 0 || order.some((x) => !Number.isFinite(Number(x)))) {
      throw new BadRequestException('order must be a non-empty array of stage ids');
    }
    const ids = order.map(Number);
    const existing = await this.db.query<{ id: string }>(`SELECT id FROM pipeline_stage WHERE pipeline_id = $1`, [pipelineId]);
    const have = existing.map((r) => Number(r.id)).sort((a, b) => a - b).join(',');
    const got = [...ids].sort((a, b) => a - b).join(',');
    if (!existing.length || have !== got) {
      throw new BadRequestException('order must contain every stage id of the pipeline exactly once');
    }
    return this.db.tx(async (c) => {
      for (let i = 0; i < ids.length; i++) {
        await c.query(`UPDATE pipeline_stage SET sort_order = $1, updated_at = now() WHERE id = $2`, [i, ids[i]]);
      }
      const rows = await c.query(`SELECT * FROM pipeline_stage WHERE pipeline_id = $1 ORDER BY sort_order`, [pipelineId]);
      return rows.rows;
    });
  }

  // ---- campaigns ----------------------------------------------------------

  listCampaigns(scope: ResolvedScope, pipelineId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'c.branch_id', vertical: 'c.vertical_id', pipeline: 'c.pipeline_id', campaign: 'c.id',
    }, params);
    let sql = `SELECT c.*, p.name AS pipeline_name, v.name AS vertical_name, b.name AS branch_name
                 FROM campaign c JOIN pipeline p ON p.id = c.pipeline_id
                 JOIN vertical v ON v.id = c.vertical_id JOIN branch b ON b.id = c.branch_id
                WHERE ${where} AND c.deleted_at IS NULL${HierarchyService.activeFilter('c', includeInactive)}`;
    if (pipelineId) { params.push(pipelineId); sql += ` AND c.pipeline_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY c.name`, params);
  }

  async createCampaign(dto: {
    pipeline_id: number; name: string; utm?: object; cost?: number; priority?: string;
    distribution_config?: object; duplicacy_config?: object; is_active?: boolean;
    // DEF-S2-02 — rendered on the campaign modal since day one, stored since migration 024
    campaign_type?: string | null; marketing_channel?: string | null;
    start_date?: string | null; end_date?: string | null;
  }, actorId: number, scope: ResolvedScope) {
    if (!dto?.pipeline_id || !dto?.name) throw new BadRequestException('pipeline_id and name are required');
    // NeoDove configs are validated strictly on create AND update (QA DEF-2).
    // Omitted/null configs fall back to the documented defaults (COALESCE below).
    const dist = dto.distribution_config != null ? validateDistributionConfig(dto.distribution_config) : null;
    await this.assertDistributionUsers(dist, scope, actorId);
    const dup = dto.duplicacy_config != null ? validateDuplicacyConfig(dto.duplicacy_config) : null;
    const p = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string }>(
      `SELECT org_id, branch_id, vertical_id FROM pipeline WHERE id = $1 AND deleted_at IS NULL`, [dto.pipeline_id],
    );
    if (!p) throw new NotFoundException('pipeline not found');
    const rows = await this.db.query(
      `INSERT INTO campaign (org_id, branch_id, vertical_id, pipeline_id, name, utm, cost, priority,
                             distribution_config, duplicacy_config,
                             campaign_type, marketing_channel, start_date, end_date, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9, '{"mode":"on_demand","batch_size":10}'::jsonb),
               COALESCE($10, '{"check_scope":"this_campaign","match_key":"phone","on_duplicate":"ignore","open_reassign_same_user":true}'::jsonb),
               $11,$12,$13,$14,COALESCE($15, TRUE),$16)
       RETURNING *`,
      [Number(p.org_id), Number(p.branch_id), Number(p.vertical_id), dto.pipeline_id, dto.name.trim(),
        JSON.stringify(dto.utm ?? {}), dto.cost ?? 0, dto.priority ?? 'med',
        dist ? JSON.stringify(dist) : null,
        dup ? JSON.stringify(dup) : null,
        HierarchyService.text(dto.campaign_type), HierarchyService.text(dto.marketing_channel),
        HierarchyService.date(dto.start_date), HierarchyService.date(dto.end_date),
        dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  async updateCampaign(id: number, dto: Record<string, unknown>, actorId: number, scope: ResolvedScope) {
    // Same strict NeoDove config validation as on create (QA DEF-2).
    if (dto.distribution_config !== undefined) {
      const dist = validateDistributionConfig(dto.distribution_config);
      await this.assertDistributionUsers(dist, scope, actorId);
      dto = { ...dto, distribution_config: dist };
      // Pool edits never break the round-robin rotation: the cursor is a
      // monotonically increasing counter and the pick applies `% pool.length`
      // at assignment time (leads.service), so shrinking/growing/reordering the
      // agent pool stays safe without touching campaign_distribution_state.
    }
    if (dto.duplicacy_config !== undefined) dto = { ...dto, duplicacy_config: validateDuplicacyConfig(dto.duplicacy_config) };
    // DEF-S2-02: the four form fields are PATCHable like every other stored field
    // ('' from an emptied date input -> NULL, never a 22P02).
    for (const k of ['campaign_type', 'marketing_channel'] as const) {
      if (dto[k] !== undefined) dto = { ...dto, [k]: HierarchyService.text(dto[k] as string | null) };
    }
    for (const k of ['start_date', 'end_date'] as const) {
      if (dto[k] !== undefined) dto = { ...dto, [k]: HierarchyService.date(dto[k] as string | null) };
    }
    return this.genericUpdate('campaign', id, dto,
      ['name', 'utm', 'cost', 'priority', 'distribution_config', 'duplicacy_config',
        'campaign_type', 'marketing_channel', 'start_date', 'end_date', 'is_active']);
  }

  // ---- sources ------------------------------------------------------------

  listSources(scope: ResolvedScope, campaignId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 's.branch_id', vertical: 's.vertical_id', pipeline: 's.pipeline_id', campaign: 's.campaign_id',
    }, params);
    let sql = `SELECT s.*, c.name AS campaign_name, ms.name AS master_source_name
                 FROM source s JOIN campaign c ON c.id = s.campaign_id
                 LEFT JOIN m_source ms ON ms.id = s.master_source_id
                WHERE ${where} AND s.deleted_at IS NULL${HierarchyService.activeFilter('s', includeInactive)}`;
    if (campaignId) { params.push(campaignId); sql += ` AND s.campaign_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY s.name`, params);
  }

  async createSource(dto: {
    campaign_id: number; name: string; channel?: string; master_source_id?: number; config?: object;
    cost_per_lead?: number | string | null; is_active?: boolean;
  }, actorId: number) {
    if (!dto?.campaign_id || !dto?.name) throw new BadRequestException('campaign_id and name are required');
    const c = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string; pipeline_id: string }>(
      `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign WHERE id = $1 AND deleted_at IS NULL`, [dto.campaign_id],
    );
    if (!c) throw new NotFoundException('campaign not found');
    const channel = dto.channel ?? 'manual';
    const webhookToken = ['meta', 'google', 'justdial', 'indiamart', 'form', 'webhook'].includes(channel)
      ? 'whk_' + Math.random().toString(36).slice(2, 18) : null;
    const rows = await this.db.query(
      `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, master_source_id,
                           name, channel, webhook_token, config, cost_per_lead, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, TRUE),$13) RETURNING *`,
      [Number(c.org_id), Number(c.branch_id), Number(c.vertical_id), Number(c.pipeline_id), dto.campaign_id,
        dto.master_source_id ?? null, dto.name.trim(), channel, webhookToken,
        JSON.stringify(dto.config ?? {}), dto.cost_per_lead ?? 0, dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  updateSource(id: number, dto: Record<string, unknown>) {
    return this.genericUpdate('source', id, dto,
      ['name', 'channel', 'master_source_id', 'config', 'cost_per_lead', 'is_active']);
  }

  // ---- shared -------------------------------------------------------------

  private async genericUpdate(table: string, id: number, dto: Record<string, unknown>, allowed: string[]) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of allowed) {
      if (dto[key] === undefined) continue;
      const val = typeof dto[key] === 'object' && dto[key] !== null ? JSON.stringify(dto[key]) : dto[key];
      params.push(val);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const rows = await this.db.query(
      `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params,
    );
    if (!rows.length) throw new NotFoundException(`${table} not found`);
    return rows[0];
  }
}
