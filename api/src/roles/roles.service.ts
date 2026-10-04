import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RecordScope } from '../rbac/rbac.types';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';

export interface RoleDto { name: string; description?: string }
export interface MatrixEntry {
  permission_key: string;
  record_scope: RecordScope;
  /**
   * DEF-S16-03 — ACCEPTED BY THE TYPE, REFUSED BY THE API. See `setMatrix()`.
   * It stays on the interface so the refusal has something to name, and so the day
   * Phase 2 implements enforcement the shape is already agreed.
   */
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
         FROM role r WHERE r.deleted_at IS NULL ORDER BY r.is_system DESC, r.name`,
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
    const role = await this.db.one(`SELECT * FROM role WHERE id = $1 AND deleted_at IS NULL`, [id]);
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
    const role = await this.db.one<{ is_system: boolean }>(`SELECT is_system FROM role WHERE id = $1 AND deleted_at IS NULL`, [id]);
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
    const role = await this.db.one<{ id: string; is_system: boolean }>(
      `SELECT id, is_system FROM role WHERE id = $1 AND deleted_at IS NULL`, [roleId],
    );
    if (!role) throw new NotFoundException('Role not found');
    // OBS-01 (backlog #17): system-role matrices are locked at the API level, not
    // just hidden in the UI — a direct PUT gets a clear 400.
    if (role.is_system) {
      throw new BadRequestException('System role permission matrices are locked and cannot be modified');
    }
    const valid: RecordScope[] = ['own', 'team', 'branch', 'vertical', 'pipeline', 'campaign', 'all'];

    /**
     * DEF-S16-03 — FIELD SCOPE IS REFUSED, NOT SILENTLY IGNORED.
     *
     * The API used to ACCEPT and PERSIST `field_scope`. `ScopeResolverService` then
     * faithfully computed `allowedFields`/`deniedFields` from it — and **no caller in the
     * entire API ever read them**, on responses OR on writes. `docs/dev/08` §8 claimed
     * they were "honoured on writes". They were not. They were consumed by nothing.
     *
     * Nothing was broken on the client's system: the Roles UI exposes record scope only,
     * and `field_scope` is NULL on all 587 live `role_permission` rows. But a security
     * control that STORES a setting, DISPLAYS IT BACK as configured, and ENFORCES NOTHING
     * is a worse failure mode than the feature being absent — it reports success and does
     * nothing, and the next person to read §8 would have trusted half of it.
     *
     * So: refuse it, with a sentence that says why and when. A control that cannot be set
     * cannot lie. Phase 2 implements enforcement (a response interceptor for reads, a
     * body filter for writes) and deletes this block.
     *
     * RECORD SCOPE — the half that decides whether you see the ROW AT ALL, and the
     * material half — is enforced everywhere and is untouched by this.
     */
    const withFieldScope = entries.filter((e) => e.field_scope != null);
    if (withFieldScope.length) {
      throw new BadRequestException(
        'Field-level scope is not supported yet — it would be stored and enforced by nothing, '
        + 'which is worse than not offering it. Remove `field_scope` from '
        + `${withFieldScope.map((e) => e.permission_key).join(', ')} and use record_scope, `
        + 'which IS enforced on every read and write. Field scope arrives in Phase 2.',
      );
    }

    return this.db.tx(async (c) => {
      await c.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
      for (const e of entries) {
        if (!valid.includes(e.record_scope)) {
          throw new BadRequestException(`invalid record_scope '${e.record_scope}' for ${e.permission_key}`);
        }
        const perm = await c.query(`SELECT id FROM permission WHERE key = $1`, [e.permission_key]);
        if (!perm.rowCount) throw new BadRequestException(`unknown permission: ${e.permission_key}`);
        // field_scope is written NULL, always — see the refusal above.
        await c.query(
          `INSERT INTO role_permission (role_id, permission_id, record_scope, field_scope) VALUES ($1,$2,$3,NULL)`,
          [roleId, perm.rows[0].id, e.record_scope],
        );
      }
      return { role_id: roleId, granted: entries.length };
    });
  }
}
