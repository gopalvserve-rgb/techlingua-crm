import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacDataService } from './rbac-data.service';
import { ScopeResolverService } from './scope-resolver.service';
import { IS_PUBLIC_KEY, PERMISSION_KEY } from './rbac.decorators';

/**
 * Global guard: reads @RequirePermission metadata, resolves the caller's effective
 * scope for it and attaches it to the request (request.scope) for query scoping.
 * Endpoints without @RequirePermission only require authentication.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbacData: RbacDataService,
    private readonly resolver: ScopeResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const permissionKey = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!permissionKey) return true; // authenticated-only endpoint

    const req = context.switchToHttp().getRequest();
    if (!req.user?.id) return false; // JwtAuthGuard runs first

    // cache grants per request (several guards/decorators may need them)
    if (!req.userGrants) req.userGrants = await this.rbacData.loadUserGrants(req.user.id);
    const scope = this.resolver.resolve(req.userGrants, permissionKey);
    if (!scope.allowed) {
      throw new ForbiddenException(`Missing permission: ${permissionKey}`);
    }
    req.scope = scope;
    return true;
  }
}
