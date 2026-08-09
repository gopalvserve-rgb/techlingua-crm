import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CustomFieldsService, CustomFieldDto } from './custom-fields.service';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';

@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  /** Active definitions for an entity (drives the lead Add/Edit form + the admin screen). */
  @Get()
  @RequirePermission('custom_field.read')
  list(@Query('entity') entity?: string, @Query('all') all?: string) {
    return this.svc.list((entity || 'lead').trim() || 'lead', all === '1' || all === 'true');
  }

  @Post()
  @RequirePermission('custom_field.create')
  create(@Body() dto: CustomFieldDto, @CurrentUser() user: { id: number }) {
    return this.svc.create(dto, user.id);
  }

  @Patch(':id')
  @RequirePermission('custom_field.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: CustomFieldDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('custom_field.delete')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(id);
  }
}
