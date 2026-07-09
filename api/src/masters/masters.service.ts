import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Generic masters module: one API shape for every master table
 * (m_<name>(id, org_id, name, code, sort_order, is_active, meta, parent_id)).
 * The whitelist below is the only place a new master needs registering.
 */
export const MASTER_TYPES: Record<string, { table: string; label: string; parent?: string }> = {
  state: { table: 'state', label: 'States' },
  city: { table: 'city', label: 'Cities', parent: 'state' },
  source: { table: 'm_source', label: 'Sources' },
  course: { table: 'm_course', label: 'Courses' },
  qualification: { table: 'm_qualification', label: 'Qualifications' },
  budget: { table: 'm_budget', label: 'Budgets' },
  status: { table: 'm_status', label: 'Lead Statuses' },
  tag: { table: 'm_tag', label: 'Tags' },
  followup_type: { table: 'm_followup_type', label: 'Follow-up Types' },
  disposition: { table: 'm_disposition', label: 'Dispositions' },
};

export interface MasterDto {
  name: string;
  code?: string;
  sort_order?: number;
  meta?: Record<string, unknown>;
  parent_id?: number | null;
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

  list(type: string, includeInactive = false) {
    const t = this.table(type);
    return this.db.query(
      `SELECT m.*, p.name AS parent_name FROM ${t} m LEFT JOIN ${MASTER_TYPES[type].parent ? this.table(MASTER_TYPES[type].parent!) : t} p ON p.id = m.parent_id
        ${includeInactive ? '' : 'WHERE m.is_active'}
        ORDER BY m.sort_order, m.name`,
    );
  }

  async create(type: string, dto: MasterDto, actorId: number) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const t = this.table(type);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const rows = await this.db.query(
      `INSERT INTO ${t} (org_id, name, code, sort_order, meta, parent_id, created_by)
       VALUES ($1,$2,$3,COALESCE($4,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM ${t})),$5,$6,$7) RETURNING *`,
      [Number(org!.id), dto.name.trim(), dto.code ?? null, dto.sort_order ?? null,
        JSON.stringify(dto.meta ?? {}), dto.parent_id ?? null, actorId],
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
      `UPDATE ${t} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
    if (!rows.length) throw new NotFoundException(`${type} #${id} not found`);
    return rows[0];
  }

  /** Deactivate (soft delete) — masters are never hard-deleted (leads may reference them). */
  deactivate(type: string, id: number) {
    return this.update(type, id, { is_active: false });
  }
}
