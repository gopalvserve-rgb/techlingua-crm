import {
  Body, Controller, Get, Post, Query, Req, Res, UseGuards, UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../rbac/rbac.decorators';
import { ApiKeyGuard } from './api-key.guard';
import { ApiRequestLogInterceptor } from './api-request-log.interceptor';
import { ApiCaller, ApiKeyService } from './api-key.service';

/**
 * THE PUBLIC, KEY-AUTHENTICATED API.
 *
 * These routes carry NO session — they are called by other systems with an API
 * key, so they are @Public (the JWT guard skips them) and guarded instead by
 * ApiKeyGuard, which authenticates the key, rate-limits it and logs the call.
 * create-lead goes through the ONE LeadIngestionService, so dedup, distribution
 * and audit are inherited exactly like the Meta/Google/form/CSV channels.
 */
@Public()
@UseGuards(ApiKeyGuard)
@UseInterceptors(ApiRequestLogInterceptor)
@Controller('public-api')
export class PublicApiController {
  constructor(private readonly keys: ApiKeyService) {}

  /** Liveness + credential check. Returns the key's name and capabilities. */
  @Public()
  @Get('health')
  health(@Req() req: Request) {
    const caller = (req as any).apiCaller as ApiCaller;
    return { ok: true, key: caller.name, scopes: caller.scopes };
  }

  /** Push a new lead into the CRM through the shared ingestion pipeline. */
  @Public()
  @Post('leads')
  async createLead(@Req() req: Request, @Body() body: any, @Res({ passthrough: true }) res: Response) {
    const caller = (req as any).apiCaller as ApiCaller;
    const r = await this.keys.createLead(caller, body ?? {}, { ip: (req as any).apiClientIp });
    // hand the outcome to the log interceptor
    (req as any).apiLog = { status_code: r.http, outcome: r.outcome, reason: r.reason, lead_id: r.lead_id };
    res.status(r.http);
    return r.body;
  }

  /** List recent leads the key may see. */
  @Public()
  @Get('leads')
  async listLeads(@Req() req: Request, @Query('limit') limit: string, @Query('offset') offset: string, @Res({ passthrough: true }) res: Response) {
    const caller = (req as any).apiCaller as ApiCaller;
    const r = await this.keys.listLeads(caller, Number(limit), Number(offset));
    (req as any).apiLog = { status_code: r.http, outcome: r.http >= 400 ? 'failed' : 'ok', reason: null };
    res.status(r.http);
    return r.body;
  }
}
