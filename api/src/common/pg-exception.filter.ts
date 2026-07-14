import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { classify, ErrorLogService } from '../errorlog/error-log.service';
import { isNotConfigured } from './not-configured.exception';

/**
 * Global exception filter (QA DEF-3): translates Postgres constraint violations
 * into readable 4xx responses instead of opaque 500s.
 *
 *   23505 unique_violation      -> 409 Conflict   ("Duplicate value: code 'PUN' already exists")
 *   23503 foreign_key_violation -> 400 Bad Request ("Invalid reference: parent_id '999' does not exist")
 *   23514 check_violation       -> 400 Bad Request ("Invalid value: violates <constraint>")
 *   23502 not_null_violation    -> 400 Bad Request
 *   22P02 invalid_text_repr     -> 400 Bad Request
 *
 * HttpExceptions pass through unchanged; anything else stays a logged 500.
 *
 * Error Log capture (Error Log module): every response emitted here is offered
 * to ErrorLogService — 5xx as level 'error' (with stack), 409/400 as 'warning';
 * 401/403/404 are never logged (noise), and neither is a NotConfiguredException
 * (DEF-S2-05: an expected "waiting on the client's credentials" 503). The capture
 * is fire-and-forget and wrapped fail-safe so the logger can never break or delay
 * the response.
 */

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
  table?: string;
  message?: string;
  stack?: string;
}

@Catch()
export class PgExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  constructor(private readonly errorLog: ErrorLogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { statusCode: status, message: body } : body;
      this.capture(host, status, this.messageOf(payload, exception.message), exception);
      return res.status(status).json(payload);
    }

    const pg = exception as PgError;
    const mapped = pg?.code ? this.mapPg(pg) : null;
    if (mapped) {
      this.capture(host, mapped.status, mapped.message, exception);
      return res.status(mapped.status).json({
        statusCode: mapped.status, error: mapped.error, message: mapped.message,
      });
    }

    this.logger.error(
      `Unhandled exception: ${(exception as Error)?.message ?? exception}`,
      (exception as Error)?.stack,
    );
    this.capture(host, 500, (exception as Error)?.message ?? String(exception), exception);
    return res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }

  /** Fail-safe, fire-and-forget error_log write. NEVER throws, never blocks. */
  private capture(host: ArgumentsHost, status: number, message: string, exception: unknown) {
    try {
      // DEF-S2-05: "not configured yet" (Google Sheet credentials, SMS gateway) is a
      // documented, expected state — a 503 the UI explains, never an Error Log row.
      if (isNotConfigured(exception)) return;
      const level = classify(status);
      if (!level) return; // 401/403/404 and other noise stay out of the log
      const req = host.switchToHttp().getRequest();
      const path: string = req?.path ?? req?.url ?? '';
      if (path.startsWith('/api/errors')) return; // client-report endpoint logs itself
      const body = req?.body && Object.keys(req.body).length ? req.body : undefined;
      void this.errorLog.capture({
        source: 'api',
        level,
        statusCode: status,
        method: req?.method ?? null,
        path,
        message,
        // stack only for real errors — validation warnings would just add noise
        stack: level === 'error' ? (exception as Error)?.stack ?? null : null,
        userId: req?.user?.id ?? null,
        ip: req?.ip ?? null,
        userAgent: req?.headers?.['user-agent'] ?? null,
        meta: body ? { body } : null, // redacted inside capture()
      });
    } catch (e) {
      // the error logger itself must never take the API down
      this.logger.error(`error_log capture skipped: ${(e as Error)?.message ?? e}`);
    }
  }

  private messageOf(payload: unknown, fallback: string): string {
    const m = (payload as any)?.message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
    return fallback;
  }

  private mapPg(e: PgError): { status: number; error: string; message: string } | null {
    // Postgres details look like: Key (code)=(PUN) already exists. / ... is not present in table "state".
    const kv = /Key \((.+?)\)=\((.+?)\)/.exec(e.detail ?? '');
    switch (e.code) {
      case '23505':
        return {
          status: 409, error: 'Conflict',
          message: kv
            ? `Duplicate value: ${kv[1]} '${kv[2]}' already exists`
            : `Duplicate value violates unique constraint${e.constraint ? ` (${e.constraint})` : ''}`,
        };
      case '23503':
        return {
          status: 400, error: 'Bad Request',
          message: kv
            ? `Invalid reference: ${kv[1]} '${kv[2]}' does not exist${e.table ? ` (table ${e.table})` : ''}`
            : 'Invalid reference: related record does not exist',
        };
      case '23514':
        return {
          status: 400, error: 'Bad Request',
          message: `Invalid value${e.constraint ? `: violates ${e.constraint}` : ' (check constraint violated)'}`,
        };
      case '23502':
        return {
          status: 400, error: 'Bad Request',
          message: `Missing required value${e.column ? ` for '${e.column}'` : ''}`,
        };
      case '22P02':
        return { status: 400, error: 'Bad Request', message: 'Invalid value format' };
      default:
        return null;
    }
  }
}
