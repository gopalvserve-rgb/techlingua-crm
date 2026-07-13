import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { DeletableDef, DELETE_REGISTRY, registryEntry } from './delete-registry';

/**
 * Soft delete / impact / restore engine (client request — every module).
 *
 * delete  -> sets deleted_at/deleted_by on the ONE row (children never touched);
 *            guards: system roles, the Super Admin user, self-delete -> 400.
 * impact  -> association hierarchy BEFORE deleting: live counts + first sample
 *            names per dependent entity type (from the central registry).
 * restore -> clears deleted_at/by; 409 while an ancestor in the row's path is
 *            itself deleted (restore the parent first).
 */

export interface ImpactEntry { key: string; label: string; count: number; sample: string[] }
export interface ImpactReport {
  entity: string; label: string; id: number; name: string; deleted: boolean;
  total_associations: number; impact: ImpactEntry[];
}

const SAMPLE_LIMIT = 5;

/** Pure guard: which delete requests are refused outright (unit-tested). */
export function deleteGuardError(entity: string, opts: {
  targetId: number; actorId: number; isSystemRole?: boolean; isSuperAdminUser?: boolean;
}): string | null {
  if (entity === 'role' && opts.isSystemRole) return 'System roles cannot be deleted';
  if (entity === 'user' && opts.targetId === opts.actorId) return 'You cannot delete your own user account';
  if (entity === 'user' && opts.isSuperAdminUser) return 'The Super Admin user cannot be deleted';
  return null;
}

@Injectable()
export class SoftDeleteService {
  constructor(private readonly db: DatabaseService) {}

  private def(entity: string): DeletableDef {
    const def = registryEntry(entity);
    if (!def) throw new BadRequestException(`Unknown deletable entity: ${entity}`);
    return def;
  }

  /** Association report ("where this id is used"). Works for live AND deleted
   *  rows (the Deleted Items screen shows impact-at-a-glance before restore). */
  async impact(entity: string, id: number): Promise<ImpactReport> {
    const def = this.def(entity);
    const row = await this.db.one<{ id: string; name: string; deleted_at: string | null }>(
      `SELECT id, ${def.nameExpr} AS name, deleted_at FROM ${def.table} WHERE id = $1`, [id],
    );
    if (!row) throw new NotFoundException(`${def.label} not found`);
    const impact: ImpactEntry[] = [];
    for (const d of def.dependents) {
      const cnt = await this.db.one<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${d.from} WHERE ${d.where}`, [id],
      );
      const n = Number(cnt?.n ?? 0);
      let sample: string[] = [];
      if (n > 0) {
        const rows = await this.db.query<{ nm: string }>(
          `SELECT ${d.nameExpr} AS nm FROM ${d.from} WHERE ${d.where} LIMIT ${SAMPLE_LIMIT}`, [id],
        );
        sample = rows.map((r) => String(r.nm));
      }
      impact.push({ key: d.key, label: d.label, count: n, sample });
    }
    return {
      entity: def.key, label: def.label, id: Number(row.id), name: String(row.name),
      deleted: row.deleted_at != null,
      total_associations: impact.reduce((a, e) => a + e.count, 0),
      impact,
    };
  }

  /** Soft delete the ONE row. Children/related records stay intact by design. */
  async remove(entity: string, id: number, actorId: number) {
    const def = this.def(entity);

    // guards — system roles, the Super Admin user, self-delete
    if (entity === 'role') {
      const r = await this.db.one<{ is_system: boolean }>(`SELECT is_system FROM role WHERE id = $1`, [id]);
      if (!r) throw new NotFoundException('Role not found');
      const err = deleteGuardError('role', { targetId: id, actorId, isSystemRole: r.is_system });
      if (err) throw new BadRequestException(err);
    }
    if (entity === 'user') {
      const sa = await this.db.one(
        `SELECT 1 FROM user_assignment ua JOIN role r ON r.id = ua.role_id
          WHERE ua.user_id = $1 AND ua.is_active AND r.is_system AND r.name = 'Super Admin' LIMIT 1`, [id],
      );
      const err = deleteGuardError('user', { targetId: id, actorId, isSuperAdminUser: !!sa });
      if (err) throw new BadRequestException(err);
    }

    const rows = await this.db.query<{ id: string; name: string }>(
      `UPDATE ${def.table} SET deleted_at = now(), deleted_by = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, ${def.nameExpr} AS name`,
      [id, actorId],
    );
    if (!rows.length) throw new NotFoundException(`${def.label} not found`);
    return { ok: true, deleted: true, entity: def.key, id: Number(rows[0].id), name: rows[0].name };
  }

  /** Restore a soft-deleted row. 409 while an ancestor is itself deleted. */
  async restore(entity: string, id: number) {
    const def = this.def(entity);
    const row = await this.db.one<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM ${def.table} WHERE id = $1`, [id],
    );
    if (!row || row.deleted_at == null) throw new NotFoundException(`${def.label} not found in deleted items`);

    for (const p of def.parents) {
      const anc = await this.db.one<{ name: string; deleted: boolean }>(p.sql, [id]);
      if (anc?.deleted) {
        throw new ConflictException(
          `Cannot restore this ${def.label.toLowerCase()} — its ${p.label.toLowerCase()} "${anc.name}" is deleted. Restore the ${p.label.toLowerCase()} first.`,
        );
      }
    }
    const rows = await this.db.query<{ id: string; name: string }>(
      `UPDATE ${def.table} SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING id, ${def.nameExpr} AS name`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`${def.label} not found in deleted items`);
    return { ok: true, restored: true, entity: def.key, id: Number(rows[0].id), name: rows[0].name };
  }

  /** Entity tabs for the Deleted Items screen. */
  entities() {
    return Object.values(DELETE_REGISTRY).map((d) => ({ key: d.key, label: d.label }));
  }

  /** Deleted rows of one entity type (Administration > Deleted Items). */
  async deletedItems(entity: string, limit = 200) {
    const def = this.def(entity);
    const rows = await this.db.query(
      `SELECT t.id, ${/^[a-z_]+$/.test(def.nameExpr) ? `t.${def.nameExpr}` : def.nameExpr} AS name,
              t.deleted_at, t.deleted_by, u.name AS deleted_by_name
         FROM ${def.table} t LEFT JOIN "user" u ON u.id = t.deleted_by
        WHERE t.deleted_at IS NOT NULL
        ORDER BY t.deleted_at DESC LIMIT $1`,
      [Math.min(Number(limit) || 200, 500)],
    );
    return { entity: def.key, label: def.label, rows };
  }
}
