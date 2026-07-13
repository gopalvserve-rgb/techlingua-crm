import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { normalizePhone } from '../common/phone.util';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';

export interface UserListFilters {
  q?: string;
  role_id?: number;
  branch_id?: number;
  status?: 'active' | 'disabled';
}

/**
 * UAT: server-side users-list filters (search / role / branch / status).
 * Pure SQL-fragment builder so it unit-tests without a DB. Appends to `params`
 * and returns ` AND …` clauses that compose with the scope WHERE.
 */
export function buildUserFilters(f: UserListFilters, params: unknown[]): string {
  let sql = '';
  if (f.q?.trim()) {
    params.push(`%${f.q.trim()}%`);
    sql += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone LIKE $${params.length})`;
  }
  if (f.role_id) {
    params.push(f.role_id);
    sql += ` AND EXISTS (SELECT 1 FROM user_assignment fa WHERE fa.user_id = u.id AND fa.is_active AND fa.role_id = $${params.length})`;
  }
  if (f.branch_id) {
    params.push(f.branch_id);
    sql += ` AND EXISTS (SELECT 1 FROM user_assignment fb WHERE fb.user_id = u.id AND fb.is_active AND fb.branch_id = $${params.length})`;
  }
  if (f.status) {
    if (!['active', 'disabled'].includes(f.status)) throw new BadRequestException('invalid status filter');
    params.push(f.status);
    sql += ` AND u.status = $${params.length}`;
  }
  return sql;
}

export interface CreateUserDto {
  name: string;
  /** MANDATORY (client update #1 — mobile-first): stored canonical E.164, unique. */
  phone: string;
  /** optional; unique when present */
  email?: string;
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
  async list(scope: ResolvedScope, requesterId: number, filters: UserListFilters = {}) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      owner: 'u.id', team: 'tm.team_id', branch: 'ua.branch_id',
      vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
    }, params);
    params.push(requesterId);
    const scopeWhere = `((${where}) OR u.id = $${params.length})`;
    const filterSql = buildUserFilters(filters, params);
    return this.db.query(
      `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.status, u.created_at,
              (SELECT COALESCE(string_agg(DISTINCT r.name, ', '), '')
                 FROM user_assignment ra JOIN role r ON r.id = ra.role_id
                WHERE ra.user_id = u.id AND ra.is_active) AS role_names
         FROM "user" u
         LEFT JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
         LEFT JOIN team_member tm ON tm.user_id = u.id
        WHERE ${scopeWhere}${filterSql}
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
    const teams = await this.db.query(
      `SELECT t.id, t.name, (t.leader_id = $1) AS is_leader
         FROM team t
        WHERE t.is_active AND (t.leader_id = $1 OR EXISTS (
              SELECT 1 FROM team_member tm WHERE tm.team_id = t.id AND tm.user_id = $1))
        ORDER BY t.name`,
      [id],
    );
    return { ...user, assignments, teams };
  }

  async create(dto: CreateUserDto, actorId: number, scope?: ResolvedScope) {
    // Mobile-first (client update #1): phone is the mandatory identifier, email optional.
    if (!dto?.name || !dto?.phone?.trim()) throw new BadRequestException('name and phone (mobile number) are required');
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
    const phone = normalizePhone(dto.phone) as string;
    const dupPhone = await this.db.one(`SELECT 1 FROM "user" WHERE phone = $1`, [phone]);
    if (dupPhone) throw new ConflictException(`Mobile number already exists: ${phone}`);
    const email = dto.email?.trim() ? dto.email.trim().toLowerCase() : null;
    if (email) {
      const dup = await this.db.one(`SELECT 1 FROM "user" WHERE lower(email)=lower($1)`, [email]);
      if (dup) throw new ConflictException(`Email already exists: ${email}`);
    }
    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    return this.db.tx(async (c) => {
      const u = await c.query(
        `INSERT INTO "user" (org_id, name, email, phone, password_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email, phone, status`,
        [org, dto.name.trim(), email, phone, hash, actorId],
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
    if (dto.phone !== undefined) {
      if (!String(dto.phone ?? '').trim()) throw new BadRequestException('phone cannot be removed (mobile-first login identifier)');
      const phone = normalizePhone(String(dto.phone)) as string;
      const clash = await this.db.one(`SELECT 1 FROM "user" WHERE phone = $1 AND id <> $2`, [phone, id]);
      if (clash) throw new ConflictException(`Mobile number already exists: ${phone}`);
      set('phone', phone);
    }
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
   * Bulk CSV import (mobile-first): header name,phone[,email][,password] —
   * phone mandatory per row, email optional. Existing phones/emails are skipped.
   */
  async importCsv(csv: string, actorId: number, scope?: ResolvedScope) {
    if (!csv?.trim()) throw new BadRequestException('csv body is required');
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col('name') < 0 || col('phone') < 0) {
      throw new BadRequestException('CSV must have header columns: name,phone[,email][,password]');
    }
    const results: Array<{ line: number; phone: string; email?: string; ok: boolean; error?: string; id?: number }> = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cells = lines[i].split(',').map((s) => s.trim());
      const phone = cells[col('phone')] ?? '';
      const email = col('email') >= 0 ? cells[col('email')] : undefined;
      try {
        const created = await this.create({
          name: cells[col('name')] ?? '',
          phone,
          email: email || undefined,
          password: col('password') >= 0 && cells[col('password')] ? cells[col('password')] : undefined,
        }, actorId, scope);
        results.push({ line: i + 1, phone, email, ok: true, id: Number(created.id) });
      } catch (e: any) {
        results.push({ line: i + 1, phone, email, ok: false, error: e.message });
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
