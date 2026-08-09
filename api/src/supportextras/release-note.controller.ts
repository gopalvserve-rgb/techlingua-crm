import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ReleaseNoteService } from './release-note.service';

interface Me { id: number; name: string }

/**
 * Help & Support › Release Notes — an ORG-WIDE in-app changelog.
 * View is release_note.view (all staff, incl. the "What's New" feed); create/edit/delete is
 * release_note.manage (admins). Literal routes (feed) declared before ':id'.
 */
@Controller('release-notes')
export class ReleaseNoteController {
  constructor(private readonly svc: ReleaseNoteService) {}

  @Get() @RequirePermission('release_note.view')
  list(@Query() q: any) { return this.svc.list(q ?? {}); }

  @Get('feed') @RequirePermission('release_note.view')
  feed(@Query('limit') limit?: string) { return this.svc.feed(Number(limit)); }

  @Post('bulk-delete/impact') @RequirePermission('release_note.manage')
  bulkImpact(@Body() b: any) { return this.svc.bulkImpact(b?.ids); }
  @Post('bulk-delete') @RequirePermission('release_note.manage')
  bulkDelete(@Body() b: any, @CurrentUser() me: Me) { return this.svc.bulkRemove(b?.ids, me); }

  @Post() @RequirePermission('release_note.manage')
  create(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.create(dto, me); }

  @Patch(':id') @RequirePermission('release_note.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.update(id, dto); }

  @Delete(':id') @RequirePermission('release_note.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.remove(id, me); }
}
