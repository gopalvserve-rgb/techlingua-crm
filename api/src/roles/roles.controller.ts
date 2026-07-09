import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { MatrixEntry, RoleDto, RolesService } from './roles.service';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('role.read')
  list() {
    return this.roles.listRoles();
  }

  /** Permission catalog for the matrix editor. */
  @Get('permissions')
  @RequirePermission('role.read')
  permissions() {
    return this.roles.listPermissions();
  }

  @Get(':id')
  @RequirePermission('role.read')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.roles.getRole(id);
  }

  @Post()
  @RequirePermission('role.create')
  create(@Body() dto: RoleDto, @CurrentUser() user: { id: number }) {
    return this.roles.createRole(dto, user.id);
  }

  @Patch(':id')
  @RequirePermission('role.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<RoleDto> & { is_active?: boolean }) {
    return this.roles.updateRole(id, dto);
  }

  /** Replace the whole permission matrix of a role (audit action: permission_change). */
  @Put(':id/permissions')
  @RequirePermission('role.update')
  setMatrix(@Param('id', ParseIntPipe) id: number, @Body() body: { entries: MatrixEntry[] }) {
    return this.roles.setMatrix(id, body?.entries ?? []);
  }
}
