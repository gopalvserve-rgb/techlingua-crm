import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ScopeEnforcerService } from './scope-enforcer.service';
import { SCOPED_ENTITY_KEY, ScopedEntityMeta } from './rbac.decorators';
import { ResolvedScope } from './rbac.types';

/**
 * Global guard (runs AFTER JwtAuthGuard + PermissionsGuard): on routes decorated
 * with @ScopedEntity(kind), verifies the :id route param is inside request.scope
 * before the handler runs. Out-of-scope (or nonexistent) ids -> 404, centrally,
 * for every by-ID GET/PATCH/DELETE across users, teams, hierarchy and masters.
 */
@Injectable()
export class RecordScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly enforcer: ScopeEnforcerService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<ScopedEntityMeta>(SCOPED_ENTITY_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();
    const scope: ResolvedScope | undefined = req.scope; // set by PermissionsGuard
    if (!scope) return true; // route without @RequirePermission — nothing to scope against

    const id = Number(req.params?.[meta.param]);
    if (!Number.isInteger(id)) return true; // ParseIntPipe rejects with 400 downstream

    await this.enforcer.assertInScope(scope, meta.kind, id, req.user?.id);
    return true;
  }
}
