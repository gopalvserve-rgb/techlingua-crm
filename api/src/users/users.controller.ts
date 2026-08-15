import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CreateUserDto, UsersService } from './users.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** UAT filters: ?q= (name/email) &role_id= &role=<name> &branch_id= &status=active|disabled — all scope-safe. */
  @Get()
  @RequirePermission('user.read')
  list(
    @CurrentScope() scope: ResolvedScope, @CurrentUser() user: { id: number },
    @Query('q') q?: string, @Query('role_id') roleId?: string, @Query('role') role?: string,
    @Query('branch_id') branchId?: string, @Query('status') status?: string,
    @Query('role_ids') roleIds?: string | string[], @Query('branch_ids') branchIds?: string | string[],
  ) {
    const nums = (v?: string | string[]): number[] | undefined => {
      if (v == null) return undefined;
      const out = [...new Set((Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','))
        .map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0))];
      return out.length ? out : undefined;
    };
    return this.users.list(scope, user.id, {
      q,
      role_id: roleId ? Number(roleId) : undefined,
      role: role || undefined,
      branch_id: branchId ? Number(branchId) : undefined,
      role_ids: nums(roleIds),
      branch_ids: nums(branchIds),
      status: status as 'active' | 'disabled' | undefined,
    });
  }

  @Get(':id')
  @RequirePermission('user.read')
  @ScopedEntity('user')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermission('user.create')
  create(@Body() dto: CreateUserDto, @CurrentUser() user: { id: number }, @CurrentScope() scope: ResolvedScope) {
    return this.users.create(dto, user.id, scope);
  }

  /** Bulk CSV import: body = { csv: "name,email,phone,password\n..." } */
  @Post('import')
  @RequirePermission('user.import')
  importCsv(@Body() body: { csv?: string }, @CurrentUser() user: { id: number }, @CurrentScope() scope: ResolvedScope) {
    return this.users.importCsv(body?.csv ?? '', user.id, scope);
  }

  @Patch(':id')
  @RequirePermission('user.update')
  @ScopedEntity('user')
  update(
    @Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateUserDto>,
    @CurrentUser() user: { id: number }, @CurrentScope() scope: ResolvedScope,
  ) {
    return this.users.update(id, dto, user.id, scope);
  }

  @Patch(':id/deactivate')
  @RequirePermission('user.deactivate')
  @ScopedEntity('user')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.users.deactivate(id);
  }

  /** Row action #2 — Activate / Deactivate the account (status toggle). */
  @Patch(':id/status')
  @RequirePermission('user.deactivate')
  @ScopedEntity('user')
  setStatus(@Param('id', ParseIntPipe) id: number, @Body() body: { status?: 'active' | 'disabled' }) {
    return this.users.setStatus(id, body?.status as 'active' | 'disabled');
  }

  /** Rows #3/#4/#5 — the branches / verticals / campaigns this user is assigned to / an agent on. */
  @Get(':id/access')
  @RequirePermission('user.read')
  @ScopedEntity('user')
  access(@Param('id', ParseIntPipe) id: number) {
    return this.users.access(id);
  }

  /** Row action #8 — the GLOBAL per-user lead-assignment switch (distribution skips a disabled user). */
  @Patch(':id/lead-assignment')
  @RequirePermission('user.update')
  @ScopedEntity('user')
  setLeadAssignment(@Param('id', ParseIntPipe) id: number, @Body() body: { enabled?: boolean }) {
    return this.users.setLeadAssignment(id, body?.enabled === true);
  }

  /** Row action #9 — admin sets a new password (strength-validated, hashed, never logged). */
  @Patch(':id/password')
  @RequirePermission('user.update')
  @ScopedEntity('user')
  changePassword(@Param('id', ParseIntPipe) id: number, @Body() body: { password?: string }) {
    return this.users.changePassword(id, String(body?.password ?? ''));
  }
}
