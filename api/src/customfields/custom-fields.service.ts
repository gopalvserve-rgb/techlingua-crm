import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Custom-field DEFINITIONS (client, Aug 2026). Definitions live in `custom_field_def`
 * (migration 004 + soft-delete in 015); the VALUES live in each owning row's `custom_fields`
 * JSONB (e.g. lead.custom_fields), keyed by `field_key`. This module lets an admin DEFINE
 * fields (Administration › Custom Fields) so they render on the lead Add/Edit form and persist
 * into lead.custom_fields — the mapping the client asked for.
 */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'bool', 'select', 'multiselect'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDto {
  entity?: string;
  field_key?: string;
  label?: string;
  data_type?: string;
  options?: string[] | null;
  required?: boolean;
  sort_order?: number;
  scope_branch_id?: number | null;
  scope_vertical_id?: number | null;
  is_active?: boolean;
}

/** field_key is a machine slug: lower snake_case, [a-z0-9_], max 60 (matches the column). */
export const slugKey = (s: string): string =>
  String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

@Injectable()
export class CustomFieldsService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!org) throw new BadRequestException('no organisation');
    return Number(org.id);
  }

  /** Active (or, with all=true, every) definition for an entity, in display order. */
  async list(entity = 'lead', all = false) {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, entity, field_key, label, data_type, options, master_ref, required,
              sort_order, is_active, scope_branch_id, scope_vertical_id
         FROM custom_field_def
        WHERE entity = $1 AND deleted_at IS NULL ${all ? '' : 'AND is_active'}
        ORDER BY sort_order ASC, id ASC`,
      [entity],
    );
    return rows;
  }

  async create(dto: CustomFieldDto, userId: number) {
    const org = await this.orgId();
    const entity = (dto.entity || 'lead').trim() || 'lead';
    const label = (dto.label || '').trim();
    if (!label) throw new BadRequestException('A label is required');
    const data_type = (dto.data_type || 'text').trim();
    if (!CUSTOM_FIELD_TYPES.includes(data_type as CustomFieldType)) throw new BadRequestException('invalid data_type');
    const field_key = dto.field_key ? slugKey(dto.field_key) : slugKey(label);
    if (!field_key) throw new BadRequestException('A valid field key is required');
    const options = data_type === 'select' || data_type === 'multiselect'
      ? (Array.isArray(dto.options) ? dto.options.map((o) => String(o).trim()).filter(Boolean) : [])
      : null;
    const dup = await this.db.one(
      `SELECT id FROM custom_field_def WHERE org_id = $1 AND entity = $2 AND field_key = $3 AND deleted_at IS NULL`,
      [org, entity, field_key],
    );
    if (dup) throw new BadRequestException(`A custom field with key "${field_key}" already exists`);
    return this.db.one(
      `INSERT INTO custom_field_def
         (org_id, entity, field_key, label, data_type, options, required, sort_order, scope_branch_id, scope_vertical_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, entity, field_key, label, data_type, options, required, sort_order, is_active`,
      [org, entity, field_key, label, data_type, options ? JSON.stringify(options) : null,
        !!dto.required, Number(dto.sort_order ?? 0), dto.scope_branch_id ?? null, dto.scope_vertical_id ?? null, userId],
    );
  }

  async update(id: number, dto: CustomFieldDto) {
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM custom_field_def WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!existing) throw new NotFoundException('custom field not found');
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto.label !== undefined) { const l = String(dto.label).trim(); if (!l) throw new BadRequestException('A label is required'); set('label', l); }
    if (dto.data_type !== undefined) {
      if (!CUSTOM_FIELD_TYPES.includes(dto.data_type as CustomFieldType)) throw new BadRequestException('invalid data_type');
      set('data_type', dto.data_type);
    }
    if (dto.options !== undefined) set('options', Array.isArray(dto.options) && dto.options.length ? JSON.stringify(dto.options.map((o) => String(o).trim()).filter(Boolean)) : null);
    if (dto.required !== undefined) set('required', !!dto.required);
    if (dto.sort_order !== undefined) set('sort_order', Number(dto.sort_order));
    if (dto.is_active !== undefined) set('is_active', !!dto.is_active);
    if (!sets.length) return existing;
    params.push(id);
    return this.db.one(
      `UPDATE custom_field_def SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, entity, field_key, label, data_type, options, required, sort_order, is_active`,
      params,
    );
  }

  /** Soft-delete (hidden from the form + every list; row kept for auditability). */
  async remove(id: number) {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM custom_field_def WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('custom field not found');
    await this.db.query(`UPDATE custom_field_def SET is_active = FALSE, deleted_at = now() WHERE id = $1`, [id]);
    return { deleted: true, id };
  }
}
