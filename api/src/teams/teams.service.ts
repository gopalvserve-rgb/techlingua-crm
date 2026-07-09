import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';

export interface TeamDto {
  name: string;
  branch_id?: number | null;
  vertical_id?: number | null;
  leader_id?: number | null;
  member_ids?: number[];
}

@Injectable()
export class TeamsService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  async list(scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, {
      team: 't.id', branch: 't.branch_id', vertical: 't.vertical_id',
    }, params);
    return this.db.query(
      `SELECT t.id, t.name, t.branch_id, b.name AS branch_name, t.vertical_id, v.name AS vertical_name,
              t.leader_id, u.name AS leader_name, t.is_active,
              (SELECT COUNT(*)::int FROM team_member tm WHERE tm.team_id = t.id) AS member_count
         FROM team t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
         LEFT JOIN "user" u ON u.id = t.leader_id
        WHERE ${where}
        ORDER BY t.name`,
      params,
    );
  }

  async get(id: number) {
    const team = await this.db.one(`SELECT * FROM team WHERE id = $1`, [id]);
    if (!team) throw new NotFoundException('Team not found');
    const members = await this.db.query(
      `SELECT u.id, u.name, u.email FROM team_member tm JOIN "user" u ON u.id = tm.user_id WHERE tm.team_id = $1`,
      [id],
    );
    return { ...team, members };
  }

  async create(dto: TeamDto, actorId: number) {
    if (!dto?.name) throw new BadRequestException('name is required');
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return this.db.tx(async (c) => {
      const t = await c.query(
        `INSERT INTO team (org_id, branch_id, vertical_id, name, leader_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [Number(org!.id), dto.branch_id ?? null, dto.vertical_id ?? null, dto.name.trim(), dto.leader_id ?? null, actorId],
      );
      for (const uid of dto.member_ids ?? []) {
        await c.query(`INSERT INTO team_member (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [t.rows[0].id, uid]);
      }
      return t.rows[0];
    });
  }

  async update(id: number, dto: Partial<TeamDto> & { is_active?: boolean }) {
    await this.get(id);
    return this.db.tx(async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.branch_id !== undefined) set('branch_id', dto.branch_id);
      if (dto.vertical_id !== undefined) set('vertical_id', dto.vertical_id);
      if (dto.leader_id !== undefined) set('leader_id', dto.leader_id);
      if (dto.is_active !== undefined) set('is_active', dto.is_active);
      if (sets.length) {
        params.push(id);
        await c.query(`UPDATE team SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
      }
      if (dto.member_ids) {
        await c.query(`DELETE FROM team_member WHERE team_id = $1`, [id]);
        for (const uid of dto.member_ids) {
          await c.query(`INSERT INTO team_member (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, uid]);
        }
      }
      return (await c.query(`SELECT * FROM team WHERE id = $1`, [id])).rows[0];
    });
  }
}
