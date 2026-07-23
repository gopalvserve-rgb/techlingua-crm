import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { ApiKeyService } from './api-key.service';

/**
 * Logs every AUTHENTICATED key call once it has run — with the final status code,
 * the endpoint, the masked key and the business outcome the handler attaches to
 * `req.apiLog`. (Rejected-at-the-guard calls are logged by ApiKeyGuard instead,
 * because the handler never runs for them.)
 */
@Injectable()
export class ApiRequestLogInterceptor implements NestInterceptor {
  constructor(private readonly keys: ApiKeyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { apiCaller?: any; apiLog?: any; apiKeyStart?: number; apiClientIp?: string }>();
    const res = http.getResponse<Response>();
    const endpoint = req.originalUrl?.split('?')[0] || req.url;
    const write = (status: number, outcomeHint?: 'ok' | 'failed') => {
      const caller = req.apiCaller;
      if (!caller) return; // unauthenticated calls are logged by the guard
      const log = req.apiLog ?? {};
      void this.keys.logRequest({
        org_id: caller.org_id, api_key_id: caller.id, key_prefix: caller.key_prefix,
        method: req.method, endpoint,
        status_code: log.status_code ?? status,
        outcome: log.outcome ?? (status >= 400 ? 'failed' : outcomeHint ?? 'ok'),
        reason: log.reason ?? null, lead_id: log.lead_id ?? null,
        ip: req.apiClientIp ?? null,
        duration_ms: req.apiKeyStart ? Date.now() - req.apiKeyStart : null,
      });
    };
    return next.handle().pipe(
      tap({
        next: () => write(res.statusCode, 'ok'),
        error: (err) => write(Number(err?.status) || 500, 'failed'),
      }),
    );
  }
}
