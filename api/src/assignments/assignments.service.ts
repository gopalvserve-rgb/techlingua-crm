import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface AssignmentDto {
  user_id: number;
  role_id: number;
  branch_id?: number | null;
  vertical_id?: number | null;
  pipeline_id?: number | null;
  campaign_id?: number | null;
  team_id?: number | null;
}

/**
 * user_assignment CRUD — the multi-unit grants engine. Consistency rule: any provided
 * child unit must belong to the provided parent (e.g. vertical inside branch).
 */
@Injectable()
export class AssignmentsService {
  constructor(private readonly db: DatabaseService) {}

  list(userId?: number) {
    const where = userId ? `WHERE ua.user_id = $1 AND ua.is_active` : `WHERE ua.is_active`;
    return this.db.query(
      `SELECT ua.*, u.name AS user_name, r.name AS role_name, b.name AS branch_name,
              v.name AS vertical_name, p.name AS pipeline_name, c.name AS campaign_name, t.name AS team_name
         FROM user_assignment ua
         JOIN "user" u ON u.id = ua.user_id
         JOIN role r ON r.id = ua.role_id
         LEFT JOIN branch b ON b.id = ua.branch_id
         LEFT JOIN vertical v ON v.id = ua.vertical_id
         LEFT JOIN pipeline p ON p.id = ua.pipeline_id
         LEFT JOIN campaign c ON c.id = ua.campaign_id
         LEFT JOIN team t ON t.id = ua.team_id
        ${where} ORDER BY u.name, r.name`,
      userId ? [userId] : [],
    );
  }

  private async validateUnits(dto: AssignmentDto) {
    if (dto.vertical_id != null) {
      const v = await this.db.one<{ branch_id: string }>(`SELECT branch_id FROM vertical WHERE id = $1`, [dto.vertical_id]);
      if (!v) throw new BadRequestException('vertical not found');
      if (dto.branch_id != null && Number(v.branch_id) !== Number(dto.branch_id)) {
        throw new BadRequestException('vertical does not belong to the given branch');
      }
    }
    if (dto.pipeline_id != null) {
      const p = await this.db.one<{ vertical_id: string }>(`SELECT vertical_id FROM pipeline WHERE id = $1`, [dto.pipeline_id]);
      if (!p) throw new BadRequestException('pipeline not found');
      if (dto.vertical_id != null && Number(p.vertical_id) !== Number(dto.vertical_id)) {
        throw new BadRequestException('pipeline does not belong to the given vertical');
      }
    }
    if (dto.campaign_id != null) {
      const c = await this.db.one<{ pipeline_id: string }>(`SELECT pipeline_id FROM campaign WHERE id = $1`, [dto.campaign_id]);
      if (!c) throw new BadRequestException('campaign not found');
      if (dto.pipeline_id != null && Number(c.pipeline_id) !== Number(dto.pipeline_id)) {
        throw new BadRequestException('campaign does not belong to the given pipeline');
      }
    }
  }

  async create(dto: AssignmentDto, actorId: number) {
    if (!dto?.user_id || !dto?.role_id) throw new BadRequestException('user_id and role_id are required');
    await this.validateUnits(dto);
    const rows = await this.db.query(
      `INSERT INTO user_assignment (user_id, role_id, branch_id, vertical_id, pipeline_id, campaign_id, team_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [dto.user_id, dto.role_id, dto.branch_id ?? null, dto.vertical_id ?? null,
        dto.pipeline_id ?? null, dto.campaign_id ?? null, dto.team_id ?? null, actorId],
    );
    return rows[0];
  }

  async remove(id: number) {
    const rows = await this.db.query(
      `UPDATE user_assignment SET is_active = FALSE, updated_at = now() WHERE id = $1 RETURNING id`, [id],
    );
    if (!rows.length) throw new NotFoundException('Assignment not found');
    return { id, removed: true };
  }
}
