import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { SmsTemplateService } from './sms-template.service';

interface Me { id: number; name: string }

/**
 * The admin-managed SMS Template master (Branch+Vertical-scoped, DLT-compliant) and the
 * manual test send. EVERY route carries @RequirePermission (the RBAC reflection test fails
 * the build otherwise), and every route has a web caller (route-reachability test).
 *
 * Reuses the existing `template.*` permissions (this IS template management) and
 * `message.send` for the test despatch — a counsellor who may send may test.
 */
@Controller('sms-templates')
export class SmsTemplateController {
  constructor(private readonly svc: SmsTemplateService) {}

  @Get()
  @RequirePermission('template.read')
  list(@Query('branch_id') branch?: string, @Query('vertical_id') vertical?: string) {
    return this.svc.list({
      branch_id: branch ? Number(branch) : undefined,
      vertical_id: vertical ? Number(vertical) : undefined,
    });
  }

  @Post()
  @RequirePermission('template.create')
  create(@Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.create(dto, Number(me.id));
  }

  @Post('preview')
  @RequirePermission('template.read')
  preview(@Body() dto: any) {
    return this.svc.previewUrl(dto);
  }

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

  /** Send this template to a typed mobile number — the client tests to +91 7827878780. */
  @Post(':id/test')
  @RequirePermission('message.send')
  test(@Param('id', ParseIntPipe) id: number, @Body() dto: { mobile: string }, @CurrentUser() me: Me) {
    return this.svc.sendTest(id, dto?.mobile, Number(me.id));
  }
}
