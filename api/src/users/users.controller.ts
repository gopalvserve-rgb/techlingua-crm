import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { CreateUserDto, UsersService } from './users.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.read')
  list(@CurrentScope() scope: ResolvedScope, @CurrentUser() user: { id: number }) {
    return this.users.list(scope, user.id);
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
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateUserDto>) {
    return this.users.update(id, dto);
  }

  @Patch(':id/deactivate')
  @RequirePermission('user.deactivate')
  @ScopedEntity('user')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.users.deactivate(id);
  }
}
