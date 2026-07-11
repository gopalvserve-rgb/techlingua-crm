import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { validateDistributionConfig, validateDuplicacyConfig } from './campaign-config.validator';

/**
 * Hierarchy CRUD: Branch > Vertical > Pipeline (+stages) > Campaign > Source.
 * On create, each child copies its parent's ancestor chain (full-path denormalisation)
 * so no client can produce an inconsistent path.
 */
@Injectable()
export class HierarchyService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  // ---- branches -----------------------------------------------------------

  /** UAT: lists hide inactive rows by default; `?include_inactive=1` shows them (scope-safe). */
  static activeFilter(alias: string, includeInactive?: boolean): string {
    return includeInactive ? '' : ` AND ${alias}.is_active`;
  }

  listBranches(scope: ResolvedScope, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'b.id' }, params);
    return this.db.query(
      `SELECT b.*, s.name AS state_name, c.name AS city_name,
              (SELECT COUNT(*)::int FROM vertical v WHERE v.branch_id = b.id AND v.is_active) AS vertical_count
         FROM branch b LEFT JOIN state s ON s.id = b.state_id LEFT JOIN city c ON c.id = b.city_id
        WHERE ${where}${HierarchyService.activeFilter('b', includeInactive)} ORDER BY b.name`,
      params,
    );
  }

  async createBranch(dto: { name: string; code: string; state_id?: number; city_id?: number; address?: string }, actorId: number) {
    if (!dto?.name || !dto?.code) throw new BadRequestException('name and code are required');
    const rows = await this.db.query(
      `INSERT INTO branch (org_id, name, code, state_id, city_id, address, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [await this.orgId(), dto.name.trim(), dto.code.trim().toUpperCase(),
        dto.state_id ?? null, dto.city_id ?? null, dto.address ?? null, actorId],
    );
    return rows[0];
  }

  updateBranch(id: number, dto: Partial<{ name: string; code: string; state_id: number; city_id: number; address: string; is_active: boolean }>) {
    return this.genericUpdate('branch', id, dto, ['name', 'code', 'state_id', 'city_id', 'address', 'is_active']);
  }

  // ---- verticals ----------------------------------------------------------

  listVerticals(scope: ResolvedScope, branchId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, { branch: 'v.branch_id', vertical: 'v.id' }, params);
    let sql = `SELECT v.*, b.name AS branch_name,
                      (SELECT COUNT(*)::int FROM pipeline p WHERE p.vertical_id = v.id AND p.is_active) AS pipeline_count
                 FROM vertical v JOIN branch b ON b.id = v.branch_id
                WHERE ${where}${HierarchyService.activeFilter('v', includeInactive)}`;
    if (branchId) { params.push(branchId); sql += ` AND v.branch_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY v.name`, params);
  }

  async createVertical(dto: { branch_id: number; name: string; code: string; smtp_config?: object; gateway_config?: object }, actorId: number) {
    if (!dto?.branch_id || !dto?.name || !dto?.code) throw new BadRequestException('branch_id, name and code are required');
    const branch = await this.db.one<{ org_id: string }>(`SELECT org_id FROM branch WHERE id = $1`, [dto.branch_id]);
    if (!branch) throw new NotFoundException('branch not found');
    const rows = await this.db.query(
      `INSERT INTO vertical (org_id, branch_id, name, code, smtp_config, gateway_config, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [Number(branch.org_id), dto.branch_id, dto.name.trim(), dto.code.trim().toUpperCase(),
        JSON.stringify(dto.smtp_config ?? {}), JSON.stringify(dto.gateway_config ?? {}), actorId],
    );
    return rows[0];
  }

  updateVertical(id: number, dto: Record<string, unknown>) {
    return this.genericUpdate('vertical', id, dto, ['name', 'code', 'smtp_config', 'gateway_config', 'is_active']);
  }

  // ---- pipelines + stages -------------------------------------------------

  listPipelines(scope: ResolvedScope, verticalId?: number, includeInactive = false) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      branch: 'p.branch_id', vertical: 'p.vertical_id', pipeline: 'p.id',
    }, params);
    let sql = `SELECT p.*, v.name AS vertical_name, b.name AS branch_name
                 FROM pipeline p JOIN vertical v ON v.id = p.vertical_id JOIN branch b ON b.id = p.branch_id
                WHERE ${where}${HierarchyService.activeFilter('p', includeInactive)}`;
    if (verticalId) { params.push(verticalId); sql += ` AND p.vertical_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY p.name`, params);
  }

  async createPipeline(dto: { vertical_id: number; name: string; code: string }, actorId: number) {
    if (!dto?.vertical_id || !dto?.name || !dto?.code) throw new BadRequestException('vertical_id, name and code are required');
    const v = await this.db.one<{ org_id: string; branch_id: string }>(
      `SELECT org_id, branch_id FROM vertical WHERE id = $1`, [dto.vertical_id],
    );
    if (!v) throw new NotFoundException('vertical not found');
    return this.db.tx(async (c) => {
      const p = await c.query(
        `INSERT INTO pipeline (org_id, branch_id, vertical_id, name, code, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [Number(v.org_id), Number(v.branch_id), dto.vertical_id, dto.name.trim(), dto.code.trim().toUpperCase(), actorId],
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
    return this.genericUpdate('pipeline', id, dto, ['name', 'code', 'is_active']);
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
                WHERE ${where}${HierarchyService.activeFilter('c', includeInactive)}`;
    if (pipelineId) { params.push(pipelineId); sql += ` AND c.pipeline_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY c.name`, params);
  }

  async createCampaign(dto: {
    pipeline_id: number; name: string; utm?: object; cost?: number; priority?: string;
    distribution_config?: object; duplicacy_config?: object;
  }, actorId: number) {
    if (!dto?.pipeline_id || !dto?.name) throw new BadRequestException('pipeline_id and name are required');
    // NeoDove configs are validated strictly on create AND update (QA DEF-2).
    // Omitted/null configs fall back to the documented defaults (COALESCE below).
    const dist = dto.distribution_config != null ? validateDistributionConfig(dto.distribution_config) : null;
    const dup = dto.duplicacy_config != null ? validateDuplicacyConfig(dto.duplicacy_config) : null;
    const p = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string }>(
      `SELECT org_id, branch_id, vertical_id FROM pipeline WHERE id = $1`, [dto.pipeline_id],
    );
    if (!p) throw new NotFoundException('pipeline not found');
    const rows = await this.db.query(
      `INSERT INTO campaign (org_id, branch_id, vertical_id, pipeline_id, name, utm, cost, priority,
                             distribution_config, duplicacy_config, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE($9, '{"mode":"on_demand","batch_size":10}'::jsonb),
               COALESCE($10, '{"check_scope":"this_campaign","match_key":"phone","on_duplicate":"ignore","open_reassign_same_user":true}'::jsonb),
               $11)
       RETURNING *`,
      [Number(p.org_id), Number(p.branch_id), Number(p.vertical_id), dto.pipeline_id, dto.name.trim(),
        JSON.stringify(dto.utm ?? {}), dto.cost ?? 0, dto.priority ?? 'med',
        dist ? JSON.stringify(dist) : null,
        dup ? JSON.stringify(dup) : null, actorId],
    );
    return rows[0];
  }

  updateCampaign(id: number, dto: Record<string, unknown>) {
    // Same strict NeoDove config validation as on create (QA DEF-2).
    if (dto.distribution_config !== undefined) dto = { ...dto, distribution_config: validateDistributionConfig(dto.distribution_config) };
    if (dto.duplicacy_config !== undefined) dto = { ...dto, duplicacy_config: validateDuplicacyConfig(dto.duplicacy_config) };
    return this.genericUpdate('campaign', id, dto,
      ['name', 'utm', 'cost', 'priority', 'distribution_config', 'duplicacy_config', 'is_active']);
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
                WHERE ${where}${HierarchyService.activeFilter('s', includeInactive)}`;
    if (campaignId) { params.push(campaignId); sql += ` AND s.campaign_id = $${params.length}`; }
    return this.db.query(sql + ` ORDER BY s.name`, params);
  }

  async createSource(dto: {
    campaign_id: number; name: string; channel?: string; master_source_id?: number; config?: object;
  }, actorId: number) {
    if (!dto?.campaign_id || !dto?.name) throw new BadRequestException('campaign_id and name are required');
    const c = await this.db.one<{ org_id: string; branch_id: string; vertical_id: string; pipeline_id: string }>(
      `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign WHERE id = $1`, [dto.campaign_id],
    );
    if (!c) throw new NotFoundException('campaign not found');
    const channel = dto.channel ?? 'manual';
    const webhookToken = ['meta', 'google', 'justdial', 'indiamart', 'form', 'webhook'].includes(channel)
      ? 'whk_' + Math.random().toString(36).slice(2, 18) : null;
    const rows = await this.db.query(
      `INSERT INTO source (org_id, branch_id, vertical_id, pipeline_id, campaign_id, master_source_id,
                           name, channel, webhook_token, config, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [Number(c.org_id), Number(c.branch_id), Number(c.vertical_id), Number(c.pipeline_id), dto.campaign_id,
        dto.master_source_id ?? null, dto.name.trim(), channel, webhookToken,
        JSON.stringify(dto.config ?? {}), actorId],
    );
    return rows[0];
  }

  updateSource(id: number, dto: Record<string, unknown>) {
    return this.genericUpdate('source', id, dto, ['name', 'channel', 'master_source_id', 'config', 'is_active']);
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
      `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
    if (!rows.length) throw new NotFoundException(`${table} not found`);
    return rows[0];
  }
}
