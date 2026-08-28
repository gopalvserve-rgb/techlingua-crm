import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { DocTemplateService } from './doc-template.service';

interface Me { id: number; name: string }

/**
 * TEMPLATE SETUP — Administration › Template Setup (dev/143 item 5).
 * Behind settings.read / settings.update (Super/Org Admin), like Numbering.
 */
@Controller('document-templates')
export class DocTemplateController {
  constructor(private readonly svc: DocTemplateService) {}

  @Get()
  @RequirePermission('settings.read')
  list() { return this.svc.list(); }

  @Get(':type')
  @RequirePermission('settings.read')
  get(@Param('type') type: string) { return this.svc.get(type); }

  @Put(':type')
  @RequirePermission('settings.update')
  update(@Param('type') type: string, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.update(type, dto, Number(me.id));
  }
}
