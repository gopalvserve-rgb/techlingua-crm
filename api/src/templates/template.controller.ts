import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { TemplateService } from './template.service';

interface Me { id: number }

@Controller('templates')
export class TemplateController {
  constructor(private readonly svc: TemplateService) {}

  /** The variable catalogue the editor's "insert variable" panel is built from. */
  @Get('catalog')
  @RequirePermission('template.read')
  catalog() { return this.svc.catalog(); }

  @Get()
  @RequirePermission('template.read')
  list(@Query('channel') channel?: string, @Query('vertical_id') verticalId?: string) {
    return this.svc.list({ channel, vertical_id: verticalId ? Number(verticalId) : undefined });
  }

  /**
   * LIVE PREVIEW against a sample lead (or a real one). Deliberately a POST: it renders
   * whatever is on screen, including unsaved edits — that is what makes it a preview and
   * not a report.
   */
  @Post('preview')
  @RequirePermission('template.read')
  preview(@Body() dto: any) { return this.svc.preview(dto); }

  @Get(':id')
  @RequirePermission('template.read')
  get(@Param('id', ParseIntPipe) id: number) { return this.svc.get(id); }

  @Post()
  @RequirePermission('template.create')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, Number(me.id)); }

  @Patch(':id')
  @RequirePermission('template.update')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.update(id, dto, Number(me.id));
  }

  @Delete(':id')
  @RequirePermission('template.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.svc.remove(id, Number(me.id));
  }
}
