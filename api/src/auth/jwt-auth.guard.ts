import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { DatabaseService } from '../database/database.service';
import { config } from '../config';

/**
 * Global JWT guard. Sets request.user = { id, email, name } from a Bearer token.
 *
 * QA DEF-QA4-01: a signature/expiry check alone let a deactivated user keep API
 * access until the JWT expired (up to 8h). The guard now ALSO verifies the user
 * still exists and is `status = 'active'` on EVERY request — one indexed PK
 * lookup, deliberately uncached so deactivation takes effect immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let payload: { sub: unknown; email?: string; name?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: config.jwtSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userId = Number(payload.sub);
    const row = await this.db.one<{ status: string }>(
      `SELECT status FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [userId],
    );
    if (!row || row.status !== 'active') {
      throw new UnauthorizedException('User is inactive');
    }

    req.user = { id: userId, email: payload.email, name: payload.name };
    return true;
  }
}
