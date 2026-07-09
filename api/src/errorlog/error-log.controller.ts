import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe,
  Patch, Post, Query, Req,
} from '@nestjs/common';
import { CurrentUser, RequirePermission, ScopedEntity } from '../rbac/rbac.decorators';
import { ErrorLogService } from './error-log.service';

type U = { id: number };
const num = (v?: string) => (v != null && v !== '' ? Number(v) : undefined);

/**
 * Admin Error Logs API (Administration › Error Logs).
 * Org-level module like masters: list/summary are permission-gated
 * (errorlog.read / errorlog.manage — Super Admin + Org Admin only), and by-ID
 * routes carry @ScopedEntity('error_log') so only an 'all'-scoped grant passes.
 */
@Controller('error-logs')
export class ErrorLogController {
  constructor(private readonly errors: ErrorLogService) {}

  @Get()
  @RequirePermission('errorlog.read')
  list(@Query() q: Record<string, string>) {
    return this.errors.list({
      source: q.source || undefined, level: q.level || undefined, status: q.status || undefined,
      status_code: num(q.status_code), q: q.q || undefined, from: q.from || undefined,
      to: q.to || undefined, fingerprint: q.fingerprint || undefined,
      grouped: q.grouped === 'true' || q.grouped === '1',
      limit: num(q.limit), offset: num(q.offset),
    });
  }

  @Get('summary')
  @RequirePermission('errorlog.read')
  summary() {
    return this.errors.summary();
  }

  /**
   * QA-only synthetic 500 (verifies capture end-to-end). Inert in production:
   * without ERRORLOG_TEST=1 in the environment it is indistinguishable from a
   * missing route (404 — which is deliberately never captured).
   */
  @Get('_test/boom')
  @RequirePermission('errorlog.manage')
  boom(): never {
    if (process.env.ERRORLOG_TEST === '1') {
      throw new Error('Synthetic QA failure (error-log test route)');
    }
    throw new NotFoundException('Not found');
  }

  @Get(':id')
  @RequirePermission('errorlog.read')
  @ScopedEntity('error_log')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.errors.get(id);
  }

  /** Bulk resolve/reopen a fingerprint group. Declared before :id so it routes first. */
  @Patch('resolve-group')
  @RequirePermission('errorlog.manage')
  resolveGroup(@Body() body: { fingerprint?: string; status?: string }, @CurrentUser() u: U) {
    return this.errors.setGroupStatus(body?.fingerprint ?? '', body?.status ?? 'resolved', u.id);
  }

  @Patch(':id')
  @RequirePermission('errorlog.manage')
  @ScopedEntity('error_log')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status?: string },
    @CurrentUser() u: U,
  ) {
    return this.errors.setStatus(id, body?.status ?? '', u.id);
  }
}

/**
 * Client crash reporting endpoint (authenticated — any logged-in user's browser
 * may report; no errorlog permission needed). The React app posts window.onerror /
 * unhandledrejection / ErrorBoundary crashes here (throttled client-side).
 */
@Controller('errors')
export class ClientErrorsController {
  constructor(private readonly errors: ErrorLogService) {}

  @Post()
  async report(
    @Body() dto: { message?: unknown; stack?: unknown; path?: unknown; meta?: unknown },
    @CurrentUser() u: U,
    @Req() req: any,
  ) {
    const message = typeof dto?.message === 'string' ? dto.message.trim() : '';
    if (!message) throw new BadRequestException('message is required');
    const id = await this.errors.capture({
      source: 'web',
      level: 'error',
      statusCode: null,
      method: null,
      path: typeof dto.path === 'string' ? dto.path : null,
      message,
      stack: typeof dto.stack === 'string' ? dto.stack : null,
      userId: u?.id ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers?.['user-agent'] ?? null,
      meta: dto.meta && typeof dto.meta === 'object' ? dto.meta : null,
    });
    return { ok: true, id };
  }
}
