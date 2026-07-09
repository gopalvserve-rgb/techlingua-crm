import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { TeamDto, TeamsService } from './teams.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission('team.read')
  list(@CurrentScope() scope: ResolvedScope) {
    return this.teams.list(scope);
  }

  @Get(':id')
  @RequirePermission('team.read')
  @ScopedEntity('team')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.teams.get(id);
  }

  @Post()
  @RequirePermission('team.create')
  create(@Body() dto: TeamDto, @CurrentUser() user: { id: number }) {
    return this.teams.create(dto, user.id);
  }

  @Patch(':id')
  @RequirePermission('team.update')
  @ScopedEntity('team')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<TeamDto>) {
    return this.teams.update(id, dto);
  }
}
