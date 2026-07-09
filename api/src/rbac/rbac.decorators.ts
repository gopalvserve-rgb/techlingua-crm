import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ResolvedScope } from './rbac.types';
import type { ScopedEntityKind } from './scope-enforcer.service';

export const PERMISSION_KEY = 'required_permission';
export const IS_PUBLIC_KEY = 'is_public';
export const SCOPED_ENTITY_KEY = 'scoped_entity';

export interface ScopedEntityMeta { kind: ScopedEntityKind; param: string }

/** Declare the permission an endpoint requires, e.g. @RequirePermission('user.create'). */
export const RequirePermission = (key: string) => SetMetadata(PERMISSION_KEY, key);

/**
 * Enforce record scope on a by-ID route: the :id (or `param`) must resolve to a
 * record inside the caller's request.scope, else 404 (see ScopeEnforcerService).
 * Example: @Patch('campaigns/:id') @RequirePermission('campaign.update') @ScopedEntity('campaign')
 */
export const ScopedEntity = (kind: ScopedEntityKind, param = 'id') =>
  SetMetadata(SCOPED_ENTITY_KEY, { kind, param } satisfies ScopedEntityMeta);

/** Mark an endpoint as public (skips JWT + permission guards) — login only. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Injects the authenticated user ({ id, email, name }) set by JwtAuthGuard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});

/** Injects the ResolvedScope computed by PermissionsGuard for the endpoint's permission. */
export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): ResolvedScope => {
  return ctx.switchToHttp().getRequest().scope;
});
