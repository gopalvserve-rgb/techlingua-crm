import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AssignmentDto, AssignmentsService } from './assignments.service';
import { CurrentScope, CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @RequirePermission('assignment.read')
  list(@Query('user_id') userId?: string) {
    return this.assignments.list(userId ? Number(userId) : undefined);
  }

  @Post()
  @RequirePermission('assignment.create')
  create(@Body() dto: AssignmentDto, @CurrentUser() user: { id: number }, @CurrentScope() scope: ResolvedScope) {
    return this.assignments.create(dto, user.id, scope);
  }

  @Delete(':id')
  @RequirePermission('assignment.delete')
  @ScopedEntity('assignment')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.assignments.remove(id);
  }
}
