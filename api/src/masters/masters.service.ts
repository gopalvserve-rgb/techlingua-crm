import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Generic masters module: one API shape for every master table
 * (m_<name>(id, org_id, name, code, sort_order, is_active, meta, parent_id)).
 * The whitelist below is the only place a new master needs registering.
 */
export const MASTER_TYPES: Record<string, { table: string; label: string; singular: string; parent?: string }> = {
  state: { table: 'state', label: 'States', singular: 'State' },
  city: { table: 'city', label: 'Cities', singular: 'City', parent: 'state' },
  source: { table: 'm_source', label: 'Sources', singular: 'Source' },
  course: { table: 'm_course', label: 'Courses', singular: 'Course' },
  qualification: { table: 'm_qualification', label: 'Qualifications', singular: 'Qualification' },
  budget: { table: 'm_budget', label: 'Budgets', singular: 'Budget' },
  status: { table: 'm_status', label: 'Lead Statuses', singular: 'Lead Status' },
  tag: { table: 'm_tag', label: 'Tags', singular: 'Tag' },
  followup_type: { table: 'm_followup_type', label: 'Follow-up Types', singular: 'Follow-up Type' },
  disposition: { table: 'm_disposition', label: 'Dispositions', singular: 'Disposition' },
  // UAT-R2 Batch A — masters that used to be hard-coded inline selects.
  training: { table: 'm_training', label: 'Training Modes', singular: 'Training Mode' },                   // #5
  visit_purpose: { table: 'm_visit_purpose', label: 'Purposes of Visit', singular: 'Purpose of Visit' },  // #18
  walkin_status: { table: 'm_walkin_status', label: 'Walk-in Statuses', singular: 'Walk-in Status' },      // #19
  // Support & Tickets (migration 037) — Ticket Category is admin-managed here.
  ticket_category: { table: 'm_ticket_category', label: 'Ticket Categories', singular: 'Ticket Category' },
  // Course Type master (dev/106, migration 095) — was a fixed course_type_def catalog; now a
  // self-manageable master. The course form's Course Type dropdown reads it (via /courses/type-catalog
  // back-compat alias) and the inline + Master adds new values; managed in Administration > Masters.
  course_type: { table: 'm_course_type', label: 'Course Types', singular: 'Course Type' },
  // Level master (dev/114, migration 097) — was a fixed course_level_def catalog; now a
  // self-manageable master. The course form's Level picker reads it (via /courses/level-catalog
  // back-compat alias) and the inline + Master adds new level codes; managed in Administration > Masters.
  level: { table: 'm_level', label: 'Levels', singular: 'Level' },
  // Campaign Type master (dev/131, task #213 item 4) — was a hard-coded inline select on the
  // Create/Edit Campaign form; now a self-manageable master. campaign.campaign_type stores the
  // picked LABEL text and the master NAME == that label, so existing campaigns keep rendering.
  campaign_type: { table: 'm_campaign_type', label: 'Campaign Types', singular: 'Campaign Type' },
  // Call Disposition master (dev/139, migration 108) — the outcome of a call. A NEW dedicated,
  // self-manageable master (distinct from the older generic `disposition`), read by the Start
  // Calling disposition form + the lead "Log disposition" control; sets lead.last_call_disposition_id.
  call_disposition: { table: 'm_call_disposition', label: 'Call Dispositions', singular: 'Call Disposition' },
};

export interface MasterDto {
  name: string;
  code?: string;
  sort_order?: number;
  meta?: Record<string, unknown>;
  parent_id?: number | null;
  /** QA-10 sweep: the Add form has a Status select — Add "Inactive" must stick. */
  is_active?: boolean;
}

@Injectable()
export class MastersService {
  constructor(private readonly db: DatabaseService) {}

  types() {
    return Object.entries(MASTER_TYPES).map(([type, def]) => ({ type, label: def.label, parent: def.parent ?? null }));
  }

  private table(type: string): string {
    const def = MASTER_TYPES[type];
    if (!def) throw new BadRequestException(`Unknown master type: ${type}`);
    return def.table; // whitelisted — safe to interpolate
  }

