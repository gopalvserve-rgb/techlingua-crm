import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';

export interface CreateUserDto {
  name: string;
  email: string;
  phone?: string;
  password?: string;
  assignments?: Array<{
    role_id: number; branch_id?: number | null; vertical_id?: number | null;
    pipeline_id?: number | null; campaign_id?: number | null; team_id?: number | null;
  }>;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
  ) {}

  private async orgId(): Promise<number> {
    const row = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!row) throw new BadRequestException('Organisation not seeded');
    return Number(row.id);
  }

  /**
   * Users are branch/vertical-scoped THROUGH their assignments, so scoped listers
   * see users who hold at least one assignment inside their scope (plus themselves).
   */
  async list(scope: ResolvedScope, requesterId: number) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      owner: 'u.id', team: 'tm.team_id', branch: 'ua.branch_id',
      vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
    }, params);
    params.push(requesterId);
    return this.db.query(
      `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.status, u.created_at
         FROM "user" u
         LEFT JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
         LEFT JOIN team_member tm ON tm.user_id = u.id
        WHERE (${where}) OR u.id = $${params.length}
        ORDER BY u.name`,
      params,
    );
  }

  async get(id: number) {
    const user = await this.db.one(
      `SELECT id, name, email, phone, status, mfa_enabled, created_at FROM "user" WHERE id = $1`, [id],
    );
    if (!user) throw new NotFoundException('User not found');
    const assignments = await this.db.query(
      `SELECT ua.id, ua.role_id, r.name AS role_name, ua.branch_id, ua.vertical_id,
              ua.pipeline_id, ua.campaign_id, ua.team_id
         FROM user_assignment ua JOIN role r ON r.id = ua.role_id
        WHERE ua.user_id = $1 AND ua.is_active ORDER BY ua.id`,
      [id],
    );
    return { ...user, assignments };
  }

  async create(dto: CreateUserDto, actorId: number, scope?: ResolvedScope) {
    if (!dto?.name || !dto?.email) throw new BadRequestException('name and email are required');
    // DEF-QA4-03: units referenced by the new user's assignments must be inside
    // the creator's scope (roles are org-level, validated by FK).
    if (scope) {
      for (const a of dto.assignments ?? []) {
        await this.enforcer.assertRefInScope(scope, 'branch', a.branch_id, actorId);
        await this.enforcer.assertRefInScope(scope, 'vertical', a.vertical_id, actorId);
        await this.enforcer.assertRefInScope(scope, 'pipeline', a.pipeline_id, actorId);
        await this.enforcer.assertRefInScope(scope, 'campaign', a.campaign_id, actorId);
        await this.enforcer.assertRefInScope(scope, 'team', a.team_id, actorId);
      }
    }
    const org = await this.orgId();
    const dup = await this.db.one(`SELECT 1 FROM "user" WHERE lower(email)=lower($1)`, [dto.email]);
    if (dup) throw new ConflictException(`Email already exists: ${dto.email}`);
    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    return this.db.tx(async (c) => {
      const u = await c.query(
        `INSERT INTO "user" (org_id, name, email, phone, password_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, status`,
        [org, dto.name.trim(), dto.email.trim().toLowerCase(), dto.phone ?? null, hash, actorId],
      );
      const userId = u.rows[0].id;
      for (const a of dto.assignments ?? []) {
        await c.query(
          `INSERT INTO user_assignment (user_id, role_id, branch_id, vertical_id, pipeline_id, campaign_id, team_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [userId, a.role_id, a.branch_id ?? null, a.vertical_id ?? null,
            a.pipeline_id ?? null, a.campaign_id ?? null, a.team_id ?? null, actorId],
        );
      }
      return u.rows[0];
    });
  }

  async update(id: number, dto: Partial<CreateUserDto> & { status?: 'active' | 'disabled' }) {
    await this.get(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.phone !== undefined) set('phone', dto.phone);
    if (dto.status !== undefined) {
      if (!['active', 'disabled'].includes(dto.status)) throw new BadRequestException('invalid status');
      set('status', dto.status);
    }
    if (dto.password) set('password_hash', await bcrypt.hash(dto.password, 10));
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    const rows = await this.db.query(
      `UPDATE "user" SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, name, email, phone, status`, params,
    );
    return rows[0];
  }

  /** Soft delete: disable login + hide from pickers. */
  deactivate(id: number) {
    return this.update(id, { status: 'disabled' });
  }

  /**
   * Bulk CSV import. Expected header: name,email,phone,password (password optional).
   * Returns per-row results; existing emails are skipped, not overwritten.
   */
  async importCsv(csv: string, actorId: number, scope?: ResolvedScope) {
    if (!csv?.trim()) throw new BadRequestException('csv body is required');
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col('name') < 0 || col('email') < 0) {
      throw new BadRequestException('CSV must have header columns: name,email[,phone][,password]');
    }
    const results: Array<{ line: number; email: string; ok: boolean; error?: string; id?: number }> = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cells = lines[i].split(',').map((s) => s.trim());
      const email = cells[col('email')] ?? '';
      try {
        const created = await this.create({
          name: cells[col('name')] ?? '',
          email,
          phone: col('phone') >= 0 ? cells[col('phone')] : undefined,
          password: col('password') >= 0 && cells[col('password')] ? cells[col('password')] : undefined,
        }, actorId, scope);
        results.push({ line: i + 1, email, ok: true, id: Number(created.id) });
      } catch (e: any) {
        results.push({ line: i + 1, email, ok: false, error: e.message });
      }
    }
    return {
      total: results.length,
      imported: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
