import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyRejected, ApiKeyService } from './api-key.service';
import { extractApiKey } from './api-key.util';

const clientIp = (req: Request): string =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

/**
 * THE API-KEY GUARD — authentication for the public, key-authed endpoints.
 *
 * These routes are @Public (no JWT), so this guard is what stands in for auth. It:
 *   1. pulls the key from `Authorization: Bearer` or `X-API-Key`,
 *   2. resolves it (unknown / disabled / revoked -> 401, logged as `rejected`),
 *   3. enforces a per-key rate limit (429, logged),
 *   4. attaches the caller to the request for the handler.
 *
 * A REJECTED call is logged HERE (the handler never runs), so the request log
 * shows refused calls too — the whole point of the log for the client.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { apiCaller?: unknown; apiKeyStart?: number }>();
    const raw = extractApiKey(req.headers as Record<string, unknown>);
    const endpoint = req.originalUrl?.split('?')[0] || req.url;
    const ip = clientIp(req);
    req.apiKeyStart = Date.now();

    let caller;
    try {
      caller = await this.keys.authenticate(raw);
    } catch (e) {
      const r = e as ApiKeyRejected;
      await this.keys.logRequest({
        method: req.method, endpoint, status_code: r.http ?? 401, outcome: 'rejected',
        reason: r.message, ip, key_prefix: raw ? raw.slice(0, 13) : null,
      });
      throw e;
    }

    // per-key rate limit (fixed window, in-process — same class as the capture channels)
    if (!this.keys.limiter.allow(`key:${caller.id}`, this.keys.perKeyLimit)) {
      const retry = this.keys.limiter.retryAfter(`key:${caller.id}`);
      await this.keys.logRequest({
        org_id: caller.org_id, api_key_id: caller.id, key_prefix: caller.key_prefix,
        method: req.method, endpoint, status_code: 429, outcome: 'rejected',
        reason: `Rate limit exceeded (${this.keys.perKeyLimit}/min). Retry after ${retry}s.`, ip,
      });
      throw new ApiKeyRejected(429, `Rate limit exceeded (${this.keys.perKeyLimit}/min). Retry after ${retry}s.`);
    }

    (req as any).apiCaller = caller;
    (req as any).apiClientIp = ip;
    return true;
  }
}