  list(type: string, includeInactive = false, filter?: { branchIds?: string[]; verticalIds?: string[]; courseIds?: string[]; statuses?: string[]; courseTypes?: string[]; deliveryModes?: string[]; q?: string }) {
    const t = this.table(type);
    const parent = MASTER_TYPES[type].parent ? this.table(MASTER_TYPES[type].parent!) : t;
    const params: unknown[] = [];
    const where: string[] = ['m.deleted_at IS NULL'];
    // STATUS filter (client, Aug 2026): active/inactive multi-select on the Course list. Default
    // (no status picked, all!=1) stays "only active" for back-compat with every other master.
    const statuses = [...new Set((filter?.statuses ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    const wantActive = statuses.includes('active');
    const wantInactive = statuses.includes('inactive');
    if (statuses.length && !(wantActive && wantInactive)) where.push(wantInactive ? 'm.is_active = FALSE' : 'm.is_active');
    else if (!includeInactive && !wantInactive) where.push('m.is_active');
    // name / code search + Branch/Vertical/Type/Delivery (stored in meta on the Course master; multi-select IN).
    if (filter?.q && String(filter.q).trim()) { params.push(`%${String(filter.q).trim()}%`); where.push(`(m.name ILIKE $${params.length} OR m.code ILIKE $${params.length})`); }
    const metaIn = (key: string, arr?: string[]) => {
      const vals = [...new Set((arr ?? []).map((x) => String(x).trim()).filter(Boolean))];
      if (!vals.length) return;
      const ph = vals.map((v) => { params.push(v); return `$${params.length}`; });
      where.push(`m.meta->>'${key}' IN (${ph.join(',')})`);
    };
    metaIn('branch_id', filter?.branchIds);
    metaIn('vertical_id', filter?.verticalIds);
    metaIn('course_type', filter?.courseTypes);
    metaIn('delivery_mode', filter?.deliveryModes);
    // COURSE filter — the master's own id (multi-select), used by the Course list "Course" filter.
    const courseIds = [...new Set((filter?.courseIds ?? []).map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n) && n > 0))];
    if (courseIds.length) { const ph = courseIds.map((v) => { params.push(v); return `$${params.length}`; }); where.push(`m.id IN (${ph.join(',')})`); }
    return this.db.query(
      `SELECT m.*, p.name AS parent_name FROM ${t} m LEFT JOIN ${parent} p ON p.id = m.parent_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.sort_order, m.name`, params,
    );
  }

  async create(type: string, dto: MasterDto, actorId: number) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const t = this.table(type);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const rows = await this.db.query(
      `INSERT INTO ${t} (org_id, name, code, sort_order, meta, parent_id, is_active, created_by)
       VALUES ($1,$2,$3,COALESCE($4,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM ${t})),$5,$6,COALESCE($7, TRUE),$8) RETURNING *`,
      [Number(org!.id), dto.name.trim(), dto.code ?? null, dto.sort_order ?? null,
        JSON.stringify(dto.meta ?? {}), dto.parent_id ?? null, dto.is_active ?? null, actorId],
    );
    return rows[0];
  }

  async update(type: string, id: number, dto: Partial<MasterDto> & { is_active?: boolean }) {
    const t = this.table(type);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.code !== undefined) set('code', dto.code);
    if (dto.sort_order !== undefined) set('sort_order', dto.sort_order);
    if (dto.meta !== undefined) set('meta', JSON.stringify(dto.meta));
    if (dto.parent_id !== undefined) set('parent_id', dto.parent_id);
    if (dto.is_active !== undefined) set('is_active', dto.is_active);
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const rows = await this.db.query(
      `UPDATE ${t} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`, params,
    );
    if (!rows.length) throw new NotFoundException(`${type} #${id} not found`);
    return rows[0];
  }

  /** Deactivate (soft delete) — masters are never hard-deleted (leads may reference them). */
  deactivate(type: string, id: number) {
    return this.update(type, id, { is_active: false });
  }
}
