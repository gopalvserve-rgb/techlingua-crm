import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { normalizePhone } from '../common/phone.util';
import { config } from '../config';

type UserRow = { id: string; name: string; email: string | null; phone: string; password_hash: string; status: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly rbacData: RbacDataService,
  ) {}

  /**
   * Password login by identifier = mobile OR email (client update #1).
   * Emails match case-insensitively; anything else is normalised to the
   * canonical E.164 phone and matched against user.phone.
   */
  async login(identifier: string, password: string) {
    const user = identifier.includes('@')
      ? await this.db.one<UserRow>(
          `SELECT id, name, email, phone, password_hash, status FROM "user" WHERE lower(email) = lower($1)`,
          [identifier],
        )
      : await this.db.one<UserRow>(
          `SELECT id, name, email, phone, password_hash, status FROM "user" WHERE phone = $1`,
          [normalizePhone(identifier)],
        );
    if (!user || user.status !== 'active' || !user.password_hash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return this.issueToken({ id: Number(user.id), name: user.name, email: user.email });
  }

  /** Mint the session JWT + response shape (shared by password and OTP logins). */
  async issueToken(user: { id: number; name: string; email: string | null }) {
    const token = await this.jwt.signAsync(
      { sub: user.id, email: user.email, name: user.name },
      { secret: config.jwtSecret, expiresIn: config.jwtExpiresIn },
    );
    return { token, user: { id: user.id, name: user.name, email: user.email } };
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
