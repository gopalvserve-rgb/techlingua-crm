import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { redact } from './redact';

const METHOD_ACTION: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * Global interceptor writing every successful mutating request to audit_log.
 * Append-only, fire-and-forget (an audit failure never fails the request, but is logged).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly db: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const action = this.actionFor(req);
    if (!action) return next.handle();

    return next.handle().pipe(
      tap((result: any) => {
        const entityType = this.entityTypeFor(req.path ?? req.url ?? '');
        const entityId = this.num(result?.id) ?? this.num(req.params?.id) ?? null;
        const actorId = action === 'login' ? this.num(result?.user?.id) : (req.user?.id ?? null);
        this.db
          .query(
            `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, before, after, ip, user_agent)
             VALUES ((SELECT id FROM organisation ORDER BY id LIMIT 1), $1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              actorId, entityType, entityId, action,
              JSON.stringify(this.sanitize(req.body ?? {})),
              action === 'login' ? null : JSON.stringify(this.sanitize(result ?? {})),
              req.ip ?? null,
              req.headers?.['user-agent'] ?? null,
            ],
          )
          .catch((e) => console.error('audit_log write failed:', e.message));
      }),
    );
  }

  private actionFor(req: any): string | null {
    const path: string = req.path ?? req.url ?? '';
    if (path.startsWith('/api/errors')) return null; // client error reports are not user actions
    if (path.includes('/auth/login')) return 'login';
    const base = METHOD_ACTION[req.method];
    if (!base) return null;
    if (path.includes('/permissions')) return 'permission_change';
    return base;
  }

  /** '/api/users/12' -> 'users'; '/api/masters/m_course/3' -> 'masters:m_course' */
  private entityTypeFor(path: string): string {
    const seg = path.replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean);
    if (seg[0] === 'masters' && seg[1]) return `masters:${seg[1]}`;
    return seg[0] ?? 'unknown';
  }

  private sanitize(obj: unknown): unknown {
    if (!obj || typeof obj !== 'object') return obj;
    return redact(obj); // shared key-based redaction (common/redact.ts)
  }

  private num(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v != null ? n : null;
  }
}
