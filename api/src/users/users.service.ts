import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { normalizePhone } from '../common/phone.util';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { assertActiveUser } from '../leads/active-user.util';

export interface UserListFilters {
  q?: string;
  role_id?: number;
  branch_id?: number;
  status?: 'active' | 'disabled';
  // Multi-select (client, Aug 2026): OR within a filter -> EXISTS ... IN (...); singular kept.
  role_ids?: number[];
  branch_ids?: number[];
  /** filter to users who hold a role by NAME (e.g. ?role=Trainer) — case-insensitive,
   *  matches "has at least one active assignment with that role". Used by the batch
   *  Trainer/Faculty picker so only Trainer-role users are offered. */
  role?: string;
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
  const ids = (single: number | undefined, arr: number[] | undefined) =>
    [...new Set([...(arr ?? []), ...(single != null ? [single] : [])])].map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const roleIds = ids(f.role_id, f.role_ids);
  if (roleIds.length) {
    const ph = roleIds.map((v) => { params.push(v); return `$${params.length}`; });
    sql += ` AND EXISTS (SELECT 1 FROM user_assignment fa WHERE fa.user_id = u.id AND fa.is_active AND fa.role_id IN (${ph.join(',')}))`;
  }
  if (f.role?.trim()) {
    params.push(f.role.trim());
    sql += ` AND EXISTS (SELECT 1 FROM user_assignment fr JOIN role rr ON rr.id = fr.role_id`
        + ` WHERE fr.user_id = u.id AND fr.is_active AND rr.name ILIKE $${params.length})`;
  }
  const branchIds = ids(f.branch_id, f.branch_ids);
  if (branchIds.length) {
    const ph = branchIds.map((v) => { params.push(v); return `$${params.length}`; });
    sql += ` AND EXISTS (SELECT 1 FROM user_assignment fb WHERE fb.user_id = u.id AND fb.is_active AND fb.branch_id IN (${ph.join(',')}))`;
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
  /** QA-10 sweep: the Add User form offers a Status — honour it on create too. */
  status?: 'active' | 'disabled';
  /** "Reports To" (client, Aug 2026): this user's reporting MANAGER. Nullable; the target
   *  must be an ACTIVE user. DIFFERENT from the task-level report_to on follow_up (016). */
  report_to_id?: number | null;
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
      `SELECT DISTINCT u.id, u.name, u.email, u.phone, u.status, u.lead_assignment_enabled, u.created_at,
              (SELECT COALESCE(string_agg(DISTINCT r.name, ', '), '')
                 FROM user_assignment ra JOIN role r ON r.id = ra.role_id
                WHERE ra.user_id = u.id AND ra.is_active) AS role_names,
              (SELECT COALESCE(string_agg(DISTINCT b.name, ', '), '')
                 FROM user_assignment ba JOIN branch b ON b.id = ba.branch_id
                WHERE ba.user_id = u.id AND ba.is_active) AS branch_names,
              -- DEF-2: the Edit User form prefills System Role / Branch / Vertical Access
              (SELECT pa.role_id FROM user_assignment pa
                WHERE pa.user_id = u.id AND pa.is_active ORDER BY pa.id LIMIT 1) AS role_id,
              (SELECT pa.branch_id FROM user_assignment pa
                WHERE pa.user_id = u.id AND pa.is_active ORDER BY pa.id LIMIT 1) AS branch_id,
              (SELECT pa.vertical_id FROM user_assignment pa
                WHERE pa.user_id = u.id AND pa.is_active ORDER BY pa.id LIMIT 1) AS vertical_id,
              u.report_to_id,
              (SELECT m.name FROM "user" m WHERE m.id = u.report_to_id) AS report_to_name
         FROM "user" u
         LEFT JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
         LEFT JOIN team_member tm ON tm.user_id = u.id
        WHERE u.deleted_at IS NULL AND ${scopeWhere}${filterSql}
        ORDER BY u.name`,
      params,
    );
  }

  async get(id: number) {
    const user = await this.db.one(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.mfa_enabled, u.lead_assignment_enabled, u.created_at,
              u.report_to_id, m.name AS report_to_name
         FROM "user" u LEFT JOIN "user" m ON m.id = u.report_to_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`, [id],
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
    // "Reports To": the target manager must be an ACTIVE user (no-deactivated-user rule).
    if (dto.report_to_id != null) await assertActiveUser(this.db, Number(dto.report_to_id), 'report_to_id');
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
    if (dto.status != null && !['active', 'disabled'].includes(dto.status)) {
      throw new BadRequestException("invalid status — expected 'active' or 'disabled'");
    }
    const status = dto.status ?? null;

    return this.db.tx(async (c) => {
      const u = await c.query(
        `INSERT INTO "user" (org_id, name, email, phone, password_hash, status, report_to_id, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, 'active'),$7,$8) RETURNING id, name, email, phone, status, report_to_id`,
        [org, dto.name.trim(), email, phone, hash, status, dto.report_to_id ?? null, actorId],
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

  /**
   * DEF-2: the Edit User form must be able to change everything the Add User form
   * shows — including Email ID and the role / branch / vertical assignment. Passing
   * `assignments` REPLACES the user's active assignment set (omit it to leave as-is).
   */
  async update(
    id: number,
    dto: Partial<CreateUserDto> & { status?: 'active' | 'disabled' },
    actorId?: number,
    scope?: ResolvedScope,
  ) {
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
    if (dto.email !== undefined) {
      const email = dto.email?.trim() ? dto.email.trim().toLowerCase() : null;
      if (email) {
        const clash = await this.db.one(`SELECT 1 FROM "user" WHERE lower(email) = lower($1) AND id <> $2`, [email, id]);
        if (clash) throw new ConflictException(`Email already exists: ${email}`);
      }
      set('email', email);
    }
    if (dto.status !== undefined) {
      if (!['active', 'disabled'].includes(dto.status)) throw new BadRequestException('invalid status');
      set('status', dto.status);
    }
    if (dto.password) set('password_hash', await bcrypt.hash(dto.password, 10));
    // "Reports To": nullable; a non-null target must be an ACTIVE user. Guard against a
    // user reporting to themselves.
    if (dto.report_to_id !== undefined) {
      if (dto.report_to_id === null) { set('report_to_id', null); }
      else {
        if (Number(dto.report_to_id) === Number(id)) throw new BadRequestException('a user cannot report to themselves');
        await assertActiveUser(this.db, Number(dto.report_to_id), 'report_to_id');
        set('report_to_id', Number(dto.report_to_id));
      }
    }

    // assignment replacement is scope-checked exactly like create()
    if (dto.assignments !== undefined && scope) {
      for (const a of dto.assignments) {
        await this.enforcer.assertRefInScope(scope, 'branch', a.branch_id, actorId ?? id);
        await this.enforcer.assertRefInScope(scope, 'vertical', a.vertical_id, actorId ?? id);
        await this.enforcer.assertRefInScope(scope, 'pipeline', a.pipeline_id, actorId ?? id);
        await this.enforcer.assertRefInScope(scope, 'campaign', a.campaign_id, actorId ?? id);
        await this.enforcer.assertRefInScope(scope, 'team', a.team_id, actorId ?? id);
      }
    }
    if (!sets.length && dto.assignments === undefined) throw new BadRequestException('nothing to update');

    return this.db.tx(async (c) => {
      let row: Record<string, unknown> | undefined;
      if (sets.length) {
        params.push(id);
        const res = await c.query(
          `UPDATE "user" SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}
           RETURNING id, name, email, phone, status`, params,
        );
        row = res.rows[0];
      }
      if (dto.assignments !== undefined) {
        await c.query(`UPDATE user_assignment SET is_active = FALSE WHERE user_id = $1`, [id]);
        for (const a of dto.assignments) {
          await c.query(
            `INSERT INTO user_assignment (user_id, role_id, branch_id, vertical_id, pipeline_id, campaign_id, team_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, a.role_id, a.branch_id ?? null, a.vertical_id ?? null,
              a.pipeline_id ?? null, a.campaign_id ?? null, a.team_id ?? null, actorId ?? id],
          );
        }
      }
      if (row) return row;
      const res = await c.query(
        `SELECT id, name, email, phone, status FROM "user" WHERE id = $1`, [id],
      );
      return res.rows[0];
    });
  }

  /** Soft delete: disable login + hide from pickers. */
  deactivate(id: number) {
    return this.update(id, { status: 'disabled' });
  }

  /**
   * Users row action #2 — Activate / Deactivate the account (status toggle). Reuses the
   * validated update() path; gated at the controller on `user.deactivate`. A disabled
   * user cannot log in (auth.service) and is skipped by every owner/reassign guard.
   */
  async setStatus(id: number, status: 'active' | 'disabled') {
    if (!['active', 'disabled'].includes(status)) throw new BadRequestException("invalid status — expected 'active' or 'disabled'");
    return this.update(id, { status });
  }

  /**
   * Users row action #8 — the GLOBAL per-user lead-assignment switch (migration 039).
   * When disabled, the distribution engine skips this user for NEW hand-outs everywhere
   * (see lead-ingestion.service resolvePool). Distinct from Activate/Deactivate (login).
   */
  async setLeadAssignment(id: number, enabled: boolean) {
    await this.get(id); // 404 if missing / soft-deleted
    if (typeof enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean');
    const res = await this.db.one<{ id: string; lead_assignment_enabled: boolean }>(
      `UPDATE "user" SET lead_assignment_enabled = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, lead_assignment_enabled`,
      [id, enabled],
    );
    if (!res) throw new NotFoundException('User not found');
    return { id: Number(res.id), lead_assignment_enabled: res.lead_assignment_enabled };
  }

  /**
   * Users row action #9 — admin sets a new password for the user. Strength-validated,
   * bcrypt-hashed exactly like create/update; the plaintext is NEVER logged or returned.
   * Gated on `user.update` at the controller.
   */
  async changePassword(id: number, password: string) {
    const pw = String(password ?? '');
    // strength first (cheap) — a weak password never touches the DB
    if (pw.length < 8) throw new BadRequestException('password must be at least 8 characters');
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
      throw new BadRequestException('password must contain at least one letter and one number');
    }
    await this.get(id); // 404 if missing / soft-deleted
    const hash = await bcrypt.hash(pw, 10);
    await this.db.query(
      `UPDATE "user" SET password_hash = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id, hash],
    );
    // NB: return NOTHING about the password — not the hash, never the plaintext.
    return { ok: true };
  }

  /**
   * Users row actions #3/#4/#5 — the branches / verticals / campaigns this user is
   * assigned to, read from their ACTIVE user_assignment rows. One scoped read backs all
   * three "View …" menu items. Gated on `user.read`.
   */
  async access(id: number) {
    await this.get(id); // 404 if missing / soft-deleted
    const branches = await this.db.query(
      `SELECT DISTINCT b.id, b.name FROM user_assignment ua JOIN branch b ON b.id = ua.branch_id
        WHERE ua.user_id = $1 AND ua.is_active AND b.deleted_at IS NULL ORDER BY b.name`, [id],
    );
    const verticals = await this.db.query(
      `SELECT DISTINCT v.id, v.name, v.branch_id FROM user_assignment ua JOIN vertical v ON v.id = ua.vertical_id
        WHERE ua.user_id = $1 AND ua.is_active AND v.deleted_at IS NULL ORDER BY v.name`, [id],
    );
    // A user "is on" a campaign three ways: a direct user_assignment.campaign_id, being a
    // campaign MANAGER (campaign_manager), or being an AGENT in its distribution pool
    // (distribution_config.agent_user_ids). UNION all three, live campaigns only.
    const campaigns = await this.db.query(
      `SELECT c.id, c.name, c.branch_id, c.vertical_id FROM campaign c WHERE c.deleted_at IS NULL AND (
             EXISTS (SELECT 1 FROM user_assignment ua
                      WHERE ua.user_id = $1 AND ua.is_active AND ua.campaign_id = c.id)
          OR EXISTS (SELECT 1 FROM campaign_manager cm
                      WHERE cm.campaign_id = c.id AND cm.user_id = $1)
          OR (c.distribution_config->'agent_user_ids') @> to_jsonb(ARRAY[$1::bigint])
        ) ORDER BY c.name`, [id],
    );
    return { branches, verticals, campaigns };
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
