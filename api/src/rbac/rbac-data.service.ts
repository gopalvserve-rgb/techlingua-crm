import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UserGrantData } from './rbac.types';

/** Loads the RBAC grant data for a user (assignments + role permissions + teams). */
@Injectable()
export class RbacDataService {
  constructor(private readonly db: DatabaseService) {}

  async loadUserGrants(userId: number): Promise<UserGrantData> {
    const assignments = await this.db.query<{
      role_id: string; branch_id: string | null; vertical_id: string | null;
      pipeline_id: string | null; campaign_id: string | null; team_id: string | null;
    }>(
      `SELECT ua.role_id, ua.branch_id, ua.vertical_id, ua.pipeline_id, ua.campaign_id, ua.team_id
         FROM user_assignment ua
         JOIN role r ON r.id = ua.role_id AND r.is_active
        WHERE ua.user_id = $1 AND ua.is_active`,
      [userId],
    );

    const roleIds = [...new Set(assignments.map((a) => Number(a.role_id)))];
    const rolePermissions = roleIds.length
      ? await this.db.query<{ role_id: string; key: string; record_scope: string; field_scope: any }>(
          `SELECT rp.role_id, p.key, rp.record_scope, rp.field_scope
             FROM role_permission rp
             JOIN permission p ON p.id = rp.permission_id
            WHERE rp.role_id = ANY($1::bigint[])`,
          [roleIds],
        )
      : [];

    const teams = await this.db.query<{ id: string }>(
      `SELECT tm.team_id AS id FROM team_member tm WHERE tm.user_id = $1
       UNION
       SELECT t.id FROM team t WHERE t.leader_id = $1 AND t.is_active`,
      [userId],
    );

    return {
      userId,
      assignments: assignments.map((a) => ({
        roleId: Number(a.role_id),
        branchId: a.branch_id == null ? null : Number(a.branch_id),
        verticalId: a.vertical_id == null ? null : Number(a.vertical_id),
        pipelineId: a.pipeline_id == null ? null : Number(a.pipeline_id),
        campaignId: a.campaign_id == null ? null : Number(a.campaign_id),
        teamId: a.team_id == null ? null : Number(a.team_id),
      })),
      rolePermissions: rolePermissions.map((rp) => ({
        roleId: Number(rp.role_id),
        permissionKey: rp.key,
        recordScope: rp.record_scope as UserGrantData['rolePermissions'][number]['recordScope'],
        fieldScope: rp.field_scope ?? null,
      })),
      teamIds: teams.map((t) => Number(t.id)),
    };
  }
}
