import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { readRawBody } from '../storage/storage.controller';
import { FeedbackService, LIMITS } from './feedback.service';

interface Me { id: number; name: string }

/**
 * Feedback (22 Nov 2026). Filing, listing your own notes, replying on them, adding files and
 * accepting an answer need no permission — everyone who can sign in may do those, and the
 * service decides against the note itself (gating them on a permission would lock out exactly
 * the people the thread exists to talk to). Changing a note's status is the team's
 * (feedback.manage).
 *
 * Files are sent as the raw bytes (Content-Type application/octet-stream), with the file's
 * name and type in the query string: a 50 MB recording is not inflated by base64 on the way.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly svc: FeedbackService) {}

  @Post()
  create(@CurrentUser() me: Me, @Body() dto: any) { return this.svc.create(me, dto); }

  @Get()
  list(@CurrentUser() me: Me, @Query() q: any) { return this.svc.list(me, { status: q?.status, kind: q?.kind, page_path: q?.page_path }); }

  @Get('summary')
  summary(@CurrentUser() me: Me) { return this.svc.summary(me); }

  @Get('files/:fileId')
  fileUrl(@CurrentUser() me: Me, @Param('fileId', ParseIntPipe) fileId: number) { return this.svc.fileUrl(me, fileId); }

  /** The file's bytes, for files kept in the database (no storage link). */
  @Get('files/:fileId/raw')
  async fileRaw(@CurrentUser() me: Me, @Param('fileId', ParseIntPipe) fileId: number, @Res() res: Response) {
    const f = await this.svc.fileBytes(me, fileId);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.file_name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(f.body);
  }

  @Get(':id')
  one(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number) { return this.svc.get(me, id); }

  @Post(':id/screenshots')
  async addScreenshot(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number, @Req() req: Request,
    @Query('name') name?: string, @Query('ct') ct?: string) {
    const bytes = await readRawBody(req, LIMITS.imageBytes);
    return this.svc.addAttachment(me, id, 'image', bytes, { name, type: ct });
  }

  /** A screen recording with the reporter's voice: WebM or MP4, 50 MB, two per note. */
  @Post(':id/recordings')
  async addRecording(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number, @Req() req: Request, @Query('ct') ct?: string) {
    const bytes = await readRawBody(req, LIMITS.videoBytes);
    return this.svc.addAttachment(me, id, 'video', bytes, { type: ct });
  }

  @Post(':id/replies')
  reply(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.svc.reply(me, id, dto?.body, { answer: dto?.answer === true });
  }

  /** The reporter saying the answer settles it. */
  @Post(':id/accept')
  accept(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number) { return this.svc.accept(me, id); }

  @Patch(':id') @RequirePermission('feedback.manage')
  resolve(@CurrentUser() me: Me, @Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.svc.resolve(me, id, dto); }
}
