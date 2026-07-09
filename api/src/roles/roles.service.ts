import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RecordScope } from '../rbac/rbac.types';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';

export interface RoleDto { name: string; description?: string }
export interface MatrixEntry {
  permission_key: string;
  record_scope: RecordScope;
  field_scope?: { allow?: string[]; deny?: string[] } | null;
}

@Injectable()
export class RolesService {
  constructor(private readonly db: DatabaseService) {}

  listRoles() {
    return this.db.query(
      `SELECT r.id, r.name, r.is_system, r.is_custom, r.description, r.is_active,
              (SELECT COUNT(*)::int FROM role_permission rp WHERE rp.role_id = r.id) AS permission_count,
              (SELECT COUNT(DISTINCT ua.user_id)::int FROM user_assignment ua WHERE ua.role_id = r.id AND ua.is_active) AS user_count
         FROM role r ORDER BY r.is_system DESC, r.name`,
    );
  }

  /** Full permission catalog grouped by module (drives the matrix editor UI). */
  listPermissions() {
    return this.db
      .query<{ id: string; key: string; module: string; action: string }>(
        `SELECT id, key, module, action FROM permission ORDER BY module, action`,
      )
      .then((perms) => ({
        catalog: PERMISSION_CATALOG,
        permissions: perms,
      }));
  }

  async getRole(id: number) {
    const role = await this.db.one(`SELECT * FROM role WHERE id = $1`, [id]);
    if (!role) throw new NotFoundException('Role not found');
    const grants = await this.db.query(
      `SELECT p.key AS permission_key, p.module, p.action, rp.record_scope, rp.field_scope
         FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 ORDER BY p.module, p.action`,
      [id],
    );
    return { ...role, grants };
  }

  async createRole(dto: RoleDto, actorId: number) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    const rows = await this.db.query(
      `INSERT INTO role (org_id, name, is_custom, description, created_by)
       VALUES ($1,$2,TRUE,$3,$4) RETURNING *`,
      [Number(org!.id), dto.name.trim(), dto.description ?? null, actorId],
    );
    return rows[0];
  }

  async updateRole(id: number, dto: Partial<RoleDto> & { is_active?: boolean }) {
    const role = await this.db.one<{ is_system: boolean }>(`SELECT is_system FROM role WHERE id = $1`, [id]);
    if (!role) throw new NotFoundException('Role not found');
    if (role.is_system && dto.name !== undefined) {
      throw new BadRequestException('System roles cannot be renamed');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.description !== undefined) set('description', dto.description);
    if (dto.is_active !== undefined) set('is_active', dto.is_active);
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const rows = await this.db.query(
      `UPDATE role SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params,
    );
    return rows[0];
  }

  /**
   * Replace a role's permission matrix atomically (the matrix editor saves whole-role).
   * Each entry: { permission_key, record_scope, field_scope? }.
   */
  async setMatrix(roleId: number, entries: MatrixEntry[]) {
    if (!Array.isArray(entries)) throw new BadRequestException('entries[] required');
    const role = await this.db.one(`SELECT id FROM role WHERE id = $1`, [roleId]);
    if (!role) throw new NotFoundException('Role not found');
    const valid: RecordScope[] = ['own', 'team', 'branch', 'vertical', 'pipeline', 'campaign', 'all'];

    return this.db.tx(async (c) => {
      await c.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
      for (const e of entries) {
        if (!valid.includes(e.record_scope)) {
          throw new BadRequestException(`invalid record_scope '${e.record_scope}' for ${e.permission_key}`);
        }
        const perm = await c.query(`SELECT id FROM permission WHERE key = $1`, [e.permission_key]);
        if (!perm.rowCount) throw new BadRequestException(`unknown permission: ${e.permission_key}`);
        await c.query(
          `INSERT INTO role_permission (role_id, permission_id, record_scope, field_scope) VALUES ($1,$2,$3,$4)`,
          [roleId, perm.rows[0].id, e.record_scope, e.field_scope ? JSON.stringify(e.field_scope) : null],
        );
      }
      return { role_id: roleId, granted: entries.length };
    });
  }
}
