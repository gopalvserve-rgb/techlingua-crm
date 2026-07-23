import 'reflect-metadata';
import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '../rbac/rbac.decorators';
import { ApiKeyService } from './api-key.service';
import { API_ENDPOINT_DOCS } from './api-docs';
import { PublicApiController } from './public-api.controller';

interface Me { id: number; name: string; email?: string }

const VERB: Record<number, string> = {
  [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE', [RequestMethod.PATCH]: 'PATCH',
};
const norm = (p: string) => `/${String(p ?? '').replace(/^\/+|\/+$/g, '')}`.replace(/\/+/g, '/');

/**
 * ADMINISTRATION › API — the admin-only management surface for the Developer/API
 * module: generate/enable/disable/revoke keys (a/d), read the docs (b), and read
 * the request log (c). Everything is behind `api.read` / `api.manage`, which
 * migration 034 grants to Super Admin and Organization Admin only.
 */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  /** (a) List every key, masked. */
  @Get()
  @RequirePermission('api.read')
  list() {
    return this.keys.list();
  }

  /**
   * (b) The API documentation. The endpoint list is REFLECTED off the real
   * PublicApiController so it cannot drift from the routes; the prose/examples
   * come from api-docs.ts. base path = /api/public-api/<route>.
   */
  @Get('docs')
  @RequirePermission('api.read')
  docs() {
    const proto = PublicApiController.prototype as unknown as Record<string, unknown>;
    const base = norm(Reflect.getMetadata(PATH_METADATA, PublicApiController) ?? '');
    const endpoints: Array<{ method: string; path: string } & typeof API_ENDPOINT_DOCS[string]> = [];
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || typeof proto[m] !== 'function') continue;
      const verbMeta = Reflect.getMetadata(METHOD_METADATA, proto[m] as object);
      if (verbMeta === undefined) continue;
      const sub = Reflect.getMetadata(PATH_METADATA, proto[m] as object) ?? '/';
      const path = `/api${norm(`${base}/${norm(sub)}`)}`.replace(/\/+/g, '/');
      const verb = VERB[verbMeta as number] ?? 'GET';
      const doc = API_ENDPOINT_DOCS[`${verb} ${path}`];
      if (doc) endpoints.push({ method: verb, path, ...doc });
    }
    // stable order: create first, then the reads
    endpoints.sort((a, b) => (a.method === b.method ? a.path.localeCompare(b.path) : a.method === 'POST' ? -1 : 1));
    return {
      base_url: '/api/public-api',
      auth: 'Send your key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. '
        + 'Keys are created in Administration › API. A disabled or revoked key is rejected with 401.',
      rate_limit: `${this.keys.perKeyLimit} requests per minute per key.`,
      endpoints,
    };
  }

  /** (c) The request log, with optional date + status filters. */
  @Get('logs')
  @RequirePermission('api.read')
  logs(@Query('key_id') keyId?: string, @Query('status') status?: string, @Query('since') since?: string, @Query('limit') limit?: string) {
    return this.keys.requestLogs({
      keyId: keyId ? Number(keyId) : undefined,
      status: status === 'ok' || status === 'failed' ? status : undefined,
      since: since || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** (a) Generate a key — the plaintext is in this response ONCE and never again. */
  @Post()
  @RequirePermission('api.manage')
  generate(@Body() dto: any, @CurrentUser() me: Me) {
    return this.keys.generate(dto ?? {}, Number(me.id));
  }

  /** (d) Enable / disable a key. */
  @Patch(':id')
  @RequirePermission('api.manage')
  setActive(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() me: Me) {
    return this.keys.setActive(id, dto?.is_active !== false, Number(me.id));
  }

  /** (a) Revoke a key for good. */
  @Delete(':id')
  @RequirePermission('api.manage')
  revoke(@Param('id', ParseIntPipe) id: number, @CurrentUser() me: Me) {
    return this.keys.revoke(id, Number(me.id));
  }
}
