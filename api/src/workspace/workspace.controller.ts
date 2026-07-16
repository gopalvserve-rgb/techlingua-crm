import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentScope, CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';
import { Me, WorkspaceService } from './workspace.service';

/**
 * Workspace & Productivity — team messages · notes · knowledge base · announcements.
 *
 * TASKS ARE NOT HERE. Workspace › Tasks is the FOLLOW-UP module (`/follow-ups`) — the
 * same table, the same statuses, the same form. See workspace.service.ts's header for
 * why that is the whole point rather than an omission.
 */
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly svc: WorkspaceService) {}

  /* ------------------------------------------------------------- messages */

  @Get('channels')
  @RequirePermission('workspace.read')
  channels(@CurrentScope() scope: ResolvedScope) { return this.svc.channels(scope); }

  @Post('channels')
  @RequirePermission('workspace.manage')
  createChannel(@Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.createChannel(dto, me, scope);
  }

  @Get('channels/:id/messages')
  @RequirePermission('workspace.read')
  messages(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.messages(id, scope, q?.limit);
  }

  @Post('channels/:id/messages')
  @RequirePermission('workspace.post')
  post(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.post(id, dto, me, scope);
  }

  /** `workspace.post` is the permission, and the SERVICE decides whether this particular
   *  person may delete this particular message (author, or a manager). Guarding the route
   *  with `workspace.manage` would stop a counsellor deleting their OWN typo. */
  @Delete('messages/:id')
  @RequirePermission('workspace.post')
  deleteMessage(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.deleteMessage(id, me, scope.all === true);
  }

  /* ---------------------------------------------------------------- notes */

  @Get('notes')
  @RequirePermission('workspace.read')
  notes(@CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.notes(me, scope, q?.q);
  }

  @Post('notes')
  @RequirePermission('workspace.post')
  createNote(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveNote(dto, me); }

  @Patch('notes/:id')
  @RequirePermission('workspace.post')
  updateNote(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.saveNote(dto, me, id);
  }

  @Delete('notes/:id')
  @RequirePermission('workspace.post')
  deleteNote(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.deleteNote(id, me); }

  /* ----------------------------------------------------------------- KB */

  @Get('kb')
  @RequirePermission('kb.read')
  kb(@CurrentScope() scope: ResolvedScope, @Query() q: any) {
    return this.svc.kb(scope, { q: q?.q, category: q?.category });
  }

  @Post('kb')
  @RequirePermission('kb.manage')
  createArticle(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveArticle(dto, me); }

  @Patch('kb/:id')
  @RequirePermission('kb.manage')
  updateArticle(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.saveArticle(dto, me, id);
  }

  @Delete('kb/:id')
  @RequirePermission('kb.manage')
  deleteArticle(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.deleteArticle(id, me); }

  /* ------------------------------------------------------- announcements */

  @Get('announcements')
  @RequirePermission('announcement.read')
  announcements(@CurrentUser() me: Me, @CurrentScope() scope: ResolvedScope) {
    return this.svc.announcements(me, scope);
  }

  @Get('announcements/manage')
  @RequirePermission('announcement.manage')
  announcementsAdmin(@CurrentScope() scope: ResolvedScope) { return this.svc.announcementsAdmin(scope); }

  @Post('announcements')
  @RequirePermission('announcement.manage')
  createAnnouncement(@Body() dto: any, @CurrentUser() me: Me) { return this.svc.saveAnnouncement(dto, me); }

  @Patch('announcements/:id')
  @RequirePermission('announcement.manage')
  updateAnnouncement(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.svc.saveAnnouncement(dto, me, id);
  }

  @Post('announcements/:id/read')
  @RequirePermission('announcement.read')
  markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) { return this.svc.markRead(id, me); }

  @Delete('announcements/:id')
  @RequirePermission('announcement.manage')
  deleteAnnouncement(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.svc.deleteAnnouncement(id, me);
  }
}
