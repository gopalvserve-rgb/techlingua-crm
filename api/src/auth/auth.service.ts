import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { config } from '../config';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly rbacData: RbacDataService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.db.one<{ id: string; name: string; email: string; password_hash: string; status: string }>(
      `SELECT id, name, email, password_hash, status FROM "user" WHERE lower(email) = lower($1)`,
      [email],
    );
    if (!user || user.status !== 'active' || !user.password_hash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const token = await this.jwt.signAsync(
      { sub: Number(user.id), email: user.email, name: user.name },
      { secret: config.jwtSecret, expiresIn: config.jwtExpiresIn },
    );
    return { token, user: { id: Number(user.id), name: user.name, email: user.email } };
  }

  /** Profile + effective permission keys (used by the web app to hide nav/actions). */
  async me(userId: number) {
    const user = await this.db.one(
      `SELECT id, name, email, phone, status FROM "user" WHERE id = $1`, [userId],
    );
    const grants = await this.rbacData.loadUserGrants(userId);
    const heldRoleIds = new Set(grants.assignments.map((a) => a.roleId));
    const permissionKeys = [...new Set(
      grants.rolePermissions.filter((rp) => heldRoleIds.has(rp.roleId)).map((rp) => rp.permissionKey),
    )].sort();
    const assignments = await this.db.query(
      `SELECT ua.id, ua.role_id, r.name AS role_name, ua.branch_id, b.name AS branch_name,
              ua.vertical_id, v.name AS vertical_name, ua.pipeline_id, p.name AS pipeline_name,
              ua.campaign_id, c.name AS campaign_name, ua.team_id, t.name AS team_name
         FROM user_assignment ua
         JOIN role r ON r.id = ua.role_id
         LEFT JOIN branch b ON b.id = ua.branch_id
         LEFT JOIN vertical v ON v.id = ua.vertical_id
         LEFT JOIN pipeline p ON p.id = ua.pipeline_id
         LEFT JOIN campaign c ON c.id = ua.campaign_id
         LEFT JOIN team t ON t.id = ua.team_id
        WHERE ua.user_id = $1 AND ua.is_active`,
      [userId],
    );
    return { user, permissionKeys, assignments };
  }
}
